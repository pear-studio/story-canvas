import { createReadStream } from "node:fs";
import path from "node:path";

import {
  isPromptDictionaryScope,
  matchPromptDictionary,
  OVERLAY_CATEGORIES,
  searchPromptDictionaryPage,
} from "./prompt-dictionary.mjs";
import { getSearchPromptDictionary } from "./prompt-dictionary-service.mjs";
import { renderTaskIdPattern } from "./render-task-id.mjs";
import { controlGenerationTask } from "./generation-lifecycle.mjs";
import { generationReference, readGenerationQueue, reorderGenerationQueue } from "./generation-queue.mjs";
import { listWorkspaceRenderHistory, listWorkspaceRenderTasks, readWorkspaceTaskDetail, readWorkspaceTaskResults } from "./render-task-workspace.mjs";
import { dictionaryStatus, readGlobalResources } from "./global-resources.mjs";
import { requireProjectDirectoryName } from "./project-contracts.mjs";
import { loraTrainingModule } from "./lora-training-module.mjs";
import {
  listLocalLoraResources,
  openLoraResourceMedia,
  readLocalLoraResource,
} from "./lora-resources.mjs";
import {
  ApiError,
  configuredPath,
  imageContentType,
  pathExists,
  readJsonBody,
  readOptionalJsonBody,
  sendJson,
} from "./http-support.mjs";

function trackedTaskQuery(searchParams) {
  const byProject = new Map();
  for (const value of searchParams.getAll("tracked")) {
    const separator = value.indexOf("/");
    if (separator < 1) throw new ApiError(400, "invalid_tracked_task");
    const projectId = value.slice(0, separator);
    const taskId = value.slice(separator + 1);
    try { requireProjectDirectoryName(projectId); }
    catch { throw new ApiError(400, "invalid_tracked_task"); }
    if (!renderTaskIdPattern.test(taskId) && !/^[a-z0-9][a-z0-9_-]{0,199}$/.test(taskId)) throw new ApiError(400, "invalid_tracked_task");
    const taskIds = byProject.get(projectId) ?? new Set();
    taskIds.add(taskId);
    byProject.set(projectId, taskIds);
  }
  return byProject;
}

async function loadDictionary(projectRoot, config) {
  return getSearchPromptDictionary(projectRoot, config);
}

export function createDictionaryReader(projectRoot, config) {
  return () => loadDictionary(projectRoot, config);
}

