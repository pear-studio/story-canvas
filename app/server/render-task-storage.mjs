import { taskGenerationSignature } from "./generation-signature.mjs";
import { persistReferenceImage } from "./reference-image.mjs";
import { encodePageKey } from "./page-key.mjs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { renderTaskIdPattern } from "./render-task-id.mjs";
import { taskHistoryMoment, CANDIDATE_HISTORY_LIMIT } from '../shared/task-history.mjs';
import { emptyTaskBusiness, assertTaskBusiness, applyTaskBusiness, discardBusinessCandidate, verifyTaskAssets } from './render-task-business.mjs';
import { candidateFilePath } from './candidate-storage.mjs';
import { readPageIndex } from './pages-store.mjs';

const activeTaskStatuses = new Set(["launching", "queued", "running"]);
const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);
const mutableItemFields = ["status", "prompt_id", "generated_at", "discarded_at"];
const replaceRetryDelays = Object.freeze([10, 20, 40, 80, 160, 320, 640]);
const retryableReplaceCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const lockRetryDelay = 10;
const lockTimeout = 10_000;
const incompleteLockStaleAfter = 30_000;

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function requireTaskId(taskId) {
  if (typeof taskId !== "string" || !renderTaskIdPattern.test(taskId)) throw new Error("渲染任务 ID 无效");
  return taskId;
}

async function readJson(target, { optional = false } = {}) {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) { if (optional && error?.code === "ENOENT") return null; throw error; }
}

async function readTaskJson(taskDirectory, filename, { optional = false } = {}) {
  const target = path.join(taskDirectory, filename);
  let info;
  try { info = await lstat(target); }
  catch (error) { if (optional && error?.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`渲染任务文件无效：${filename}`);
  const resolved = await realpath(target);
  if (!isWithin(taskDirectory, resolved)) throw new Error(`渲染任务文件越界：${filename}`);
  return readJson(resolved);
}

async function replaceWithRetry(source, target, {
  renameFile = rename,
  retryDelays = replaceRetryDelays,
  wait = waitFor,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      if (!retryableReplaceCodes.has(error?.code) || attempt >= retryDelays.length) throw error;
      await wait(retryDelays[attempt]);
    }
  }
}

