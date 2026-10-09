import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { projectOwnedAssetDirectories } from "./project-storage-layout.mjs";

export const EXPECTED_PROJECT_REVISION_HEADER = "x-story-canvas-expected-revision";
export const PROJECT_REVISION_HEADER = "x-story-canvas-revision";

const fixedFactFiles = [
  "project.json",
  "render-profile.override.json",
  "creative-agreement.json",
  "lettering/dialogue-layouts.json",
  "lettering/settings.json",
];

export function isProjectFactChange(filename) {
  if (!filename) return true;
  const relative = String(filename).replaceAll("\\", "/");
  return fixedFactFiles.some((file) => file === relative || file.startsWith(`${relative}/`))
    || ["story", "characters", "scenes", "pages", "materials", "finished", ...projectOwnedAssetDirectories].some((directory) =>
      relative === directory || relative.startsWith(`${directory}/`) || directory.startsWith(`${relative}/`));
}

export class ProjectWriteCoordinatorError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function optionalStat(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function collectFactMetadata(directory, projectDirectory, entries, accept) {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const child of children) {
    if (child.isSymbolicLink()) continue;
    const target = path.join(directory, child.name);
    if (child.isDirectory()) {
      await collectFactMetadata(target, projectDirectory, entries, accept);
      continue;
    }
    const relative = path.relative(projectDirectory, target).replaceAll("\\", "/");
    if (!child.isFile() || !accept(relative)) continue;
    const info = await stat(target);
    entries.push(`${relative}:${info.size}:${info.mtimeMs}`);
  }
}

async function readDiskSignature(projectDirectory) {
  const entries = [];
  for (const directory of projectOwnedAssetDirectories) {
    await collectFactMetadata(path.join(projectDirectory, directory), projectDirectory, entries, () => true);
  }
  await collectFactMetadata(path.join(projectDirectory, "finished"), projectDirectory, entries, relative => relative.endsWith(".json"));
  for (const relative of fixedFactFiles) {
    const info = await optionalStat(path.join(projectDirectory, ...relative.split("/")));
    entries.push(info ? `${relative}:${info.size}:${info.mtimeMs}` : `${relative}:missing`);
  }
  await collectFactMetadata(
    path.join(projectDirectory, "materials"),
    projectDirectory,
    entries,
    () => true,
  );
  await collectFactMetadata(
    path.join(projectDirectory, "story"),
    projectDirectory,
    entries,
    (relative) => relative.endsWith(".json"),
  );
  await collectFactMetadata(
    path.join(projectDirectory, "characters"),
    projectDirectory,
    entries,
    (relative) => relative.endsWith(".json"),
  );
  for (const directory of ["scenes", "pages"]) {
    await collectFactMetadata(path.join(projectDirectory, directory), projectDirectory, entries, relative => relative.endsWith(".json"));
  }
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

export function createProjectWriteCoordinator({
  onExternalChange = () => undefined,
  watchDirectory = watch,
} = {}) {
  // 这里只保存项目级串行化与磁盘签名事实。请求凭据和响应 revision 由
  // project-operations.mjs 显式处理，协调器不再承载 HTTP 请求上下文。
  const operationContexts = new AsyncLocalStorage();
  const locks = new Map();
  const retiredDirectories = new Set();
  const states = new Map();

  const lockKey = (projectDirectory) => path.resolve(projectDirectory);
  const stateFor = (projectDirectory) => {
    const key = lockKey(projectDirectory);
    let state = states.get(key);
    if (!state) {
      state = { lastDiskSignature: null, change: 0, scannedChange: -1, watcher: null };
      states.set(key, state);
    }
    return state;
  };

  async function currentRevisionLocked(projectDirectory, state = stateFor(projectDirectory), { suppressExternalChange = false } = {}) {
    const change = state.change;
    const diskSignature = await readDiskSignature(projectDirectory);
    if (state.lastDiskSignature && state.lastDiskSignature !== diskSignature && !suppressExternalChange) {
      onExternalChange({ projectDirectory: lockKey(projectDirectory), previous: state.lastDiskSignature, current: diskSignature });
    }
    state.lastDiskSignature = diskSignature;
    state.scannedChange = change;
    return diskSignature;
  }

  async function withMutationLock(projectDirectory, operation) {
    const key = lockKey(projectDirectory);
    const parentContext = operationContexts.getStore();
    if (parentContext?.keys.has(key)) throw new ProjectWriteCoordinatorError(500, "nested_project_operation");
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locks.set(key, current);
    await previous.catch(() => undefined);
    try {
      if (retiredDirectories.has(key)) throw new ProjectWriteCoordinatorError(409, "project_moved");
      const state = stateFor(key);
      const keys = new Set(parentContext?.keys ?? []);
      keys.add(key);
      return await operationContexts.run({ keys }, () => operation({
        projectDirectory: key,
        state,
        currentRevision: (options = {}) => currentRevisionLocked(key, state, options),
      }));
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  async function getState(projectDirectory) {
    return withMutationLock(projectDirectory, ({ currentRevision }) => currentRevision());
  }

  async function getObservedState(projectDirectory) {
    const state = stateFor(projectDirectory);
    if (!state.watcher) {
      try {
        state.watcher = watchDirectory(projectDirectory, { recursive: true, persistent: false }, (_event, filename) => {
          if (isProjectFactChange(filename)) state.change += 1;
        });
        state.change += 1; // 开始观察之前的缓存不可复用。
        state.watcher.on("error", () => {
          state.watcher?.close();
          state.watcher = null;
          state.change += 1;
        });
      } catch { /* 不支持文件通知时退回按需读取，不能返回永久过期的 revision。 */ }
    }
    if (state.watcher && state.lastDiskSignature && state.scannedChange === state.change) return state.lastDiskSignature;
    return getState(projectDirectory);
  }

  async function readConsistent(projectDirectory, operation) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await getState(projectDirectory);
      const value = await operation();
      const after = await getState(projectDirectory);
      if (before === after) return { value, revision: after };
    }
    throw new ProjectWriteCoordinatorError(409, "project_changed_during_read");
  }

  return {
    withMutationLock,
    getState,
    getObservedState,
    readConsistent,
    retire(projectDirectory) {
      retiredDirectories.add(lockKey(projectDirectory));
      const state = stateFor(projectDirectory);
      state.watcher?.close();
      state.watcher = null;
    },
    close() { for (const state of states.values()) { state.watcher?.close(); state.watcher = null; } },
    restore(projectDirectory) { retiredDirectories.delete(lockKey(projectDirectory)); },
  };
}
