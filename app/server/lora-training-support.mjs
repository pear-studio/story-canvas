import { registeredProjectPath, listRegisteredProjects } from "./project-registry.mjs";
import { existsSync } from "node:fs";
import { validateSavedRunSettings } from "./lora-training-settings.mjs";
import { validPreparation } from "./lora-image-preparation-contract.mjs";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { validateLoraTrainingRunManifest } from "./lora-training-run-manifest.mjs";

export { validateLoraTrainingRunManifest };

export const execFileAsync = promisify(execFile);
export const idPatterns = Object.freeze({
  dataset: /^dataset-[a-f0-9]{12}$/,
  task: /^(?:lora|dataset)-[a-f0-9]{12}$/,
  asset: /^(?:asset-[a-f0-9]{12}|[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{3})$/,
  item: /^item-[a-f0-9]{12}$/,
  group: /^group-[a-f0-9]{12}$/,
  run: /^run-[a-f0-9]{12}$/,
  checkpoint: /^checkpoint-[a-f0-9]{12}$/,
});
export const sha256Pattern = /^[0-9a-f]{64}$/;
export const imageExtensions = new Set([".jpeg", ".jpg", ".png", ".webp"]);
export const postprocessPipelineVersion = 1;
export const postprocessDownsampleAlgorithm = "lanczos3";
export const maxPostprocessPixels = 64 * 1024 * 1024;
export const maxUpscaleIntermediatePixels = 128 * 1024 * 1024;
export const upscaleModelId = "real-esrgan-x4plus-anime-6b";
export const upscaleModelManifestRelativePath = path.join("library", "lora-training", "upscalers", `${upscaleModelId}.json`);
export const runningStatuses = new Set(["starting", "running", "stopping"]);
const loraHashCache = new Map();

export class LoraTrainingError extends Error {
  constructor(status, code, details) {
    super(code);
    this.name = "LoraTrainingError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createId(kind) {
  return `${kind}-${randomBytes(6).toString("hex")}`;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(target, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new LoraTrainingError(422, "invalid_lora_training_json", [path.basename(target)]);
    throw error;
  }
}

export async function writeAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
    loraHashCache.delete(target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(target, value) {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function prepareFileChange(target, content) {
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new LoraTrainingError(422, "unsafe_lora_training_storage", [target]);
  return { target, content, previous: info ? await readFile(target) : null };
}

export async function commitFileChanges(changes) {
  const prepared = [];
  const targets = new Set();
  for (const change of changes) {
    if (targets.has(change.target)) throw new LoraTrainingError(500, "duplicate_lora_training_file_change", [change.target]);
    targets.add(change.target);
    prepared.push(await prepareFileChange(change.target, change.content));
  }
  const committed = [];
  try {
    for (const change of prepared) {
      if (change.content === null) await unlink(change.target).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      else await writeAtomic(change.target, change.content);
      committed.push(change);
    }
  } catch (error) {
    for (const change of committed.reverse()) {
      if (change.previous === null) await unlink(change.target).catch(() => undefined);
      else await writeAtomic(change.target, change.previous).catch(() => undefined);
    }
    throw error;
  }
}

export async function sha256File(target) {
  const info = await stat(target);
  const cached = loraHashCache.get(target);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.sha256;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  loraHashCache.set(target, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
  return sha256;
}

export async function readLogTail(target, maxBytes = 32 * 1024) {
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return "";
  const start = Math.max(0, info.size - maxBytes);
  const handle = await import("node:fs/promises").then(({ open }) => open(target, "r"));
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8").replace(/^.*?\n/, start ? "" : (match) => match).slice(-maxBytes);
  } finally {
    await handle.close();
  }
}

export function loraInputsRoot(projectDirectory) { return path.join(projectDirectory, "workspace"); }

export function datasetRoot(repositoryRoot, datasetId) { return registeredProjectPath(repositoryRoot, datasetId, "training"); }
export function taskRoot(repositoryRoot, taskId) { return datasetRoot(repositoryRoot, taskId); }

// 历史记录保留训练时的标识，不将旧 manifest 改写为当前项目事实。
export function trainingRecordProjectRoot(repositoryRoot, taskId) {
  const projects = listRegisteredProjects(repositoryRoot, "training");
  const entry = projects.find(item => item.id === taskId) ?? projects.find(item => item.available && existsSync(path.join(item.path, "Training", taskId)));
  if (!entry) throw new LoraTrainingError(404, "training_project_not_found");
  return entry.path;
}
export function runRoot(repositoryRoot, taskId, runId) {
  if (!idPatterns.run.test(runId) || !idPatterns.task.test(taskId)) throw new LoraTrainingError(400, "invalid_lora_training_run_id");
  return path.join(trainingRecordProjectRoot(repositoryRoot, taskId), "Saved", "Training", taskId, runId);
}

export function checkpointDirectoryFromManifest(manifest, fallback = null) {
  // v5 清单直接冻结 checkpoints_dir；v4 历史清单只能从 sd-scripts argv 推断。
  if (typeof manifest?.paths?.checkpoints_dir === "string" && manifest.paths.checkpoints_dir.trim()) return path.resolve(manifest.paths.checkpoints_dir);
  const outputIndex = manifest?.execution?.argv?.indexOf("--output_dir") ?? -1;
  const outputDirectory = outputIndex >= 0 ? manifest.execution.argv[outputIndex + 1] : null;
  return typeof outputDirectory === "string" && outputDirectory.trim() ? path.resolve(outputDirectory) : fallback;
}

export function itemPaths(projectDirectory, datasetId, item) {
  const root = datasetRoot(projectDirectory, datasetId);
  const image = path.resolve(root, item.file ?? "");
  if (!isWithin(root, image) || !imageExtensions.has(path.extname(image).toLowerCase()) || !/^assets\/(?:asset-[a-f0-9]{12}|[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{3})\/(?:original|processed-[a-f0-9]{64})\.(?:jpe?g|png|webp)$/i.test(String(item.file ?? "").replaceAll("\\", "/"))) {
    throw new LoraTrainingError(422, "invalid_lora_training_item_path", [item.id]);
  }
  const relativeParts = String(item.file).replaceAll("\\", "/").split("/");
  if (relativeParts[1] !== item.asset_id) throw new LoraTrainingError(422, "invalid_lora_training_item_path", [item.id]);
  const assetDirectory = path.join(root, "assets", item.asset_id);
  return { image, caption: path.join(assetDirectory, "caption.txt"), meta: path.join(assetDirectory, "meta.json"), assetDirectory };
}

export function assetMetaPath(projectDirectory, datasetId, assetId) {
  if (!idPatterns.asset.test(assetId ?? "")) throw new LoraTrainingError(422, "invalid_lora_training_asset_id");
  return path.join(datasetRoot(projectDirectory, datasetId), "assets", assetId, "meta.json");
}

export async function readSafeDatasetFile(projectDirectory, datasetId, target, detail) {
  const root = datasetRoot(projectDirectory, datasetId);
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new LoraTrainingError(422, "unsafe_lora_training_dataset_storage", [detail]);
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  if (!isWithin(rootReal, targetReal)) throw new LoraTrainingError(422, "unsafe_lora_training_dataset_storage", [detail]);
  return readFile(target);
}

export async function readOriginalAssetProjection(projectDirectory, datasetId, assetId) {
  const directory = path.join(datasetRoot(projectDirectory, datasetId), "assets", assetId);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const imageEntries = entries.filter((entry) => /^original\.(?:jpe?g|png|webp)$/i.test(entry.name));
  const entry = imageEntries.find((candidate) => /^original\./i.test(candidate.name));
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new LoraTrainingError(422, "unsafe_lora_training_dataset_storage", [assetId]);
  const filename = entry.name;
  const imagePath = path.join(directory, filename);
  const buffer = await readSafeDatasetFile(projectDirectory, datasetId, imagePath, assetId);
  if (!buffer) return null;
  const metadata = await orientedImageMetadata(buffer).catch(() => null);
  return {
    filename,
    bytes: buffer.length,
    width: metadata?.width ?? null,
    height: metadata?.height ?? null,
    version: createHash("sha256").update(buffer).digest("hex"),
  };
}

export async function readAssetSource(projectDirectory, datasetId, assetId) {
  const meta = await readJson(assetMetaPath(projectDirectory, datasetId, assetId), { optional: true });
  if (meta === null) return "";
  if (!isRecord(meta) || (meta.source !== undefined && (typeof meta.source !== "string" || !meta.source.trim()))) {
    throw new LoraTrainingError(422, "invalid_lora_training_asset_meta", [assetId]);
  }
  return meta.source?.trim() ?? "";
}

export async function readAssetMeta(projectDirectory, datasetId, assetId) {
  const meta = await readJson(assetMetaPath(projectDirectory, datasetId, assetId), { optional: true });
  if (!isRecord(meta) || meta.version !== 1) throw new LoraTrainingError(422, "invalid_lora_training_asset_meta", [assetId]);
  const allowedKeys = new Set(["version", "source", "original", "current", "processing", "preparation", "preparation_error", "pipeline_version"]);
  const originalFile = meta.original?.file;
  const currentFile = meta.current?.file;
  const validOriginal = typeof originalFile === "string" && /^original\.(?:jpe?g|png|webp)$/i.test(originalFile);
  const validCurrent = typeof currentFile === "string" && (/^original\.(?:jpe?g|png|webp)$/i.test(currentFile) || /^processed-[a-f0-9]{64}\.png$/.test(currentFile));
  if ([...Object.keys(meta)].some((key) => !allowedKeys.has(key)) || !validOriginal || !validCurrent || !sha256Pattern.test(meta.original?.sha256 ?? "") || !sha256Pattern.test(meta.current?.sha256 ?? "") || (meta.source !== undefined && (typeof meta.source !== "string" || !meta.source.trim())) || !Number.isInteger(meta.pipeline_version) || meta.pipeline_version < 1) {
    throw new LoraTrainingError(422, "invalid_lora_training_asset_meta", [assetId]);
  }
  if (meta.processing !== null) {
    const processing = meta.processing;
    const crop = processing?.crop;
    const validCrop = isRecord(crop) && [crop.x, crop.y, crop.width, crop.height].every(Number.isInteger) && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0;
    const validScale = processing?.upscale === true ? [1, 2, 4].includes(processing.output_scale) : processing?.upscale === false && processing.output_scale === null;
    const validModel = processing?.upscale === true
      ? processing.model?.id === upscaleModelId && sha256Pattern.test(processing.model?.sha256 ?? "")
      : processing.model === null;
    if (!isRecord(processing) || !validCrop || !validScale || !validModel || !Number.isInteger(processing.pipeline_version) || processing.pipeline_version < 1) throw new LoraTrainingError(422, "invalid_lora_training_asset_meta", [assetId]);
  }
  if (meta.preparation !== undefined && (!validPreparation(meta.preparation)
    || !/^processed-[a-f0-9]{64}\.png$/.test(meta.preparation.baseline_file ?? "")
    || (meta.preparation.enhanced_file !== null && !/^processed-[a-f0-9]{64}\.png$/.test(meta.preparation.enhanced_file ?? ""))
    || meta.current.file !== (meta.preparation.decision === "enhanced" ? meta.preparation.enhanced_file : meta.preparation.baseline_file))) {
    throw new LoraTrainingError(422, "invalid_lora_training_asset_meta", [assetId]);
  }
  return meta;
}

export async function normalizeOrientedImage(buffer) {
  const result = await sharp(buffer).rotate().toColourspace("srgb").png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
  if (!result.info.width || !result.info.height) throw new LoraTrainingError(422, "invalid_lora_training_image");
  return result;
}

export async function orientedImageMetadata(buffer) {
  const metadata = await sharp(buffer).metadata();
  const swap = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  return { ...metadata, width: swap ? metadata.height : metadata.width, height: swap ? metadata.width : metadata.height };
}

export function normalizeCropPixels(crop, width, height) {
  if (!isRecord(crop) || !["x", "y", "width", "height"].every((key) => Number.isFinite(crop[key]))) throw new LoraTrainingError(422, "invalid_lora_training_crop");
  const left = Math.round(crop.x);
  const top = Math.round(crop.y);
  const right = Math.round(crop.x + crop.width);
  const bottom = Math.round(crop.y + crop.height);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (![left, top, cropWidth, cropHeight].every(Number.isInteger) || left < 0 || top < 0 || cropWidth < 1 || cropHeight < 1 || left + cropWidth > width || top + cropHeight > height) throw new LoraTrainingError(422, "invalid_lora_training_crop");
  return { x: left, y: top, width: cropWidth, height: cropHeight };
}

export function normalizeCropInput(crop, width, height) {
  if (isRecord(crop) && ["x", "y", "width", "height"].every((key) => Number.isFinite(crop[key])) && ["x", "y", "width", "height"].every((key) => crop[key] >= 0 && crop[key] <= 1) && (crop.width <= 1 || crop.height <= 1)) {
    return normalizeCropPixels({ x: crop.x * width, y: crop.y * height, width: crop.width * width, height: crop.height * height }, width, height);
  }
  return normalizeCropPixels(crop, width, height);
}

export function cropChangesImage(crop, width, height) {
  return crop.x !== 0 || crop.y !== 0 || crop.width !== width || crop.height !== height;
}

export function postprocessFingerprint({ originalSha256, crop, upscale, outputScale, modelSha256, pipelineVersion = postprocessPipelineVersion }) {
  return createHash("sha256").update(canonicalJson({ original_sha256: originalSha256, crop, upscale: Boolean(upscale), output_scale: outputScale ?? null, model_sha256: modelSha256 ?? null, downsample_algorithm: postprocessDownsampleAlgorithm, pipeline_version: pipelineVersion })).digest("hex");
}

export function validateBaseDirIdentity(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是底模目录身份对象`);
    return;
  }
  const relativePath = value.relative_path;
  // v5 的 base 各项是 models_root 下的目录前缀；逐文件身份以 library/lora-training/qwen-image21-models.json 为准。
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.includes("..") || relativePath.includes("\\") || !relativePath.endsWith("/")) {
    errors.push(`${label}.relative_path 必须是 models_root 下以 / 结尾的正斜杠目录前缀`);
  }
  if (Object.hasOwn(value, "sha256")) errors.push(`${label} 不带单文件 sha256；逐文件身份见模型清单`);
  if (value.source !== undefined && (typeof value.source !== "string" || !value.source.trim())) errors.push(`${label}.source 必须是非空字符串`);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateTarget(value, errors) {
  if (!isRecord(value) || value.family !== "qwen-image-2-1") errors.push("target.family 必须为 qwen-image-2-1");
  if (typeof value?.prompt_family !== "string" || !value.prompt_family.trim()) errors.push("target.prompt_family 不能为空");
  if (!isRecord(value?.usage_defaults)) errors.push("target.usage_defaults 必须是对象");
  else {
    const usage = value.usage_defaults;
    if (usage.clip_skip !== null && (!Number.isInteger(usage.clip_skip) || usage.clip_skip < 1)) errors.push("target.usage_defaults.clip_skip 必须是正整数或 null");
    if (typeof usage.sampler !== "string" || !usage.sampler) errors.push("target.usage_defaults.sampler 不能为空");
    if (typeof usage.scheduler !== "string" || !usage.scheduler) errors.push("target.usage_defaults.scheduler 不能为空");
    if (!Number.isInteger(usage.steps) || usage.steps < 1) errors.push("target.usage_defaults.steps 必须是正整数");
    if (typeof usage.cfg !== "number" || usage.cfg < 0) errors.push("target.usage_defaults.cfg 必须是非负数");
  }
  for (const kind of ["dit", "text_encoder", "vae", "processor"]) validateBaseDirIdentity(value.base?.[kind], `target.base.${kind}`, errors);
}

export function validateActivationTerms(value, errors, label = "activation_terms") {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return;
  }
  const terms = new Set();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${label}[${index}] 必须是非空字符串`);
      continue;
    }
    const normalized = entry.trim().toLocaleLowerCase("en");
    if (terms.has(normalized)) errors.push(`${label} 包含重复标签：${entry.trim()}`);
    terms.add(normalized);
  }
}

export const loraTrainingOverrideDefinitions = Object.freeze({
  network_dim: "integer",
  learning_rate: "number",
  gradient_accumulation_steps: "integer",
});

export function validateTrainingRecipeOverrides(value, errors) {
  if (!isRecord(value)) {
    errors.push("training_recipe.overrides 必须是对象");
    return;
  }
  validateExactKeys(value, Object.keys(loraTrainingOverrideDefinitions), "training_recipe.overrides", errors);
  for (const [key, kind] of Object.entries(loraTrainingOverrideDefinitions)) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    const valid = kind === "integer"
      ? Number.isInteger(entry) && entry >= 1
      : typeof entry === "number" && Number.isFinite(entry) && entry > 0;
    if (!valid) errors.push(`training_recipe.overrides.${key} 无效`);
  }
}

export function validateExactKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.includes(key)) errors.push(`${label} 包含未支持字段：${key}`);
  }
}

