import { listRegisteredProjects, registerProject } from "./project-registry.mjs";
import { initialRunSettings } from "./lora-training-settings.mjs";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as support from "./lora-training-support.mjs";
import { listLoraTrainingRuns } from "./lora-training-run-index.mjs";
import { readLoraTrainingRecipe } from "./lora-training-recipe.mjs";

const {
  LoraTrainingError, idPatterns, sha256Pattern, imageExtensions, postprocessPipelineVersion,
  postprocessDownsampleAlgorithm, createId, isRecord, isWithin, exists, readJson, writeAtomic,
  writeJsonAtomic, commitFileChanges, sha256File, readLogTail, loraInputsRoot, datasetRoot,
  taskRoot, itemPaths, assetMetaPath, readSafeDatasetFile, readOriginalAssetProjection,
  readAssetSource, readAssetMeta, normalizeOrientedImage, orientedImageMetadata, canonicalJson,
  validateLoraTrainingDataset, validateLoraTrainingTask, assertLoraTrainingRunManifest,
  configuredPath, execFileAsync,
} = support;

export async function requireStoredDocument(projectDirectory, directory, filename, validate, missingCode, unsafeCode, invalidCode) {
  const directoryInfo = await lstat(directory).catch(() => null);
  if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) throw new LoraTrainingError(422, unsafeCode);
  if (directoryInfo) {
    const projectReal = path.resolve(directory);
    const directoryReal = await realpath(directory);
    if (!isWithin(projectReal, directoryReal)) throw new LoraTrainingError(422, unsafeCode);
  }
  const file = path.join(directory, filename);
  const fileInfo = await lstat(file).catch(() => null);
  if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink())) throw new LoraTrainingError(422, unsafeCode);
  const value = await readJson(file, { optional: true });
  if (!value) throw new LoraTrainingError(404, missingCode);
  const errors = validate(value);
  if (errors.length) throw new LoraTrainingError(422, invalidCode, errors);
  return { directory, value };
}

export async function requireDataset(projectDirectory, datasetId) {
  const stored = await requireStoredDocument(projectDirectory, datasetRoot(projectDirectory, datasetId), "project.json", validateLoraTrainingDataset, "lora_training_dataset_not_found", "unsafe_lora_training_dataset_storage", "invalid_lora_training_dataset");
  const dataset = structuredClone(stored.value);
  for (const item of dataset.items) {
    const meta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
    item.file = `assets/${item.asset_id}/${meta.current.file}`;
    const files = itemPaths(projectDirectory, datasetId, item);
    const originalPath = path.join(files.assetDirectory, meta.original.file);
    const currentPath = path.join(files.assetDirectory, meta.current.file);
    for (const target of [files.assetDirectory, originalPath, currentPath, files.caption, files.meta]) {
      const info = await lstat(target).catch(() => null);
      if (!info || info.isSymbolicLink() || (target === files.assetDirectory ? !info.isDirectory() : !info.isFile())) throw new LoraTrainingError(422, "unsafe_lora_training_dataset_storage", [item.id]);
      if (info) {
        const targetReal = await realpath(target);
        if (!isWithin(await realpath(files.assetDirectory), targetReal)) throw new LoraTrainingError(422, "unsafe_lora_training_dataset_storage", [item.id]);
      }
    }
    const [originalSha256, currentSha256] = await Promise.all([sha256File(originalPath), sha256File(currentPath)]);
    if (originalSha256 !== meta.original.sha256 || currentSha256 !== meta.current.sha256) throw new LoraTrainingError(422, "invalid_lora_training_asset_meta", [item.id, "图片 SHA-256 与 meta.json 不一致"]);
  }
  return { directory: stored.directory, dataset, storedDataset: stored.value };
}

export function storedDatasetProjection(dataset) {
  return {
    ...dataset,
    items: dataset.items.map(({ file: _file, ...item }) => item),
  };
}

export async function requireDatasetForUpdate(projectDirectory, datasetId) {
  return requireDataset(projectDirectory, datasetId);
}

export async function requireTask(projectDirectory, taskId) {
  const stored = await requireStoredDocument(projectDirectory, taskRoot(projectDirectory, taskId), "settings.json", value => validateLoraTrainingTask({ ...value, name: "训练项目", dataset_id: taskId }), "lora_training_task_not_found", "unsafe_lora_training_task_storage", "invalid_lora_training_task");
  const { dataset } = await requireDataset(projectDirectory, taskId);
  return { directory: stored.directory, task: { ...stored.value, name: dataset.name, dataset_id: taskId } };
}

export async function createLoraTrainingDataset(projectDirectory, input = {}) {
  if (Object.hasOwn(input, "concept") || Object.hasOwn(input, "plan")) throw new LoraTrainingError(422, "lora_training_dataset_legacy_fields", ["dataset.json 不再接受 concept 或 plan，请使用 description"]);
  const id = createId("dataset");
  const groupId = createId("group");
  const dataset = {
    version: 5,
    name: String(input.name ?? "新数据集").trim() || "新数据集",
    description: String(input.description ?? "").trim(),
    activation_terms: Array.isArray(input.activation_terms) ? input.activation_terms.map((entry) => String(entry ?? "").trim()) : [],
    groups: [{ id: groupId, name: "主要素材", enabled: true, repeats: 1 }],
    items: [],
  };
  const errors = validateLoraTrainingDataset(dataset);
  if (errors.length) throw new LoraTrainingError(422, "invalid_lora_training_dataset", errors);
  const directory = input.path ? path.resolve(input.path) : path.join(projectDirectory, "workspace", id);
  if (await exists(directory)) throw new LoraTrainingError(409, "training_project_already_exists");
  await mkdir(directory, { recursive: true });
  registerProject(projectDirectory, { id, type: "training", path: directory, temporary: !input.path });
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeJsonAtomic(path.join(directory, "project.json"), dataset);
  await createLoraTrainingTask(projectDirectory, projectDirectory, { dataset_id: id });
  return readLoraTrainingDataset(projectDirectory, id);
}

