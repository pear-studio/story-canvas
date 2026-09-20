import { listRegisteredProjects } from "./project-registry.mjs";
import { expandSavedRunSettings } from "./lora-training-settings.mjs";
import { readMusiqStatus } from "./lora-image-quality.mjs";
import { trainingImageTarget } from "./lora-image-preparation-contract.mjs";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { createLoraTrainingRunManifest } from "./lora-training-run-manifest.mjs";
import * as support from "./lora-training-support.mjs";
import { captionerManifestPath, captionerModelRoot, inspectCaptioningProvider, isPathLikeCommand, readCaptioningLatest, readLoraTrainingDataset, readLoraTrainingTask, requireDataset, requireTask, resolveCaptionerCommand } from "./lora-training-facts.mjs";
import { listLoraTrainingRuns } from "./lora-training-run-index.mjs";
import { readLoraTrainingRecipe } from "./lora-training-recipe.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";

const {
  LoraTrainingError, idPatterns, sha256Pattern, runningStatuses, upscaleModelManifestRelativePath, upscaleModelId,
  loraTrainingOverrideDefinitions,
  createId, isRecord, isWithin, exists, readJson, writeAtomic, writeJsonAtomic,
  commitFileChanges, sha256File, loraInputsRoot, datasetRoot, taskRoot, runRoot, generatedRunRoot, itemPaths,
  readSafeDatasetFile, readAssetMeta, canonicalJson, configuredPath, execFileAsync,
  assertLoraTrainingRunManifest,
} = support;

const loraEnvironmentCache = new Map();