export function validateLoraTrainingDataset(value) {
  const errors = [];
  if (!isRecord(value)) return ["dataset.json 必须是 JSON 对象"];
  validateExactKeys(value, ["version", "name", "description", "activation_terms", "groups", "items"], "dataset.json", errors);
  if (value.version !== 5) errors.push("version 必须为 5");
  if (typeof value.name !== "string" || !value.name.trim()) errors.push("name 不能为空");
  if (typeof value.description !== "string") errors.push("description 无效");
  if (Object.hasOwn(value, "concept") || Object.hasOwn(value, "plan")) errors.push("dataset.json 不再保存 concept 或 plan，请手动迁移到 description");
  validateActivationTerms(value.activation_terms, errors);
  if (!Array.isArray(value.groups)) errors.push("groups 必须是数组");
  if (!Array.isArray(value.items)) errors.push("items 必须是数组");
  const groupIds = new Set();
  for (const group of value.groups ?? []) {
    if (!isRecord(group) || !idPatterns.group.test(group.id ?? "")) errors.push("分组 ID 无效");
    else if (groupIds.has(group.id)) errors.push(`分组 ID 重复：${group.id}`);
    else groupIds.add(group.id);
    if (typeof group?.name !== "string" || !group.name.trim()) errors.push(`${group?.id ?? "分组"} 的名称不能为空`);
    if (typeof group?.enabled !== "boolean") errors.push(`${group?.id ?? "分组"} 的 enabled 必须是布尔值`);
    if (!Number.isInteger(group?.repeats) || group.repeats < 1) errors.push(`${group?.id ?? "分组"} 的 repeats 必须是正整数`);
    if (Object.keys(group ?? {}).some((key) => !["id", "name", "enabled", "repeats"].includes(key))) errors.push(`${group?.id ?? "分组"} 包含未支持字段`);
  }
  const itemIds = new Set();
  const assetIds = new Set();
  for (const item of value.items ?? []) {
    validateExactKeys(item, ["id", "asset_id", "group_id", "enabled"], item?.id ?? "图片项", errors);
    if (!isRecord(item) || !idPatterns.item.test(item.id ?? "")) errors.push("图片项 ID 无效");
    else if (itemIds.has(item.id)) errors.push(`图片项 ID 重复：${item.id}`);
    else itemIds.add(item.id);
    if (!idPatterns.asset.test(item?.asset_id ?? "")) errors.push(`${item?.id ?? "图片项"} 的 asset_id 无效`);
    else if (assetIds.has(item.asset_id)) errors.push(`asset_id 重复：${item.asset_id}`);
    else assetIds.add(item.asset_id);
    if (!groupIds.has(item?.group_id)) errors.push(`${item?.id ?? "图片项"} 引用了未知分组`);
    if (typeof item?.enabled !== "boolean") errors.push(`${item?.id ?? "图片项"} 的 enabled 必须是布尔值`);
    if (Object.hasOwn(item ?? {}, "file")) errors.push(`${item?.id ?? "图片项"} 不保存 file；当前图片由 asset meta.json 唯一确定`);
    if (Object.hasOwn(item ?? {}, "crop")) errors.push(`${item?.id ?? "图片项"} 不再保存 crop；请使用 asset meta.json 的后处理配方`);
  }
  if (JSON.stringify(value).includes('"caption"')) errors.push("dataset.json 不保存 Caption；Caption 只存在于 asset/caption.txt");
  return [...new Set(errors)];
}