export async function createLoraTrainingTask(projectRoot, projectDirectory, input = {}) {
  const datasetId = String(input.dataset_id ?? "");
  const id = datasetId;
  if (await exists(path.join(taskRoot(projectDirectory, id), "settings.json"))) return readLoraTrainingTask(projectDirectory, id);
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  if (input?.target?.family && input.target.family !== "anima") throw new LoraTrainingError(422, "unsupported_lora_training_family");
  const family = "anima";
  const trainerManifest = await readJson(path.join(projectRoot, "library", "lora-training", "trainer.json"), { optional: true });
  const referenceBase = trainerManifest?.reference_models?.[family];
  const defaultTarget = {
    family: "anima",
    prompt_family: "anima",
    usage_defaults: { clip_skip: null, sampler: "euler", scheduler: "simple", steps: 24, cfg: 4 },
    base: referenceBase ? Object.fromEntries(["dit", "text_encoder", "vae", "llm_adapter"].filter((key) => referenceBase[key]).map((key) => [key, referenceBase[key]])) : {
      dit: { relative_path: "diffusion_models/anima-base-v1.0.safetensors" },
      text_encoder: { relative_path: "text_encoders/qwen_3_06b_base.safetensors" },
      vae: { relative_path: "vae/qwen_image_vae.safetensors" },
    },
  };
  const target = {
    family,
    prompt_family: String(input?.target?.prompt_family ?? defaultTarget.prompt_family).trim() || defaultTarget.prompt_family,
    usage_defaults: { ...defaultTarget.usage_defaults, ...(isRecord(input?.target?.usage_defaults) ? input.target.usage_defaults : {}) },
    base: input?.target?.base ?? defaultTarget.base,
  };
  const recipeId = typeof input.recipe_id === "string" ? input.recipe_id : "anima-character-r32-v1";
  const recipe = await readLoraTrainingRecipe(projectRoot, recipeId);
  if (!recipe || recipe.family !== family) throw new LoraTrainingError(422, "invalid_training_recipe");
  const task = {
    version: 4,
    name: String(input.name ?? `${dataset.name} · Anima`).trim() || `${dataset.name} · Anima`,
    dataset_id: datasetId,
    target,
    training_recipe: { id: recipeId, overrides: Object.fromEntries(Object.keys(support.loraTrainingOverrideDefinitions).map(key => [key, recipe.semantic_config[key]])) },
    run_defaults: initialRunSettings(),
  };
  const errors = validateLoraTrainingTask(task);
  if (errors.length) throw new LoraTrainingError(422, "invalid_lora_training_task", errors);
  const directory = taskRoot(projectDirectory, id);
  await mkdir(directory, { recursive: true });
  const { name: _name, dataset_id: _dataset, ...settings } = task;
  await writeJsonAtomic(path.join(directory, "settings.json"), settings);
  return readLoraTrainingTask(projectDirectory, id);
}

export const listRuns = listLoraTrainingRuns;

export async function readDatasetItems(projectDirectory, datasetId, dataset) {
  const items = [];
  const assetSources = new Map();
  const originalAssets = new Map();
  for (const item of dataset.items) {
    const files = itemPaths(projectDirectory, datasetId, item);
    const caption = await readFile(files.caption, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error));
    const captionSha256 = await sha256File(files.caption).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    const info = await stat(files.image).catch(() => null);
    const imageBuffer = await readFile(files.image).catch(() => null);
    const metadata = imageBuffer ? await orientedImageMetadata(imageBuffer).catch(() => null) : null;
    const imageVersion = imageBuffer ? createHash("sha256").update(imageBuffer).digest("hex") : null;
    if (!assetSources.has(item.asset_id)) {
      assetSources.set(item.asset_id, await readAssetSource(projectDirectory, datasetId, item.asset_id));
    }
    if (!originalAssets.has(item.asset_id)) {
      originalAssets.set(item.asset_id, await readOriginalAssetProjection(projectDirectory, datasetId, item.asset_id));
    }
    const source = assetSources.get(item.asset_id);
    const original = originalAssets.get(item.asset_id);
    const meta = await readAssetMeta(projectDirectory, datasetId, item.asset_id);
    items.push({
      ...item,
      ...(source ? { source } : {}),
      ...(original ? {
        original_media_url: `lora-training/datasets/${datasetId}/assets/${item.asset_id}/${original.filename}`,
        original_image_bytes: original.bytes,
        original_image_width: original.width,
        original_image_height: original.height,
        original_image_version: original.version,
      } : {}),
      ...(meta.processing ? { processing: structuredClone(meta.processing) } : {}),
      ...(meta.preparation_error ? { preparation_error: String(meta.preparation_error) } : {}),
      ...(meta.preparation ? { preparation: structuredClone(meta.preparation) } : {}),
      ...(meta.original ? { original_file: meta.original.file, original_sha256: meta.original.sha256 ?? original?.version ?? null } : {}),
      caption: caption.trimEnd(),
      caption_sha256: captionSha256,
      image_bytes: info?.size ?? null,
      image_width: metadata?.width ?? null,
      image_height: metadata?.height ?? null,
      image_version: imageVersion,
      media_url: `lora-training/datasets/${datasetId}/${item.file.replaceAll("\\", "/")}`,
    });
  }
  return items;
}

export async function readLoraTrainingDataset(projectDirectory, datasetId) {
  const { dataset, storedDataset } = await requireDataset(projectDirectory, datasetId);
  const items = await readDatasetItems(projectDirectory, datasetId, dataset);
  const captioning = await readCaptioningProjection(projectDirectory, datasetId, dataset, items);
  return { id: datasetId, dataset: storedDataset, items, captioning };
}

export function effectiveDatasetItemCount(dataset, items) {
  const enabledGroupIds = new Set(dataset.groups.filter((group) => group.enabled).map((group) => group.id));
  return items.filter((item) => item.enabled && enabledGroupIds.has(item.group_id)).length;
}

export async function listLoraTrainingDatasets(projectDirectory) {
  const entries = listRegisteredProjects(projectDirectory, "training");
  const datasets = [];
  for (const entry of entries) {
    if (!entry.available) continue;
    // 导航摘要只依赖 dataset.json；图片完整性与 Caption 在打开详情和训练预检时检查。
    try {
      const { value: dataset } = await requireStoredDocument(projectDirectory, datasetRoot(projectDirectory, entry.id), "project.json", validateLoraTrainingDataset, "lora_training_dataset_not_found", "unsafe_lora_training_dataset_storage", "invalid_lora_training_dataset");
      datasets.push({ id: entry.id, name: dataset.name, activation_terms: dataset.activation_terms, item_count: dataset.items.length, enabled_item_count: dataset.items.filter((item) => item.enabled).length, effective_item_count: effectiveDatasetItemCount(dataset, dataset.items) });
    } catch (error) {
      datasets.push({ id: entry.id, error: error.code ?? "invalid_lora_training_dataset" });
    }
  }
  return { datasets };
}

