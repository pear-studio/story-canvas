import { createReadStream } from "node:fs";

import { imageContentType, sendFile, sendJson } from "./http-support.mjs";
import { ensureMediaVariant, resolveMediaVariantWidth } from "./media-variants.mjs";
import { loraTrainingModule } from "./lora-training-module.mjs";

/**
 * LoRA HTTP Adapter。
 *
 * 路由负责训练项目 HTTP 参数与事实读写边界；素材、Caption、训练快照和运行控制
 * 的语义由 lora-training Module 提供。事实写入与派生通过 trainingOperations 串行处理，不进入项目锁。
 */
export async function handleLoraTrainingRequest({
  request,
  response,
  decodedPath,
  resolvedProjectRoot,
  config,
  readJsonBody,
  readOptionalJsonBody,
  readLoraAssetRequest,
  trainingOperations,
}) {
  if (!decodedPath.startsWith("/api/lora-training/")) return false;
  const projectDirectory = resolvedProjectRoot;
  if (request.method === "GET" && decodedPath === "/api/lora-training/runs") {
    sendJson(response, 200, await loraTrainingModule.runtime.list(projectDirectory));
    return true;
  }
  const run = (write, operation) => trainingOperations.execute(decodedPath, request.headers["if-match"], write, operation);
  const readFacts = operation => run(false, operation);
  const mutateFacts = operation => run(true, operation);
  const deriveFromFacts = operation => run(true, operation);
  const mutateDerived = operation => run(false, operation);
  const sendOperation = (status, result) => {
    response.setHeader("etag", result.revision);
    sendJson(response, status, result.value);
  };
  const prepareChanged = async (directory, detail, itemIds) => (await loraTrainingModule.media.postprocess.prepare(resolvedProjectRoot, directory, detail.id, config, { itemIds })).dataset;
  const datasetMedia = /^\/api\/lora-training\/media\/(.+)$/.exec(decodedPath);
  if (request.method === "GET" && datasetMedia) {
    const relativePath = `lora-training/${datasetMedia[1]}`;
    let media = await loraTrainingModule.media.dataset.open(projectDirectory, relativePath);
    const width = resolveMediaVariantWidth(new URL(request.url, "http://localhost").searchParams.get("w"));
    media.contentType = imageContentType(media.target);
    if (width) {
      try { media = await ensureMediaVariant(projectDirectory, media, relativePath, width); }
      catch { /* 缩略图失败时仍可查看原图。 */ }
    }
    const etag = `"${media.info.size}-${media.info.mtimeMs}-${media.info.ctimeMs}-${width ?? "original"}-${media.contentType}"`;
    const headers = { "cache-control": "private, no-cache", etag, "x-content-type-options": "nosniff" };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return true;
    }
    sendFile(response, media, { headers });
    return true;
  }
  const loraRunActionMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/runs\/([^/]+)\/stop\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraRunActionMatch) {
    // 停止只操作运行状态，不等待其他数据集的打标或图片处理释放事实队列。
    const result = await loraTrainingModule.runtime.stop(projectDirectory, loraRunActionMatch[1], loraRunActionMatch[2]);
    sendJson(response, 202, result);
    return true;
  }
  const loraRunResumeMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/runs\/([^/]+)\/resume\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraRunResumeMatch) {
    // 续训走冻结 + runtime 的完整路径；来源新鲜度在串行队列内再次校验，陈旧来源返回 409。
    const value = await readJsonBody(request);
    const result = await deriveFromFacts(({ projectDirectory }) => loraTrainingModule.coordination.resumeRun(resolvedProjectRoot, projectDirectory, loraRunResumeMatch[1], loraRunResumeMatch[2], config, value));
    sendOperation(202, result);
    return true;
  }
  const loraRunMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/runs\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "DELETE" && loraRunMatch) {
    const result = await mutateDerived(({ projectDirectory }) => loraTrainingModule.runtime.deleteRun(projectDirectory, loraRunMatch[1], loraRunMatch[2]));
    sendOperation(200, result);
    return true;
  }
  const loraRunsMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/runs\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraRunsMatch) {
    const value = await readJsonBody(request);
    const result = await deriveFromFacts(({ projectDirectory }) => loraTrainingModule.coordination.startRun(resolvedProjectRoot, projectDirectory, loraRunsMatch[1], config, { runSettings: value.run_settings }));
    sendOperation(202, result);
    return true;
  }
  const loraPostprocessPreviewMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/postprocess\/preview\/?$/.exec(decodedPath);
  const prepareMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/postprocess\/prepare\/?$/.exec(decodedPath);
  if (request.method === "POST" && prepareMatch) {
    const value = await readOptionalJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.media.postprocess.prepare(resolvedProjectRoot, projectDirectory, prepareMatch[1], config, { itemIds: Array.isArray(value?.item_ids) ? value.item_ids : undefined }));
    sendOperation(200, result);
    return true;
  }
  if (request.method === "POST" && loraPostprocessPreviewMatch) {
    const value = await readJsonBody(request);
    const result = await deriveFromFacts(({ projectDirectory }) => loraTrainingModule.media.postprocess.preview(resolvedProjectRoot, projectDirectory, loraPostprocessPreviewMatch[1], value, config));
    sendOperation(200, result);
    return true;
  }
  const loraPostprocessMediaMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/postprocess\/preview\/([a-f0-9]{64})\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraPostprocessMediaMatch) {
    const media = await loraTrainingModule.media.postprocess.openPreview(projectDirectory, loraPostprocessMediaMatch[1], loraPostprocessMediaMatch[2]);
    response.writeHead(200, { "content-type": "image/png", "content-length": media.info.size, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    createReadStream(media.target).pipe(response);
    return true;
  }
  const loraPostprocessApplyMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/postprocess\/(apply|restore)\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraPostprocessApplyMatch) {
    const value = await readOptionalJsonBody(request);
    const result = await mutateFacts(async ({ projectDirectory }) => {
      const detail = loraPostprocessApplyMatch[2] === "apply"
        ? await loraTrainingModule.media.postprocess.apply(resolvedProjectRoot, projectDirectory, loraPostprocessApplyMatch[1], value, config)
        : await loraTrainingModule.media.postprocess.restore(projectDirectory, loraPostprocessApplyMatch[1], value?.item_id);
      return prepareChanged(projectDirectory, detail, [value?.item_id]);
    });
    sendOperation(200, result);
    return true;
  }
  const loraBulkUpscaleMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/postprocess\/bulk-upscale\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraBulkUpscaleMatch) {
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.media.postprocess.bulkUpscale(resolvedProjectRoot, projectDirectory, loraBulkUpscaleMatch[1], config));
    sendOperation(200, result);
    return true;
  }
  const loraDatasetActionMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/(assets|copies)\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraDatasetActionMatch) {
    const action = loraDatasetActionMatch[2];
    if (action === "assets") {
      const value = await readLoraAssetRequest(request);
      const result = await mutateFacts(async ({ projectDirectory }) => {
        const before = await loraTrainingModule.facts.datasets.read(projectDirectory, loraDatasetActionMatch[1]);
        const detail = await loraTrainingModule.facts.datasets.importAssets(projectDirectory, loraDatasetActionMatch[1], value);
        const existing = new Set(before.items.map(item => item.id));
        return prepareChanged(projectDirectory, detail, detail.items.filter(item => !existing.has(item.id)).map(item => item.id));
      });
      sendOperation(201, result);
    } else {
      const value = await readJsonBody(request);
      const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.datasets.copyItem(projectDirectory, loraDatasetActionMatch[1], value));
      sendOperation(201, result);
    }
    return true;
  }
  const loraCaptionRunsMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/caption-runs\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraCaptionRunsMatch) {
    const value = await readOptionalJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.run({ projectRoot: resolvedProjectRoot, projectDirectory, datasetId: loraCaptionRunsMatch[1], mode: value?.mode ?? "missing", itemId: value?.item_id ?? null, config, confirmOverwrite: value?.confirm_overwrite === true }));
    sendOperation(200, result);
    return true;
  }
  const loraCaptionRunMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/caption-runs\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraCaptionRunMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.readRun(projectDirectory, loraCaptionRunMatch[1], loraCaptionRunMatch[2]));
    sendOperation(200, result);
    return true;
  }
  const loraCaptionAuditMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/caption-audit\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraCaptionAuditMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.audit.read(projectDirectory, loraCaptionAuditMatch[1]));
    sendOperation(200, result);
    return true;
  }
  if (request.method === "POST" && loraCaptionAuditMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.audit.record(projectDirectory, loraCaptionAuditMatch[1], value));
    sendOperation(200, result);
    return true;
  }
  const loraCaptioningMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/captioning\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraCaptioningMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.read(projectDirectory, loraCaptioningMatch[1]));
    sendOperation(200, result);
    return true;
  }
  const loraCaptioningItemMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/captioning\/items\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "PUT" && loraCaptioningItemMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.confirm(projectDirectory, loraCaptioningItemMatch[1], loraCaptioningItemMatch[2], value?.prompt, { confirm: value?.confirm === true }));
    sendOperation(200, result);
    return true;
  }
  const loraCaptionMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/captions\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "PUT" && loraCaptionMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.captions.save(projectDirectory, loraCaptionMatch[1], loraCaptionMatch[2], value?.caption));
    sendOperation(200, result);
    return true;
  }
  const loraDatasetMatch = /^\/api\/lora-training\/datasets\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraDatasetMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.datasets.read(projectDirectory, loraDatasetMatch[1]));
    sendOperation(200, result);
    return true;
  }
  if (request.method === "PUT" && loraDatasetMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.datasets.update(projectDirectory, loraDatasetMatch[1], value));
    sendOperation(200, result);
    return true;
  }
  const loraDatasetsMatch = /^\/api\/lora-training\/datasets\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraDatasetsMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.datasets.list(projectDirectory));
    sendOperation(200, result);
    return true;
  }
  if (request.method === "POST" && loraDatasetsMatch) {
    const value = await readOptionalJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.datasets.create(projectDirectory, value));
    sendOperation(201, result);
    return true;
  }
  const loraTaskPreflightMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/preflight\/?$/.exec(decodedPath);
  if (request.method === "POST" && loraTaskPreflightMatch) {
    const value = await readJsonBody(request);
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.plan.preflight(resolvedProjectRoot, projectDirectory, loraTaskPreflightMatch[1], config, { runSettings: value.run_settings }));
    sendOperation(200, result);
    return true;
  }
  const loraTaskRunSettingsMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/run-settings\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraTaskRunSettingsMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.plan.runSettings.read(resolvedProjectRoot, projectDirectory, loraTaskRunSettingsMatch[1], config));
    sendOperation(200, result);
    return true;
  }
  const loraTaskMatch = /^\/api\/lora-training\/tasks\/([^/]+)\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraTaskMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.tasks.read(projectDirectory, loraTaskMatch[1]));
    sendOperation(200, result);
    return true;
  }
  if (request.method === "PUT" && loraTaskMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(({ projectDirectory }) => loraTrainingModule.facts.tasks.update(resolvedProjectRoot, projectDirectory, loraTaskMatch[1], value));
    sendOperation(200, result);
    return true;
  }
  const loraTasksMatch = /^\/api\/lora-training\/tasks\/?$/.exec(decodedPath);
  if (request.method === "GET" && loraTasksMatch) {
    const result = await readFacts(({ projectDirectory }) => loraTrainingModule.facts.tasks.list(projectDirectory));
    sendOperation(200, result);
    return true;
  }
  return false;
}
