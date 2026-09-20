import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { resolveLocalComfyTarget } from "./comfy-runtime.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";
import * as support from "./lora-training-support.mjs";
import { invalidateLoraCaptioningItem, readLoraTrainingDataset, requireDataset } from "./lora-training-facts.mjs";
import { comfyQueueStatus, readUpscaleModelStatus } from "./lora-training-plan.mjs";
import { historyImages, waitComfyHistory } from "./lora-training-runtime.mjs";
import { createMusiqSession, readMusiqStatus } from "./lora-image-quality.mjs";
import { prepareTrainingImage } from "./lora-image-preparation.mjs";
import { preparationPolicy } from "./lora-image-preparation-contract.mjs";

const {
  LoraTrainingError, idPatterns, sha256Pattern, postprocessPipelineVersion, postprocessDownsampleAlgorithm,
  maxPostprocessPixels, maxUpscaleIntermediatePixels, upscaleModelId, createHash: _unused,
  isRecord, exists, readJson, writeAtomic, writeJsonAtomic, sha256File, datasetRoot, itemPaths,
  readSafeDatasetFile, readAssetMeta, normalizeOrientedImage, normalizeCropInput, cropChangesImage,
  postprocessFingerprint, canonicalJson, imageExtensions, isWithin,
} = support;

export function postprocessRuntimeRoot(projectDirectory, datasetId) {
  return path.join(datasetRoot(projectDirectory, datasetId), "Saved", "cache", "lora-postprocessing");
}

export function safePreviewId(value) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new LoraTrainingError(422, "invalid_lora_postprocess_preview");
  return value;
}

export async function openLoraTrainingMedia(projectDirectory, relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("..") || path.isAbsolute(relativePath)) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  const [prefix, kind, datasetId, ...segments] = relativePath.split("/");
  if (prefix !== "lora-training" || kind !== "datasets" || !idPatterns.dataset.test(datasetId) || !segments.length) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  const root = datasetRoot(projectDirectory, datasetId);
  const target = path.resolve(root, segments.join(path.sep));
  if (!isWithin(root, target) || !imageExtensions.has(path.extname(target).toLowerCase())) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  const rootInfo = await lstat(root).catch(() => null);
  const info = await lstat(target).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  if (!info) throw new LoraTrainingError(404, "lora_training_media_not_found");
  if (!info.isFile() || info.isSymbolicLink()) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  if (!isWithin(rootReal, targetReal)) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  return { target, info };
}

export async function openLoraPostprocessPreviewMedia(projectDirectory, datasetId, previewId) {
  if (!idPatterns.dataset.test(datasetId ?? "")) throw new LoraTrainingError(400, "invalid_lora_training_media_path");
  safePreviewId(previewId);
  const target = path.join(postprocessRuntimeRoot(projectDirectory, datasetId), `preview-${previewId}.png`);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new LoraTrainingError(404, "lora_postprocess_preview_not_found");
  return { target, info };
}

export function compileLoraUpscaleWorkflow({ image, modelName, filenamePrefix }) {
  return {
    "1": { class_type: "LoadImage", inputs: { image } },
    "2": { class_type: "UpscaleModelLoader", inputs: { model_name: modelName } },
    "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
    "4": { class_type: "SaveImage", inputs: { filename_prefix: filenamePrefix, images: ["3", 0] } },
  };
}

function comfyUnavailableError(apiUrl) {
  return new LoraTrainingError(503, "comfyui_unavailable", [`ComfyUI 未启动或无法连接：${apiUrl}。请先在顶部“环境”菜单启动 ComfyUI。`]);
}

export function chooseLoraUpscaleScale(shortSide, targetShortSide = 1024) {
  const value = Number(shortSide);
  const target = Number(targetShortSide);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(target) || target <= 0) return null;
  return value * 2 > target ? 2 : 4;
}

