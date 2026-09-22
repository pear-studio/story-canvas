import { listRegisteredProjects } from "./project-registry.mjs";
import { readSafeTensorsMetadata } from "./safetensors-metadata.mjs";
import { readdir, stat, readFile } from "node:fs/promises";
import { mergeLossHistory } from "../shared/lora-loss.mjs";
import path from "node:path";

import * as support from "./lora-training-support.mjs";

const {
  idPatterns, runningStatuses, runRoot,
  createId,
  readJson,
  readLogTail,
  sha256File,
  validateLoraTrainingRunManifest,
  checkpointDirectoryFromManifest,
} = support;

// v4（Anima）历史 run 的只读展示标记：基本信息保留，不能精确续训。
export const legacyRunNote = "Anima 历史记录，不支持精确续训";

export async function inventoryCheckpoints(runDirectory, statusValue, checkpointDirectory = null, checkpointRelativePath = null, { includeRunning = false } = {}) {
  const outputDirectory = checkpointDirectory ?? path.join(runDirectory, "checkpoints");
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
  const existing = new Map((statusValue.checkpoints ?? []).map((entry) => [entry.file, entry]));
  const checkpoints = [];
  for (const entry of entries) {
    // runner 以临时文件 + rename 发布 checkpoint，运行中也可以安全盘点。
    if (!includeRunning && runningStatuses.has(statusValue.status)) continue;
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".safetensors") continue;
    const checkpointPath = path.join(outputDirectory, entry.name);
    try { await readSafeTensorsMetadata(checkpointPath, { strict: true }); } catch { continue; }
    const info = await stat(checkpointPath);
    const step = Number(/(?:step-?|lora-)(\d+)/i.exec(entry.name)?.[1] ?? 0);
    const previous = existing.get(entry.name);
    const hash = await sha256File(checkpointPath);
    if (previous) {
      checkpoints.push({ ...previous, available: previous.sha256 === hash && previous.size === info.size });
      continue;
    }
    checkpoints.push({
      available: true,
      id: previous?.id ?? createId("checkpoint"),
      file: entry.name,
      step,
      sha256: hash,
      size: info.size,
      ...(checkpointRelativePath ? { relative_path: path.posix.join(checkpointRelativePath, entry.name) } : previous?.relative_path ? { relative_path: previous.relative_path } : {}),
    });
  }
  for (const previous of existing.values()) if (!checkpoints.some(entry => entry.file === previous.file)) checkpoints.push({ ...previous, available: false });
  return checkpoints.sort((left, right) => left.step - right.step || left.file.localeCompare(right.file, "en"));
}

async function directorySize(directory) {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

// runner 输出的有版本 JSONL 事件；无法解析的行静默跳过，不让坏行拖垮列表。
export function parseLoraRunEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value?.v !== 1 || typeof value.event !== "string") continue;
    events.push(value);
  }
  return events;
}

export function lossHistoryFromEvents(events) {
  const points = new Map();
  for (const event of events) {
    if (event.event !== "optimizer_step" || !Number.isInteger(event.step) || event.step < 1 || !Number.isFinite(event.loss)) continue;
    points.set(event.step, event.loss);
  }
  return [...points].sort(([a], [b]) => a - b).map(([step, loss]) => ({ step, loss }));
}

