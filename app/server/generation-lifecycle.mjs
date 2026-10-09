import { generationFailureMessage } from './generation-failure.mjs';
import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { requireProjectDirectoryName } from "./project-contracts.mjs";
import { readRenderTaskState, updateRenderTask, listProjectRenderTaskStates } from "./render-task-storage.mjs";
import { renderTaskIdPattern } from "./render-task-id.mjs";
import { readGenerationCandidateRecords } from "./candidate-storage.mjs";
import { failedRenderTaskSnapshot } from "./render-task-state.mjs";
import { cancelComparisonExperiment, failComparisonExperiment, markComparisonExperimentStarted,
  readComparisonExperimentStorage, requeueComparisonExperiment } from "./comparison-experiment-storage.mjs";
import { completeGenerationTask, controlGenerationQueue, enqueueGenerationTask, ensureGenerationQueue,
  generationReference, readGenerationQueue, recoverGenerationQueue, startGenerationQueueDrain } from "./generation-queue.mjs";

async function markRenderTaskProcessFailed(projectDirectory, taskId, message, { now = () => new Date() } = {}) {
  const failedAt = now().toISOString();
  let changed = false;
  try {
    const results = new Map((await readGenerationCandidateRecords(projectDirectory)).filter(record => record.task_id === taskId).map(record => [record.candidate_id, record]));
    await updateRenderTask(projectDirectory, taskId, (current) => {
      for (const item of current.items) {
        const result = results.get(item.candidate_id);
        if (result && item.status !== "discarded") { item.status = "available"; item.generated_at = result.generated_at; }
      }
      const failed = failedRenderTaskSnapshot(current, taskId, message, failedAt);
      if (!failed) return current;
      changed = true;
      return failed;
    });
    return changed;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const active = new Set(["launching", "queued", "running"]);
const terminal = new Set(["completed", "failed", "incomplete", "cancelled"]);
const key = ref => `${ref.project_id}\0${ref.purpose}\0${ref.task_id}`;

async function failTask(projectRoot, taskId, purpose, error) {
  if (purpose === "candidate") return markRenderTaskProcessFailed(projectRoot, taskId, generationFailureMessage(error));
  return failComparisonExperiment(projectRoot, taskId, error);
}

/** 所有执行入口共用一次失败收尾和队列移除；不自动重试执行失败的任务。 */
export async function executeGenerationTask({ projectRoot, taskId, purpose, generationQueue }, run) {
  let failure = null;
  try {
    return await run();
  } catch (error) {
    failure = error;
    try { await failTask(projectRoot, taskId, purpose, error); }
    catch (cleanupError) { error.cleanupErrors = [...(error.cleanupErrors ?? []), cleanupError]; }
    throw error;
  } finally {
    if (generationQueue) {
      try { await completeGenerationTask(generationQueue.repositoryRoot, generationQueue.reference); }
      catch (cleanupError) {
        if (!failure) throw cleanupError;
        failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanupError];
      }
    }
  }
}

export async function submitGenerationTask(repositoryRoot, reference) {
  const projectRoot = reference.purpose === "comparison" ? repositoryRoot : registeredProjectPath(repositoryRoot, reference.project_id);
  try {
    if (reference.purpose === "comparison") await markComparisonExperimentStarted(projectRoot, reference.task_id);
    await enqueueGenerationTask(repositoryRoot, reference);
  } catch (error) {
    await failTask(projectRoot, reference.task_id, reference.purpose, error);
    throw error;
  }
}

/** 取消不补建队列引用，避免把已经结束的任务重新排队。 */
export async function controlGenerationTask(repositoryRoot, projectId, taskId, action, { purpose = null } = {}) {
  if (action !== "cancel") throw Object.assign(new Error("任务只支持取消"), { code: "invalid_task_control", status: 400 });
  if (purpose !== null && !["candidate", "comparison"].includes(purpose)) throw Object.assign(new Error("任务用途无效"), { code: "invalid_task_purpose", status: 400 });
  const projectRoot = purpose === "comparison" ? repositoryRoot : registeredProjectPath(path.resolve(repositoryRoot), projectId);
  const candidate = purpose !== "comparison" && renderTaskIdPattern.test(taskId) ? await readRenderTaskState(projectRoot, taskId) : null;
  const comparison = !candidate && purpose !== "candidate" ? await readComparisonExperimentStorage(projectRoot, taskId) : null;
  if (!candidate && !comparison) throw Object.assign(new Error("任务不存在"), { code: "task_not_found", status: 404 });
  const kind = candidate ? "candidate" : "comparison";
  const current = candidate ?? comparison.status;
  if (!active.has(current.status)) throw Object.assign(new Error("终态任务不能取消"), { code: "task_terminal", status: 409 });
  const reference = generationReference(projectId, taskId, kind, candidate?.created_at ?? comparison.manifest.created_at);
  let queue;
  try { queue = await controlGenerationQueue(repositoryRoot, reference, "cancel"); }
  catch (error) {
    if (error?.code !== "generation_task_not_queued") throw error;
    queue = await readGenerationQueue(repositoryRoot);
  }
  if (!queue.active || key(queue.active) !== key(reference)) {
    if (candidate) await updateRenderTask(projectRoot, taskId, state => {
      if (!active.has(state.status)) return state;
      state.status = "cancelled";
      state.failed_at = null;
      state.completed_at = null;
      for (const item of state.items) if (["queued", "running"].includes(item.status)) item.status = "cancelled";
      return state;
    });
    else await cancelComparisonExperiment(projectRoot, taskId);
    await completeGenerationTask(repositoryRoot, reference);
  }
  return { kind, reference, status: candidate ? await readRenderTaskState(projectRoot, taskId) : await readComparisonExperimentStorage(projectRoot, taskId) };
}

/** 只在启动时重建队列投影；轮询和控制操作都不承担恢复工作。 */
export async function recoverGenerationTasks(repositoryRoot, { apiUrl, drainOptions = {} } = {}) {
  const references = [];
  const entries = listRegisteredProjects(repositoryRoot, "story").filter(entry => entry.available);
  for (const project of entries) {
    const projectRoot = project.path;
    for (const state of await listProjectRenderTaskStates(projectRoot, { scope: "active", strict: true })) {
      if (active.has(state.status)) references.push(generationReference(project.id, state.id, "candidate", state.created_at));
      // 终态写入与目录归档之间可能退出，或归档暂时被 Windows 文件占用阻止。
      else if (terminal.has(state.status)) await updateRenderTask(projectRoot, state.id, () => undefined);
    }
  }
    const directory = path.join(repositoryRoot, "Saved", "comparisons");
    const experiments = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of experiments) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const status = JSON.parse(await readFile(path.join(directory, entry.name, "status.json"), "utf8"));
      if (active.has(status.status) && status.started_at) references.push(generationReference(null, entry.name, "comparison", status.created_at ?? status.started_at));
    }
  await ensureGenerationQueue(repositoryRoot, references);
  const queue = await recoverGenerationQueue(repositoryRoot);
  // 重启不取消已经发给 ComfyUI 的请求；等待其自然结束后再提交。
  void startGenerationQueueDrain(repositoryRoot, apiUrl, drainOptions).catch(error => console.error("生成队列恢复失败", error));
  const queued = queue.items.filter(item => !queue.active || key(item) !== key(queue.active));
  for (const item of queued) {
    const projectRoot = item.purpose === "comparison" ? repositoryRoot : registeredProjectPath(repositoryRoot, item.project_id);
    try {
      if (item.pending_control === "cancel") {
        await controlGenerationTask(repositoryRoot, item.project_id, item.task_id, "cancel", { purpose: item.purpose });
      } else if (item.purpose === "candidate") {
        const record = await updateRenderTask(projectRoot, item.task_id, state => {
          if (state.status === "running") {
            state.status = "queued";
            state.started_at = null;
            for (const output of state.items) if (output.status === "running") output.status = "queued";
          }
          return state;
        });
        // ensure 保留了原 active 引用；死租约释放后，终态不能再次交给执行器。
        if (terminal.has(record.state.status)) await completeGenerationTask(repositoryRoot, item);
      } else {
        const record = await requeueComparisonExperiment(projectRoot, item.task_id);
        if (terminal.has(record.status.status)) await completeGenerationTask(repositoryRoot, item);
      }
    } catch (error) {
      try { await failTask(projectRoot, item.task_id, item.purpose, error); }
      finally { await completeGenerationTask(repositoryRoot, item); }
    }
  }
}