function currentCropForLoraBulkUpscale(item) {
  const originalWidth = Number(item.original_image_width ?? item.image_width);
  const originalHeight = Number(item.original_image_height ?? item.image_height);
  const crop = item.processing?.crop;
  if (!crop || !Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || originalWidth <= 0 || originalHeight <= 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return {
    x: crop.x / originalWidth,
    y: crop.y / originalHeight,
    width: crop.width / originalWidth,
    height: crop.height / originalHeight,
  };
}

export function planLoraBulkUpscale(items, targetShortSide = 1024) {
  const planned = [];
  const skipped = { already_upscaled: 0, above_target: 0, invalid: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.processing?.upscale === true) {
      skipped.already_upscaled += 1;
      continue;
    }
    const width = Number(item?.image_width);
    const height = Number(item?.image_height);
    const shortSide = Math.min(width, height);
    if (!Number.isFinite(shortSide) || shortSide <= 0) {
      skipped.invalid += 1;
      continue;
    }
    if (shortSide >= targetShortSide) {
      skipped.above_target += 1;
      continue;
    }
    const outputScale = chooseLoraUpscaleScale(shortSide, targetShortSide);
    if (!outputScale) {
      skipped.invalid += 1;
      continue;
    }
    planned.push({ item_id: item.id, asset_id: item.asset_id, short_side: shortSide, crop: currentCropForLoraBulkUpscale(item), output_scale: outputScale });
  }
  return { planned, skipped };
}

function loraBulkUpscaleError(error) {
  return {
    code: error?.code ?? "lora_bulk_upscale_failed",
    details: Array.isArray(error?.details) ? error.details : [error?.message ?? String(error)],
  };
}

export async function bulkUpscaleLoraTrainingDataset(projectRoot, projectDirectory, datasetId, config = {}) {
  const initial = await readLoraTrainingDataset(projectDirectory, datasetId);
  const plan = planLoraBulkUpscale(initial.items);
  if (!plan.planned.length) return { processed: 0, attempted: 0, skipped: plan.skipped, failed: [], scales: { 2: 0, 4: 0 }, dataset: initial };

  const model = await readUpscaleModelStatus(projectRoot, config);
  if (!model.ready) throw new LoraTrainingError(409, "lora_upscale_model_unavailable", [model.message, model.path ?? model.relative_path]);
  const queue = await comfyQueueStatus(config);
  if (!queue) throw comfyUnavailableError(primaryComfyUiUrl(config));

  const failed = [];
  const scales = { 2: 0, 4: 0 };
  let processed = 0;
  for (const target of plan.planned) {
    const request = { item_id: target.item_id, crop: target.crop, upscale: true, output_scale: target.output_scale };
    try {
      const preview = await previewLoraTrainingPostprocess(projectRoot, projectDirectory, datasetId, request, config);
      await applyLoraTrainingPostprocess(projectRoot, projectDirectory, datasetId, { ...request, preview_id: preview.preview_id }, config);
      processed += 1;
      scales[target.output_scale] += 1;
    } catch (error) {
      failed.push({ item_id: target.item_id, asset_id: target.asset_id, output_scale: target.output_scale, error: loraBulkUpscaleError(error) });
    }
  }
  return { processed, attempted: plan.planned.length, skipped: plan.skipped, failed, scales, dataset: await readLoraTrainingDataset(projectDirectory, datasetId) };
}

