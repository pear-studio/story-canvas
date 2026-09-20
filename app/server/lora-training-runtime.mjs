import { listRegisteredProjects } from "./project-registry.mjs";
import { execFile, spawn } from "node:child_process";
import { mkdir, lstat, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseLoraTrainingLine } from "../shared/lora-loss.mjs";
export { parseLoraTrainingLine } from "../shared/lora-loss.mjs";
import * as support from "./lora-training-support.mjs";
import { inventoryCheckpoints, readRunLossHistory } from "./lora-training-run-index.mjs";
export { listAllLoraTrainingRuns } from "./lora-training-run-index.mjs";

const {
  LoraTrainingError, idPatterns, runningStatuses,
  isWithin, readJson, writeJsonAtomic,
  runRoot, generatedRunRoot, readLogTail, execFileAsync, assertLoraTrainingRunManifest, checkpointDirectoryFromManifest,
} = support;

const trainingProcesses = new Map();
let trainingAdmission = false;

export function hasActiveLoraTraining() {
  return trainingAdmission || trainingProcesses.size > 0;
}

export async function updateRunStatus(runDirectory, update) {
  const target = path.join(runDirectory, "status.json");
  const current = await readJson(target);
  const next = mergeLoraRunStatus(current, update);
  if (next === current) return current;
  if (["completed", "interrupted", "failed"].includes(next.status)) {
    next.loss_history = await readRunLossHistory(runDirectory);
    const manifest = await readJson(path.join(runDirectory, "manifest.json"), { optional: true });
    if (manifest) {
      const checkpointDirectory = checkpointDirectoryFromManifest(manifest, path.join(runDirectory, "checkpoints"));
      next.checkpoints = await inventoryCheckpoints(runDirectory, next, checkpointDirectory, manifest.checkpoints_relative_path ?? null);
    }
    const archive = path.join(path.resolve(runDirectory, "../../../.."), "Training", path.basename(path.dirname(runDirectory)), path.basename(runDirectory));
    await mkdir(archive, { recursive: true });
    next.log_tail = [await readLogTail(path.join(runDirectory, "logs", "stdout.log")), await readLogTail(path.join(runDirectory, "logs", "stderr.log"))].filter(Boolean).join("\n");
    await writeJsonAtomic(path.join(archive, "result.json"), next);
  }
  await writeJsonAtomic(target, next);
  return next;
}

export function mergeLoraRunStatus(current, update, updatedAt = new Date().toISOString()) {
  if (update?.status === "running" && !["starting", "running"].includes(current?.status)) return current;
  return { ...current, ...update, updated_at: updatedAt };
}

export async function mutateRunDerived(runDirectory, manifest, { projectId = null, mutateDerived = null } = {}, operation) {
  if (mutateDerived && projectId) {
    return mutateDerived(projectId, ({ projectDirectory }) => operation(runRoot(projectDirectory, manifest.task_id, manifest.id)));
  }
  return operation(runDirectory);
}

export function attachLogParser(stream, logFile, runDirectory, manifest, tracker, { projectId = null, mutateDerived = null } = {}) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    writeFile(logFile, text, { flag: "a" }).catch(() => undefined);
    pending += text.replaceAll("\r", "\n");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      tracker.outputTail = `${tracker.outputTail}\n${line}`.slice(-16_384);
      const parsed = parseLoraTrainingLine(line);
      if (parsed.step !== null) tracker.step = Math.max(tracker.step, parsed.step);
      if (parsed.loss !== null && Number.isFinite(parsed.loss)) tracker.loss = parsed.loss;
    }
    const now = Date.now();
    if (!tracker.finished && now - tracker.lastPersisted >= 1500) {
      tracker.lastPersisted = now;
      const elapsed = (now - tracker.startedAt) / 1000;
      const rate = tracker.step > 0 ? elapsed / tracker.step : null;
      const update = { status: "running", step: tracker.step, loss: tracker.loss, eta_seconds: rate ? Math.max(0, Math.round((tracker.maxSteps - tracker.step) * rate)) : null };
      void mutateRunDerived(runDirectory, manifest, { projectId, mutateDerived }, (currentDirectory) => updateRunStatus(currentDirectory, update)).catch(() => undefined);
    }
  });
}

