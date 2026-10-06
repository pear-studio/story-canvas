import { taskGenerationSignature } from "./generation-signature.mjs";
import { persistReferenceImage } from "./reference-image.mjs";
import { encodePageKey } from "./page-key.mjs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { renderTaskIdPattern } from "./render-task-id.mjs";

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
  const lockFile = path.join(locksRoot, `${requireTaskId(taskId)}.lock`);
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
  const release = await acquireTaskLock(storeRoot, taskId, options);
  try { return await operation(storeRoot); }
  finally { await release(); }
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
  return withTaskLock(projectDirectory, task.id, async (storeRoot) => {
    if (await locateTask(storeRoot, task.id)) throw Object.assign(new Error(`渲染任务已存在：${task.id}`), { code: "render_task_exists" });
    const destination = renderTaskDirectory(storeRoot, "active", task.id);
    const staging = path.join(storeRoot, `.create-${task.id}-${(options.uniqueId ?? randomUUID)()}`);
    try {
      await mkdir(staging, { recursive: false });
      await persistReferenceImage(staging, task.items, options.referenceImage);
      await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(staging, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error?.code === "EEXIST") throw Object.assign(new Error(`渲染任务已存在：${task.id}`), { code: "render_task_exists" });
      throw error;
    }
    return { task: structuredClone(task), state, task_directory: destination };
  }, options);
}

async function readStoredTask(projectDirectory, taskId, detail) {
  const storeRoot = await resolveRenderTaskStoreRoot(projectDirectory);
  if (!storeRoot) return null;
  // 读取与终态归档共用任务锁，避免定位目录后它被移到 history。
  const release = await acquireTaskLock(storeRoot, taskId);
  try {
    const located = await locateTask(storeRoot, taskId);
    if (!located) return null;
    if (!detail) return structuredClone(located.state);
    const manifest = await readTaskJson(located.directory, "manifest.json");
    return { task: hydrateTask(manifest, located.state), state: structuredClone(located.state), scope: located.scope, task_directory: located.directory };
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
  return withTaskLock(projectDirectory, taskId, async (storeRoot) => {
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