export async function prepareLoraTrainingDataset(projectRoot, projectDirectory, datasetId, config = {}, dependencies = {}) {
  const initial = await readLoraTrainingDataset(projectDirectory, datasetId);
  const groups = new Set(initial.dataset.groups.filter(group => group.enabled).map(group => group.id));
  const items = initial.items.filter(item => dependencies.itemIds ? dependencies.itemIds.includes(item.id) : item.enabled && groups.has(item.group_id));
  const quality = dependencies.quality ?? await readMusiqStatus(projectRoot, config);
  const upscaleIdentity = dependencies.upscaler ?? (await readJson(path.join(projectRoot, "library/lora-training/upscalers/real-esrgan-x4plus-anime-6b.json"), { optional: true }))?.file;
  let session;
  let upscaler;
  const result = { prepared: 0, reused: 0, enhanced: 0, already_good: 0, no_gain: 0, failed: [] };
  try {
    for (const item of items) {
      try {
        if (!quality.ready) throw new LoraTrainingError(409, "lora_musiq_unavailable", [quality.message]);
        const files = itemPaths(projectDirectory, datasetId, item);
        const meta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
        const original = await readSafeDatasetFile(projectDirectory, datasetId, path.join(files.assetDirectory, meta.original.file), item.id);
        if (!original) throw new LoraTrainingError(422, "lora_training_original_missing", [item.id]);
        const normalized = await sharp(original).rotate().toColourspace("srgb").png().toBuffer({ resolveWithObject: true });
        // 始终复用原图上的裁剪，不叠加以前的超分或训练图准备。
        const crop = normalizeCropInput(meta.processing?.crop ?? { x: 0, y: 0, width: normalized.info.width, height: normalized.info.height }, normalized.info.width, normalized.info.height);
        if (crop.width * crop.height > maxPostprocessPixels) throw new LoraTrainingError(422, "lora_postprocess_image_too_large", [maxPostprocessPixels]);
        const manualUpscale = meta.processing?.upscale === true;
        const input = { manual_upscale: manualUpscale ? meta.processing.output_scale : null, original_sha256: createHash("sha256").update(original).digest("hex"), crop, policy: preparationPolicy, quality_sha256: quality.sha256, upscale_sha256: upscaleIdentity?.sha256 ?? null };
        const fingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex");
        if (meta.preparation?.fingerprint === fingerprint && meta.current.sha256 === item.image_version) {
          result.reused += 1;
          continue;
        }
        const cropped = await sharp(normalized.data).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).flatten({ background: "#ffffff" }).png().toBuffer();
        session ??= dependencies.createSession ? dependencies.createSession() : createMusiqSession(projectRoot, quality);
        const appliedUpscale = manualUpscale && !meta.preparation
          ? await readSafeDatasetFile(projectDirectory, datasetId, path.join(files.assetDirectory, meta.current.file), item.id) : null;
        const prepared = await prepareTrainingImage(cropped, {
          forceUpscale: manualUpscale,
          score: buffer => session.score(buffer),
          upscale: async buffer => {
            if (appliedUpscale) {
              upscaler ??= dependencies.upscaler ?? { sha256: meta.processing.model.sha256 };
              return appliedUpscale;
            }
            const dimensions = await sharp(buffer).metadata();
            if (dimensions.width * dimensions.height * 16 > maxUpscaleIntermediatePixels) throw new LoraTrainingError(422, "lora_upscale_image_too_large", [maxUpscaleIntermediatePixels]);
            upscaler ??= dependencies.upscaler ?? await readUpscaleModelStatus(projectRoot, config);
            if (!upscaler.ready) throw new LoraTrainingError(409, "lora_upscale_model_unavailable", [upscaler.message]);
            const enhanced = await (dependencies.upscale ? dependencies.upscale(buffer) : executeLoraUpscale(projectRoot, projectDirectory, datasetId, buffer, fingerprint, config, upscaler));
            return manualUpscale ? sharp(enhanced).resize({ width: crop.width * meta.processing.output_scale, height: crop.height * meta.processing.output_scale, kernel: "lanczos3" }).png().toBuffer() : enhanced;
          },
        });
        const imageFile = buffer => `processed-${createHash("sha256").update(buffer).digest("hex")}.png`;
        const baselineFile = imageFile(prepared.baseline);
        const enhancedFile = prepared.enhanced ? imageFile(prepared.enhanced) : null;
        const selectedBuffer = prepared.decision === "enhanced" ? prepared.enhanced : prepared.baseline;
        const selectedFile = prepared.decision === "enhanced" ? enhancedFile : baselineFile;
        const previousMeta = await readFile(files.meta);
        const oldFiles = new Set([meta.current.file, meta.preparation?.baseline_file, meta.preparation?.enhanced_file].filter(Boolean));
        const newFiles = new Set([baselineFile, enhancedFile].filter(Boolean));
        const created = [];
        try {
          for (const [file, buffer] of [[baselineFile, prepared.baseline], [enhancedFile, prepared.enhanced]]) {
            if (!file || !buffer || await exists(path.join(files.assetDirectory, file))) continue;
            await writeAtomic(path.join(files.assetDirectory, file), buffer); created.push(file);
          }
          meta.current = { file: selectedFile, sha256: createHash("sha256").update(selectedBuffer).digest("hex") };
          delete meta.preparation_error;
          meta.preparation = { ...preparationPolicy, fingerprint, target: prepared.target, before_score: prepared.before_score, after_score: prepared.after_score,
            decision: prepared.decision, baseline_file: baselineFile, enhanced_file: enhancedFile, quality_sha256: quality.sha256,
            upscale_sha256: prepared.enhanced ? upscaler.sha256 : null };
          await writeJsonAtomic(files.meta, meta);
          if (meta.current.sha256 !== item.image_version) await invalidateLoraCaptioningItem(projectDirectory, datasetId, item.id);
        } catch (error) {
          await writeAtomic(files.meta, previousMeta);
          for (const file of created) await unlink(path.join(files.assetDirectory, file)).catch(() => undefined);
          throw error;
        }
        for (const file of oldFiles) if (!newFiles.has(file) && /^processed-[a-f0-9]{64}\.png$/.test(file)) await unlink(path.join(files.assetDirectory, file)).catch(() => undefined);
        result.prepared += 1;
        result[prepared.decision] += 1;
      } catch (error) {
        const failedFiles = itemPaths(projectDirectory, datasetId, item);
        const failedMeta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
        failedMeta.preparation_error = error.details?.join("；") || error.message || "图片处理失败";
        await writeJsonAtomic(failedFiles.meta, failedMeta);
        result.failed.push({ item_id: item.id, asset_id: item.asset_id, error: loraBulkUpscaleError(error) });
        // 共用评分进程的失败会被会话缓存；其余图片记录原因，不反复启动进程。
      }
    }
  } finally { session?.close(); }
  return { ...result, total: items.length, dataset: await readLoraTrainingDataset(projectDirectory, datasetId) };
}