export async function spawnRun(runDirectory, manifest, { projectId = null, mutateDerived = null, background = false } = {}) {
  if (trainingProcesses.size) throw new LoraTrainingError(409, "lora_training_active");
  const child = spawn(manifest.execution.executable, manifest.execution.argv, { cwd: path.dirname(manifest.execution.argv[0]), env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const startedAt = new Date().toISOString();
  const tracker = { step: 0, loss: null, outputTail: "", startedAt: Date.now(), lastPersisted: 0, maxSteps: manifest.config.max_train_steps, finished: false };
  trainingProcesses.set(manifest.id, { child, runDirectory, manifest, projectId, mutateDerived });
  const initialStatus = { status: "running", pid: child.pid, process_started_at: startedAt, error: null, exit_code: null };
  if (background) await mutateRunDerived(runDirectory, manifest, { projectId, mutateDerived }, (currentDirectory) => updateRunStatus(currentDirectory, initialStatus));
  else await updateRunStatus(runDirectory, initialStatus);
  attachLogParser(child.stdout, path.join(runDirectory, "logs", "stdout.log"), runDirectory, manifest, tracker, { projectId, mutateDerived });
  attachLogParser(child.stderr, path.join(runDirectory, "logs", "stderr.log"), runDirectory, manifest, tracker, { projectId, mutateDerived });
  child.once("error", (error) => {
    tracker.finished = true;
    void mutateRunDerived(runDirectory, manifest, { projectId, mutateDerived }, (currentDirectory) => updateRunStatus(currentDirectory, { status: "failed", error: error.message, exit_code: null })).finally(() => {
      if (trainingProcesses.get(manifest.id)?.child === child) trainingProcesses.delete(manifest.id);
    });
  });
  child.once("close", (code, signal) => {
    if (tracker.finished) return;
    tracker.finished = true;
    void (async () => {
      await mutateRunDerived(runDirectory, manifest, { projectId, mutateDerived }, async (currentDirectory) => {
        const current = await readJson(path.join(currentDirectory, "status.json"));
        const stopped = current.status === "stopping";
        const checkpointDirectory = checkpointDirectoryFromManifest(manifest, path.join(currentDirectory, "checkpoints"));
        const checkpoints = await inventoryCheckpoints(currentDirectory, current, checkpointDirectory, manifest.checkpoints_relative_path ?? null);
        await updateRunStatus(currentDirectory, { status: code === 0 && !stopped ? "completed" : stopped ? "interrupted" : "failed", step: tracker.step || current.step || 0, loss: tracker.loss ?? current.loss, eta_seconds: null, exit_code: code, exit_signal: signal, pid: null, checkpoints, completed_at: code === 0 && !stopped ? new Date().toISOString() : null, interrupted_at: stopped ? new Date().toISOString() : null, error: code === 0 || stopped ? null : `训练进程退出，代码 ${code}${signal ? `，信号 ${signal}` : ""}` });
      });
    })().finally(() => {
      if (trainingProcesses.get(manifest.id)?.child === child) trainingProcesses.delete(manifest.id);
    });
  });
  return { id: manifest.id, status: "running", pid: child.pid };
}

/**
 * 运行时的唯一启动 Seam：只消费已通过 manifest 校验的冻结执行说明。
 * 计划冻结阶段已经复制图片、Caption、模型身份和全部训练参数；这里不再读取
 * 当前项目 task 或 dataset。
 */
export async function executeLoraTrainingManifest(projectDirectory, manifest, { projectId = null, mutateDerived = null } = {}) {
  assertLoraTrainingRunManifest(manifest, { taskId: manifest?.task_id, runId: manifest?.id });
  const directory = runRoot(projectDirectory, manifest.task_id, manifest.id);
  if (!(await lstat(directory).catch(() => null))?.isDirectory()) throw new LoraTrainingError(404, "lora_training_run_not_found");
  return spawnRun(directory, manifest, { projectId, mutateDerived });
}

export async function requireRun(projectDirectory, taskId, runId) {
  const directory = generatedRunRoot(projectDirectory, taskId, runId);
  const runtimeDirectory = runRoot(projectDirectory, taskId, runId);
  const info = await lstat(directory).catch(() => null);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new LoraTrainingError(422, "unsafe_lora_training_run_storage");
  if (info) {
    const [projectReal, runReal] = await Promise.all([realpath(projectDirectory), realpath(directory)]);
    if (!isWithin(projectReal, runReal)) throw new LoraTrainingError(422, "unsafe_lora_training_run_storage");
  }
  const [manifest, statusValue] = await Promise.all([readJson(path.join(directory, "manifest.json"), { optional: true }), readJson(path.join(directory, "result.json"), { optional: true })]);
  if (!manifest || !statusValue) throw new LoraTrainingError(404, "lora_training_run_not_found");
  assertLoraTrainingRunManifest(manifest, { taskId, runId });
  const live = await readJson(path.join(runtimeDirectory, "status.json"), { optional: true });
  const status = ["completed", "interrupted", "failed"].includes(statusValue.status) ? statusValue : live ?? { ...statusValue, status: "interrupted", pid: null };
  return { directory, runtimeDirectory, manifest, status };
}

export async function readLoraTrainingRun(projectDirectory, taskId, runId) {
  return requireRun(projectDirectory, taskId, runId);
}

export function execSpecific(executable, args) {
  return execFileAsync(executable, args, { windowsHide: true, timeout: 15_000 }).catch((error) => {
    if (error?.code === 128 || error?.code === "ESRCH") return null;
    throw error;
  });
}

export async function stopLoraTrainingRun(projectDirectory, taskId, runId) {
  const run = await requireRun(projectDirectory, taskId, runId);
  const active = trainingProcesses.get(runId);
  if (!active || active.runDirectory !== run.runtimeDirectory) throw new LoraTrainingError(409, "lora_training_process_not_managed");
  await updateRunStatus(run.runtimeDirectory, { status: "stopping" });
  if (process.platform === "win32") await execSpecific("taskkill.exe", ["/PID", String(active.child.pid), "/T"]);
  else active.child.kill("SIGTERM");
  return { stopping: true, run_id: runId };
}

export async function waitComfyHistory(apiUrl, promptId, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${apiUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const value = await response.json();
      if (value?.[promptId]) return value[promptId];
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new LoraTrainingError(504, "lora_training_comfy_history_timeout");
}

export function historyImages(history) {
  const images = [];
  for (const output of Object.values(history?.outputs ?? {})) for (const image of output?.images ?? []) images.push(image);
  return images;
}

export async function deleteLoraTrainingRun(projectDirectory, taskId, runId) {
  const run = await requireRun(projectDirectory, taskId, runId);
  if (runningStatuses.has(run.status.status) || trainingProcesses.has(runId)) throw new LoraTrainingError(409, "active_lora_training_run");
  await rm(run.directory, { recursive: true, force: false });
  await rm(run.runtimeDirectory, { recursive: true, force: true });
  return { deleted: true, run_id: runId };
}

export async function inspectWindowsProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue; if($p){$p | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress}`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10_000 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}

export async function recoverLoraTrainingRuns(projectRoot, { mutateDerived = null } = {}) {
  const projectDirectory = projectRoot;
  const recovered = [];
  for (const project of listRegisteredProjects(projectRoot, "training").filter(entry => entry.available)) {
    const tasksRoot = path.join(project.path, "Saved", "Training");
    const tasks = await readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
    for (const task of tasks) {
      if (!task.isDirectory() || !idPatterns.task.test(task.name)) continue;
      const runs = await readdir(path.join(tasksRoot, task.name), { withFileTypes: true }).catch(() => []);
      for (const entry of runs) {
        if (!entry.isDirectory() || !idPatterns.run.test(entry.name)) continue;
        const directory = path.join(tasksRoot, task.name, entry.name);
        const statusValue = await readJson(path.join(directory, "status.json"), { optional: true }).catch(() => null);
        if (!runningStatuses.has(statusValue?.status)) continue;
        const manifest = await readJson(path.join(directory, "manifest.json"), { optional: true }).catch(() => null);
        try {
          assertLoraTrainingRunManifest(manifest, { taskId: task.name, runId: entry.name });
        } catch (error) {
          const update = { status: "failed", pid: null, eta_seconds: null, interrupted_at: new Date().toISOString(), error: `run manifest 无效：${error.message}`, recovery: "invalid_manifest" };
          const markInvalid = currentDirectory => writeJsonAtomic(path.join(currentDirectory, "status.json"), mergeLoraRunStatus(statusValue, update));
          await markInvalid(directory);
          recovered.push({ task_id: task.name, run_id: entry.name, verified: false, process_found: false, invalid_manifest: true });
          continue;
        }
        const outcome = await readJson(path.join(generatedRunRoot(projectDirectory, task.name, entry.name), "result.json"), { optional: true });
        if (outcome && !runningStatuses.has(outcome.status)) { await writeJsonAtomic(path.join(directory, "status.json"), outcome); continue; }
        const processInfo = process.platform === "win32" ? await inspectWindowsProcess(statusValue.pid) : null;
        const expectedExecutable = path.resolve(manifest?.execution?.executable ?? "").toLowerCase();
        const command = String(processInfo?.CommandLine ?? "");
        const verified = processInfo && path.resolve(processInfo.ExecutablePath ?? "").toLowerCase() === expectedExecutable && command.includes(entry.name) && command.includes(path.basename(manifest.execution.argv[0]));
        if (verified) await execSpecific("taskkill.exe", ["/PID", String(statusValue.pid), "/T"]);
        const update = { status: verified || !processInfo ? "interrupted" : "failed", pid: null, eta_seconds: null, interrupted_at: new Date().toISOString(), error: processInfo && !verified ? "发现 PID 存活但无法确认训练进程身份，请让 Agent 检查" : null, recovery: verified ? "verified_orphan_terminated" : processInfo ? "identity_unverified" : "process_missing" };
        await updateRunStatus(directory, update);
        recovered.push({ task_id: task.name, run_id: entry.name, verified, process_found: Boolean(processInfo) });
      }
    }
  }
  return recovered;
}

export async function shutdownLoraTrainingProcesses({ mutateDerived = null } = {}) {
  const active = [...trainingProcesses.values()];
  for (const entry of active) {
    const update = { status: "stopping" };
    if (mutateDerived && entry.projectId) {
      await mutateDerived(entry.projectId, ({ projectDirectory }) => updateRunStatus(runRoot(projectDirectory, entry.manifest.task_id, entry.manifest.id), update)).catch(() => undefined);
    } else {
      await updateRunStatus(entry.runDirectory, update).catch(() => undefined);
    }
    if (process.platform === "win32") await execSpecific("taskkill.exe", ["/PID", String(entry.child.pid), "/T"]).catch(() => undefined);
    else entry.child.kill("SIGTERM");
  }
}

export const loraTrainingIdPatterns = idPatterns;


export function createLoraTrainingRuntimeInterface(implementation) {
  return Object.freeze({
    list: implementation.listAllLoraTrainingRuns,
    lifecycle: Object.freeze({
      active: implementation.hasActiveLoraTraining,
      recover: implementation.recoverLoraTrainingRuns,
      shutdown: implementation.shutdownLoraTrainingProcesses,
    }),
    startManifest: implementation.executeLoraTrainingManifest,
    readRun: implementation.readLoraTrainingRun,
    stop: implementation.stopLoraTrainingRun,
    deleteRun: implementation.deleteLoraTrainingRun,
  });
}