export function validateLoraTrainingTask(value) {
  const errors = [];
  if (!isRecord(value)) return ["plan.json 必须是 JSON 对象"];
  validateExactKeys(value, ["version", "name", "dataset_id", "target", "training_recipe", "run_defaults"], "plan.json", errors);
  if (value.version !== 5) errors.push("version 必须为 5");
  errors.push(...validateSavedRunSettings(value.run_defaults));
  if (typeof value.name !== "string" || !value.name.trim()) errors.push("name 不能为空");
  if (!idPatterns.dataset.test(value.dataset_id ?? "")) errors.push("dataset_id 无效");
  validateTarget(value.target, errors);
  if (!isRecord(value.training_recipe) || typeof value.training_recipe.id !== "string" || !value.training_recipe.id.trim()) errors.push("training_recipe 无效");
  else {
    validateTrainingRecipeOverrides(value.training_recipe.overrides, errors);
    for (const key of Object.keys(loraTrainingOverrideDefinitions)) {
      if (!Object.hasOwn(value.training_recipe.overrides ?? {}, key)) errors.push(`training_recipe.overrides.${key} 必填`);
    }
  }
  if (Object.hasOwn(value, "concept") || Object.hasOwn(value, "plan") || Object.hasOwn(value, "groups") || Object.hasOwn(value, "items")) errors.push("训练任务只保存数据集引用和训练配置");
  if (Object.hasOwn(value, "runs") || Object.hasOwn(value, "run_summaries")) errors.push("plan.json 不保存 run 摘要；run 从 Outputs/lora-training 读取");
  return [...new Set(errors)];
}



export function assertLoraTrainingRunManifest(manifest, { taskId = null, runId = null } = {}) {
  const errors = validateLoraTrainingRunManifest(manifest);
  if (runId && manifest?.id !== runId) errors.push("manifest.id 与 run 目录不一致");
  if (taskId && manifest?.task_id !== taskId) errors.push("manifest.task_id 与任务目录不一致");
  if (errors.length) throw new LoraTrainingError(422, "invalid_lora_training_run_manifest", [...new Set(errors)]);
  return manifest;
}

export function configuredPath(projectRoot, value, fallback) {
  const selected = typeof value === "string" && value.trim() ? value : fallback;
  return selected ? path.resolve(projectRoot, selected) : null;
}

export function generatedRunRoot(projectDirectory, taskId, runId) {
  runRoot(projectDirectory, taskId, runId);
  return path.join(trainingRecordProjectRoot(projectDirectory, taskId), "Training", taskId, runId);
}