export async function uploadComfyImage(apiUrl, buffer, filename) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  let response;
  try {
    response = await fetch(`${apiUrl}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw comfyUnavailableError(apiUrl);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !value.name) throw new LoraTrainingError(502, "lora_upscale_upload_failed", [value.error ?? response.status]);
  return value.name;
}

export async function executeLoraUpscale(projectRoot, projectDirectory, datasetId, sourceBuffer, fingerprint, config, model) {
  if (resolveLocalComfyTarget(primaryComfyUiUrl(config), null).reason === "remote_instance") {
    throw new LoraTrainingError(422, "lora_upscale_remote_comfyui_unsupported", ["图片超分只支持本机 ComfyUI"]);
  }
  const apiUrl = primaryComfyUiUrl(config);
  if (!apiUrl) throw new LoraTrainingError(409, "comfyui_not_configured");
  const queue = await comfyQueueStatus(config);
  if (!queue) throw comfyUnavailableError(apiUrl);
  const uploadName = await uploadComfyImage(apiUrl, sourceBuffer, `lora-postprocess-${fingerprint}.png`);
  const modelName = String(model.relative_path).replaceAll("\\", "/").replace(/^upscale_models\//, "");
  const workflow = compileLoraUpscaleWorkflow({ image: uploadName, modelName, filenamePrefix: `story-canvas/lora-postprocessing/${fingerprint}` });
  let submitted;
  try {
    submitted = await fetch(`${apiUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: `lora-postprocess-${fingerprint}` }), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw comfyUnavailableError(apiUrl);
  }
  const submission = await submitted.json().catch(() => ({}));
  if (!submitted.ok || !submission.prompt_id) throw new LoraTrainingError(502, "lora_upscale_submit_failed", [submission.error ?? submitted.status]);
  let history;
  try {
    history = await waitComfyHistory(apiUrl, submission.prompt_id);
  } catch (error) {
    if (error instanceof LoraTrainingError) throw error;
    throw comfyUnavailableError(apiUrl);
  }
  const image = historyImages(history)[0];
  if (!image) throw new LoraTrainingError(502, "lora_upscale_no_image");
  let view;
  try {
    view = await fetch(`${apiUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? "")}&type=${encodeURIComponent(image.type ?? "output")}`, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw comfyUnavailableError(apiUrl);
  }
  if (!view.ok) throw new LoraTrainingError(502, "lora_upscale_image_unavailable");
  return Buffer.from(await view.arrayBuffer());
}