export async function gitCommit(directory) {
  try {
    return (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { windowsHide: true, timeout: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}

export async function pythonProbe(python, trainerRoot) {
  const code = "import json,sys,torch,accelerate,transformers,diffusers,safetensors; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.version.cuda,'cuda_available':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,'vram_bytes':torch.cuda.get_device_properties(0).total_memory if torch.cuda.is_available() else 0,'accelerate':accelerate.__version__,'transformers':transformers.__version__,'diffusers':diffusers.__version__,'safetensors':safetensors.__version__}))";
  const result = await execFileAsync(python, ["-c", code], { cwd: trainerRoot, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}

export async function entryHelp(python, trainerRoot, entry) {
  try {
    await execFileAsync(python, [path.join(trainerRoot, entry), "--help"], { cwd: trainerRoot, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function readLoraTrainingEnvironment(projectRoot, config) {
  const manifest = await readJson(path.join(projectRoot, "library", "lora-training", "trainer.json"), { optional: true });
  const trainerRoot = configuredPath(projectRoot, config?.lora_training?.trainer_root, "app/data.local/lora-training/sd-scripts");
  const python = configuredPath(projectRoot, config?.lora_training?.python, "app/data.local/lora-training/sd-scripts/.venv/Scripts/python.exe");
  const captioning = await inspectCaptioningProvider(projectRoot, config);
  const upscaler = await readUpscaleModelStatus(projectRoot, config);
  const quality = await readMusiqStatus(projectRoot, config);
  const checks = [];
  let probe = null;
  const commit = trainerRoot && await exists(trainerRoot) ? await gitCommit(trainerRoot) : null;
  checks.push({ id: "trainer_root", ok: Boolean(trainerRoot && await exists(trainerRoot)), message: trainerRoot && await exists(trainerRoot) ? "训练器目录可用" : "训练器目录缺失" });
  checks.push({ id: "trainer_commit", ok: Boolean(commit && manifest?.sd_scripts?.commit === commit), message: commit ? (manifest?.sd_scripts?.commit === commit ? "训练器 commit 符合版本清单" : `训练器 commit 不符：${commit}`) : "无法读取训练器 commit" });
  const entryFilesPresent = Boolean(trainerRoot && await exists(path.join(trainerRoot, "anima_train_network.py")));
  try {
    probe = await pythonProbe(python, trainerRoot);
    checks.push({ id: "python", ok: manifest?.runtime?.python === probe.python, message: `Python ${probe.python}` });
    checks.push({ id: "torch", ok: manifest?.runtime?.torch === probe.torch, message: `Torch ${probe.torch}` });
    checks.push({ id: "cuda", ok: probe.cuda_available, message: probe.cuda_available ? `${probe.gpu}，CUDA ${probe.cuda}` : "CUDA 不可用" });
  } catch (error) {
    checks.push({ id: "python", ok: false, message: `训练 Python 不可用：${error.message}` });
  }
  const animaHelp = entryFilesPresent && python && await exists(python) ? await entryHelp(python, trainerRoot, "anima_train_network.py") : false;
  checks.push({ id: "entry_anima", ok: animaHelp, message: animaHelp ? "Anima 训练入口参数可读取" : "Anima 训练入口不可运行" });
  const referenceModels = [];
  for (const [family, definitions] of Object.entries(manifest?.reference_models ?? {})) {
    for (const [kind, identity] of Object.entries(definitions)) {
      if (!isRecord(identity) || !identity.relative_path) continue;
      const resolved = await resolveModel(projectRoot, config, `${family}.${kind}`, identity);
      referenceModels.push({ family, kind, relative_path: identity.relative_path, exists: resolved.exists, matches: resolved.matches, sha256: resolved.sha256, size: resolved.size });
      checks.push({
        id: `reference_model_${family}_${kind}`,
        ok: resolved.exists && resolved.matches,
        message: !resolved.exists
          ? `${family} ${kind} 参考模型缺失`
          : resolved.matches
            ? `${family} ${kind} 参考模型身份符合版本清单`
            : `${family} ${kind} 参考模型 SHA-256 不匹配`,
      });
    }
  }
  return { available: checks.every((check) => check.ok), trainer_root: trainerRoot, python, manifest, commit, runtime: probe, checks, reference_models: referenceModels, captioning, optional_capabilities: { upscaler, quality } };
}

export function loraEnvironmentCacheKey(projectRoot, config) {
  return canonicalJson({
    projectRoot: path.resolve(projectRoot),
    models_root: config?.models_root ?? null,
    lora_training: config?.lora_training ?? null,
  });
}

export async function loraEnvironmentFileSignature(target) {
  const info = await stat(target).catch(() => null);
  return info ? { size: info.size, mtime_ms: info.mtimeMs } : null;
}

export async function loraEnvironmentDependencyFingerprint(projectRoot, config) {
  const trainerRoot = configuredPath(projectRoot, config?.lora_training?.trainer_root, "app/data.local/lora-training/sd-scripts");
  const python = configuredPath(projectRoot, config?.lora_training?.python, "app/data.local/lora-training/sd-scripts/.venv/Scripts/python.exe");
  const trainerManifestPath = path.join(projectRoot, "library", "lora-training", "trainer.json");
  const trainerManifest = await readJson(trainerManifestPath, { optional: true });
  const captioning = config?.lora_training?.captioning;
  const captionerManifestPathValue = captionerManifestPath(projectRoot, captioning);
  const captionerManifest = captionerManifestPathValue ? await readJson(captionerManifestPathValue, { optional: true }) : null;
  const captionerRoot = captionerModelRoot(projectRoot, captioning, captionerManifest, config?.models_root);
  const upscalerManifestPath = path.join(projectRoot, upscaleModelManifestRelativePath);
  const modelsRoot = configuredPath(projectRoot, config?.models_root);
  const dependencies = new Set();
  const add = (target) => { if (target) dependencies.add(path.resolve(target)); };
  add(trainerManifestPath);
  add(upscalerManifestPath);
  add(python);
  if (trainerRoot) {
    add(path.join(trainerRoot, "anima_train_network.py"));
    add(path.join(trainerRoot, ".git", "HEAD"));
    add(path.join(trainerRoot, ".git", "index"));
  }
  if (modelsRoot) {
    for (const definitions of Object.values(trainerManifest?.reference_models ?? {})) {
      for (const identity of Object.values(definitions ?? {})) if (isRecord(identity) && typeof identity.relative_path === "string") add(path.join(modelsRoot, identity.relative_path));
    }
    const upscalerManifest = await readJson(upscalerManifestPath, { optional: true });
    if (typeof upscalerManifest?.file?.relative_path === "string") add(path.join(modelsRoot, upscalerManifest.file.relative_path));
  }
  add(captionerManifestPathValue);
  if (captioning && isPathLikeCommand(String(captioning.command ?? ""))) add(resolveCaptionerCommand(projectRoot, captioning.command));
  if (captionerRoot) {
    for (const definition of Object.values(captionerManifest?.files ?? {})) if (isRecord(definition) && typeof definition.relative_path === "string") add(path.join(captionerRoot, definition.relative_path));
    for (const definition of Array.isArray(captionerManifest?.supporting_files) ? captionerManifest.supporting_files : []) if (isRecord(definition) && typeof definition.relative_path === "string") add(path.join(captionerRoot, definition.relative_path));
  }
  const files = [];
  for (const target of [...dependencies].sort()) files.push({ path: target, signature: await loraEnvironmentFileSignature(target) });
  return canonicalJson({
    trainer_commit: trainerRoot ? await gitCommit(trainerRoot) : null,
    trainer_manifest: trainerManifest,
    captioner_manifest: captionerManifest,
    files,
  });
}

export async function readCachedLoraTrainingEnvironment(projectRoot, config, { force = false } = {}) {
  const key = loraEnvironmentCacheKey(projectRoot, config);
  const fingerprint = await loraEnvironmentDependencyFingerprint(projectRoot, config);
  const cached = loraEnvironmentCache.get(key);
  if (!force && cached?.fingerprint === fingerprint && cached.value) return cached.value;
  if (!force && cached?.fingerprint === fingerprint && cached.promise) return cached.promise;
  const promise = readLoraTrainingEnvironment(projectRoot, config)
    .then((value) => {
      loraEnvironmentCache.set(key, { fingerprint, value });
      return value;
    })
    .catch((error) => {
      if (loraEnvironmentCache.get(key)?.promise === promise) loraEnvironmentCache.delete(key);
      throw error;
    });
  loraEnvironmentCache.set(key, { fingerprint, promise });
  return promise;
}

export async function listLoraTrainingRecipes(projectRoot) {
  const root = path.join(projectRoot, "library", "lora-training", "recipes");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const recipes = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    const recipe = await readJson(path.join(root, entry.name), { optional: true });
    if (!isRecord(recipe) || typeof recipe.id !== "string" || !isRecord(recipe.semantic_config)) continue;
    if (recipe.family !== "anima") continue;
    recipes.push({
      id: recipe.id,
      version: recipe.version,
      name: typeof recipe.name === "string" ? recipe.name : recipe.id,
      description: typeof recipe.description === "string" ? recipe.description : "",
      family: recipe.family,
      semantic_config: recipe.semantic_config,
    });
  }
  return { recipes: recipes.sort((left, right) => left.id.localeCompare(right.id, "en")) };
}

export const readTrainingRecipe = readLoraTrainingRecipe;

export function validateSemanticConfig(next) {
  for (const key of ["resolution", "effective_batch_size", "network_dim", "network_alpha"]) if (!Number.isInteger(next[key]) || next[key] < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", [key]);
  if (typeof next.learning_rate !== "number" || next.learning_rate <= 0) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["learning_rate"]);
  if (typeof next.optimizer_type !== "string" || !next.optimizer_type) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["optimizer_type"]);
  return next;
}

export function semanticTrainingConfig(task, recipe) {
  const allowed = new Set(Object.keys(loraTrainingOverrideDefinitions));
  const next = { ...recipe.semantic_config };
  for (const [key, value] of Object.entries(task.training_recipe.overrides ?? {})) {
    if (!allowed.has(key)) throw new LoraTrainingError(422, "unsupported_lora_training_parameter", [key]);
    next[key] = value;
  }
  return validateSemanticConfig(next);
}

export function validateRunSettings(settings, semantic) {
  if (!isRecord(settings)) throw new LoraTrainingError(422, "missing_lora_training_run_settings");
  const allowed = new Set(["note", "max_train_steps", "save_every_n_steps", "seed", "micro_batch_size", "gradient_accumulation_steps", "max_data_loader_n_workers", "blocks_to_swap"]);
  if (settings.note !== undefined && typeof settings.note !== "string") throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["note"]);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknown.length) throw new LoraTrainingError(422, "unsupported_lora_training_parameter", unknown);
  for (const key of ["max_train_steps", "save_every_n_steps", "seed", "micro_batch_size", "gradient_accumulation_steps", "max_data_loader_n_workers"]) if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", [key]);
  if (settings.blocks_to_swap !== undefined && (!Number.isInteger(settings.blocks_to_swap) || settings.blocks_to_swap < 0)) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["blocks_to_swap"]);
  if (settings.blocks_to_swap === undefined) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["blocks_to_swap"]);
  if (settings.save_every_n_steps > settings.max_train_steps) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["save_every_n_steps"]);
  if (settings.micro_batch_size * settings.gradient_accumulation_steps !== semantic.effective_batch_size) throw new LoraTrainingError(422, "effective_batch_mismatch", [{ expected: semantic.effective_batch_size, actual: settings.micro_batch_size * settings.gradient_accumulation_steps }]);
  return settings;
}

export function flattenTrainingConfig(semantic, settings) {
  return validateTrainingConfig({
    resolution: semantic.resolution,
    max_train_steps: settings.max_train_steps,
    train_batch_size: settings.micro_batch_size,
    network_dim: semantic.network_dim,
    network_alpha: semantic.network_alpha,
    learning_rate: semantic.learning_rate,
    optimizer_type: semantic.optimizer_type,
    save_every_n_steps: settings.save_every_n_steps,
    seed: settings.seed,
    gradient_accumulation_steps: settings.gradient_accumulation_steps,
    max_data_loader_n_workers: settings.max_data_loader_n_workers,
    ...(settings.blocks_to_swap !== undefined ? { blocks_to_swap: settings.blocks_to_swap } : {}),
  });
}

export async function readLoraTrainingRunSettings(projectRoot, projectDirectory, taskId, config, { skipEnvironment = false } = {}) {
  const { task } = await requireTask(projectDirectory, taskId);
  const recipe = await readTrainingRecipe(projectRoot, task.training_recipe.id);
  if (!recipe || recipe.family !== task.target.family) throw new LoraTrainingError(422, "invalid_training_recipe");
  const semantic = semanticTrainingConfig(task, recipe);
  const previousRun = (await listLoraTrainingRuns(projectDirectory, taskId))[0];
  return {
    recipe: { id: recipe.id, version: recipe.version, name: recipe.name },
    semantic_config: semantic,
    values: expandSavedRunSettings(task, semantic),
    last_run: previousRun ? { id: previousRun.id, created_at: previousRun.manifest.created_at,
      status: previousRun.status.status, config: previousRun.manifest.config } : null,
  };
}

export function modelEntries(task) {
  return [["dit", task.target.base.dit], ["text_encoder", task.target.base.text_encoder], ["vae", task.target.base.vae], ...(task.target.base.llm_adapter ? [["llm_adapter", task.target.base.llm_adapter]] : [])];
}

export function preflightItemLabel(item) {
  const identity = item.asset_id ? `图片“${item.asset_id}”` : `图片项 ${item.id}`;
  return `${identity}（${item.file ?? item.id}）`;
}

export async function resolveModel(projectRoot, config, label, identity, { hash = true } = {}) {
  const root = configuredPath(projectRoot, config?.models_root);
  if (!root) return { label, identity, path: null, exists: false, sha256: null };
  const target = path.resolve(root, identity?.relative_path ?? "");
  if (!isWithin(root, target)) throw new LoraTrainingError(422, "invalid_lora_training_model_path", [label]);
  const present = await exists(target);
  const actualHash = present && hash ? await sha256File(target) : null;
  return { label, identity, path: target, exists: present, sha256: actualHash, matches: present && (!identity.sha256 || identity.sha256 === actualHash), size: present ? (await stat(target)).size : null };
}

export async function readUpscaleModelManifest(projectRoot) {
  return readJson(path.join(projectRoot, upscaleModelManifestRelativePath), { optional: true });
}

export async function readUpscaleModelStatus(projectRoot, config) {
  const manifest = await readUpscaleModelManifest(projectRoot);
  const identity = manifest?.file ?? manifest;
  if (!isRecord(identity) || typeof identity.relative_path !== "string" || !sha256Pattern.test(identity.sha256 ?? "")) return { id: upscaleModelId, ready: false, path: null, relative_path: identity?.relative_path ?? null, sha256: null, expected_sha256: identity?.sha256 ?? null, size_bytes: identity?.size_bytes ?? null, message: "超分模型清单缺失或身份不完整" };
  const resolved = await resolveModel(projectRoot, config, "图片超分模型", identity);
  return {
    id: manifest?.id ?? upscaleModelId,
    name: manifest?.name ?? "Real-ESRGAN Anime 6B",
    ready: resolved.exists && resolved.matches,
    path: resolved.path,
    relative_path: identity.relative_path,
    sha256: resolved.sha256,
    expected_sha256: identity.sha256,
    size_bytes: identity.size_bytes ?? null,
    native_scale: manifest?.native_scale ?? 4,
    output_scales: manifest?.output_scales ?? [1, 2, 4],
    message: !resolved.exists ? `超分模型缺失：${resolved.path ?? identity.relative_path}` : resolved.matches ? "超分模型可用" : `超分模型 SHA-256 不匹配：${resolved.path}`,
  };
}

export async function activeRunStatuses(projectRoot) {
  const active = [];
  for (const project of listRegisteredProjects(projectRoot, "training").filter(entry => entry.available)) {
  const tasksRoot = path.join(project.path, "Saved", "Training");
    const tasks = await readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
    for (const task of tasks) {
      if (!task.isDirectory()) continue;
      const runs = await readdir(path.join(tasksRoot, task.name), { withFileTypes: true }).catch(() => []);
      for (const run of runs) {
        if (!run.isDirectory()) continue;
        const statusValue = await readJson(path.join(tasksRoot, task.name, run.name, "status.json"), { optional: true }).catch(() => null);
        if (runningStatuses.has(statusValue?.status)) active.push({ task_id: task.name, run_id: run.name, status: statusValue.status });
      }
    }
  }
  return active;
}

export async function readLoraActivationGuide() {
  const markdown = await readFile(new URL("../../docs/reference/lora-activation-tags.md", import.meta.url), "utf8");
  return { title: "LoRA 激活标签指南", markdown };
}

export async function preflightLoraTraining(projectRoot, projectDirectory, taskId, config, { skipEnvironment = false, runSettings = null } = {}) {
  const { task } = await requireTask(projectDirectory, taskId);
  const { dataset } = await requireDataset(projectDirectory, task.dataset_id);
  const latestCaptioning = await readCaptioningLatest(projectDirectory, task.dataset_id);
  const blockers = [];
  const warnings = [];
  const environment = skipEnvironment ? null : await readLoraTrainingEnvironment(projectRoot, config);
  if (environment && !environment.available) blockers.push({ code: "training_environment_unavailable", message: "LoRA 训练环境缺失或版本不符" });
  const enabledGroups = dataset.groups.filter((group) => group.enabled);
  const enabledGroupIds = new Set(enabledGroups.map((group) => group.id));
  const enabledItems = dataset.items.filter((item) => item.enabled && enabledGroupIds.has(item.group_id));
  if (!enabledGroups.length) blockers.push({ code: "no_enabled_groups", message: "没有启用分组" });
  if (!enabledItems.length) blockers.push({ code: "no_enabled_images", message: "没有启用图片" });
  const hashes = new Map();
  const groupCaptionSets = new Map();
  const captions = [];
  for (const item of enabledItems) {
    try {
      const files = itemPaths(projectDirectory, task.dataset_id, item);
      const metadata = await sharp(await readFile(files.image)).rotate().metadata();
      const caption = (await readFile(files.caption, "utf8")).trim();
      captions.push(caption);
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      const shortSide = Math.min(width, height);
      const itemLabel = preflightItemLabel(item);
      const meta = await readAssetMeta(projectDirectory, task.dataset_id, item.asset_id);
      const target = width && height ? trainingImageTarget(width, height) : null;
      if (!meta.preparation || width !== target?.width || height !== target?.height
        || width !== meta.preparation.target.width || height !== meta.preparation.target.height) {
        blockers.push({ code: "training_image_unprepared", item_id: item.id, message: `${itemLabel}尚未准备为 1024 训练图，请在数据集中检查处理失败原因并点击重试` });
      }
      if (!caption) blockers.push({ code: "empty_caption", item_id: item.id, message: `${itemLabel}的 Caption 为空` });
      if (shortSide < 512) warnings.push({ code: "low_resolution", item_id: item.id, message: `${itemLabel}分辨率为 ${width}×${height}，短边 ${shortSide} 低于 512` });
      const ratio = (metadata.width ?? 1) / (metadata.height ?? 1);
      if (ratio > 3 || ratio < 1 / 3) warnings.push({ code: "extreme_aspect_ratio", item_id: item.id, message: `${itemLabel}宽高比为 ${ratio.toFixed(2)}，比例较为极端` });
      if (metadata.space && !["srgb", "rgb"].includes(metadata.space)) warnings.push({ code: "unusual_color_space", item_id: item.id, message: `${itemLabel}颜色空间为 ${metadata.space}` });
      const hash = await sha256File(files.image);
      const captionHash = await sha256File(files.caption);
      const record = latestCaptioning.items[item.id];
      const confirmed = record?.image_sha256 === hash
        && record?.confirmation?.image_sha256 === hash
        && record?.confirmation?.caption_sha256 === captionHash;
      if (caption && !confirmed) blockers.push({ code: "caption_unconfirmed", item_id: item.id, message: `${itemLabel}的 Caption 尚未确认，或图片／Caption 已发生变化` });
      if (hashes.has(hash)) {
        const otherItem = hashes.get(hash);
        warnings.push({ code: "duplicate_image", item_id: item.id, other_item_id: otherItem.id, message: `${itemLabel}与${preflightItemLabel(otherItem)}完全相同` });
      } else hashes.set(hash, item);
      const captionSet = groupCaptionSets.get(item.group_id) ?? new Set();
      captionSet.add(caption);
      groupCaptionSets.set(item.group_id, captionSet);
    } catch (error) {
      const itemLabel = preflightItemLabel(item);
      blockers.push({ code: "invalid_image_or_caption", item_id: item.id, message: error?.code === "ENOENT" ? `${itemLabel}缺少图片或 Caption` : `${itemLabel}无法解码：${error.message}` });
    }
  }
  for (const term of dataset.activation_terms) {
    if (!captions.some((caption) => caption.includes(term))) warnings.push({ code: "activation_term_unused", term, message: `激活标签“${term}”没有出现在任何启用 Caption 中` });
  }
  for (const group of enabledGroups) {
    const count = enabledItems.filter((item) => item.group_id === group.id).length;
    if (count > 3 && groupCaptionSets.get(group.id)?.size === 1) warnings.push({ code: "low_caption_variation", group_id: group.id, message: `分组“${group.name}”（${group.id}）的 ${count} 张图片使用了完全相同的 Caption` });
  }
  const models = [];
  for (const [label, identity] of modelEntries(task)) {
    const model = await resolveModel(projectRoot, config, label, identity);
    models.push(model);
    if (!model.exists) blockers.push({ code: "model_missing", model: label, message: `${label} 模型文件缺失` });
    else if (!identity.sha256) blockers.push({ code: "model_sha_unconfirmed", model: label, actual_sha256: model.sha256, message: `${label} 尚未写入完整 SHA-256` });
    else if (!model.matches) blockers.push({ code: "model_sha_mismatch", model: label, actual_sha256: model.sha256, message: `${label} SHA-256 不匹配` });
  }
  const activeRuns = await activeRunStatuses(projectRoot);
  if (activeRuns.length) blockers.push({ code: "lora_training_active", message: "当前设备已有训练 run", runs: activeRuns });
  if ((environment?.runtime?.vram_bytes ?? 0) <= 13 * 1024 ** 3) warnings.push({ code: "anima_low_vram", message: "12 GB 设备训练 Anima 预计很慢" });
  warnings.push({ code: "anima_license", message: "Anima 使用非商业许可证，分发或商用前请核对来源许可" });
  const recipe = await readTrainingRecipe(projectRoot, task.training_recipe.id);
  if (!recipe || recipe.family !== task.target.family) blockers.push({ code: "invalid_training_recipe", message: "训练方案缺失或模型家族不符" });
  let effectiveConfig = null;
  let semanticConfig = null;
  if (recipe?.family === task.target.family) {
    try {
      semanticConfig = semanticTrainingConfig(task, recipe);
      runSettings = expandSavedRunSettings(task, semanticConfig, runSettings);
      effectiveConfig = effectiveTrainingConfig(task, recipe, runSettings);
      if (effectiveConfig.resolution !== 1024) blockers.push({ code: "training_image_resolution_mismatch", message: "训练图片准备固定为 1024 级别，请将训练分辨率设为 1024" });
    } catch (error) {
      const message = error.code === "unsaved_lora_training_settings" ? "请先保存训练参数，再执行预检" : error.code === "effective_batch_mismatch" ? `Micro Batch × 梯度累积必须等于训练方案的有效 Batch（${semanticConfig?.effective_batch_size ?? "—"}）` : error.code === "missing_lora_training_run_settings" ? "请先填写本次训练的实验与执行参数" : "训练参数无效";
      blockers.push({ code: error.code ?? "invalid_lora_training_parameter", message });
    }
  }
  const estimatedBytes = models.reduce((sum, model) => sum + (model.size ?? 0), 0) * 0.15 + enabledItems.length * 16 * 1024 ** 2 + 5 * 1024 ** 3;
  const volume = await statfs(projectDirectory).catch(() => null);
  const availableDiskBytes = volume ? Number(volume.bavail) * Number(volume.bsize) : null;
  if (availableDiskBytes !== null && availableDiskBytes < estimatedBytes) blockers.push({ code: "insufficient_disk_space", message: `可用磁盘 ${Math.round(availableDiskBytes / 1024 ** 3)} GB，低于快照与最低保存余量` });
  return { ready: blockers.length === 0, blockers, warnings, environment, models: models.map(({ path: _path, ...model }) => model), recipe: recipe ? { id: recipe.id, version: recipe.version, name: recipe.name, sha256: recipe.sha256 } : null, semantic_config: semanticConfig, run_settings: runSettings, effective_config: effectiveConfig, dataset: { id: task.dataset_id, name: dataset.name }, estimated_disk_bytes: Math.round(estimatedBytes), available_disk_bytes: availableDiskBytes };
}

export function validateTrainingConfig(next) {
  for (const key of ["resolution", "max_train_steps", "train_batch_size", "network_dim", "network_alpha", "save_every_n_steps", "seed"]) if (!Number.isInteger(next[key]) || next[key] < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", [key]);
  if (!Number.isInteger(next.gradient_accumulation_steps ?? 1) || (next.gradient_accumulation_steps ?? 1) < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["gradient_accumulation_steps"]);
  if (typeof next.learning_rate !== "number" || next.learning_rate <= 0) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["learning_rate"]);
  if (typeof next.optimizer_type !== "string" || !next.optimizer_type) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["optimizer_type"]);
  if (next.save_every_n_steps > next.max_train_steps) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["save_every_n_steps"]);
  return next;
}

