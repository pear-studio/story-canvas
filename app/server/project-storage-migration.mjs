import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { candidateFileRelativePath, publishCandidateResult } from "./candidate-storage.mjs";
import { requireProjectDirectoryName } from "./project-contracts.mjs";
import { projectGitattributes, projectGitignore } from "./project-storage-layout.mjs";
import { requireIdleProject } from "./project-management.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = target => lstat(target).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
const json = async target => JSON.parse(await readFile(target, "utf8"));
const save = async (target, value) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value, null, 2) + "\n"); };

// 包含 .git、未跟踪文件和空目录；迁移不能使用项目复制的事实白名单。
export async function projectTreeFingerprint(directory) {
  const entries = [];
  async function walk(target, relative) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`迁移拒绝链接：${relative}`);
    if (info.isDirectory()) {
      entries.push([relative, "directory"]);
      for (const name of (await readdir(target)).sort()) await walk(path.join(target, name), relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) entries.push([relative, sha256(await readFile(target))]);
    else throw new Error(`迁移不支持的文件类型：${relative}`);
  }
  await walk(directory, "");
  return entries;
}

function currentPageKey(key) {
  return { page_id: key?.page_id };
}

async function mergeMove(source, destination) {
  if (!await exists(source)) return;
  if (!await exists(destination)) { await mkdir(path.dirname(destination), { recursive: true }); await rename(source, destination); return; }
  if (!(await lstat(source)).isDirectory() || !(await lstat(destination)).isDirectory()) throw new Error(`迁移路径冲突：${destination}`);
  for (const entry of await readdir(source)) await mergeMove(path.join(source, entry), path.join(destination, entry));
  await rmdir(source);
}

async function removeEmptyDirectories(directory) {
  if (!await exists(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name));
  if (!(await readdir(directory)).length) await rmdir(directory);
}

async function migrateRenderResults(directory) {
  const published = [];
  for (const scope of ["active", "history"]) {
    const root = path.join(directory, "tasks", "render", scope);
    for (const entry of await readdir(root, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
      if (!entry.isDirectory() || !entry.name.startsWith("render-")) continue;
      const taskDirectory = path.join(root, entry.name);
      const raw = await readFile(path.join(taskDirectory, "manifest.json"), "utf8");
      const manifest = JSON.parse(raw);
      const state = await json(path.join(taskDirectory, "state.json"));
      if (!["completed", "failed"].includes(state.status)) throw new Error(`迁移前必须结束渲染任务：${entry.name}`);
      const frozen = manifest.task;
      if (!Array.isArray(frozen?.items)) throw new Error(`无法读取任务快照：${entry.name}`);
      const task = { ...frozen, ...state, project: state.project_id, snapshot: frozen.snapshot,
        items: frozen.items.map(item => ({ ...item, ...state.items.find(current => current.id === item.id) })) };
      for (const item of task.items) {
        if (item.status !== "available") continue;
        const oldFile = String(item.file).replaceAll("\\", "/");
        if (!oldFile.startsWith("candidates/") || oldFile.split("/").includes("..")) throw new Error(`迁移候选路径无效：${oldFile}`);
        const image = await readFile(path.join(directory, ...oldFile.split("/")));
        const next = { ...item, page_key: currentPageKey(item.page_key) };
        const result = await publishCandidateResult(directory, task, next, image, { evidence: { original_manifest: raw, sha256: sha256(Buffer.from(raw)) }, warm: false });
        if (sha256(image) !== sha256(await readFile(path.join(directory, result.file)))) throw new Error("迁移图片校验失败");
        published.push({ from: oldFile, to: result.file, sha256: sha256(image) });
        await rm(path.join(directory, oldFile));
      }
      // 旧快照仅作为生成详情中的历史证据；任务面板保留当前形状的轻量摘要，不可重跑。
      const nextState = { ...state, pages: state.pages.map(page => ({ ...page, owner_kind: page.page_key.owner_kind, page_key: currentPageKey(page.page_key) })),
        items: state.items.map(item => ({ ...item, page_key: currentPageKey(item.page_key), file: item.candidate_id ? candidateFileRelativePath(currentPageKey(item.page_key), item.candidate_id) : item.file })) };
      await save(path.join(directory, "Saved", "render", "history", entry.name, "state.json"), nextState);
      await rm(path.join(taskDirectory, "manifest.json"));
      await rm(path.join(taskDirectory, "state.json"));
    }
  }
  await removeEmptyDirectories(path.join(directory, "candidates"));
  await removeEmptyDirectories(path.join(directory, "tasks"));
  return published;
}

async function replaceProjectDirectory(source, staging, backup, renameDirectory) {
  try { await renameDirectory(source, backup); }
  catch (error) {
    if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
    // Windows 编辑器可能持有根目录句柄。离线时保留根目录，逐个切换子项；
    // 日志与完整旧子项留在 workspace 下，异常退出后可以人工还原，不能启动半迁移项目。
    const marker = path.join(source, ".storage-migration.json");
    const baseline = await projectTreeFingerprint(source);
    const next = await projectTreeFingerprint(staging);
    await cp(source, backup, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    if (JSON.stringify(await projectTreeFingerprint(backup)) !== JSON.stringify(baseline)) throw new Error("迁移回滚备份校验失败");
    await save(marker, { source, staging, backup, original_files: baseline, next_files: next });
    const install = async (from, entries, oldEntries) => {
      const oldFiles = new Map(oldEntries.filter(([, kind]) => kind !== "directory"));
      const nextFiles = new Map(entries.filter(([, kind]) => kind !== "directory"));
      for (const [relative, hash] of nextFiles) {
        if (oldFiles.get(relative) === hash) continue;
        const target = path.join(source, relative);
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = target + ".migration-" + randomUUID();
        await copyFile(path.join(from, relative), temporary);
        try { await rename(temporary, target); } finally { await rm(temporary, { force: true }); }
      }
      for (const [relative] of oldFiles) if (!nextFiles.has(relative)) await rm(path.join(source, relative), { force: true });
      for (const [relative, kind] of [...oldEntries].reverse()) if (relative && kind === "directory" && !entries.some(([name]) => name === relative)) {
        await rmdir(path.join(source, relative)).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error; });
      }
    };
    try {
      await install(staging, next, baseline);
      const actual = (await projectTreeFingerprint(source)).filter(([name, kind]) => kind !== "directory" && name !== ".storage-migration.json");
      if (JSON.stringify(actual) !== JSON.stringify(next.filter(([, kind]) => kind !== "directory"))) throw new Error("切换后文件字节校验失败");
      await rm(marker);
      await rm(staging, { recursive: true, force: true });
    } catch (switchError) {
      const current = (await projectTreeFingerprint(source)).filter(([name]) => name !== ".storage-migration.json");
      await install(backup, baseline, current);
      await rm(marker);
      throw switchError;
    }
    return;
  }
  try { await renameDirectory(staging, source); }
  catch (error) { await renameDirectory(backup, source); throw error; }
}