export async function previewLoraTrainingPostprocess(projectRoot, projectDirectory, datasetId, value, config) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const item = dataset.items.find((entry) => entry.id === value?.item_id || entry.id === value?.source_item_id);
  if (!item) throw new LoraTrainingError(404, "lora_training_item_not_found");
  const files = itemPaths(projectDirectory, datasetId, item);
  const meta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
  const originalFile = String(meta.original?.file ?? `original${path.extname(files.image)}`);
  const originalPath = path.join(files.assetDirectory, originalFile);
  const originalBuffer = await readSafeDatasetFile(projectDirectory, datasetId, originalPath, item.id);
  if (!originalBuffer) throw new LoraTrainingError(422, "lora_training_original_missing", [item.id]);
  const normalized = await normalizeOrientedImage(originalBuffer);
  const crop = normalizeCropInput(value?.crop, normalized.info.width, normalized.info.height);
  const upscale = value?.upscale === true;
  const outputScale = upscale ? Number(value?.output_scale) : null;
  if (!cropChangesImage(crop, normalized.info.width, normalized.info.height) && !upscale) throw new LoraTrainingError(422, "lora_postprocess_no_changes");
  if (upscale && ![1, 2, 4].includes(outputScale)) throw new LoraTrainingError(422, "invalid_lora_upscale_scale");
  const model = upscale ? await readUpscaleModelStatus(projectRoot, config) : null;
  if (upscale && !model.ready) throw new LoraTrainingError(409, "lora_upscale_model_unavailable", [model.message, model.path ?? model.relative_path]);
  const originalSha256 = createHash("sha256").update(originalBuffer).digest("hex");
  const fingerprint = postprocessFingerprint({ originalSha256, crop, upscale, outputScale, modelSha256: model?.sha256 ?? null });
  const runtimeRoot = postprocessRuntimeRoot(projectDirectory, datasetId);
  const previewPath = path.join(runtimeRoot, `preview-${fingerprint}.png`);
  const manifestPath = path.join(runtimeRoot, `preview-${fingerprint}.json`);
  const existing = await readJson(manifestPath, { optional: true });
  if (existing?.version === 1 && existing.fingerprint === fingerprint && existing.dataset_id === datasetId && existing.item_id === item.id && existing.pipeline_version === postprocessPipelineVersion && existing.downsample_algorithm === postprocessDownsampleAlgorithm && sha256Pattern.test(existing.output_sha256 ?? "") && await exists(previewPath) && await sha256File(previewPath) === existing.output_sha256) {
    return { preview_id: fingerprint, fingerprint, output_sha256: existing.output_sha256, width: existing.width, height: existing.height, item_id: item.id, cached: true };
  }
  if (crop.width * crop.height > maxPostprocessPixels) throw new LoraTrainingError(422, "lora_postprocess_image_too_large", [maxPostprocessPixels]);
  const croppedImage = sharp(normalized.data).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
  if (upscale) croppedImage.flatten({ background: "#ffffff" });
  const croppedBuffer = await croppedImage.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  let outputBuffer;
  if (!upscale) outputBuffer = croppedBuffer;
  else {
    const intermediate = crop.width * crop.height * 16;
    if (intermediate > maxUpscaleIntermediatePixels) throw new LoraTrainingError(422, "lora_upscale_image_too_large", [maxUpscaleIntermediatePixels]);
    outputBuffer = await executeLoraUpscale(projectRoot, projectDirectory, datasetId, croppedBuffer, fingerprint, config, model);
    if (outputScale !== 4) outputBuffer = await sharp(outputBuffer).resize({ width: crop.width * outputScale, height: crop.height * outputScale, kernel: sharp.kernel.lanczos3 }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    else outputBuffer = await sharp(outputBuffer).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  }
  const outputMetadata = await sharp(outputBuffer).metadata();
  if ((outputMetadata.width ?? 0) * (outputMetadata.height ?? 0) > maxPostprocessPixels) throw new LoraTrainingError(422, "lora_postprocess_output_too_large", [maxPostprocessPixels]);
  const outputSha256 = createHash("sha256").update(outputBuffer).digest("hex");
  await writeAtomic(previewPath, outputBuffer);
  await writeJsonAtomic(manifestPath, { version: 1, fingerprint, dataset_id: datasetId, item_id: item.id, original_sha256: originalSha256, crop, upscale, output_scale: outputScale, model_sha256: model?.sha256 ?? null, output_sha256: outputSha256, width: outputMetadata.width, height: outputMetadata.height, downsample_algorithm: postprocessDownsampleAlgorithm, pipeline_version: postprocessPipelineVersion });
  return { preview_id: fingerprint, fingerprint, output_sha256: outputSha256, width: outputMetadata.width, height: outputMetadata.height, item_id: item.id, cached: false };
}