export function effectiveTrainingConfig(task, recipe, runSettings = null) {
  const semantic = semanticTrainingConfig(task, recipe);
  const settings = validateRunSettings(runSettings, semantic);
  return flattenTrainingConfig(semantic, settings);
}

export function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createLoraTrainingDatasetToml(runDirectory, groups, snapshots, config) {
  const lines = ["[general]", "caption_extension = \".txt\"", "shuffle_caption = false", "", "[[datasets]]", `resolution = ${config.resolution}`, `batch_size = ${config.train_batch_size}`, "enable_bucket = true", "bucket_no_upscale = true", "bucket_reso_steps = 64"];
  for (const group of groups) {
    const directory = path.join(runDirectory, "dataset", group.id);
    if (!snapshots.some((item) => item.group_id === group.id)) continue;
    lines.push("", "[[datasets.subsets]]", `image_dir = ${tomlString(directory)}`, `num_repeats = ${group.repeats}`);
  }
  return `${lines.join("\n")}\n`;
}

export function compileLoraTrainingArguments({ trainerRoot, python, runDirectory, checkpointDirectory = path.join(runDirectory, "checkpoints"), models, config, datasetConfig, metadata = {} }) {
  const script = path.join(trainerRoot, "anima_train_network.py");
  const common = [script,
    "--dataset_config", datasetConfig,
    "--output_dir", checkpointDirectory,
    "--output_name", "lora",
    "--logging_dir", path.join(runDirectory, "logs", "tensorboard"),
    "--save_model_as", "safetensors",
    "--max_train_steps", String(config.max_train_steps),
    "--train_batch_size", String(config.train_batch_size),
    "--gradient_accumulation_steps", String(config.gradient_accumulation_steps ?? 1),
    "--network_dim", String(config.network_dim),
    "--network_alpha", String(config.network_alpha),
    "--learning_rate", String(config.learning_rate),
    "--optimizer_type", String(config.optimizer_type),
    "--lr_scheduler", "cosine",
    "--lr_warmup_steps", String(Math.min(100, Math.floor(config.max_train_steps * 0.05))),
    "--mixed_precision", "bf16",
    "--save_precision", "bf16",
    "--seed", String(config.seed),
    "--save_every_n_steps", String(config.save_every_n_steps),
    "--gradient_checkpointing",
    "--network_train_unet_only",
    "--cache_latents",
    "--cache_latents_to_disk",
    "--max_data_loader_n_workers", String(config.max_data_loader_n_workers ?? 2),
    "--persistent_data_loader_workers",
    "--network_module", "networks.lora_anima",
  ];
  for (const [flag, value] of [
    ["--metadata_title", metadata.title],
    ["--metadata_author", metadata.author],
    ["--metadata_description", metadata.description],
    ["--metadata_tags", metadata.tags],
    ["--metadata_trigger_phrase", metadata.trigger_phrase],
  ]) if (typeof value === "string" && value.trim()) common.push(flag, value.trim());
  common.push("--pretrained_model_name_or_path", models.dit.path, "--qwen3", models.text_encoder.path, "--vae", models.vae.path, "--sdpa", "--cache_text_encoder_outputs", "--cache_text_encoder_outputs_to_disk", "--qwen_image_vae_2d", "--vae_chunk_size", "32", "--llm_adapter_lr", "0");
  if (models.llm_adapter) common.push("--llm_adapter_path", models.llm_adapter.path);
  if (config.blocks_to_swap) common.push("--blocks_to_swap", String(config.blocks_to_swap));
  return { executable: python, argv: common };
}