export async function updateLoraTrainingDataset(projectDirectory, datasetId, value) {
  const { directory, dataset: current } = await requireDatasetForUpdate(projectDirectory, datasetId);
  const next = {
    ...value,
    version: 5,
  };
  const errors = validateLoraTrainingDataset(next);
  if (errors.length) throw new LoraTrainingError(422, "invalid_lora_training_dataset", errors);
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  for (const item of next.items) {
    const previous = currentById.get(item.id);
    if (!previous || previous.asset_id !== item.asset_id) throw new LoraTrainingError(409, "lora_training_item_identity_locked", [item.id]);
  }
  await pruneCaptioningLatest(projectDirectory, datasetId, next.items.map((item) => item.id));
  await writeJsonAtomic(path.join(directory, "project.json"), storedDatasetProjection(next));
  const nextItemIds = new Set(next.items.map((item) => item.id));
  const removedAssets = new Set(current.items.filter((item) => !nextItemIds.has(item.id)).map((item) => item.asset_id));
  for (const assetId of removedAssets) {
    if (!next.items.some((item) => item.asset_id === assetId)) {
      const assetDirectory = path.join(directory, "assets", assetId);
      if (isWithin(path.join(directory, "assets"), assetDirectory)) await rm(assetDirectory, { recursive: true, force: true });
    }
  }
  return readLoraTrainingDataset(projectDirectory, datasetId);
}

export async function readLoraTrainingTask(projectDirectory, taskId) {
  const { task } = await requireTask(projectDirectory, taskId);
  const [storedDataset, runs] = await Promise.all([
    requireStoredDocument(
      projectDirectory,
      datasetRoot(projectDirectory, task.dataset_id),
      "project.json",
      validateLoraTrainingDataset,
      "lora_training_dataset_not_found",
      "unsafe_lora_training_dataset_storage",
      "invalid_lora_training_dataset",
    ),
    listRuns(projectDirectory, taskId),
  ]);
  const dataset = storedDataset.value;
  return { id: taskId, task, dataset: { id: task.dataset_id, name: dataset.name, activation_terms: dataset.activation_terms, item_count: dataset.items.length, enabled_item_count: dataset.items.filter((item) => item.enabled).length, effective_item_count: effectiveDatasetItemCount(dataset, dataset.items) }, runs };
}

export async function listLoraTrainingTasks(projectDirectory) {
  const entries = listRegisteredProjects(projectDirectory, "training");
  const tasks = [];
  for (const entry of entries) {
    if (!entry.available) continue;
    const detail = await readLoraTrainingTask(projectDirectory, entry.id).catch((error) => ({ id: entry.id, error: error.code ?? "invalid_lora_training_task" }));
    if (detail.error) tasks.push(detail);
    else tasks.push({ id: detail.id, name: detail.task.name, family: detail.task.target.family, dataset: detail.dataset, runs: detail.runs.map(({ id, status: value, manifest, disk_bytes }) => ({ id, status: value.status, step: value.step ?? 0, created_at: manifest.created_at, disk_bytes })) });
  }
  tasks.sort((left, right) => {
    const latest = task => (task.runs ?? []).reduce((date, run) => run.created_at > date ? run.created_at : date, "");
    return latest(right).localeCompare(latest(left)) || (left.name ?? left.id).localeCompare(right.name ?? right.id, "zh-CN", { numeric: true }) || left.id.localeCompare(right.id);
  });
  return { tasks };
}

export async function updateLoraTrainingTask(projectRoot, projectDirectory, taskId, value) {
  const directory = taskRoot(projectDirectory, taskId);
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo) throw new LoraTrainingError(404, "lora_training_task_not_found");
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new LoraTrainingError(422, "unsafe_lora_training_task_storage");
  const projectReal = path.resolve(directory);
  const directoryReal = await realpath(directory);
  if (!isWithin(projectReal, directoryReal)) throw new LoraTrainingError(422, "unsafe_lora_training_task_storage");
  const taskFile = path.join(directory, "settings.json");
  const taskFileInfo = await lstat(taskFile).catch(() => null);
  if (!taskFileInfo) throw new LoraTrainingError(404, "lora_training_task_not_found");
  if (!taskFileInfo.isFile() || taskFileInfo.isSymbolicLink()) throw new LoraTrainingError(422, "unsafe_lora_training_task_storage");
  if (value.dataset_id !== taskId) throw new LoraTrainingError(422, "training_project_dataset_fixed");
  const next = { ...value, version: 4 };
  const errors = validateLoraTrainingTask(next);
  if (errors.length) throw new LoraTrainingError(422, "invalid_lora_training_task", errors);
  const recipe = await readLoraTrainingRecipe(projectRoot, next.training_recipe.id);
  if (!recipe || recipe.family !== next.target.family) throw new LoraTrainingError(422, "invalid_training_recipe");
  await requireStoredDocument(
    projectDirectory,
    datasetRoot(projectDirectory, next.dataset_id),
    "project.json",
    validateLoraTrainingDataset,
    "lora_training_dataset_not_found",
    "unsafe_lora_training_dataset_storage",
    "invalid_lora_training_dataset",
  );
  const { name: _name, dataset_id: _dataset, ...settings } = next;
  await writeJsonAtomic(taskFile, settings);
  return readLoraTrainingTask(projectDirectory, taskId);
}

export function safeUploadFilename(value) {
  const filename = path.basename(String(value ?? "image.png")).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const extension = path.extname(filename).toLowerCase();
  if (!imageExtensions.has(extension)) throw new LoraTrainingError(422, "unsupported_lora_training_image", [filename]);
  return { filename, extension };
}

export function optionalAssetSource(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new LoraTrainingError(422, "invalid_lora_training_asset_source");
  return value.trim() || undefined;
}

export function reserveAssetId(usedAssetIds, value) {
  let assetId;
  if (value === undefined || value === null || value === "") {
    do assetId = createId("asset"); while (usedAssetIds.has(assetId));
  } else {
    if (typeof value !== "string" || !idPatterns.asset.test(value.trim())) throw new LoraTrainingError(422, "invalid_lora_training_asset_id");
    assetId = value.trim();
  }
  if (usedAssetIds.has(assetId)) throw new LoraTrainingError(409, "lora_training_asset_id_conflict", [assetId]);
  usedAssetIds.add(assetId);
  return assetId;
}