export async function migrateProjectStorage(repositoryRoot, projectId, { beforeSwap = null, renameDirectory = rename } = {}) {
  requireProjectDirectoryName(projectId);
  const workspace = path.resolve(repositoryRoot, "workspace");
  const source = path.join(workspace, projectId);
  if (await exists(path.join(source, ".storage-migration.json"))) throw new Error("上次迁移尚未完成，先按标记中的备份路径恢复");
  await requireIdleProject(source);
  if (!await exists(path.join(source, "source")) && !await exists(path.join(source, "inputs")) && !await exists(path.join(source, "tasks"))) throw new Error("项目没有待迁移的旧目录");
  const baseline = await projectTreeFingerprint(source);
  if (baseline.some(([name, kind]) => kind !== "directory" && /^tasks\/(?:lora-training|comparison-experiments)\//.test(name))) throw new Error("检测到当前存量项目之外的旧实验或训练 run；须先离线整理这些成果，迁移未修改项目");
  const suffix = randomUUID();
  const staging = path.join(workspace, `.storage-migration-${projectId}-${suffix}`);
  const backup = path.join(workspace, `.storage-backup-${projectId}-${suffix}`);
  if ([staging, backup].some(target => path.dirname(target) !== workspace)) throw new Error("迁移目录越界");
  let swapped = false;
  try {
    await cp(source, staging, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    if (JSON.stringify(await projectTreeFingerprint(staging)) !== JSON.stringify(baseline)) throw new Error("完整项目副本校验失败");
    await mergeMove(path.join(staging, "source"), path.join(staging, "materials"));
    await mergeMove(path.join(staging, "inputs", "lora-training"), path.join(staging, "lora-training"));
    await mergeMove(path.join(staging, "lora-training", "tasks"), path.join(staging, "lora-training", "plans"));
    const plans = path.join(staging, "lora-training", "plans");
    for (const id of await readdir(plans).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
      const old = path.join(plans, id, "task.json");
      if (await exists(old)) await mergeMove(old, path.join(plans, id, "plan.json"));
    }
    await mergeMove(path.join(staging, "inputs"), path.join(staging, "materials"));
    const candidates = await migrateRenderResults(staging);
    for (const name of ["progress", "locks"]) await mergeMove(path.join(staging, "tasks", "render", name), path.join(staging, "Saved", "render", name));
    await removeEmptyDirectories(path.join(staging, "tasks"));
    await mergeMove(path.join(staging, "cache"), path.join(staging, "Saved", "cache"));
    await removeEmptyDirectories(path.join(staging, "output"));
    const lettering = path.join(staging, "lettering", "dialogue-layouts.json");
    if (await exists(lettering)) {
      const value = await json(lettering);
      if (value.pages?.some(page => page.page_key?.owner_kind === "story" && Object.hasOwn(page.page_key, "owner_id"))) {
        value.pages = value.pages.map(page => ({ ...page, owner_kind: page.page_key.owner_kind, page_key: currentPageKey(page.page_key) }));
        await save(lettering, value);
      }
    }
    const ignoreFile = path.join(staging, ".gitignore");
    const oldIgnore = await readFile(ignoreFile, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
    const retained = oldIgnore.split(/\r?\n/).filter(line => !/^\/(?:inputs|source|materials|lora-training|tasks|candidates|output|cache)\/$/.test(line));
    await writeFile(ignoreFile, retained.join("\n") + "\n" + projectGitignore);
    const attributesFile = path.join(staging, ".gitattributes");
    await writeFile(attributesFile, (await readFile(attributesFile, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error))) + "\n" + projectGitattributes);
    await beforeSwap?.({ source, staging });
    await requireIdleProject(source);
    if (JSON.stringify(await projectTreeFingerprint(source)) !== JSON.stringify(baseline)) throw new Error("迁移期间原项目发生变化，未替换原目录");
    await replaceProjectDirectory(source, staging, backup, renameDirectory);
    swapped = true;
    const report = { project_id: projectId, directory: source, backup_directory: backup, original_files: baseline.filter(([, kind]) => kind !== "directory").length, candidates };
    await save(path.join(workspace, `.storage-migration-${projectId}-${suffix}.json`), report);
    return report;
  } finally {
    if (!swapped && await exists(source) && !await exists(path.join(source, ".storage-migration.json"))) await rm(staging, { recursive: true, force: true });
  }
}