export async function handleRuntimeRequest({
  request,
  response,
  requestUrl,
  decodedPath,
  projectRoot,
  config,
  serverInstanceId,
  serverStartedAt,
  readHardwareStatus,
  comfyEndpointSelector,
  controlComfyRuntime,
  mutateDerivedState,
  generationScheduler = null,
}) {
  if (request.method === "GET" && decodedPath === "/api/health") {
    const dictionary = await dictionaryStatus(projectRoot, config);
    sendJson(response, 200, {
      ok: true,
      service: "story-canvas",
      api_version: 1,
      instance_id: serverInstanceId,
      started_at: serverStartedAt,
      workspaceReady: await pathExists(path.join(projectRoot, "workspace")),
      comfyuiUrl: comfyEndpointSelector?.currentUrl?.() ?? null,
      comfyuiEndpointCount: comfyEndpointSelector?.urls?.().length ?? 0,
      comfyuiRootConfigured: Boolean(configuredPath(projectRoot, config.comfyui_root)),
      modelsRootConfigured: Boolean(configuredPath(projectRoot, config.models_root)),
      dictionary,
    });
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/lora-resources") {
    sendJson(response, 200, await listLocalLoraResources(projectRoot, config));
    return true;
  }
  const loraResourceMediaMatch = /^\/api\/lora-resources\/([^/]+)\/media\/(.+)$/.exec(decodedPath);
  if (request.method === "GET" && loraResourceMediaMatch) {
    const media = await openLoraResourceMedia(projectRoot, loraResourceMediaMatch[1], loraResourceMediaMatch[2]);
    response.writeHead(200, {
      "content-type": imageContentType(media.target),
      "content-length": media.info.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(media.target).pipe(response);
    return true;
  }
  const loraResourceMatch = /^\/api\/lora-resources\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraResourceMatch) {
    sendJson(response, 200, await readLocalLoraResource(projectRoot, config, loraResourceMatch[1]));
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/resources") {
    sendJson(response, 200, await readGlobalResources(projectRoot, config));
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/tasks/history") {
    sendJson(response, 200, await listWorkspaceRenderHistory(projectRoot, { before: requestUrl.searchParams.get("before") }));
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/tasks") {
    sendJson(response, 200, await listWorkspaceRenderTasks(projectRoot, {
      trackedByProject: trackedTaskQuery(requestUrl.searchParams),
    }));
    return true;
  }
  const taskDetailMatch = /^\/api\/tasks\/([^/]+)\/([^/]+)\/?$/.exec(decodedPath);
  const taskResultsMatch = /^\/api\/tasks\/([^/]+)\/([^/]+)\/results\/?$/.exec(decodedPath);
  if (request.method === "GET" && taskResultsMatch) {
    const purpose = requestUrl.searchParams.get("purpose") ?? "candidate";
    if (!["candidate", "comparison", "finished"].includes(purpose)) throw new ApiError(400, "invalid_task_purpose");
    sendJson(response, 200, { images: await readWorkspaceTaskResults(projectRoot, taskResultsMatch[1], taskResultsMatch[2], purpose) });
    return true;
  }
  if (request.method === "GET" && taskDetailMatch) {
    const purpose = requestUrl.searchParams.get("purpose") ?? "candidate";
    if (!["candidate", "comparison", "finished"].includes(purpose)) throw new ApiError(400, "invalid_task_purpose");
    sendJson(response, 200, { task: await readWorkspaceTaskDetail(projectRoot, taskDetailMatch[1], taskDetailMatch[2], purpose) });
    return true;
  }
  const taskControlMatch = /^\/api\/tasks\/([^/]+)\/([^/]+)\/(cancel)\/?$/.exec(decodedPath);
  const taskControlBodyMatch = /^\/api\/tasks\/([^/]+)\/([^/]+)\/control\/?$/.exec(decodedPath);
  if (request.method === "POST" && (taskControlMatch || taskControlBodyMatch)) {
    const projectId = (taskControlMatch ?? taskControlBodyMatch)[1];
    const taskId = (taskControlMatch ?? taskControlBodyMatch)[2];
    const body = taskControlBodyMatch ? await readJsonBody(request) : null;
    const action = taskControlMatch ? taskControlMatch[3] : body?.action;
    const result = body?.purpose === "comparison"
      ? await controlGenerationTask(projectRoot, null, taskId, action, { purpose: "comparison" })
      : await mutateDerivedState(projectId, () => controlGenerationTask(projectRoot, projectId, taskId, action, { generationScheduler, purpose: body?.purpose ?? null }));
    const state = result?.value?.status ?? result?.status;
    // Candidate control returns the render state string, while comparison
    // control returns its storage record (`record.status.status`).  Keep the
    // public task contract flat and never turn a valid comparison state into
    // the misleading queued fallback.
    const status = typeof state === "string"
      ? state
      : typeof state?.status === "string"
        ? state.status
        : typeof state?.status?.status === "string"
          ? state.status.status
          : "queued";
    const controlled = result?.value ?? result;
    const queue = await readGenerationQueue(projectRoot);
    const purpose = controlled.kind;
    const pendingControl = queue.items.find(item => item.project_id === (purpose === "comparison" ? null : projectId) && item.task_id === taskId && item.purpose === purpose)?.pending_control ?? null;
    sendJson(response, 200, { task: { id: taskId, project_id: purpose === "comparison" ? null : projectId, purpose, status, pending_control: pendingControl }, queue_revision: queue.revision });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/tasks/reorder") {
    const value = await readJsonBody(request);
    const requested = value?.items ?? value?.order;
    if (!Array.isArray(requested) || !Number.isSafeInteger(value?.expected_revision)) throw new ApiError(400, "invalid_task_order");
    const currentQueue = await readGenerationQueue(projectRoot);
    const references = requested.map((item) => {
      const existing = currentQueue.items.find((entry) => entry.project_id === item?.project_id
        && entry.purpose === item?.purpose && entry.task_id === item?.task_id);
      if (!existing || item?.created_at !== undefined) throw new ApiError(400, "invalid_task_order");
      return generationReference(existing.project_id, existing.task_id, existing.purpose, existing.created_at);
    });
    const queue = await reorderGenerationQueue(projectRoot, references, { expectedRevision: value.expected_revision });
    sendJson(response, 200, { revision: queue.revision, items: queue.items.map((item) => ({ project_id: item.project_id, task_id: item.task_id, purpose: item.purpose })) });
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/hardware-status") {
    sendJson(response, 200, await readHardwareStatus());
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comfyui/refresh") {
    await comfyEndpointSelector?.refresh?.();
    readHardwareStatus.invalidateComfyUi?.();
    sendJson(response, 200, { hardware: await readHardwareStatus() });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comfyui/select") {
    const value = await readJsonBody(request);
    const result = comfyEndpointSelector?.select?.(value?.url);
    if (!result?.selected) {
      throw new ApiError(result?.reason === "not_found" ? 404 : 409, result?.reason === "not_found" ? "comfyui_endpoint_not_found" : "comfyui_endpoint_unavailable");
    }
    readHardwareStatus.invalidateComfyUi?.();
    sendJson(response, 200, { hardware: await readHardwareStatus() });
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/lora-training/environment") {
    sendJson(response, 200, await loraTrainingModule.plan.environment.read(projectRoot, config, {
      force: requestUrl.searchParams.get("refresh") === "1",
    }));
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/lora-training/recipes") {
    sendJson(response, 200, await loraTrainingModule.plan.recipes.list(projectRoot));
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/lora-training/guides/activation-tags") {
    sendJson(response, 200, await loraTrainingModule.plan.activationGuide());
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comfyui/start") {
    const runtime = await controlComfyRuntime.start();
    await comfyEndpointSelector?.refresh?.();
    readHardwareStatus.invalidateComfyUi?.();
    sendJson(response, 200, { runtime });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comfyui/install") {
    const value = await readOptionalJsonBody(request);
    sendJson(response, 200, { runtime: await controlComfyRuntime.install({ device: value?.device }) });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comfyui/update") {
    await readOptionalJsonBody(request);
    sendJson(response, 200, { runtime: await controlComfyRuntime.update() });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comfyui/stop") {
    const runtime = await controlComfyRuntime.stop();
    await comfyEndpointSelector?.refresh?.();
    readHardwareStatus.invalidateComfyUi?.();
    sendJson(response, 200, { runtime });
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/prompt-dictionary") {
    const scope = requestUrl.searchParams.get("scope");
    const query = requestUrl.searchParams.get("q");
    const limitValue = requestUrl.searchParams.get("limit");
    const offsetValue = requestUrl.searchParams.get("offset");
    const category = requestUrl.searchParams.get("category");
    if (!isPromptDictionaryScope(scope)) throw new ApiError(400, "invalid_prompt_dictionary_scope");
    if (query === null || !query.trim() || query.length > 100) throw new ApiError(400, "invalid_prompt_dictionary_query");
    if (limitValue !== null && (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 50)) {
      throw new ApiError(400, "invalid_prompt_dictionary_limit");
    }
    if (offsetValue !== null && (!/^\d+$/.test(offsetValue) || !Number.isSafeInteger(Number(offsetValue)))) {
      throw new ApiError(400, "invalid_prompt_dictionary_offset");
    }
    if (category !== null && !OVERLAY_CATEGORIES.includes(category)) throw new ApiError(400, "invalid_prompt_dictionary_category");
    const dictionary = await loadDictionary(projectRoot, config);
    const page = searchPromptDictionaryPage(dictionary.entries, query, {
      scope,
      limit: limitValue === null ? 12 : Number(limitValue),
      offset: offsetValue === null ? 0 : Number(offsetValue),
      category,
    });
    sendJson(response, 200, { ...dictionary.status, ...page });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/prompt-dictionary/matches") {
    const value = await readJsonBody(request);
    if (!isPromptDictionaryScope(value?.scope)) throw new ApiError(400, "invalid_prompt_dictionary_scope");
    if (!Array.isArray(value?.prompts)
      || value.prompts.length > 500
      || value.prompts.some((prompt) => typeof prompt !== "string" || prompt.length > 500)) {
      throw new ApiError(400, "invalid_prompt_list");
    }
    const dictionary = await loadDictionary(projectRoot, config);
    sendJson(response, 200, {
      ...dictionary.status,
      matches: dictionary.status.available
        ? matchPromptDictionary(dictionary.entries, value.prompts, { scope: value.scope })
        : [],
    });
    return true;
  }
  return false;
}