export async function importOneAsset(projectDirectory, datasetId, dataset, groupId, source, assetId) {
  if (!dataset.groups.some((group) => group.id === groupId)) throw new LoraTrainingError(422, "unknown_lora_training_group");
  if (!idPatterns.asset.test(assetId ?? "")) throw new LoraTrainingError(422, "invalid_lora_training_asset_id");
  const itemId = createId("item");
  const { extension } = safeUploadFilename(source.filename);
  const assetSource = optionalAssetSource(source.source);
  const directory = path.join(datasetRoot(projectDirectory, datasetId), "assets", assetId);
  await mkdir(directory, { recursive: false });
  const target = path.join(directory, `original${extension === ".jpeg" ? ".jpg" : extension}`);
  try {
    if (source.buffer) await writeFile(target, source.buffer);
    else await copyFile(source.path, target);
    await normalizeOrientedImage(await readFile(target));
    const caption = String(source.caption ?? "").trim();
    await writeAtomic(path.join(directory, "caption.txt"), caption ? `${caption}\n` : "");
    const originalSha256 = createHash("sha256").update(await readFile(target)).digest("hex");
    await writeJsonAtomic(path.join(directory, "meta.json"), {
      version: 1,
      ...(assetSource ? { source: assetSource } : {}),
      original: { file: path.basename(target), sha256: originalSha256 },
      current: { file: path.basename(target), sha256: originalSha256 },
      processing: null,
      pipeline_version: postprocessPipelineVersion,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof LoraTrainingError) throw error;
    throw new LoraTrainingError(422, "invalid_lora_training_image", [source.filename, error.message]);
  }
  return { id: itemId, asset_id: assetId, file: path.relative(datasetRoot(projectDirectory, datasetId), target).replaceAll("\\", "/"), group_id: groupId, enabled: true };
}

export async function importLoraTrainingAssets(projectDirectory, datasetId, { group_id: groupId, asset_id: assetId, files = [] }) {
  const { directory, dataset } = await requireDataset(projectDirectory, datasetId);
  const imported = [];
  const usedAssetIds = new Set(dataset.items.map((item) => item.asset_id));
  try {
    for (const file of files) imported.push(await importOneAsset(projectDirectory, datasetId, dataset, groupId, file, reserveAssetId(usedAssetIds, file.asset_id ?? assetId)));
  } catch (error) {
    for (const item of imported) await rm(path.dirname(itemPaths(projectDirectory, datasetId, item).image), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (!imported.length) throw new LoraTrainingError(422, "no_lora_training_assets");
  dataset.items.push(...imported);
  await writeJsonAtomic(path.join(directory, "project.json"), storedDatasetProjection(dataset));
  return readLoraTrainingDataset(projectDirectory, datasetId);
}

export async function copyLoraTrainingItem(projectDirectory, datasetId, value) {
  const { directory, dataset } = await requireDataset(projectDirectory, datasetId);
  const source = dataset.items.find((item) => item.id === value?.source_item_id);
  if (!source) throw new LoraTrainingError(404, "lora_training_item_not_found");
  const groupId = value?.group_id ?? source.group_id;
  if (!dataset.groups.some((group) => group.id === groupId)) throw new LoraTrainingError(422, "unknown_lora_training_group");
  const assetId = reserveAssetId(new Set(dataset.items.map((item) => item.asset_id)), value?.asset_id);
  const itemId = createId("item");
  const latest = await readCaptioningLatest(projectDirectory, datasetId);
  const sourceLatest = latest.items[source.id];
  const sourceFiles = itemPaths(projectDirectory, datasetId, source);
  const assetDirectory = path.join(directory, "assets", assetId);
  try {
    const sourceAssetDirectory = path.dirname(sourceFiles.meta);
    await cp(sourceAssetDirectory, assetDirectory, { recursive: true, errorOnExist: true });
    const sourceMeta = await readAssetMeta(projectDirectory, datasetId, source.asset_id);
    const copiedMeta = structuredClone(sourceMeta);
    copiedMeta.version = 1;
    await writeJsonAtomic(path.join(assetDirectory, "meta.json"), copiedMeta);
    const currentFile = String(copiedMeta.current?.file ?? path.basename(sourceFiles.image));
    const target = path.join(assetDirectory, currentFile);
    await sharp(await readFile(target)).metadata();
  } catch (error) {
    await rm(assetDirectory, { recursive: true, force: true });
    if (error instanceof LoraTrainingError) throw error;
    throw new LoraTrainingError(422, "invalid_lora_training_image", [path.basename(sourceFiles.image), error.message]);
  }
  const copiedMeta = await readAssetMeta(projectDirectory, datasetId, assetId);
  const currentFile = String(copiedMeta.current?.file ?? path.basename(sourceFiles.image));
  dataset.items.push({ id: itemId, asset_id: assetId, file: `assets/${assetId}/${currentFile}`, group_id: groupId, enabled: source.enabled });
  try {
    await writeJsonAtomic(path.join(directory, "project.json"), storedDatasetProjection(dataset));
    if (sourceLatest) {
      const nextLatest = { ...latest, items: { ...latest.items, [itemId]: structuredClone(sourceLatest) } };
      await writeJsonAtomic(captioningLatestPath(projectDirectory, datasetId), nextLatest);
    }
  } catch (error) {
    dataset.items = dataset.items.filter((item) => item.id !== itemId);
    await writeJsonAtomic(path.join(directory, "project.json"), storedDatasetProjection(dataset)).catch(() => undefined);
    await rm(assetDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return readLoraTrainingDataset(projectDirectory, datasetId);
}



export async function saveLoraTrainingCaption(projectDirectory, datasetId, itemId, caption) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const item = dataset.items.find((entry) => entry.id === itemId);
  if (!item) throw new LoraTrainingError(404, "lora_training_item_not_found");
  if (typeof caption !== "string") throw new LoraTrainingError(422, "invalid_lora_training_caption");
  const files = itemPaths(projectDirectory, datasetId, item);
  const captionContent = caption.trim() ? `${caption.trim()}\n` : "";
  const latest = (await pruneCaptioningLatest(projectDirectory, datasetId, dataset.items.map((entry) => entry.id), null, { persist: false })).latest;
  if (latest.items[itemId]) latest.items[itemId] = { ...latest.items[itemId], confirmation: null };
  await commitFileChanges([
    { target: files.caption, content: captionContent },
    { target: captioningLatestPath(projectDirectory, datasetId), content: `${JSON.stringify(latest, null, 2)}\n` },
  ]);
  return { saved: true, item_id: itemId, caption: caption.trim() };
}

/*
 * 基础 Prompt 的持久化和三方合并。
 *
 * latest.json 只保存最近一次成功的自动结果；图片旁的 .txt 是当前有效文本，
 * 因此手工编辑不会覆盖自动结果。打标器本身通过配置注入，未配置时接口明确
 * 报错，不在服务端伪造标签。
 */
const captioningVersion = 1;
export function captioningRoot(projectDirectory, datasetId) {
  return path.join(datasetRoot(projectDirectory, datasetId), "captioning");
}

export function captioningLatestPath(projectDirectory, datasetId) {
  return path.join(captioningRoot(projectDirectory, datasetId), "latest.json");
}

const captionAuditVersion = 1;
const defaultCaptionAuditScope = Object.freeze({ family: "anima", prompt_family: "anima" });

export function captionAuditPath(projectDirectory, datasetId) {
  return path.join(captioningRoot(projectDirectory, datasetId), "audit.json");
}

export async function readCaptionAuditSnapshot(projectDirectory, datasetId) {
  const value = await readJson(captionAuditPath(projectDirectory, datasetId), { optional: true });
  if (value === null) return { version: captionAuditVersion, scope: { ...defaultCaptionAuditScope }, updated_at: null, images: {} };
  if (!isRecord(value)
    || value.version !== captionAuditVersion
    || !isRecord(value.scope)
    || value.scope.family !== defaultCaptionAuditScope.family
    || value.scope.prompt_family !== defaultCaptionAuditScope.prompt_family
    || (value.updated_at !== null && typeof value.updated_at !== "string")
    || !isRecord(value.images)) throw new LoraTrainingError(422, "invalid_lora_caption_audit");
  for (const [imageSha256, entry] of Object.entries(value.images)) {
    if (!sha256Pattern.test(imageSha256) || !isRecord(entry) || typeof entry.audited_at !== "string" || !entry.audited_at) {
      throw new LoraTrainingError(422, "invalid_lora_caption_audit", [imageSha256]);
    }
  }
  return value;
}

function captionAuditEntry(item, extra = {}) {
  return { item_id: item.id, asset_id: item.asset_id, image_sha256: item.image_version ?? null, ...extra };
}

export async function readLoraCaptionAudit(projectDirectory, datasetId) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const items = await readDatasetItems(projectDirectory, datasetId, dataset);
  const snapshot = await readCaptionAuditSnapshot(projectDirectory, datasetId);
  const enabledGroupIds = new Set(dataset.groups.filter((group) => group.enabled).map((group) => group.id));
  const effectiveItems = items.filter((item) => item.enabled && enabledGroupIds.has(item.group_id));
  const audited = [];
  const pending = [];
  const blocked = [];
  for (const item of effectiveItems) {
    if (!item.image_version || !item.image_width || !item.image_height) {
      blocked.push(captionAuditEntry(item, { reason: "invalid_image", message: "图片无法解码" }));
      continue;
    }
    if (!comparablePrompt(item.caption)) {
      blocked.push(captionAuditEntry(item, { reason: "empty_caption", message: "Caption 为空" }));
      continue;
    }
    const audit = snapshot.images[item.image_version];
    if (audit) audited.push(captionAuditEntry(item, { audited_at: audit.audited_at }));
    else pending.push(captionAuditEntry(item));
  }
  return {
    version: captionAuditVersion,
    scope: structuredClone(snapshot.scope),
    updated_at: snapshot.updated_at,
    summary: { total: effectiveItems.length, audited: audited.length, pending: pending.length, blocked: blocked.length },
    audited,
    pending,
    blocked,
  };
}

export async function recordLoraCaptionAudit(projectDirectory, datasetId, value) {
  const promptFamily = value?.prompt_family ?? defaultCaptionAuditScope.prompt_family;
  if (promptFamily !== defaultCaptionAuditScope.prompt_family || !Array.isArray(value?.image_sha256) || value.image_sha256.some((entry) => !sha256Pattern.test(entry ?? ""))) {
    throw new LoraTrainingError(422, "invalid_lora_caption_audit_request");
  }
  const requestedHashes = [...new Set(value.image_sha256)];
  const current = await readLoraCaptionAudit(projectDirectory, datasetId);
  const availableHashes = new Set([...current.audited, ...current.pending].map((entry) => entry.image_sha256));
  const unknownHashes = requestedHashes.filter((imageSha256) => !availableHashes.has(imageSha256));
  if (unknownHashes.length) throw new LoraTrainingError(422, "lora_caption_audit_unknown_image", unknownHashes);
  const snapshot = await readCaptionAuditSnapshot(projectDirectory, datasetId);
  const auditedAt = new Date().toISOString();
  for (const imageSha256 of requestedHashes) snapshot.images[imageSha256] = { audited_at: auditedAt };
  snapshot.version = captionAuditVersion;
  snapshot.scope = { ...defaultCaptionAuditScope, prompt_family: promptFamily };
  snapshot.updated_at = auditedAt;
  await writeJsonAtomic(captionAuditPath(projectDirectory, datasetId), snapshot);
  return readLoraCaptionAudit(projectDirectory, datasetId);
}

export async function invalidateLoraCaptioningItem(projectDirectory, datasetId, itemId) {
  const latestPath = captioningLatestPath(projectDirectory, datasetId);
  const latest = await readCaptioningLatest(projectDirectory, datasetId);
  if (!Object.hasOwn(latest.items, itemId)) return;
  latest.items[itemId] = { ...latest.items[itemId], confirmation: null };
  await writeJsonAtomic(latestPath, latest);
}

export function captioningRuntimeRoot(projectDirectory, datasetId) {
  if (!idPatterns.dataset.test(datasetId)) throw new LoraTrainingError(400, "invalid_lora_training_dataset_id");
  return path.join(projectDirectory, "Saved", "cache", "lora-captioning", datasetId);
}

export function captioningRuntimeRunRoot(projectDirectory, datasetId, runId) {
  if (!idPatterns.run.test(runId)) throw new LoraTrainingError(400, "invalid_lora_caption_run_id");
  return path.join(captioningRuntimeRoot(projectDirectory, datasetId), runId);
}

export function comparablePrompt(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").trim();
}

export async function readCaptioningLatest(projectDirectory, datasetId) {
  const value = await readJson(captioningLatestPath(projectDirectory, datasetId), { optional: true });
  if (value === null) return { version: captioningVersion, items: {}, tagger: null, updated_at: null };
  if (!isRecord(value) || value.version !== captioningVersion || !isRecord(value.items)) throw new LoraTrainingError(422, "invalid_lora_captioning_latest");
  for (const [itemId, entry] of Object.entries(value.items)) {
    const confirmation = entry?.confirmation;
    if (!isRecord(entry) || (entry.base_prompt !== null && typeof entry.base_prompt !== "string") || !sha256Pattern.test(entry.image_sha256 ?? "") || !sha256Pattern.test(entry.caption_sha256 ?? "") || (confirmation !== null && (!isRecord(confirmation) || !sha256Pattern.test(confirmation.image_sha256 ?? "") || !sha256Pattern.test(confirmation.caption_sha256 ?? "")))) throw new LoraTrainingError(422, "invalid_lora_captioning_latest", [itemId]);
  }
  return value;
}

export async function pruneCaptioningLatest(projectDirectory, datasetId, itemIds, currentImageHashes = null, { persist = true } = {}) {
  const latest = await readCaptioningLatest(projectDirectory, datasetId);
  const allowed = new Set(itemIds);
  const staleItemIds = Object.keys(latest.items).filter((itemId) => !allowed.has(itemId)
    || currentImageHashes instanceof Map && latest.items[itemId]?.image_sha256 !== currentImageHashes.get(itemId));
  if (!staleItemIds.length) return { latest, stale_item_ids: [], changed: false };
  const stale = new Set(staleItemIds);
  const next = {
    ...latest,
    items: Object.fromEntries(Object.entries(latest.items).filter(([itemId]) => allowed.has(itemId) && !stale.has(itemId))),
  };
  if (persist) await writeJsonAtomic(captioningLatestPath(projectDirectory, datasetId), next);
  return { latest: next, stale_item_ids: staleItemIds, changed: true };
}

export async function readCaptioningProjection(projectDirectory, datasetId, dataset, items) {
  const latest = await readCaptioningLatest(projectDirectory, datasetId);
  const projections = items.map((item) => {
    const candidateRecord = latest.items[item.id] ?? null;
    const record = candidateRecord?.image_sha256 === item.image_version ? candidateRecord : null;
    const currentPrompt = comparablePrompt(item.caption);
    const basePrompt = record?.base_prompt ?? null;
    const captionSha = item.caption_sha256;
    const confirmed = Boolean(record?.confirmation?.image_sha256 === item.image_version && record?.confirmation?.caption_sha256 === captionSha);
    const state = !record ? (currentPrompt ? "unconfirmed" : "unlabeled") : confirmed ? "confirmed" : "unconfirmed";
    return {
      item_id: item.id,
      current_prompt: currentPrompt,
      base_prompt: basePrompt,
      image_sha256: record?.image_sha256 ?? null,
      caption_sha256: record?.caption_sha256 ?? null,
      raw_tags: record?.raw_tags ?? [],
      state,
      confirmed,
    };
  });
  return {
    version: captioningVersion,
    latest: latest.updated_at ? { updated_at: latest.updated_at, tagger: latest.tagger ?? null } : null,
    summary: { total: dataset.items.length, with_base: projections.filter((entry) => entry.base_prompt !== null).length, confirmed: projections.filter((entry) => entry.state === "confirmed").length, unconfirmed: projections.filter((entry) => entry.state !== "confirmed").length },
    items: projections,
  };
}

export async function readLoraCaptioning(projectDirectory, datasetId) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const items = await readDatasetItems(projectDirectory, datasetId, dataset);
  return readCaptioningProjection(projectDirectory, datasetId, dataset, items);
}

export async function readLoraCaptioningRun(projectDirectory, datasetId, runId) {
  const runDirectory = captioningRuntimeRunRoot(projectDirectory, datasetId, runId);
  const result = await readJson(path.join(runDirectory, "result.json"), { optional: true });
  if (!result) throw new LoraTrainingError(404, "lora_caption_run_not_found");
  return result;
}

export function captioningTagger(value) {
  return { id: String(value?.id ?? "configured-captioner"), version: String(value?.version ?? "unknown") };
}

export function captioningResults(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : isRecord(value?.items) ? Object.entries(value.items).map(([item_id, result]) => ({ item_id, ...result })) : [];
  return entries.map((entry) => ({
    item_id: String(entry?.item_id ?? entry?.id ?? ""),
    prompt: comparablePrompt(entry?.prompt ?? entry?.caption ?? entry?.base_prompt),
    raw_tags: Array.isArray(entry?.raw_tags) ? entry.raw_tags : Array.isArray(entry?.tags) ? entry.tags : [],
  })).filter((entry) => entry.item_id && entry.prompt);
}

export function isPathLikeCommand(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\") || value.startsWith(".");
}

export function resolveCaptionerCommand(projectRoot, value) {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command) return "";
  return isPathLikeCommand(command) ? path.resolve(projectRoot, command) : command;
}

export function captionerManifestPath(projectRoot, provider) {
  if (typeof provider?.manifest === "string" && provider.manifest.trim()) return configuredPath(projectRoot, provider.manifest);
  const id = typeof provider?.id === "string" ? provider.id.trim() : "";
  return id ? path.join(projectRoot, "library", "lora-training", "captioners", `${id}.json`) : null;
}

export function captionerModelRoot(projectRoot, provider, manifest) {
  const fallback = manifest?.id ? `app/data.local/lora-training/captioning/${manifest.id}` : null;
  return configuredPath(projectRoot, provider?.model_root, fallback);
}

export async function resolveCaptionerFile(projectRoot, root, key, definition) {
  if (!isRecord(definition) || typeof definition.relative_path !== "string" || !definition.relative_path.trim()) {
    return { key, ok: false, message: `${key} 文件清单无效`, path: null, sha256: null, size: null };
  }
  if (!root) return { key, ok: false, message: `${key} 模型目录未配置`, path: null, sha256: null, size: null };
  const target = path.resolve(root, definition.relative_path);
  if (!isWithin(root, target)) throw new LoraTrainingError(422, "invalid_lora_captioner_model_path", [key]);
  const present = await exists(target);
  if (!present) return { key, ok: false, message: `${key} 文件缺失`, path: target, sha256: null, size: null };
  const info = await stat(target);
  const actualHash = definition.sha256 ? await sha256File(target) : null;
  const sizeMatches = !Number.isSafeInteger(definition.size_bytes) || definition.size_bytes === info.size;
  const hashMatches = !definition.sha256 || actualHash === definition.sha256;
  return {
    key,
    ok: sizeMatches && hashMatches,
    message: sizeMatches && hashMatches ? `${key} 文件身份符合清单` : `${key} 文件 SHA-256 或大小不符`,
    path: target,
    sha256: actualHash,
    size: info.size,
  };
}

export function readCaptionerProviders(args) {
  if (!Array.isArray(args)) return [];
  const index = args.findIndex((entry) => String(entry) === "--providers");
  if (index < 0) return [];
  return String(args[index + 1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function captionerProviderPolicyCheck(manifest, provider) {
  const runtime = manifest?.runtime;
  const required = Array.isArray(runtime?.required_providers)
    ? runtime.required_providers.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const forbidden = Array.isArray(runtime?.forbidden_providers)
    ? runtime.forbidden_providers.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  if (!required.length && !forbidden.length) return null;
  const configured = readCaptionerProviders(provider?.args);
  const missing = required.filter((entry) => !configured.includes(entry));
  const forbiddenUsed = forbidden.filter((entry) => configured.includes(entry));
  const firstProviderOk = !required.length || configured[0] === required[0];
  const ok = configured.length > 0 && !missing.length && !forbiddenUsed.length && firstProviderOk;
  let message = "打标器 Provider 配置符合部署要求";
  if (!configured.length) message = `未配置 --providers；部署要求使用 ${required.join("、") || "GPU Provider"}`;
  else if (missing.length) message = `打标器缺少必需 Provider：${missing.join("、")}`;
  else if (!firstProviderOk) message = `首选 Provider 必须是 ${required[0]}`;
  else if (forbiddenUsed.length) message = `打标器不得显式请求：${forbiddenUsed.join("、")}`;
  return { ok, message };
}

export async function inspectCaptioningProvider(projectRoot, config) {
  const provider = config?.lora_training?.captioning;
  const command = resolveCaptionerCommand(projectRoot, provider?.command);
  const configured = Boolean(command);
  const id = typeof provider?.id === "string" && provider.id.trim() ? provider.id.trim() : null;
  const version = typeof provider?.version === "string" && provider.version.trim() ? provider.version.trim() : null;
  const checks = [];
  if (!configured) {
    const checks = [{ id: "captioner_config", ok: false, message: "未配置 lora_training.captioning.command" }];
    return { configured: false, ready: false, id, version, message: checks[0].message, manifest: null, model_root: null, files: [], checks };
  }

  let commandOk = true;
  if (isPathLikeCommand(String(provider.command))) {
    commandOk = await exists(command);
    checks.push({ id: "captioner_command", ok: commandOk, message: commandOk ? "打标器命令可用" : "打标器命令文件缺失" });
  } else {
    checks.push({ id: "captioner_command", ok: true, message: "打标器命令将从 PATH 查找" });
  }

  const manifestPath = captionerManifestPath(projectRoot, provider);
  const manifest = manifestPath ? await readJson(manifestPath, { optional: true }) : null;
  const manifestOk = Boolean(manifest && manifest.version === 1 && manifest.id);
  checks.push({ id: "captioner_manifest", ok: manifestOk, message: manifestOk ? "打标器清单可读取" : "打标器清单缺失或无效" });

  const modelRoot = manifestOk ? captionerModelRoot(projectRoot, provider, manifest) : null;
  const resolvedFiles = [];
  if (manifestOk) {
    for (const key of ["model", "labels", "thresholds"]) {
      const resolved = await resolveCaptionerFile(projectRoot, modelRoot, key, manifest.files?.[key]);
      resolvedFiles.push(resolved);
      checks.push({ id: `captioner_${key}`, ok: resolved.ok, message: resolved.message });
    }
    const providerPolicy = captionerProviderPolicyCheck(manifest, provider);
    if (providerPolicy) checks.push({ id: "captioner_provider_policy", ...providerPolicy });
  }

  const checkArgs = Array.isArray(provider?.check_args)
    ? provider.check_args.map((entry) => String(entry))
    : Array.isArray(provider?.args)
      ? [...provider.args.map((entry) => String(entry)), "--check"]
      : [];
  if (commandOk && checkArgs.length) {
    try {
      const runtime = await execFileAsync(command, checkArgs, { cwd: projectRoot, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
      const parsed = JSON.parse(runtime.stdout.trim());
      checks.push({ id: "captioner_runtime", ok: parsed?.ok === true, message: parsed?.ok === true ? `打标器运行依赖可用：ONNX Runtime ${parsed.onnxruntime}` : `打标器运行检查失败：${(parsed?.problems ?? []).join("；") || "未知错误"}` });
    } catch (error) {
      checks.push({ id: "captioner_runtime", ok: false, message: `打标器运行检查失败：${error.message}` });
    }
  }

  const ready = checks.every((check) => check.ok);
  return {
    configured,
    ready,
    id,
    version,
    message: ready ? "打标器可用" : (checks.find((check) => !check.ok)?.message ?? "打标器不可用"),
    manifest: manifestOk ? { id: manifest.id, name: manifest.name ?? manifest.id } : null,
    model_root: modelRoot,
    files: resolvedFiles.map((entry) => ({
      id: entry.key,
      path: entry.path,
      exists: entry.size !== null,
      matches: entry.ok,
      sha256: entry.sha256,
      expected_sha256: manifest?.files?.[entry.key]?.sha256 ?? null,
    })),
    checks,
  };
}

export async function runConfiguredCaptioner(projectRoot, projectDirectory, datasetId, items, runDirectory, config) {
  const provider = config?.lora_training?.captioning;
  const command = resolveCaptionerCommand(projectRoot, provider?.command);
  if (!command) throw new LoraTrainingError(503, "lora_caption_tagger_unavailable", ["未配置 lora_training.captioning.command"]);
  const input = { version: 1, dataset_id: datasetId, items: await Promise.all(items.map(async (item) => {
    const files = itemPaths(projectDirectory, datasetId, item);
    return { item_id: item.id, image_path: files.image, image_sha256: await sha256File(files.image) };
  })) };
  await writeJsonAtomic(path.join(runDirectory, "input.json"), input);
  const args = Array.isArray(provider.args) ? provider.args.map((entry) => String(entry)) : [];
  const cwd = typeof provider.cwd === "string" && provider.cwd.trim() ? path.resolve(projectRoot, provider.cwd) : projectRoot;
  if (!isWithin(projectRoot, cwd)) throw new LoraTrainingError(422, "invalid_lora_captioner_cwd");
  let stdout;
  try {
    ({ stdout } = await execFileAsync(command, args, { cwd, windowsHide: true, timeout: Number(provider.timeout_ms) > 0 ? Number(provider.timeout_ms) : 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LORA_CAPTION_INPUT: path.join(runDirectory, "input.json") } }));
  } catch (error) {
    throw new LoraTrainingError(502, "lora_caption_tagger_failed", [error?.message ?? String(error)]);
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new LoraTrainingError(502, "lora_caption_tagger_invalid_output"); }
  const results = captioningResults(parsed);
  if (!results.length) throw new LoraTrainingError(502, "lora_caption_tagger_empty_output");
  return { provider, results };
}

export async function runLoraCaptioning(projectRoot, projectDirectory, datasetId, mode, config, { item_id: itemId = null, confirm_overwrite: confirmOverwrite = false } = {}) {
  if (mode !== "missing" && mode !== "single") throw new LoraTrainingError(400, "invalid_lora_caption_run_mode");
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const items = await readDatasetItems(projectDirectory, datasetId, dataset);
  const currentImageHashes = new Map(items.map((item) => [item.id, item.image_version]));
  const pruned = await pruneCaptioningLatest(projectDirectory, datasetId, items.map((item) => item.id), currentImageHashes, { persist: false });
  const { latest } = pruned;
  let candidates;
  if (mode === "missing") {
    candidates = items.filter((item) => !item.caption.trim());
  } else {
    const item = items.find((entry) => entry.id === itemId);
    if (!item) throw new LoraTrainingError(404, "lora_training_item_not_found");
    if (item.caption.trim() && confirmOverwrite !== true) throw new LoraTrainingError(409, "lora_caption_single_overwrite_confirmation_required", [item.id]);
    candidates = [item];
  }
  const runId = createId("run");
  const runDirectory = captioningRuntimeRunRoot(projectDirectory, datasetId, runId);
  await mkdir(runDirectory, { recursive: true });
  if (!candidates.length) {
    if (pruned.changed) await commitFileChanges([{ target: captioningLatestPath(projectDirectory, datasetId), content: `${JSON.stringify(latest, null, 2)}\n` }]);
    const result = { version: 1, run_id: runId, mode, created_at: new Date().toISOString(), tagger: latest.tagger ?? null, processed: 0, updated: 0 };
    await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
    return result;
  }
  const { provider, results } = await runConfiguredCaptioner(projectRoot, projectDirectory, datasetId, candidates, runDirectory, config);
  const resultById = new Map(results.map((entry) => [entry.item_id, entry]));
  const missingResults = candidates.filter((item) => !resultById.has(item.id));
  if (missingResults.length) throw new LoraTrainingError(502, "lora_caption_tagger_missing_item", missingResults.map((item) => item.id));
  const nextLatest = structuredClone(latest);
  let updated = 0;
  const captionChanges = [];
  for (const item of candidates) {
    const generated = resultById.get(item.id);
    const files = itemPaths(projectDirectory, datasetId, item);
    const imageSha = await sha256File(files.image);
    const captionContent = `${generated.prompt}\n`;
    const captionSha = createHash("sha256").update(captionContent).digest("hex");
    captionChanges.push({ target: files.caption, content: captionContent });
    nextLatest.items[item.id] = { image_sha256: imageSha, caption_sha256: captionSha, base_prompt: generated.prompt, raw_tags: generated.raw_tags, confirmation: null };
    updated += 1;
  }
  nextLatest.version = captioningVersion;
  nextLatest.updated_at = new Date().toISOString();
  nextLatest.tagger = captioningTagger(provider);
  captionChanges.push({ target: captioningLatestPath(projectDirectory, datasetId), content: `${JSON.stringify(nextLatest, null, 2)}\n` });
  await commitFileChanges(captionChanges);
  const result = { version: 1, run_id: runId, mode, created_at: new Date().toISOString(), tagger: nextLatest.tagger, processed: candidates.length, updated };
  await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
  return result;
}

export async function updateLoraCaptioningItem(projectDirectory, datasetId, itemId, prompt, { confirm = false } = {}) {
  const { dataset } = await requireDataset(projectDirectory, datasetId);
  const item = dataset.items.find((entry) => entry.id === itemId);
  if (!item) throw new LoraTrainingError(404, "lora_training_item_not_found");
  if (typeof prompt !== "string") throw new LoraTrainingError(422, "invalid_lora_training_caption");
  const files = itemPaths(projectDirectory, datasetId, item);
  const text = comparablePrompt(prompt);
  const captionContent = text ? `${text}\n` : "";
  const latest = (await pruneCaptioningLatest(projectDirectory, datasetId, dataset.items.map((entry) => entry.id), null, { persist: false })).latest;
  const imageSha = await sha256File(files.image);
  const captionSha = createHash("sha256").update(captionContent).digest("hex");
  const previous = latest.items[itemId];
  const sameImage = previous?.image_sha256 === imageSha;
  const rawResult = sameImage
    ? previous
    : { image_sha256: imageSha, caption_sha256: captionSha, base_prompt: null, raw_tags: [] };
  latest.items[itemId] = { ...rawResult, image_sha256: imageSha, confirmation: confirm ? { image_sha256: imageSha, caption_sha256: captionSha } : null };
  latest.version = captioningVersion;
  latest.updated_at = new Date().toISOString();
  await commitFileChanges([
    { target: files.caption, content: captionContent },
    { target: captioningLatestPath(projectDirectory, datasetId), content: `${JSON.stringify(latest, null, 2)}\n` },
  ]);
  return { saved: true, item_id: itemId, prompt: text, confirmed: Boolean(confirm) };
}


export function createLoraTrainingFactsInterface(implementation) {
  return Object.freeze({
    datasets: Object.freeze({
      list: implementation.listLoraTrainingDatasets,
      read: implementation.readLoraTrainingDataset,
      create: implementation.createLoraTrainingDataset,
      update: implementation.updateLoraTrainingDataset,
      importAssets: implementation.importLoraTrainingAssets,
      copyItem: implementation.copyLoraTrainingItem,
    }),
    captions: Object.freeze({
      read: implementation.readLoraCaptioning,
      readRun: implementation.readLoraCaptioningRun,
      run: ({ projectRoot, projectDirectory, datasetId, mode = "missing", itemId = null, config, confirmOverwrite = false }) =>
        implementation.runLoraCaptioning(projectRoot, projectDirectory, datasetId, mode, config, { item_id: itemId, confirm_overwrite: confirmOverwrite }),
      save: implementation.saveLoraTrainingCaption,
      confirm: implementation.updateLoraCaptioningItem,
      audit: Object.freeze({
        read: implementation.readLoraCaptionAudit,
        record: implementation.recordLoraCaptionAudit,
      }),
    }),
    tasks: Object.freeze({
      list: implementation.listLoraTrainingTasks,
      read: implementation.readLoraTrainingTask,
      create: implementation.createLoraTrainingTask,
      update: implementation.updateLoraTrainingTask,
    }),
  });
}