export async function applyLoraTrainingPostprocess(projectRoot, projectDirectory, datasetId, value, config = {}) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const item = dataset.items.find((entry) => entry.id === value?.item_id);
  if (!item) throw new LoraTrainingError(404, "lora_training_item_not_found");
  const previewId = safePreviewId(value?.preview_id);
  const runtimeRoot = postprocessRuntimeRoot(projectDirectory, datasetId);
  const manifest = await readJson(path.join(runtimeRoot, `preview-${previewId}.json`), { optional: true });
  const previewPath = path.join(runtimeRoot, `preview-${previewId}.png`);
  if (!isRecord(manifest) || manifest.version !== 1 || manifest.fingerprint !== previewId || manifest.dataset_id !== datasetId || manifest.item_id !== item.id || manifest.pipeline_version !== postprocessPipelineVersion || manifest.downsample_algorithm !== postprocessDownsampleAlgorithm || !sha256Pattern.test(manifest.original_sha256 ?? "") || !sha256Pattern.test(manifest.output_sha256 ?? "") || !(await exists(previewPath))) throw new LoraTrainingError(404, "lora_postprocess_preview_not_found");
  const files = itemPaths(projectDirectory, datasetId, item);
  const meta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
  const originalFile = String(meta.original?.file ?? `original${path.extname(files.image)}`);
  const originalPath = path.join(files.assetDirectory, originalFile);
  const originalBuffer = await readSafeDatasetFile(projectDirectory, datasetId, originalPath, item.id);
  const originalSha256 = originalBuffer ? createHash("sha256").update(originalBuffer).digest("hex") : null;
  const normalizedOriginal = originalBuffer ? await normalizeOrientedImage(originalBuffer) : null;
  const canonicalCrop = normalizedOriginal ? normalizeCropInput(value.crop, normalizedOriginal.info.width, normalizedOriginal.info.height) : null;
  if (normalizedOriginal && canonicalCrop && !cropChangesImage(canonicalCrop, normalizedOriginal.info.width, normalizedOriginal.info.height) && !value.upscale) throw new LoraTrainingError(422, "lora_postprocess_no_changes");
  if (originalSha256 !== manifest.original_sha256 || canonicalJson(canonicalCrop) !== canonicalJson(manifest.crop) || Boolean(value.upscale) !== Boolean(manifest.upscale) || (value.output_scale ?? null) !== (manifest.output_scale ?? null)) throw new LoraTrainingError(409, "lora_postprocess_preview_stale");
  if (manifest.model_sha256) {
    const model = await readUpscaleModelStatus(projectRoot, config);
    if (!model.ready || model.sha256 !== manifest.model_sha256) throw new LoraTrainingError(409, "lora_postprocess_preview_stale");
  }
  const outputBuffer = await readFile(previewPath);
  const outputSha256 = createHash("sha256").update(outputBuffer).digest("hex");
  if (outputSha256 !== manifest.output_sha256) throw new LoraTrainingError(409, "lora_postprocess_preview_stale");
  const recalculatedFingerprint = postprocessFingerprint({ originalSha256, crop: canonicalCrop, upscale: Boolean(value.upscale), outputScale: value.output_scale ?? null, modelSha256: manifest.model_sha256 ?? null });
  if (recalculatedFingerprint !== previewId) throw new LoraTrainingError(409, "lora_postprocess_preview_stale");
  const targetFile = `processed-${previewId}.png`;
  const previousFiles = new Set([meta.current?.file, meta.preparation?.baseline_file, meta.preparation?.enhanced_file].filter(Boolean));
  const targetPath = path.join(files.assetDirectory, targetFile);
  const targetExisted = await exists(targetPath);
  const previousTarget = targetExisted ? await readFile(targetPath) : null;
  const previousMeta = await readFile(files.meta);
  try {
    await writeAtomic(targetPath, outputBuffer);
    meta.current = { file: targetFile, sha256: outputSha256 };
    delete meta.preparation;
    meta.processing = { crop: manifest.crop, upscale: Boolean(manifest.upscale), output_scale: manifest.output_scale ?? null, model: manifest.model_sha256 ? { id: upscaleModelId, sha256: manifest.model_sha256 } : null, pipeline_version: postprocessPipelineVersion };
    await writeJsonAtomic(files.meta, meta);
    await invalidateLoraCaptioningItem(projectDirectory, datasetId, item.id);
  } catch (error) {
    if (previousTarget === null) await unlink(targetPath).catch(() => undefined);
    else await writeAtomic(targetPath, previousTarget).catch(() => undefined);
    await writeAtomic(files.meta, previousMeta).catch(() => undefined);
    throw error;
  }
  for (const file of previousFiles) if (file !== targetFile && /^processed-[a-f0-9]{64}\.png$/i.test(file)) await unlink(path.join(files.assetDirectory, file)).catch(() => undefined);
  return readLoraTrainingDataset(projectDirectory, datasetId);
}

