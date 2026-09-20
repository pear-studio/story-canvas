import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import path from "node:path";

import { runComparisonExperiment } from "./comparison-experiment-runtime.mjs";
import { generationReference, readGenerationQueue, waitForGenerationQueueDrain } from "./generation-queue.mjs";
import { runPersistedRenderTask } from "./render-project-runtime.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";

function projectPath(repositoryRoot, projectId) {
  return registeredProjectPath(path.resolve(repositoryRoot), projectId);
}

/**
 * Owns the in-process worker registry. Startup and new submissions
 * all enter through this registry; the queue file remains the only ordering
 * authority rather than a second scheduler implementation.
 */
export function createGenerationScheduler({
  repositoryRoot,
  config = {},
  comparisonAdapterFactory = null,
  getComfyUiUrl = () => primaryComfyUiUrl(config),
  // The runners are injectable only so scheduler behavior can be tested
  // without a ComfyUI process; the production defaults remain the two
  // existing domain runtimes.
  runCandidate = runPersistedRenderTask,
  runComparison = runComparisonExperiment,
} = {}) {
  const workers = new Map();
  let closed = false;
  function key(item) { return `${item.project_id}\0${item.purpose}\0${item.task_id}`; }
  function isActiveItem(queue, item) {
    return queue.active
      && queue.active.project_id === item.project_id
      && queue.active.purpose === item.purpose
      && queue.active.task_id === item.task_id;
  }
  function start(item) {
    if (closed) return null;
    const workerKey = key(item);
    if (workers.has(workerKey)) return workers.get(workerKey);
    const projectRoot = item.purpose === "comparison" ? repositoryRoot : projectPath(repositoryRoot, item.project_id);
    const reference = generationReference(item.project_id, item.task_id, item.purpose, item.created_at);
    const worker = (async () => {
      await waitForGenerationQueueDrain(repositoryRoot);
      if (closed) return;
      return item.purpose === "candidate"
        ? runCandidate({ projectRoot, repositoryRoot, taskId: item.task_id, apiUrl: getComfyUiUrl(), generationQueue: { repositoryRoot, reference } })
        : (async () => {
        const apiUrl = getComfyUiUrl();
        return runComparison({
          projectRoot,
          experimentId: item.task_id,
          apiUrl,
          modelsRoot: config.models_root ? path.resolve(repositoryRoot, config.models_root) : undefined,
          adapter: comparisonAdapterFactory?.({ apiUrl }) ?? null,
          generationQueue: { repositoryRoot, reference },
        });
      })();
    })();
    workers.set(workerKey, worker);
    void worker.catch((error) => console.error(`[story-canvas] 任务 ${item.task_id} 执行失败`, error))
      .finally(() => workers.delete(workerKey));
    return worker;
  }
  const api = {
    async startQueued() {
      if (closed) return 0;
      const queue = await readGenerationQueue(repositoryRoot);
      for (const item of queue.items) {
        if (item.status !== "queued" || isActiveItem(queue, item)) continue;
        // An active lease is already being serviced by its owner.  Its item
        // remains queued in the shallow file until the current Unit boundary,
        // so dispatching it here would create a duplicate worker after a
        // second server starts.
        start(item);
      }
      return queue.items.length;
    },
    async startReference(reference) {
      const queue = await readGenerationQueue(repositoryRoot);
      const item = queue.items.find((entry) => entry.project_id === reference.project_id
        && entry.purpose === reference.purpose && entry.task_id === reference.task_id);
      if (!item || item.status !== "queued" || isActiveItem(queue, item)) return null;
      start(item);
      return true;
    },
    start,
    size: () => workers.size,
    close() {
      closed = true;
    },
  };
  return api;
}
