import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 文件操作和候选媒体锁；项目事实写入仍由 project-operations 统一协调。
export class FactError extends Error {
  constructor(code, details = []) {
    super(code);
    this.name = "FactError";
    this.code = code;
    this.status = code === "story_edit_target_busy" || code.endsWith("_conflict") ? 409 : 422;
    this.details = Array.isArray(details) ? details : [details];
  }
}

const storyLockOwnerTokenPattern = /^[a-f0-9]{32}$/;
export const STORY_LOCK_MALFORMED_GRACE_MS = 5_000;

function fail(code, details) { throw new FactError(code, details); }

export function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function factLocksRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), "Saved", "state", "fact-locks");
}

export async function assertRealPathWithin(root, target, label) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isWithin(realRoot, realTarget)) fail("unsafe_story_edit_path", [`${label} 的真实路径越界：${target}`]);
  return { realRoot, realTarget };
}

export async function assertProjectFactBoundary(projectRoot, projectDirectory, target, label) {
  const targetInfo = await lstat(target);
  if (targetInfo.isSymbolicLink()) fail("unsafe_story_edit_path", [`${label} 不能是链接：${target}`]);
  await assertRealPathWithin(projectDirectory, target, label);
}

export async function assertNoReparsePoints(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail("unsafe_story_edit_path", [`目录包含链接或 junction：${target}`]);
    if (info.isDirectory()) await assertNoReparsePoints(target);
  }
}

export async function removeSafeRuntimeDirectory(projectRoot, runtimeRoot, directory, label) {
  const root = path.resolve(runtimeRoot);
  const absolute = path.resolve(directory);
  if (!isWithin(root, absolute) || absolute === root) fail("unsafe_story_edit_path", [absolute]);
  const info = await lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_story_edit_path", [absolute]);
  await assertRealPathWithin(path.resolve(projectRoot), root, `${label} root`);
  await assertRealPathWithin(root, absolute, label);
  await assertNoReparsePoints(absolute);
  await rm(absolute, { recursive: true, force: true });
}

export function projectRelativePath(...segments) {
  return segments.join("/");
}

export function targetPath(projectDirectory, relativePath) {
  return path.join(projectDirectory, ...relativePath.split("/"));
}

export async function readJson(target, label) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error?.code === "ENOENT") fail("story_edit_file_missing", [`${label} 不存在：${target}`]);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("unsafe_story_edit_file", [`${label} 不是普通文件：${target}`]);
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) fail("invalid_story_edit_json", [`${label} 不是有效 JSON：${target}`]);
    throw error;
  }
}

export async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readOptionalFact(directory, relative, fallback = null) {
  const target = targetPath(directory, relative);
  const info = await lstat(target).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!info) return structuredClone(fallback);
  await assertProjectFactBoundary(directory, directory, target, relative);
  return JSON.parse(await readFile(target, 'utf8'));
}

function parsedStoryLockOwner(source) {
  try {
    const owner = JSON.parse(source);
    if (!Number.isInteger(owner?.pid) || owner.pid < 1
      || !storyLockOwnerTokenPattern.test(owner.token ?? "")
      || !Number.isFinite(Date.parse(owner.created_at))) return null;
    return owner;
  } catch {
    return null;
  }
}

async function readStoryLockSnapshot(lockPath) {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) return { info, source: null, owner: null };
    const source = await readFile(lockPath, "utf8");
    return { info, source, owner: parsedStoryLockOwner(source) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeMalformedStoryLock(lockPath, observed) {
  const current = await readStoryLockSnapshot(lockPath);
  if (!current || current.owner || current.source !== observed.source
    || current.info.size !== observed.info.size || current.info.mtimeMs !== observed.info.mtimeMs) return false;
  await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return true;
}

async function removeOwnedStoryLock(lockPath, ownerToken) {
  const current = await readStoryLockSnapshot(lockPath);
  if (!current || current.owner?.token !== ownerToken) return false;
  await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return true;
}

export async function withResourceLock(projectRoot, projectId, lockName, detail, operation) {
  const lockBase = factLocksRoot(projectRoot);
  await mkdir(lockBase, { recursive: true });
  await assertRealPathWithin(path.resolve(projectRoot), lockBase, "fact locks root");
  const lockRoot = path.join(lockBase, projectId);
  await mkdir(lockRoot, { recursive: true });
  await assertRealPathWithin(lockBase, lockRoot, "story page lock directory");
  const lockPath = path.join(lockRoot, `${lockName}.lock`);
  const ownerToken = randomBytes(16).toString("hex");
  let handle;
  const deadline = Date.now() + 1000;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail("story_edit_target_busy", [detail]);
      await delay(Math.min(20 * 2 ** Math.min(attempt - 1, 4), remaining));
    }
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: ownerToken, created_at: new Date().toISOString() })}\n`);
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      const observed = await readStoryLockSnapshot(lockPath);
      if (!observed) continue;
      if (!observed.owner) {
        const ageMs = Date.now() - observed.info.mtimeMs;
        if (!Number.isFinite(ageMs) || ageMs < STORY_LOCK_MALFORMED_GRACE_MS) continue;
        await removeMalformedStoryLock(lockPath, observed);
        continue;
      }
      let active = true;
      try { process.kill(observed.owner.pid, 0); }
      catch (probeError) { active = probeError?.code !== "ESRCH"; }
      if (active) continue;
      await removeOwnedStoryLock(lockPath, observed.owner.token);
    }
  }
  if (!handle) fail("story_edit_target_busy", [detail]);
  await handle.close();
  try { return await operation(); }
  finally { await removeOwnedStoryLock(lockPath, ownerToken); }
}

export function withPageLocks(projectRoot, projectId, pageIds, operation) {
  const ordered = [...new Set(pageIds)].sort((left, right) => left.localeCompare(right, "en"));
  const enter = (index) => {
    if (index === ordered.length) return operation();
    const pageId = ordered[index];
    const lockId = `page-${createHash("sha256").update(pageId).digest("hex")}`;
    return withResourceLock(projectRoot, projectId, lockId, pageId, () => enter(index + 1));
  };
  return enter(0);
}

export async function rollbackCreatedFactFiles(targets, originalError, failureCode) {
  const rollbackFailures = [];
  for (const target of targets) {
    try { await unlink(target); }
    catch (error) { if (error?.code !== "ENOENT") rollbackFailures.push({ target, error }); }
  }
  if (!rollbackFailures.length) return;
  const failure = new FactError(failureCode, [
    `原始错误：${originalError?.code ?? originalError?.message ?? String(originalError)}`,
    ...rollbackFailures.map(item => `未清理 ${item.target}：${item.error?.code ?? item.error?.message ?? String(item.error)}`),
  ]);
  failure.cause = originalError;
  throw failure;
}