export async function restoreLoraTrainingOriginal(projectDirectory, datasetId, itemId) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const item = dataset.items.find((entry) => entry.id === itemId);
  if (!item) throw new LoraTrainingError(404, "lora_training_item_not_found");
  const files = itemPaths(projectDirectory, datasetId, item);
  const meta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
  const originalFile = String(meta.original?.file ?? `original${path.extname(files.image)}`);
  const originalPath = path.join(files.assetDirectory, originalFile);
  const originalBuffer = await readSafeDatasetFile(projectDirectory, datasetId, originalPath, item.id);
  if (!originalBuffer) throw new LoraTrainingError(422, "lora_training_original_missing", [item.id]);
  const previousFiles = new Set([meta.current?.file, meta.preparation?.baseline_file, meta.preparation?.enhanced_file].filter(Boolean));
  const previousMeta = await readFile(files.meta);
  meta.current = { file: originalFile, sha256: createHash("sha256").update(originalBuffer).digest("hex") };
  meta.processing = null;
  delete meta.preparation;
  try {
    await writeJsonAtomic(files.meta, meta);
    await invalidateLoraCaptioningItem(projectDirectory, datasetId, item.id);
  } catch (error) {
    await writeAtomic(files.meta, previousMeta).catch(() => undefined);
    throw error;
  }
  for (const file of previousFiles) if (file !== originalFile && /^processed-[a-f0-9]{64}\.png$/i.test(file)) await unlink(path.join(files.assetDirectory, file)).catch(() => undefined);
  return readLoraTrainingDataset(projectDirectory, datasetId);
}

export function createLoraTrainingMediaInterface(implementation) {
  return Object.freeze({
    postprocess: Object.freeze({
      preview: implementation.previewLoraTrainingPostprocess,
      apply: implementation.applyLoraTrainingPostprocess,
      restore: implementation.restoreLoraTrainingOriginal,
      bulkUpscale: implementation.bulkUpscaleLoraTrainingDataset,
      prepare: implementation.prepareLoraTrainingDataset,
      openPreview: implementation.openLoraPostprocessPreviewMedia,
    }),
    dataset: Object.freeze({
      open: implementation.openLoraTrainingMedia,
    }),
  });
}
