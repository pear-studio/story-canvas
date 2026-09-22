import { listRegisteredProjects } from "./project-registry.mjs";
import { spawn } from "node:child_process";
import { copyFile, mkdir, lstat, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as support from "./lora-training-support.mjs";
import { inventoryCheckpoints, readRunLossHistory, parseLoraRunEvents } from "./lora-training-run-index.mjs";
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

// 优雅停止的默认等待：runner 在下一个完整更新边界保存恢复包，可能耗时数十秒。
const defaultGracefulStopTimeoutMs = 120_000;
const snapshotIdPattern = /^step-\d{6,}$/;

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
      next.checkpoints = await inventoryCheckpoints(runDirectory, next, checkpointDirectory, manifest.paths?.checkpoints_relative_path ?? manifest.checkpoints_relative_path ?? null);
      next.log_tail = await readLogTail(manifest.paths?.log_file ?? path.join(runDirectory, "console.log"));
      const archive = manifest.paths?.archive_dir ?? path.join(path.resolve(runDirectory, "../../../.."), "Training", path.basename(path.dirname(runDirectory)), path.basename(runDirectory));
      await mkdir(archive, { recursive: true });
      await writeJsonAtomic(path.join(archive, "result.json"), next);
    }
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

// 上游 stdout/stderr 原样进 console.log；结构化进度只来自 events.jsonl。
export function attachLogTee(stream, logFile, tracker) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    writeFile(logFile, text, { flag: "a" }).catch(() => undefined);
    tracker.outputTail = `${tracker.outputTail}\n${text}`.slice(-16_384);
  });
}

export async function pollRunEvents(entry) {
  if (entry.pollPromise) return entry.pollPromise;
  entry.pollPromise = drainRunEvents(entry);
  try { await entry.pollPromise; } finally { entry.pollPromise = null; }
}