export async function readRunLossHistory(directory) {
  const eventsText = await readFile(path.join(directory, "events.jsonl"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (eventsText !== null) return lossHistoryFromEvents(parseLoraRunEvents(eventsText));
  // v4 历史 run：进度只存在于 tqdm 日志。
  const logs = await Promise.all(["stdout.log", "stderr.log"].map(name => readFile(path.join(directory, "logs", name), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  })));
  return mergeLossHistory([], logs.join("\n"));
}

async function readRunResumePointer(archiveDirectory) {
  const pointer = await readJson(path.join(archiveDirectory, "resume", "latest.json"), { optional: true }).catch(() => null);
  if (!pointer || typeof pointer.snapshot_id !== "string") return null;
  const statePath = path.join(archiveDirectory, "resume", pointer.snapshot_id, "state.json");
  if (!/^step-\d{6,}$/.test(pointer.snapshot_id) || await sha256File(statePath).catch(() => null) !== pointer.sha256) return null;
  return { snapshot_id: pointer.snapshot_id, step: Number.isInteger(pointer.step) ? pointer.step : null, sha256: typeof pointer.sha256 === "string" ? pointer.sha256 : null };
}

export async function listLoraTrainingRuns(projectDirectory, taskId) {
  const project = support.trainingRecordProjectRoot(projectDirectory, taskId);
  const ids = taskId.startsWith("dataset-") ? (await readdir(path.join(project, "Training")).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).filter(id => idPatterns.task.test(id)) : [taskId];
  const roots = ids.map(id => ({ id, root: path.join(project, "Training", id) }));
  const combined = [];
  for (const { id: sourceTaskId, root } of roots) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPatterns.run.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const [manifest, outcome, live, consoleLog, stdout, stderr] = await Promise.all([
      readJson(path.join(directory, "manifest.json"), { optional: true }).catch(() => null),
      readJson(path.join(directory, "result.json"), { optional: true }).catch(() => null),
      readJson(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "status.json"), { optional: true }).catch(() => null),
      readLogTail(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "console.log")),
      readLogTail(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "logs", "stdout.log")),
      readLogTail(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "logs", "stderr.log")),
    ]);
    const rawStatus = outcome && !runningStatuses.has(outcome.status) ? outcome : live ?? (outcome ? { ...outcome, status: "interrupted", pid: null } : null);
    if (!manifest && !rawStatus) continue;
    // v4 历史或无法解析的清单进入只读 legacy 分支，不影响整表。
    const valid = manifest && validateLoraTrainingRunManifest(manifest).length === 0 && manifest.task_id === sourceTaskId && manifest.id === entry.name;
    const runtimeDirectory = runRoot(projectDirectory, sourceTaskId, entry.name);
    const statusValue = { ...rawStatus, log_tail: [consoleLog, stdout, stderr].filter(Boolean).join("\n") || rawStatus?.log_tail || "" };
    statusValue.loss_history = rawStatus?.loss_history ?? await readRunLossHistory(runtimeDirectory);
    if (valid) {
      statusValue.checkpoints = await inventoryCheckpoints(directory, rawStatus, checkpointDirectoryFromManifest(manifest, path.join(directory, "checkpoints")), manifest.paths?.checkpoints_relative_path ?? null);
      statusValue.resume = await readRunResumePointer(directory);
    }
    runs.push({
      id: entry.name,
      manifest,
      created_at: manifest?.created_at ?? rawStatus?.updated_at ?? "",
      status: statusValue,
      disk_bytes: await directorySize(directory),
      ...(valid ? { resumable: Boolean(statusValue.resume) } : { legacy: true, resumable: false, legacy_note: legacyRunNote }),
    });
  }
  combined.push(...runs);
  }
  return combined.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at), "en"));
}

export function sortTrainingRuns(runs) {
  const time = run => run.status.completed_at ?? run.status.interrupted_at ?? run.created_at ?? run.manifest?.created_at ?? "";
  return [...runs].sort((a, b) => Number(runningStatuses.has(b.status.status)) - Number(runningStatuses.has(a.status.status))
    || String(time(b)).localeCompare(String(time(a)), "en") || b.id.localeCompare(a.id, "en"));
}

export async function listAllLoraTrainingRuns(projectDirectory) {
  const runs = [];
  for (const entry of listRegisteredProjects(projectDirectory, "training")) if (entry.available) runs.push(...await listLoraTrainingRuns(projectDirectory, entry.id));
  return { runs: sortTrainingRuns(runs) };
}
