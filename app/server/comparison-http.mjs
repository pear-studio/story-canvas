import { importComparisonPage, createBlankComparisonInput } from "./comparison-inputs.mjs";
import { readdir } from "node:fs/promises";
import { collectComparisonResults, diffComparisonInputs, exportComparisonSheet } from "./comparison-review.mjs";
import path from "node:path";

import { resolveLocalComfyTarget } from "./comfy-runtime.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";
import { prepareComparisonExperimentExecution } from "./comparison-execution-plan.mjs";
import { createComparisonExperiment } from "./comparison-experiment.mjs";
import {
  createComparisonExperimentStorage,
  listComparisonExperimentViews,
  withComparisonOperation, deleteComparisonExperiment,
  readComparisonExperimentStorage,
  readComparisonExperimentView,
  retryComparisonExperiment,
} from "./comparison-experiment-storage.mjs";
import {
  readComparisonExperimentResult,
  runComparisonExperiment,
} from "./comparison-experiment-runtime.mjs";
import { generationReference, readGenerationQueue } from "./generation-queue.mjs";
import { submitGenerationTask, controlGenerationTask } from "./generation-lifecycle.mjs";
import { freezeComparisonLoraSources } from "./comparison-lora-identity.mjs";
import { preflightComparisonExperiment } from "./comparison-preflight.mjs";
import { stageComparisonImports, materializeComparisonReferences } from "./comparison-reference-images.mjs";
import {
  ApiError,
  configuredPath,
  readJsonBody,
  sendBuffer, sendJson,
} from "./http-support.mjs";

export function publicComparisonRecord(record) {
  const status = record?.status?.status === "incomplete" ? "failed" : record?.status?.status;
  return {
    id: record.id,
    manifest: record.manifest,
    status: {
      ...record.status,
      status,
      cells: record.status.cells.map((cell) => ({ ...cell, status: cell.status === "incomplete" ? "failed" : cell.status })),
    },
  };
}

/**
 * 处理 comparison experiment 的 HTTP 边界。返回 false 表示当前请求不属于该边界。
 */