async function writeJsonAtomic(target, value, options = {}) {
  const temporary = `${target}.${process.pid}.${(options.uniqueId ?? randomUUID)()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await replaceWithRetry(temporary, target, options);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function plainDirectory(target, containmentRoot, { optional = false, create = false } = {}) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (optional && !create) return null;
    if (!create) throw error;
    try { await mkdir(target, { recursive: false }); }
    catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
    info = await lstat(target);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`本地渲染任务目录无效：${target}`);
  const resolved = await realpath(target);
  if (!isWithin(containmentRoot, resolved)) throw new Error(`本地渲染任务目录越界：${target}`);
  return resolved;
}

export async function resolveRenderTaskStoreRoot(projectDirectory, { create = false } = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const projectInfo = await lstat(projectRoot);
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) throw new Error("项目目录无效");
  const projectReal = await realpath(projectRoot);
  const tasksRoot = await plainDirectory(path.join(projectRoot, "Saved"), projectReal, { optional: !create, create });
  if (!tasksRoot) return null;
  const storeRoot = await plainDirectory(path.join(tasksRoot, "render"), projectReal, { optional: !create, create });
  if (!storeRoot) return null;
  if (create) {
    for (const child of ["active", "history", "progress", "locks"]) {
      await plainDirectory(path.join(storeRoot, child), storeRoot, { create: true });
    }
  }
  return storeRoot;
}

function renderTaskDirectory(storeRoot, scope, taskId) {
  requireTaskId(taskId);
  if (!new Set(["active", "history"]).has(scope)) throw new Error("渲染任务存储范围无效");
  return path.join(storeRoot, scope, taskId);
}

async function resolveTaskDirectory(storeRoot, scope, taskId, { optional = false } = {}) {
  const target = renderTaskDirectory(storeRoot, scope, taskId);
  return plainDirectory(target, storeRoot, { optional });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function removeStaleLock(lockFile, { now = Date.now, isProcessAlive = processAlive } = {}) {
  let owner = null;
  try { owner = await readJson(lockFile); } catch { /* 写 owner 前崩溃时按文件年龄判断。 */ }
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
    if (isProcessAlive(owner.pid)) return false;
  } else {
    const info = await stat(lockFile).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info || now() - info.mtimeMs < incompleteLockStaleAfter) return false;
  }
  try { await unlink(lockFile); return true; }
  catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}

async function acquireTaskLock(storeRoot, taskId, options = {}) {
  const locksRoot = await plainDirectory(path.join(storeRoot, "locks"), storeRoot, { create: true });
  const lockFile = path.join(locksRoot, `${taskId === 'catalog' ? taskId : requireTaskId(taskId)}.lock`);
  const token = (options.uniqueId ?? randomUUID)();
  const startedAt = (options.now ?? Date.now)();
  for (;;) {
    let handle;
    try {
      handle = await open(lockFile, "wx");
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, "utf8");
      return async () => {
        await handle.close();
        const owner = await readJson(lockFile, { optional: true }).catch(() => null);
        if (owner?.token === token) await unlink(lockFile).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await unlink(lockFile).catch(() => undefined);
      }
      // Windows 在另一个读取者尚未关闭已删除锁文件时，wx 也会暂时返回 EPERM。
      if (error?.code !== "EEXIST" && !(process.platform === "win32" && error?.code === "EPERM")) throw error;
      if (error.code === "EEXIST" && await removeStaleLock(lockFile, options)) continue;
      if ((options.now ?? Date.now)() - startedAt >= (options.lockTimeoutMs ?? lockTimeout)) {
        throw Object.assign(new Error(`渲染任务状态正被其他进程更新：${taskId}`), { code: "render_task_busy" });
      }
      await (options.lockWait ?? waitFor)(options.lockRetryDelayMs ?? lockRetryDelay);
    }
  }
}

async function withTaskLock(projectDirectory, taskId, operation, options = {}) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory, { create: true });
  const releaseCatalog = await acquireTaskLock(storeRoot, 'catalog', options);
  try {
    const catalog = await ensureCatalog(storeRoot, { business: true });
    const release = await acquireTaskLock(storeRoot, taskId, options);
    try { return await operation(storeRoot, catalog); }
    finally { await release(); }
  } finally { await releaseCatalog(); }
}

export const RENDER_HISTORY_LIMIT = CANDIDATE_HISTORY_LIMIT;
const indexFile = 'history-index.json';
const businessFile = 'business-summary.json';
const requiredFile = 'business-summary-required.json';
const dirtyFile = 'catalog-dirty.json';
const pendingFile = 'cleanup-pending.json';

function reference(state) {
  const moment = taskHistoryMoment(state);
  return { id: state.id, moment: moment ? new Date(moment).toISOString() : '' };
}

function assertIndex(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Array.isArray(value.references)
    || new Set(value.references.map(row => row.id)).size !== value.references.length
    || value.references.some(row => !renderTaskIdPattern.test(row.id) || typeof row.moment !== 'string' || (row.moment && new Date(row.moment).toISOString() !== row.moment))) throw new Error('任务历史索引无效');
  return value;
}

async function pendingCleanup(storeRoot) {
  const value = await readTaskJson(storeRoot, pendingFile, { optional: true });
  if (value && (value.version !== 1 || !Array.isArray(value.ids) || value.ids.some(id => !renderTaskIdPattern.test(id)))) throw new Error('任务清理待办无效');
  return value?.ids ?? [];
}

async function loadBusiness(storeRoot) {
  const business = await readTaskJson(storeRoot, businessFile, { optional: true });
  const required = await readTaskJson(storeRoot, requiredFile, { optional: true });
  if (required && required.version !== 1) throw new Error('任务业务摘要初始化标记无效');
  if (!business && required) throw new Error('任务业务摘要缺失，不能用剩余历史重建；请恢复摘要文件');
  return business ? assertTaskBusiness(business) : emptyTaskBusiness();
}

async function saveBusiness(storeRoot, business) {
  await writeJsonAtomic(path.join(storeRoot, businessFile), assertTaskBusiness(business));
  if (!await readTaskJson(storeRoot, requiredFile, { optional: true })) await writeJsonAtomic(path.join(storeRoot, requiredFile), { version: 1 });
}

async function scanCatalogStates(storeRoot) {
  const pending = new Set(await pendingCleanup(storeRoot));
  const states = [];
  for (const scope of ['active', 'history']) {
    for (const id of await listScopeTaskIds(storeRoot, scope)) {
      if (pending.has(id)) continue;
      const directory = await resolveTaskDirectory(storeRoot, scope, id);
      states.push(assertState(await readTaskJson(directory, 'state.json'), id));
    }
  }
  return states;
}

// 索引可重建；清源后的业务摘要必须合并保留，缺失/坏文件不能静默覆盖。
async function ensureCatalog(storeRoot, { business: needBusiness = false } = {}) {
  let index;
  try { index = assertIndex(await readTaskJson(storeRoot, indexFile)); }
  catch (error) {
    if ((error.code && error.code !== 'ENOENT') || /越界|任务文件无效/.test(error.message)) throw error;
  }
  const dirty = await readTaskJson(storeRoot, dirtyFile, { optional: true });
  if (dirty && (dirty.version !== 1 || (dirty.operation && dirty.operation !== 'candidate-delete'))) throw new Error('任务索引更新标记无效');
  const initialized = await readTaskJson(storeRoot, requiredFile, { optional: true });
  if (index && !dirty) {
    const pending = new Set(await pendingCleanup(storeRoot));
    index.references = index.references.filter(row => !pending.has(row.id));
    return { index, business: needBusiness ? await loadBusiness(storeRoot) : null };
  }
  if (dirty?.operation === 'candidate-delete') await recoverCandidateDelete(storeRoot, dirty);
  const states = await scanCatalogStates(storeRoot);
  // 干净索引单独损坏时仍可修复，不依赖不可重建摘要。
  let business = needBusiness || dirty || !initialized ? await loadBusiness(storeRoot) : null;
  if (business) {
    for (const state of states) applyTaskBusiness(business, state);
    if (dirty?.operation === 'candidate-delete') {
      const projectDirectory = path.dirname(path.dirname(storeRoot));
      const candidateDirectory = path.dirname(candidateFilePath(projectDirectory, dirty.page_key, dirty.candidate_id));
      // 删除是整个候选目录原子移走；存在表示 move 尚未提交，缺失表示已提交。
      if (!await plainDirectory(candidateDirectory, projectDirectory, { optional: true })) discardBusinessCandidate(business, dirty.task_id, dirty.candidate_id);
    }
    await saveBusiness(storeRoot, business);
  }
  index = { version: 1, generation: (index?.generation ?? 0) + 1, references: states.filter(state => terminalTaskStatuses.has(state.status)).map(reference) };
  await writeJsonAtomic(path.join(storeRoot, indexFile), index);
  if (dirty) await unlink(path.join(storeRoot, dirtyFile));
  return { index, business };
}

async function recoverCandidateDelete(storeRoot, intent) {
  requireTaskId(intent.task_id);
  const projectDirectory = path.dirname(path.dirname(storeRoot));
  const directory = path.dirname(candidateFilePath(projectDirectory, intent.page_key, intent.candidate_id));
  if (await plainDirectory(directory, projectDirectory, { optional: true })) return false;
  const located = (await pendingCleanup(storeRoot)).includes(intent.task_id) ? null : await locateTask(storeRoot, intent.task_id);
  const item = located?.state.items.find(item => item.candidate_id === intent.candidate_id);
  if (item && item.status !== 'discarded') {
    item.status = 'discarded';
    item.discarded_at = intent.discarded_at;
    located.state.revision++;
    await writeJsonAtomic(path.join(located.directory, 'state.json'), located.state);
  }
  return true;
}

async function beginCatalogWrite(storeRoot, value = {}) {
  await writeJsonAtomic(path.join(storeRoot, dirtyFile), { version: 1, ...value });
}

async function commitCatalogState(storeRoot, catalog, state, options = {}) {
  // 状态提交成功后，投影失败不能触发任务执行失败或远端重跑。
  try {
    await options.catalogCheckpoint?.('source-written');
    applyTaskBusiness(catalog.business, state);
    await saveBusiness(storeRoot, catalog.business);
    await options.catalogCheckpoint?.('business-written');
    catalog.index.references = catalog.index.references.filter(row => row.id !== state.id);
    if (terminalTaskStatuses.has(state.status)) catalog.index.references.push(reference(state));
    catalog.index.generation++;
    await writeJsonAtomic(path.join(storeRoot, indexFile), catalog.index);
    await options.catalogCheckpoint?.('index-written');
    await unlink(path.join(storeRoot, dirtyFile));
  } catch (error) { console.warn(`任务状态已保存，业务摘要/历史索引待修复：${state.id}：${error.message}`); }
}

export async function readRenderHistoryReferences(projectDirectory) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return [];
  const release = await acquireTaskLock(storeRoot, 'catalog');
  try { return (await ensureCatalog(storeRoot)).index.references; }
  finally { await release(); }
}

export async function readRenderTaskBusiness(projectDirectory) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return emptyTaskBusiness();
  const release = await acquireTaskLock(storeRoot, 'catalog');
  try { return (await ensureCatalog(storeRoot, { business: true })).business; }
  finally { await release(); }
}

// 调用方已经持有候选 mutation/media 锁；源档案清理后仍能更新摘要并回滚移动失败。
export async function deleteRetainedCandidate(projectDirectory, taskId, pageKey, candidateId, move, { checkpoint = async () => {} } = {}) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory, { create: true });
  const release = await acquireTaskLock(storeRoot, 'catalog');
  try {
    const { business } = await ensureCatalog(storeRoot, { business: true });
    const intent = { operation: 'candidate-delete', task_id: taskId, page_key: pageKey, candidate_id: candidateId, discarded_at: new Date().toISOString() };
    await beginCatalogWrite(storeRoot, intent);
    await checkpoint('prepared');
    try { await move(); }
    catch (error) {
      await unlink(path.join(storeRoot, dirtyFile));
      throw error;
    }
    try {
      await checkpoint('moved');
      await recoverCandidateDelete(storeRoot, intent);
      discardBusinessCandidate(business, taskId, candidateId);
      await saveBusiness(storeRoot, business);
      await unlink(path.join(storeRoot, dirtyFile));
    } catch (error) { console.warn(`候选已删除，任务摘要待修复：${candidateId}：${error.message}`); }
  } finally { await release(); }
}

async function removeTaskArchive(storeRoot, id) {
  requireTaskId(id);
  const directory = await resolveTaskDirectory(storeRoot, 'history', id, { optional: true });
  if (directory) await rm(directory, { recursive: true, force: false });
  const submissions = await plainDirectory(path.join(storeRoot, 'submissions'), storeRoot, { optional: true });
  if (submissions) {
    const target = await plainDirectory(path.join(submissions, id), storeRoot, { optional: true });
    if (target) await rm(target, { recursive: true, force: false });
  }
  const progress = await plainDirectory(path.join(storeRoot, 'progress'), storeRoot, { optional: true });
  if (progress) {
    const target = path.join(progress, `${id}.json`);
    const info = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || !isWithin(storeRoot, await realpath(target))) throw new Error('任务进度路径无效');
      await unlink(target);
    }
  }
}

// 调用方须持 candidate mutation 锁；isIdle 在 catalog 锁内核对队列收尾。
export async function maintainRenderTaskHistory(projectDirectory, { limit = RENDER_HISTORY_LIMIT, isIdle = async () => true, checkpoint = async () => {} } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('任务保留上限无效');
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return { removed: [], blocked: [] };
  const release = await acquireTaskLock(storeRoot, 'catalog');
  try {
    const catalog = await ensureCatalog(storeRoot, { business: true });
    const active = await listScopeStates(storeRoot, 'active', { strict: true });
    if (active.length || !await isIdle()) return { removed: [], blocked: [], skipped: 'active' };
    const pending = await pendingCleanup(storeRoot);
    const pageIndex = await readPageIndex(projectDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const currentPages = new Set(pageIndex?.pages.map(page => page.page_id) ?? []);
    const references = [...catalog.index.references].sort((a, b) => `${b.moment}/${b.id}`.localeCompare(`${a.moment}/${a.id}`, 'en'));
    const blocked = [];
    for (const row of references.slice(limit)) {
      const located = await locateTask(storeRoot, row.id);
      if (!located || located.scope !== 'history' || !terminalTaskStatuses.has(located.state.status)) continue;
      try {
        const missing = await verifyTaskAssets(projectDirectory, located.state);
        applyTaskBusiness(catalog.business, located.state);
        const batch = catalog.business.batches[row.id];
        if (batch) {
          for (const item of missing) {
            // 页面归档会整体移走媒体；这种情形保留批次摘要供还原。
            if (!currentPages.has(item.page_id)) continue;
            const pageDirectory = path.dirname(path.dirname(candidateFilePath(projectDirectory, { page_id: item.page_id }, item.candidate_id)));
            if (!await plainDirectory(pageDirectory, projectDirectory, { optional: true })) continue;
            batch.available_ids = batch.available_ids.filter(id => id !== item.candidate_id);
          }
          if (!batch.available_ids.length) delete catalog.business.batches[row.id];
        }
        pending.push(row.id);
      } catch (error) { blocked.push({ id: row.id, error: error.message }); }
    }
    // 页面删除会归档候选以支持还原；运行摘要随项目保留，不能仅凭当前页面索引裁掉。
    await saveBusiness(storeRoot, catalog.business);
    if (!pending.length) return { removed: [], blocked };
    const ids = [...new Set(pending)];
    await writeJsonAtomic(path.join(storeRoot, pendingFile), { version: 1, ids });
    await checkpoint('prepared');
    catalog.index.references = catalog.index.references.filter(row => !ids.includes(row.id));
    catalog.index.generation++;
    await writeJsonAtomic(path.join(storeRoot, indexFile), catalog.index);
    const removed = [], remaining = [];
    for (const id of ids) {
      try {
        await removeTaskArchive(storeRoot, id);
        removed.push(id);
        await checkpoint('removed', id);
      } catch (error) { remaining.push(id); blocked.push({ id, error: error.message }); }
    }
    if (remaining.length) await writeJsonAtomic(path.join(storeRoot, pendingFile), { version: 1, ids: remaining });
    else await unlink(path.join(storeRoot, pendingFile));
    return { removed, blocked };
  } finally { await release(); }
}

function createState(task, display, revision = 1) {
  return {
    version: 1,
    id: task.id,
    project_id: task.project,
    project_title: String(display?.project_title ?? task.project),
    purpose: task.purpose,
    render_profile: task.render_profile,
    media_kind: (task.render_profile==='minimax-h3'||task.items.some(item=>item.video_settings))?'video':'image',
    status: task.status,
    created_at: task.created_at ?? null,
    started_at: task.started_at ?? null,
    completed_at: task.completed_at ?? null,
    failed_at: task.failed_at ?? null,
    error: task.error ?? null,
    revision,
    pages: Array.isArray(display?.pages) ? structuredClone(display.pages) : [],
    items: task.items.map((item) => ({
      id: item.id,
      page_key: structuredClone(item.page_key),
      candidate_id: item.candidate_id ?? null,
      file: item.file ?? null,
      seed: Number.isSafeInteger(item.seed) ? item.seed : null,
      status: item.status,
      generated_at: item.generated_at ?? null,
      prompt_id: item.prompt_id ?? null,
      discarded_at: item.discarded_at ?? null,
      generation_signature: taskGenerationSignature(task, item),
    })),
  };
}

function createManifest(task) {
  const frozen = structuredClone(task);
  for (const field of ["status", "started_at", "completed_at", "failed_at", "error"]) delete frozen[field];
  frozen.items = frozen.items.map((item) => {
    const result = { ...item };
    for (const field of mutableItemFields) delete result[field];
    return result;
  });
  return { storage_version: 1, id: task.id, project: task.project, task: frozen };
}

function assertState(state, taskId) {
  if (state?.version !== 1 || state.id !== taskId || typeof state.project_id !== "string"
    || ![...activeTaskStatuses, ...terminalTaskStatuses].includes(state.status)
    || !Array.isArray(state.items) || !Array.isArray(state.pages) || !Number.isSafeInteger(state.revision) || state.revision < 1) {
    throw new Error(`渲染任务状态无效：${taskId}`);
  }
  return state;
}

function hydrateTask(manifest, state) {
  if (manifest?.storage_version !== 1 || manifest.id !== state.id || manifest.project !== state.project_id || !Array.isArray(manifest.task?.items)) {
    throw new Error(`渲染任务 manifest 与 state 不一致：${state.id}`);
  }
  const stateItems = new Map(state.items.map((item) => [item.id, item]));
  if (stateItems.size !== manifest.task.items.length) throw new Error(`渲染任务条目状态不完整：${state.id}`);
  const task = structuredClone(manifest.task);
  task.status = state.status;
  for (const field of ["started_at", "completed_at", "failed_at", "error"]) {
    if (state[field] == null) delete task[field];
    else task[field] = state[field];
  }
  task.items = task.items.map((item) => {
    const mutable = stateItems.get(item.id);
    if (!mutable) throw new Error(`渲染任务条目状态缺失：${item.id}`);
    const next = { ...item };
    for (const field of mutableItemFields) {
      if (mutable[field] == null) delete next[field];
      else next[field] = mutable[field];
    }
    return next;
  });
  return task;
}

async function locateTask(storeRoot, taskId) {
  for (const scope of ["active", "history"]) {
    const directory = await resolveTaskDirectory(storeRoot, scope, taskId, { optional: true });
    if (!directory) continue;
    const state = await readTaskJson(directory, "state.json", { optional: true });
    if (!state) throw Object.assign(new Error(`渲染任务缺少 state.json：${taskId}`), { code: "ENOENT" });
    return { scope, directory, state: assertState(state, taskId) };
  }
  return null;
}

export async function createRenderTask(projectDirectory, task, display, options = {}) {
  requireTaskId(task?.id);
  if (typeof task?.project !== "string" || !task.project) throw new Error("渲染任务缺少项目 ID");
  if (!Array.isArray(task?.items)) throw new Error("渲染任务缺少条目");
  if (!activeTaskStatuses.has(task.status)) throw new Error("新渲染任务必须处于活动状态");
  const manifest = createManifest(task);
  const state = createState(task, display);
  return withTaskLock(projectDirectory, task.id, async (storeRoot, catalog) => {
    if (await locateTask(storeRoot, task.id)) throw Object.assign(new Error(`渲染任务已存在：${task.id}`), { code: "render_task_exists" });
    const destination = renderTaskDirectory(storeRoot, "active", task.id);
    const staging = path.join(storeRoot, `.create-${task.id}-${(options.uniqueId ?? randomUUID)()}`);
    try {
      await mkdir(staging, { recursive: false });
      await persistReferenceImage(staging, task.items, options.referenceImage);
      await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(staging, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await beginCatalogWrite(storeRoot);
      await replaceWithRetry(staging, destination, options);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error?.code === "EEXIST") throw Object.assign(new Error(`渲染任务已存在：${task.id}`), { code: "render_task_exists" });
      throw error;
    }
    await commitCatalogState(storeRoot, catalog, state, options);
    return { task: structuredClone(task), state, task_directory: destination };
  }, options);
}

async function readStoredTask(projectDirectory, taskId, detail) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return null;
  // 读取与终态归档共用任务锁，避免定位目录后它被移到 history。
  const releaseCatalog = await acquireTaskLock(storeRoot, 'catalog');
  try {
    if ((await readTaskJson(storeRoot, dirtyFile, { optional: true }))?.operation === 'candidate-delete') await ensureCatalog(storeRoot, { business: true });
    const release = await acquireTaskLock(storeRoot, taskId);
    try {
    const located = await locateTask(storeRoot, taskId);
    if (!located) return null;
    if (!detail) return structuredClone(located.state);
    const manifest = await readTaskJson(located.directory, "manifest.json");
    return { task: hydrateTask(manifest, located.state), state: structuredClone(located.state), scope: located.scope, task_directory: located.directory };
    } finally { await release(); }
  } finally { await releaseCatalog(); }
}

export async function readRenderTaskStatesById(projectDirectory, ids) {
  ids.forEach(requireTaskId);
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return new Map(ids.map(id => [id, null]));
  const release = await acquireTaskLock(storeRoot, 'catalog');
  try {
    if ((await readTaskJson(storeRoot, dirtyFile, { optional: true }))?.operation === 'candidate-delete') await ensureCatalog(storeRoot, { business: true });
    const states = new Map();
    // 项目级锁保持这一页的源状态一致，无须为每条再次打开两个文件锁。
    for (const id of ids) states.set(id, (await locateTask(storeRoot, id))?.state ?? null);
    return states;
  } finally { await release(); }
}

export async function readRenderTask(projectDirectory, taskId) {
  return readStoredTask(projectDirectory, taskId, true);
}

export async function readRenderTaskState(projectDirectory, taskId) {
  return readStoredTask(projectDirectory, taskId, false);
}

function validateUpdatedTask(task, manifest, located) {
  if (!isDeepStrictEqual(createManifest(task), manifest)) {
    throw new Error(`渲染任务不可变内容不能在状态更新时改变：${task.id}`);
  }
  if (![...activeTaskStatuses, ...terminalTaskStatuses].includes(task.status)) {
    throw new Error(`渲染任务状态无效：${task.id}`);
  }
  if (terminalTaskStatuses.has(located.state.status) && task.status !== located.state.status) throw new Error(`终态渲染任务不能变更状态：${task.id}`);
  if (located.scope === "history" && activeTaskStatuses.has(task.status)) throw new Error(`历史渲染任务不能重新激活：${task.id}`);
}

export async function updateRenderTask(projectDirectory, taskId, mutate, options = {}) {
  if (typeof mutate !== "function") throw new TypeError("渲染任务 mutation 必须是函数");
  return withTaskLock(projectDirectory, taskId, async (storeRoot, catalog) => {
    const located = await locateTask(storeRoot, taskId);
    if (!located) throw Object.assign(new Error(`渲染任务不存在：${taskId}`), { code: "ENOENT" });
    const manifest = await readTaskJson(located.directory, "manifest.json");
    const currentTask = hydrateTask(manifest, located.state);
    const draft = structuredClone(currentTask);
    const returned = await mutate(draft, { state: structuredClone(located.state), scope: located.scope });
    const task = returned === undefined ? draft : returned;
    if (!task || typeof task !== "object" || task.id !== taskId) throw new Error(`渲染任务 mutation 返回值无效：${taskId}`);
    validateUpdatedTask(task, manifest, located);
    const state = createState(task, located.state, located.state.revision + 1);
    state.project_title = located.state.project_title;
    state.pages = structuredClone(located.state.pages);
    await beginCatalogWrite(storeRoot);
    await writeJsonAtomic(path.join(located.directory, "state.json"), state, options);
    let taskDirectory = located.directory;
    if (located.scope === "active" && terminalTaskStatuses.has(state.status)) {
      const destination = renderTaskDirectory(storeRoot, "history", task.id);
      try {
        await replaceWithRetry(located.directory, destination, options);
        taskDirectory = destination;
      } catch (error) {
        if (!retryableReplaceCodes.has(error?.code)) throw error;
      }
    }
    await commitCatalogState(storeRoot, catalog, state, options);
    return { task: structuredClone(task), state, task_directory: taskDirectory };
  }, options);
}

async function listScopeTaskIds(storeRoot, scope) {
  const directory = await plainDirectory(path.join(storeRoot, scope), storeRoot, { optional: true });
  if (!directory) return [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && renderTaskIdPattern.test(entry.name))
    .map((entry) => entry.name).sort((left, right) => right.localeCompare(left, "en"));
}

export async function listRenderHistoryTaskIds(projectDirectory) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  return storeRoot ? listScopeTaskIds(storeRoot, "history") : [];
}

async function listScopeStates(storeRoot, scope, { strict = false } = {}) {
  const selected = await listScopeTaskIds(storeRoot, scope);
  const states = [];
  for (const taskId of selected) {
    try {
      const taskDirectory = await resolveTaskDirectory(storeRoot, scope, taskId);
      states.push(assertState(await readTaskJson(taskDirectory, "state.json"), taskId));
    } catch (error) {
      if (strict) throw Object.assign(new Error(`活动渲染任务状态不可验证：${taskId}：${error.message}`), { code: "render_task_state_invalid", cause: error });
      // 展示读取忽略单个损坏的本机派生状态。
    }
  }
  return states;
}

export async function listProjectRenderTaskStates(projectDirectory, { scope = "all", strict = false } = {}) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return [];
  if (scope === "active") return listScopeStates(storeRoot, "active", { strict });
  if (scope === "history") return listScopeStates(storeRoot, "history", { strict });
  if (scope !== "all") throw new Error("渲染任务查询范围无效");
  const active = await listScopeStates(storeRoot, "active", { strict });
  const history = await listScopeStates(storeRoot, "history", { strict });
  return [...active, ...history];
}

export async function listActiveProjectTaskIds(projectDirectory) {
  return (await listProjectRenderTaskStates(projectDirectory, { scope: "active", strict: true }))
    .filter((state) => activeTaskStatuses.has(state.status)).map((state) => state.id);
}

export function isActiveRenderTaskState(state) {
  return activeTaskStatuses.has(state?.status);
}

export function renderTaskProgressFile(projectDirectory, taskId) {
  requireTaskId(taskId);
  return path.join(path.resolve(projectDirectory), "Saved", "render", "progress", `${taskId}.json`);
}

export async function assertNoActivePageRender(projectDirectory, pageKey) {
  const canonical = encodePageKey(pageKey);
  const tasks = await listProjectRenderTaskStates(projectDirectory, { scope: "active", strict: true });
  const active = tasks.filter(task => activeTaskStatuses.has(task.status) && task.items.some(item => encodePageKey(item.page_key) === canonical));
  if (active.length) throw Object.assign(new Error("页面仍有活动生成任务"), { status: 409, code: "page_has_active_render", details: active.map(task => task.id) });
}
