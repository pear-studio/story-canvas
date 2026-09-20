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
  sha256Pattern,
  assertLoraTrainingRunManifest,
  checkpointDirectoryFromManifest,
} = support;

export async function inventoryCheckpoints(runDirectory, statusValue, checkpointDirectory = null, checkpointRelativePath = null) {
  const outputDirectory = checkpointDirectory ?? path.join(runDirectory, "checkpoints");
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
  const existing = new Map((statusValue.checkpoints ?? []).map((entry) => [entry.file, entry]));
  const checkpoints = [];
  for (const entry of entries) {
    if (runningStatuses.has(statusValue.status)) continue;
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".safetensors") continue;
    const checkpointPath = path.join(outputDirectory, entry.name);
    try { await readSafeTensorsMetadata(checkpointPath, { strict: true }); } catch { continue; }
    const info = await stat(checkpointPath);
    const step = Number(/(?:step|lora-)(\d+)/i.exec(entry.name)?.[1] ?? 0);
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

export async function readRunLossHistory(directory) {
  const logs = await Promise.all(["stdout.log", "stderr.log"].map(name => readFile(path.join(directory, "logs", name), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  })));
  return mergeLossHistory([], logs.join("\n"));
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
    const [manifest, outcome, live, stdout, stderr] = await Promise.all([
      readJson(path.join(directory, "manifest.json"), { optional: true }),
      readJson(path.join(directory, "result.json"), { optional: true }),
      readJson(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "status.json"), { optional: true }),
      readLogTail(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "logs", "stdout.log")),
      readLogTail(path.join(runRoot(projectDirectory, sourceTaskId, entry.name), "logs", "stderr.log")),
    ]);
    const rawStatus = outcome && !runningStatuses.has(outcome.status) ? outcome : live ?? (outcome ? { ...outcome, status: "interrupted", pid: null } : null);
    if (!manifest || !rawStatus) continue;
    assertLoraTrainingRunManifest(manifest, { taskId: sourceTaskId, runId: entry.name });
    const statusValue = { ...rawStatus, checkpoints: await inventoryCheckpoints(directory, rawStatus, checkpointDirectoryFromManifest(manifest, path.join(directory, "checkpoints")), manifest.checkpoints_relative_path ?? null), log_tail: [stdout, stderr].filter(Boolean).join("\n") || rawStatus.log_tail || "" };
    statusValue.loss_history = rawStatus.loss_history ?? await readRunLossHistory(runRoot(projectDirectory, sourceTaskId, entry.name));
    runs.push({
      id: entry.name,
      manifest,
      status: statusValue,
      disk_bytes: await directorySize(directory),
    });
  }
  combined.push(...runs);
  }
  return combined.sort((left, right) => String(right.manifest.created_at).localeCompare(String(left.manifest.created_at), "en"));
}

export function sortTrainingRuns(runs) {
  const time = run => run.status.completed_at ?? run.status.interrupted_at ?? run.manifest.created_at;
  return [...runs].sort((a, b) => Number(runningStatuses.has(b.status.status)) - Number(runningStatuses.has(a.status.status))
    || String(time(b)).localeCompare(String(time(a)), "en") || b.id.localeCompare(a.id, "en"));
}

export async function listAllLoraTrainingRuns(projectDirectory) {
  const runs = [];
  for (const entry of listRegisteredProjects(projectDirectory, "training")) if (entry.available) runs.push(...await listLoraTrainingRuns(projectDirectory, entry.id));
  return { runs: sortTrainingRuns(runs) };
}