async function drainRunEvents(entry) {
  const file = entry.manifest.paths.events_file;
  const info = await stat(file).catch(() => null);
  if (!info || info.size <= entry.eventsOffset) return;
  const handle = await open(file, "r");
  let text;
  try {
    const buffer = Buffer.alloc(info.size - entry.eventsOffset);
    await handle.read(buffer, 0, buffer.length, entry.eventsOffset);
    entry.eventsOffset = info.size;
    text = entry.pendingEventsLine + buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  entry.pendingEventsLine = lines.pop() ?? "";
  for (const line of lines) for (const event of parseLoraRunEvents(line)) await applyRunEvent(entry, event);
}

async function applyRunEvent(entry, event) {
  const tracker = entry.tracker;
  switch (event.event) {
    case "phase":
      if (typeof event.phase === "string") {
        tracker.phase = event.phase;
        if (event.status === "begin") tracker.phaseStartedAt = Date.now();
        if (event.status === "end" && tracker.phaseStartedAt) tracker.phaseDurations[event.phase] = (tracker.phaseDurations[event.phase] ?? 0) + (Date.now() - tracker.phaseStartedAt) / 1000;
      }
      break;
    case "cache_progress":
      if (Number.isInteger(event.done) && Number.isInteger(event.total)) tracker.cacheProgress = { done: event.done, total: event.total };
      break;
    case "optimizer_step":
      if (Number.isInteger(event.step)) tracker.step = Math.max(tracker.step, event.step);
      if (Number.isInteger(event.target)) tracker.target = event.target;
      if (Number.isFinite(event.loss)) tracker.loss = event.loss;
      if (Number.isFinite(event.lr)) tracker.lr = event.lr;
      if (Number.isInteger(event.samples_seen)) tracker.samplesSeen = event.samples_seen;
      if (Number.isFinite(event.seconds) && event.seconds > 0) tracker.secondsPerStep = event.seconds;
      break;
    case "checkpoint":
      tracker.checkpointsDirty = true;
      break;
    case "resume_saved":
      if (typeof event.snapshot_id === "string") {
        tracker.resume = { snapshot_id: event.snapshot_id, step: event.step ?? null, sha256: event.sha256 ?? null };
        await cleanupSupersededResumeSnapshots(entry, event.snapshot_id).catch(() => undefined);
      }
      break;
    case "end":
      tracker.endStatus = event.status === "stopped" ? "stopped" : "completed";
      if (event.performance && typeof event.performance === "object") {
        tracker.runnerPerformance = event.performance;
        tracker.phasePerformance[event.phase ?? entry.phase] = event.performance;
      }
      break;
    case "error":
      tracker.error = typeof event.message === "string" ? event.message : "训练 runner 报告错误";
      break;
  }
}

/**
 * 新恢复包发布后清理被取代的旧包：同 run 的上一份与续训父 run 的来源包。
 * 只删除系统登记快照（目录名 step-NNNNNN 且含 state.json），并校验绝对路径
 * 位于训练项目 Training 目录内；runner 自身永不删除旧包。
 */
export async function cleanupSupersededResumeSnapshots(entry, publishedSnapshotId) {
  const { manifest } = entry;
  // 轮询可能一次读到多个历史保存事件。只能按磁盘上真正最新的完整包清理。
  const current = await readJson(path.join(manifest.paths.resume_dir, "latest.json"), { optional: true });
  if (current?.snapshot_id !== publishedSnapshotId) return [];
  const publishedState = path.join(manifest.paths.resume_dir, publishedSnapshotId, "state.json");
  if (await support.sha256File(publishedState).catch(() => null) !== current.sha256) return [];
  const trainingRoot = path.dirname(path.dirname(path.resolve(manifest.paths.archive_dir)));
  const removeSnapshot = async (directory) => {
    const resolved = path.resolve(directory);
    if (!snapshotIdPattern.test(path.basename(resolved)) || !isWithin(trainingRoot, resolved)) return false;
    const resolvedReal = await realpath(resolved).catch(() => null);
    if (!resolvedReal || !isWithin(await realpath(trainingRoot), resolvedReal)) return false;
    if (!await readJson(path.join(resolved, "state.json"), { optional: true }).catch(() => null)) return false;
    await rm(resolved, { recursive: true, force: true });
    return true;
  };
  const removed = [];
  const entries = await readdir(manifest.paths.resume_dir, { withFileTypes: true }).catch(() => []);
  for (const item of entries) {
    if (!item.isDirectory() || !snapshotIdPattern.test(item.name) || Number(item.name.slice(5)) >= current.step) continue;
    if (await removeSnapshot(path.join(manifest.paths.resume_dir, item.name))) removed.push(item.name);
  }
  const taskRoot = path.dirname(manifest.paths.archive_dir);
  for (const sibling of await readdir(taskRoot, { withFileTypes: true })) {
    if (!sibling.isDirectory() || !idPatterns.run.test(sibling.name) || sibling.name === manifest.id) continue;
    const siblingArchive = path.join(taskRoot, sibling.name);
    const oldManifest = await readJson(path.join(siblingArchive, "manifest.json"), { optional: true });
    if (sibling.name !== manifest.resume?.parent_run_id && (!oldManifest || oldManifest.task_id !== manifest.task_id || oldManifest.created_at > manifest.created_at)) continue;
    const oldResume = path.join(siblingArchive, "resume");
    for (const snapshot of await readdir(oldResume, { withFileTypes: true }).catch(() => [])) {
      if (snapshot.isDirectory() && await removeSnapshot(path.join(oldResume, snapshot.name))) removed.push(`${sibling.name}/${snapshot.name}`);
    }
    await rm(path.join(oldResume, "latest.json"), { force: true });
  }
  return removed;
}

function statusUpdateFromTracker(tracker) {
  const eta = tracker.target > tracker.step && tracker.secondsPerStep ? Math.max(0, Math.round((tracker.target - tracker.step) * tracker.secondsPerStep)) : null;
  return {
    status: "running",
    phase: tracker.phase,
    step: tracker.step,
    loss: tracker.loss,
    lr: tracker.lr,
    samples_seen: tracker.samplesSeen,
    cache_progress: tracker.cacheProgress,
    resume: tracker.resume,
    eta_seconds: eta,
  };
}

async function persistEntryStatus(entry, update) {
  await mutateRunDerived(entry.runDirectory, entry.manifest, entry, (currentDirectory) => updateRunStatus(currentDirectory, update));
}

function schedulePersist(entry) {
  const tracker = entry.tracker;
  const now = Date.now();
  if (tracker.finished || now - tracker.lastPersisted < 1500) return;
  tracker.lastPersisted = now;
  void (async () => {
    const update = statusUpdateFromTracker(tracker);
    if (tracker.checkpointsDirty) {
      tracker.checkpointsDirty = false;
      const checkpointDirectory = checkpointDirectoryFromTracker(entry);
      update.checkpoints = await inventoryCheckpoints(entry.runDirectory, await readJson(path.join(entry.runDirectory, "status.json")), checkpointDirectory, entry.manifest.paths?.checkpoints_relative_path ?? null, { includeRunning: true });
    }
    await persistEntryStatus(entry, update);
  })().catch(() => undefined);
}

function checkpointDirectoryFromTracker(entry) {
  return checkpointDirectoryFromManifest(entry.manifest, path.join(entry.runDirectory, "checkpoints"));
}

function spawnPhase(entry, phase) {
  const { manifest } = entry;
  const argv = [...manifest.execution.argv, "--phase", phase];
  const child = spawn(manifest.execution.executable, argv, { cwd: path.dirname(manifest.execution.argv[0]), env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  entry.child = child;
  entry.phase = phase;
  attachLogTee(child.stdout, manifest.paths.log_file, entry.tracker);
  attachLogTee(child.stderr, manifest.paths.log_file, entry.tracker);
  child.once("error", (error) => {
    void finalizeRun(entry, null, null, error.message).finally(() => releaseEntry(entry, child));
  });
  child.once("close", (code, signal) => {
    void onPhaseClose(entry, phase, code, signal).finally(() => {
      if (trainingProcesses.get(entry.manifest.id)?.child === child) releaseEntry(entry, child);
    });
  });
}

function releaseEntry(entry, child) {
  if (entry.stopTimer) clearTimeout(entry.stopTimer);
  if (entry.eventsTimer) clearInterval(entry.eventsTimer);
  if (trainingProcesses.get(entry.manifest.id)?.child === child) trainingProcesses.delete(entry.manifest.id);
}

async function onPhaseClose(entry, phase, code, signal) {
  await pollRunEvents(entry).catch(() => undefined);
  const tracker = entry.tracker;
  // cache 阶段成功退出后启动仅 DiT 的训练进程。
  if (phase === "cache" && code === 0 && !tracker.finished && tracker.endStatus !== "stopped" && tracker.error === null) {
    const current = await readJson(path.join(entry.runDirectory, "status.json")).catch(() => null);
    if (current?.status === "stopping") {
      await finalizeRun(entry, code, signal);
      return;
    }
    spawnPhase(entry, "train");
    await persistEntryStatus(entry, { ...statusUpdateFromTracker(tracker), status: "running", phase: "train", pid: entry.child.pid, process_started_at: new Date().toISOString() }).catch(() => undefined);
    return;
  }
  await finalizeRun(entry, code, signal);
}

async function finalizeRun(entry, code, signal, spawnError = null) {
  const tracker = entry.tracker;
  if (tracker.finished) return;
  tracker.finished = true;
  await pollRunEvents(entry).catch(() => undefined);
  const current = await readJson(path.join(entry.runDirectory, "status.json")).catch(() => null);
  const stopped = current?.status === "stopping" || tracker.endStatus === "stopped";
  const status = spawnError ? "failed" : code === 0 && !stopped && entry.phase === "train" ? "completed" : stopped ? "interrupted" : "failed";
  const finishedAt = new Date().toISOString();
  const performance = {
    wall_seconds: Math.round((Date.now() - entry.startedAt) / 100) / 10,
    phase_seconds: Object.fromEntries(Object.entries(tracker.phaseDurations).map(([key, value]) => [key, Math.round(value * 10) / 10])),
    seconds_per_update: tracker.secondsPerStep ?? null,
    samples_seen: tracker.samplesSeen,
    runner: tracker.runnerPerformance ?? null,
    phases: tracker.phasePerformance,
  };
  for (const file of ["events.jsonl", "console.log"]) await copyFile(path.join(entry.runDirectory, file), path.join(entry.manifest.paths.archive_dir, file)).catch(() => undefined);
  await persistEntryStatus(entry, {
    status,
    step: tracker.step || current?.step || 0,
    loss: tracker.loss ?? current?.loss ?? null,
    lr: tracker.lr ?? current?.lr ?? null,
    samples_seen: tracker.samplesSeen || current?.samples_seen || 0,
    cache_progress: tracker.cacheProgress ?? current?.cache_progress ?? null,
    resume: tracker.resume ?? current?.resume ?? null,
    eta_seconds: null,
    exit_code: code,
    exit_signal: signal,
    pid: null,
    performance,
    completed_at: status === "completed" ? finishedAt : null,
    interrupted_at: status === "interrupted" ? finishedAt : null,
    error: status === "failed" ? (tracker.error ?? spawnError ?? `训练进程退出，代码 ${code}${signal ? `，信号 ${signal}` : ""}`) : null,
  }).catch(() => undefined);
}

/**
 * 运行时的唯一启动 Seam：只消费已通过 manifest 校验的冻结执行说明。
 * 计划冻结阶段已经复制图片、Caption、模型身份和全部训练参数；这里不再读取
 * 当前项目 task 或 dataset。两阶段执行：先 spawn --phase cache，成功退出后再
 * spawn --phase train。
 */
export async function executeLoraTrainingManifest(projectDirectory, manifest, { projectId = null, mutateDerived = null } = {}) {
  assertLoraTrainingRunManifest(manifest, { taskId: manifest?.task_id, runId: manifest?.id });
  const directory = runRoot(projectDirectory, manifest.task_id, manifest.id);
  if (!(await lstat(directory).catch(() => null))?.isDirectory()) throw new LoraTrainingError(404, "lora_training_run_not_found");
  if (trainingProcesses.size) throw new LoraTrainingError(409, "lora_training_active");
  const entry = {
    runDirectory: directory,
    manifest,
    projectId,
    mutateDerived,
    child: null,
    phase: null,
    startedAt: Date.now(),
    eventsOffset: 0,
    pendingEventsLine: "",
    eventsTimer: null,
    stopTimer: null,
    tracker: {
      step: 0, loss: null, lr: null, samplesSeen: 0, target: manifest.run.max_train_steps,
      phase: null, phaseStartedAt: null, phaseDurations: {}, cacheProgress: null,
      resume: null, error: null, endStatus: null, runnerPerformance: null, phasePerformance: {},
      secondsPerStep: null, outputTail: "", lastPersisted: 0, finished: false, checkpointsDirty: false,
    },
  };
  trainingProcesses.set(manifest.id, entry);
  entry.eventsTimer = setInterval(() => {
    void pollRunEvents(entry).then(() => schedulePersist(entry)).catch(() => undefined);
  }, 1000);
  entry.eventsTimer.unref?.();
  try {
    spawnPhase(entry, "cache");
  } catch (error) {
    trainingProcesses.delete(manifest.id);
    throw error;
  }
  await persistEntryStatus(entry, { status: "running", phase: "cache", pid: entry.child.pid, process_started_at: new Date(entry.startedAt).toISOString(), error: null, exit_code: null });
  return { id: manifest.id, status: "running", pid: entry.child.pid };
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
  // v4（Anima）历史 run 只读展示：基本信息保留，明确标记不支持精确续训。
  let legacy = null;
  try {
    assertLoraTrainingRunManifest(manifest, { taskId, runId });
  } catch {
    legacy = { family: typeof manifest?.family === "string" ? manifest.family : "anima", resumable: false, note: "Anima 历史记录，不支持精确续训" };
  }
  const live = await readJson(path.join(runtimeDirectory, "status.json"), { optional: true });
  const status = ["completed", "interrupted", "failed"].includes(statusValue.status) ? statusValue : live ?? { ...statusValue, status: "interrupted", pid: null };
  return { directory, runtimeDirectory, manifest, status, ...(legacy ? { legacy } : {}) };
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

function forceKillEntry(entry) {
  if (!entry.child) return;
  if (process.platform === "win32") void execSpecific("taskkill.exe", ["/PID", String(entry.child.pid), "/T"]).catch(() => undefined);
  else entry.child.kill("SIGTERM");
}

// 停止只写控制请求；runner 在下一完整更新边界保存后退出，超时才强制终止。
export async function stopLoraTrainingRun(projectDirectory, taskId, runId, { gracefulTimeoutMs = defaultGracefulStopTimeoutMs } = {}) {
  const run = await requireRun(projectDirectory, taskId, runId);
  const active = trainingProcesses.get(runId);
  if (!active || active.runDirectory !== run.runtimeDirectory) throw new LoraTrainingError(409, "lora_training_process_not_managed");
  const controlDir = active.manifest.paths?.control_dir ?? path.join(run.runtimeDirectory, "control");
  await mkdir(controlDir, { recursive: true });
  await writeJsonAtomic(path.join(controlDir, "stop.json"), { version: 1, requested_at: new Date().toISOString() });
  await updateRunStatus(run.runtimeDirectory, { status: "stopping" });
  if (active.stopTimer) clearTimeout(active.stopTimer);
  active.stopTimer = setTimeout(() => forceKillEntry(active), gracefulTimeoutMs);
  active.stopTimer.unref?.();
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
        // v4（Anima）历史 run 没有可恢复语义，直接标中断，不尝试接管。
        if (manifest && manifest.version !== 5) {
          const update = { status: "interrupted", pid: null, eta_seconds: null, interrupted_at: new Date().toISOString(), error: null, recovery: "legacy_manifest" };
          await writeJsonAtomic(path.join(directory, "status.json"), mergeLoraRunStatus(statusValue, update));
          recovered.push({ task_id: task.name, run_id: entry.name, verified: false, process_found: false, legacy_manifest: true });
          continue;
        }
        try {
          assertLoraTrainingRunManifest(manifest, { taskId: task.name, runId: entry.name });
        } catch (error) {
          const update = { status: "failed", pid: null, eta_seconds: null, interrupted_at: new Date().toISOString(), error: `run manifest 无效：${error.message}`, recovery: "invalid_manifest" };
          await writeJsonAtomic(path.join(directory, "status.json"), mergeLoraRunStatus(statusValue, update));
          recovered.push({ task_id: task.name, run_id: entry.name, verified: false, process_found: false, invalid_manifest: true });
          continue;
        }
        const outcome = await readJson(path.join(generatedRunRoot(projectDirectory, task.name, entry.name), "result.json"), { optional: true });
        if (outcome && !runningStatuses.has(outcome.status)) { await writeJsonAtomic(path.join(directory, "status.json"), outcome); continue; }
        const processInfo = process.platform === "win32" ? await inspectWindowsProcess(statusValue.pid) : null;
        // cache/train 两阶段是同一 executable 与 manifest 路径的先后两个进程，身份核对方式相同。
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
    const controlDir = entry.manifest.paths?.control_dir;
    if (controlDir) await writeJsonAtomic(path.join(controlDir, "stop.json"), { version: 1, requested_at: new Date().toISOString() }).catch(() => undefined);
    forceKillEntry(entry);
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