export async function handleComparisonRequest({
  request,
  response,
  decodedPath,
  projectRoot,
  config,
  readFacts,
  activeComparisonProcesses,
  comparisonAdapterFactory,
  generationScheduler = null,
}) {
  if (!decodedPath.startsWith("/api/comparison-experiments")) return false;
  const importPages = async body => {
    if (typeof body?.project_id !== "string" || !Array.isArray(body.page_keys) || !body.page_keys.length) throw new ApiError(422, "comparison_pages_required");
    const result = await readFacts(body.project_id, async ({ projectDirectory }) => Promise.all(body.page_keys.map(pageKey => importComparisonPage({ repositoryRoot: projectRoot, projectDirectory, projectId: body.project_id, pageKey, localConfig: config, includeReferenceBytes: true }))));
    return stageComparisonImports(projectRoot, result.value);
  };
  if (request.method === "GET" && decodedPath === "/api/comparison-experiments/input-options") {
    const files = await readdir(path.join(projectRoot, "library", "render-profiles"));
    sendJson(response, 200, { profiles: files.filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)) });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comparison-experiments/input-lora") {
    const body = await readJsonBody(request);
    const [entry] = await freezeComparisonLoraSources({ repositoryRoot: projectRoot, config, sources: [body.source] });
    sendJson(response, 200, { lora: { filename: entry.relative_path.slice("loras/".length), relative_path: entry.relative_path,
      sha256: entry.sha256, size_bytes: entry.size_bytes, weight: 1, kind: "comparison", owner: entry.id } });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comparison-experiments/import") {
    const body = await readJsonBody(request);
    sendJson(response, 200, { inputs: await importPages(body) });
    return true;
  }
  if (request.method === "POST" && decodedPath === "/api/comparison-experiments/blank-input") {
    const body = await readJsonBody(request);
    sendJson(response, 200, { input: await createBlankComparisonInput(projectRoot, body.profile_id, body.canvas) });
    return true;
  }
  const deleteMatch = /^\/api\/comparison-experiments\/([^/]+)$/.exec(decodedPath);
  if (request.method === "DELETE" && (deleteMatch || decodedPath === "/api/comparison-experiments")) {
    const body = deleteMatch ? null : await readJsonBody(request);
    const ids = deleteMatch ? [deleteMatch[1]] : body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string")) throw new ApiError(422, "comparison_ids_required");
    const deleted = await withComparisonOperation(projectRoot, async () => {
      const queue = await readGenerationQueue(projectRoot);
      for (const id of ids) {
        if (activeComparisonProcesses.has(`${path.resolve(projectRoot)}:${id}`) || queue.items.some(item => item.purpose === "comparison" && item.task_id === id)) throw new ApiError(409, "comparison_running", ["请先停止实验，等待执行结束后再删除"]);
        const record = await readComparisonExperimentView(projectRoot, id);
        if (record.status.status === "running" || (record.status.status === "queued" && record.status.started_at)) throw new ApiError(409, "comparison_running");
      }
      for (const id of ids) await deleteComparisonExperiment(projectRoot, id);
      return ids;
    });
    sendJson(response, 200, { deleted });
    return true;
  }
  const cancelMatch = /^\/api\/comparison-experiments\/([^/]+)\/cancel$/.exec(decodedPath);
  if (request.method === "POST" && cancelMatch) {
    await withComparisonOperation(projectRoot, () => controlGenerationTask(projectRoot, null, cancelMatch[1], "cancel", { purpose: "comparison" }));
    sendJson(response, 200, { cancelled: true });
    return true;
  }
  const reviewMatch = /^\/api\/comparison-experiments\/(review|diff|sheet)\/?$/.exec(decodedPath);
  if (request.method === "POST" && reviewMatch) {
    const body = await readJsonBody(request);
    const action = reviewMatch[1];
    const result = await withComparisonOperation(projectRoot, async () => {
      const projectDirectory = projectRoot;
      const review = await collectComparisonResults(projectDirectory, { ...body, include_inputs: action === "diff" || body?.include_inputs === true });
      if (action === "diff") return diffComparisonInputs(review.rows);
      if (action === "sheet") return exportComparisonSheet(projectDirectory, review, {
        columns: body?.columns, font_size: body?.font_size, title: body?.title, labels: body?.labels,
      });
      return review;
    });
    sendJson(response, 200, result);
    return true;
  }

  const resultMatch = /^\/api\/comparison-experiments\/([^/]+)\/results\/(cell-[a-f0-9]{64})\.png\/?$/.exec(decodedPath);
  if (request.method === "GET" && resultMatch) {
    const projectDirectory = projectRoot;
    const value = await readComparisonExperimentResult(projectDirectory, resultMatch[1], resultMatch[2]);
    sendBuffer(response, value, {
      contentType: "image/png",
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
    return true;
  }

  const collectionMatch = /^\/api\/comparison-experiments\/?$/.exec(decodedPath);
  if (request.method === "GET" && collectionMatch) {
    sendJson(response, 200, { experiments: (await listComparisonExperimentViews(projectRoot)).map(publicComparisonRecord) });
    return true;
  }
  if (request.method === "POST" && collectionMatch) {
    const value = await readJsonBody(request);
    if (!value?.id || (value.axes !== undefined && !Array.isArray(value.axes))) throw new ApiError(422, "invalid_comparison_experiment");
    if (value.page_import !== undefined && value.inputs !== undefined) throw new ApiError(422, "comparison_input_source_conflict", ["page_import 与 inputs 只能选择一种"]);
    const result = await withComparisonOperation(projectRoot, async () => {
      const projectDirectory = projectRoot;
      const imported = value.page_import === undefined ? value.inputs : await importPages(value.page_import);
      if (!Array.isArray(imported) || !imported.length) throw new ApiError(422, "comparison_inputs_required");
      const { inputs, images } = await materializeComparisonReferences(projectRoot, imported);
      const axes = value.axes ?? [];
      const resolvedAxes = axes.some(axis => axis?.type === "input") ? axes : [
        { type: "input", values: inputs.map(input => ({ value_id: input.id, label: input.label, value: input.id })) },
        ...axes,
      ];
      let registries = value.registries;
      if (Array.isArray(value.lora_sources)) {
        const loras = await freezeComparisonLoraSources({ repositoryRoot: projectRoot, config, sources: value.lora_sources });
        const application = value.lora_application === undefined ? {} : { application: value.lora_application };
        const includeBaseline = value.include_lora_baseline !== false;
        registries = {
          loras,
          lora_configs: [
            ...(includeBaseline ? [{ id: "baseline", label: "基线", lora_ref: null }] : []),
            ...loras.map((lora) => ({
              id: lora.id,
              label: lora.name ?? path.basename(lora.relative_path, path.extname(lora.relative_path)),
              lora_ref: lora.id,
              ...application,
            })),
          ],
        };
      }
      const manifest = createComparisonExperiment({ id: value.id, axes: resolvedAxes, registries });
      const preflight = await preflightComparisonExperiment({
        manifest, inputs,
      });
      return createComparisonExperimentStorage({
        projectRoot: projectDirectory,
        manifest,
        preflight,
        referenceImages: images,
      });
    });
    sendJson(response, 201, { experiment: publicComparisonRecord(result) });
    return true;
  }

  const startMatch = /^\/api\/comparison-experiments\/([^/]+)\/(start|retry)\/?$/.exec(decodedPath);
  if (request.method === "POST" && startMatch) {
    if (resolveLocalComfyTarget(primaryComfyUiUrl(config), null).reason === "remote_instance") {
      throw new ApiError(422, "comparison_remote_comfyui_unsupported", ["对比实验只支持本机 ComfyUI"]);
    }
    const projectId = null;
    const experimentId = startMatch[1];
    const result = await withComparisonOperation(projectRoot, async () => {
      const projectDirectory = projectRoot;
      let record = await readComparisonExperimentStorage(projectDirectory, experimentId);
      const activeKey = `${path.resolve(projectDirectory)}:${experimentId}`;
      if (activeComparisonProcesses.has(activeKey)) throw new ApiError(409, "comparison_experiment_already_running");
      const queue = await readGenerationQueue(projectRoot);
      const matches = item => item?.project_id === projectId && item?.task_id === experimentId && item?.purpose === "comparison";
      if (queue.items.some(matches) || matches(queue.active)) throw new ApiError(409, "comparison_experiment_already_running");
      if (startMatch[2] === "retry") {
        // 上面已排除 worker 和队列引用，允许恢复失败收尾也未能落盘的残留状态。
        if (!["incomplete", "failed", "completed"].includes(record.status.status)
          && !(["queued", "running"].includes(record.status.status) && record.status.started_at)) throw new ApiError(409, "comparison_retry_unavailable");
        try { record = await retryComparisonExperiment(projectDirectory, experimentId, undefined, { recoverInterrupted: true }); }
        catch (error) {
          if (typeof error?.code === "string" && (error.code.startsWith("comparison_") || error.code.startsWith("invalid_comparison"))) {
            throw new ApiError(422, error.code, [error.message]);
          }
          throw error;
        }
        if (record.status.status === "completed") return record;
      }
      if (record.status.status !== "queued") throw new ApiError(409, "comparison_experiment_terminal");
      if (!record.execution) {
        record = await prepareComparisonExperimentExecution({
          repositoryRoot: projectRoot,
          projectRoot: projectDirectory,
          localConfig: config,
          experimentId,
        });
      }
      await submitGenerationTask(projectRoot, generationReference(projectId, experimentId, "comparison", record.manifest.created_at));
      record = await readComparisonExperimentStorage(projectDirectory, experimentId);
      activeComparisonProcesses.set(activeKey, true);
      const adapter = comparisonAdapterFactory?.({ apiUrl: primaryComfyUiUrl(config) }) ?? null;
      const reference = generationReference(projectId, experimentId, "comparison", record.manifest.created_at);
      const worker = generationScheduler
        ? generationScheduler.start(reference)
        : runComparisonExperiment({
          projectRoot: projectDirectory,
          experimentId,
          apiUrl: primaryComfyUiUrl(config),
          modelsRoot: configuredPath(projectRoot, config.models_root),
          adapter,
          generationQueue: { repositoryRoot: projectRoot, reference },
        });
      void worker.catch((error) => console.error(`[story-canvas] 对比实验 ${experimentId} 执行失败`, error))
        .finally(async () => {
          activeComparisonProcesses.delete(activeKey);
        });
      return record;
    });
    sendJson(response, 202, { experiment: publicComparisonRecord(result), started: result.status.status !== "completed" });
    return true;
  }

  const detailMatch = /^\/api\/comparison-experiments\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "GET" && detailMatch) {
    const record = await readComparisonExperimentView(projectRoot, detailMatch[1]);
    const queue = await readGenerationQueue(projectRoot);
    const activeKey = `${path.resolve(projectRoot)}:${record.id}`;
    const inQueue = queue.items.some(item => item.project_id === null && item.task_id === record.id && item.purpose === "comparison");
    const retryAvailable = !activeComparisonProcesses.has(activeKey) && !inQueue
      && (["incomplete", "failed"].includes(record.status.status)
        || (["queued", "running"].includes(record.status.status) && Boolean(record.status.started_at)));
    sendJson(response, 200, { experiment: { ...publicComparisonRecord(record), retry_available: retryAvailable } });
    return true;
  }

  return false;
}