export async function snapshotRun(projectRoot, projectDirectory, taskId, config, preflight) {
  const { task } = await requireTask(projectDirectory, taskId);
  const { dataset } = await requireDataset(projectDirectory, task.dataset_id);
  const runId = createId("run");
  const modelsRoot = configuredPath(projectRoot, config.models_root);
  if (!modelsRoot) throw new LoraTrainingError(409, "models_root_not_configured");
  const checkpointsRelativePath = path.posix.join("loras", "training", taskId, runId);
  const checkpointDirectory = path.join(modelsRoot, ...checkpointsRelativePath.split("/"));
  const runsDirectory = path.dirname(runRoot(projectDirectory, taskId, runId));
  const temporary = path.join(runsDirectory, `.${runId}.${randomBytes(4).toString("hex")}.tmp`);
  const destination = path.join(runsDirectory, runId);
  await mkdir(temporary, { recursive: true });
  try {
    for (const name of ["dataset", "config", "logs"]) await mkdir(path.join(temporary, name), { recursive: true });
    await mkdir(checkpointDirectory, { recursive: true });
    const enabledGroupIds = new Set(dataset.groups.filter((group) => group.enabled).map((group) => group.id));
    const snapshots = [];
    for (const item of dataset.items.filter((entry) => entry.enabled && enabledGroupIds.has(entry.group_id))) {
      const files = itemPaths(projectDirectory, task.dataset_id, item);
      const groupDirectory = path.join(temporary, "dataset", item.group_id);
      await mkdir(groupDirectory, { recursive: true });
      const extension = path.extname(files.image).toLowerCase();
      const imageTarget = path.join(groupDirectory, `${item.id}${extension}`);
      const captionTarget = path.join(groupDirectory, `${item.id}.txt`);
      await Promise.all([copyFile(files.image, imageTarget), copyFile(files.caption, captionTarget)]);
      snapshots.push({ item_id: item.id, asset_id: item.asset_id, group_id: item.group_id, source_file: item.file, image_file: path.relative(temporary, imageTarget).replaceAll("\\", "/"), caption_file: path.relative(temporary, captionTarget).replaceAll("\\", "/"), image_sha256: await sha256File(imageTarget), caption_sha256: await sha256File(captionTarget) });
    }
    const finalConfig = preflight.effective_config;
    const datasetToml = createLoraTrainingDatasetToml(destination, dataset.groups.filter((group) => group.enabled), snapshots, finalConfig);
    const datasetConfig = path.join(destination, "config", "dataset.toml");
    await writeFile(path.join(temporary, "config", "dataset.toml"), datasetToml);
    const models = Object.fromEntries(preflight.models.map((model) => [model.label, { ...model, path: path.resolve(config.models_root ? configuredPath(projectRoot, config.models_root) : "", model.identity.relative_path) }]));
    const activationText = dataset.activation_terms.join(", ");
    const compiled = compileLoraTrainingArguments({
      trainerRoot: preflight.environment.trainer_root,
      python: preflight.environment.python,
      runDirectory: destination,
      checkpointDirectory,
      models,
      config: finalConfig,
      datasetConfig,
      metadata: {
        title: task.name,
        author: "StoryCanvas",
        description: dataset.description,
        tags: activationText,
        trigger_phrase: activationText,
      },
    });
    const manifest = createLoraTrainingRunManifest({
      runId,
      taskId,
      task,
      dataset,
      snapshots,
      preflight,
      finalConfig,
      execution: compiled,
      datasetToml: { sha256: createHash("sha256").update(datasetToml).digest("hex") },
      checkpointsRelativePath,
    });
    await writeJsonAtomic(path.join(temporary, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(temporary, "status.json"), { version: 1, status: "starting", step: 0, loss: null, eta_seconds: null, pid: null, process_started_at: null, exit_code: null, error: null, checkpoints: [], updated_at: new Date().toISOString() });
    // 归档仅复制真正输入的图片、Caption、配置和 manifest，不包含训练器缓存。
    const archive = generatedRunRoot(projectDirectory, taskId, runId);
    const archiveStaging = path.join(datasetRoot(projectDirectory, taskId), "Saved", "staging", "lora-" + runId);
    await mkdir(archiveStaging, { recursive: true });
    for (const name of ["dataset", "config", "manifest.json"]) await cp(path.join(temporary, name), path.join(archiveStaging, name), { recursive: true, errorOnExist: true });
    await copyFile(path.join(temporary, "status.json"), path.join(archiveStaging, "result.json"));
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(archiveStaging, archive);
    await rename(temporary, destination);
    return { runId, runDirectory: destination, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function comfyQueueStatus(config) {
  const apiUrl = primaryComfyUiUrl(config);
  if (!apiUrl) return null;
  try {
    const response = await fetch(apiUrl + "/queue", { signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function freezeLoraTrainingRun(projectRoot, projectDirectory, taskId, config, { runSettings = null } = {}) {
  const preflight = await preflightLoraTraining(projectRoot, projectDirectory, taskId, config, { runSettings });
  if (!preflight.ready) throw new LoraTrainingError(409, "lora_training_preflight_failed", preflight);
  return snapshotRun(projectRoot, projectDirectory, taskId, config, preflight);
}


export function createLoraTrainingPlanInterface(implementation) {
  return Object.freeze({
    environment: Object.freeze({
      read: implementation.readCachedLoraTrainingEnvironment,
      readCached: implementation.readCachedLoraTrainingEnvironment,
      inspect: implementation.readLoraTrainingEnvironment,
    }),
    recipes: Object.freeze({
      list: implementation.listLoraTrainingRecipes,
    }),
    runSettings: Object.freeze({
      read: implementation.readLoraTrainingRunSettings,
    }),
    preflight: implementation.preflightLoraTraining,
    activationGuide: implementation.readLoraActivationGuide,
    freeze: implementation.freezeLoraTrainingRun,
  });
}
