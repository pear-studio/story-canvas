import { listRegisteredProjects } from "./project-registry.mjs";
import { expandSavedRunSettings } from "./lora-training-settings.mjs";
import { readMusiqStatus } from "./lora-image-quality.mjs";
import { trainingImageTarget } from "./lora-image-preparation-contract.mjs";
import { randomBytes } from "node:crypto";
import { cp, copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createLoraTrainingRunManifest, validateLoraTrainingRunManifest } from "./lora-training-run-manifest.mjs";
import * as support from "./lora-training-support.mjs";
import { captionerManifestPath, captionerModelRoot, inspectCaptioningProvider, isPathLikeCommand, readCaptioningLatest, requireDataset, requireTask, resolveCaptionerCommand } from "./lora-training-facts.mjs";
import { listLoraTrainingRuns } from "./lora-training-run-index.mjs";
import { readLoraTrainingRecipe } from "./lora-training-recipe.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";

const {
  LoraTrainingError, idPatterns, sha256Pattern, runningStatuses, upscaleModelManifestRelativePath, upscaleModelId,
  loraTrainingOverrideDefinitions,
  createId, isRecord, isWithin, exists, readJson, writeJsonAtomic,
  sha256File, datasetRoot, runRoot, generatedRunRoot, itemPaths,
  readAssetMeta, canonicalJson, configuredPath, execFileAsync,
  assertLoraTrainingRunManifest,
} = support;

const loraEnvironmentCache = new Map();

// runner 单文件由仓库管理；版本随语义变更手动递增，sha256 在冻结时实测。
export const QWEN_RUNNER_NAME = "qwen-image21-lora-runner";
export const QWEN_RUNNER_VERSION = 1;

export function loraRunnerPath(projectRoot) {
  return path.join(projectRoot, "app", "python", "qwen-image21-lora-runner.py");
}

export async function gitCommit(directory) {
  try {
    return (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { windowsHide: true, timeout: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}

// 训练器身份：优先 git HEAD；无 git 历史的 zipball 安装退化为关键文件内容指纹核对。
export async function resolveTrainerCommit(trainerRoot, manifest) {
  const commit = await gitCommit(trainerRoot);
  if (commit) return { commit, matches: manifest?.commit === commit, message: manifest?.commit === commit ? "DiffSynth commit 符合版本清单" : `DiffSynth commit 不符：${commit}` };
  const identityFiles = Array.isArray(manifest?.identity_files) ? manifest.identity_files : [];
  if (identityFiles.length === 0) return { commit: null, matches: false, message: "无法读取 DiffSynth commit" };
  for (const entry of identityFiles) {
    const target = path.join(trainerRoot, entry.file);
    const hash = await sha256File(target).catch(() => null);
    if (hash !== entry.sha256) return { commit: null, matches: false, message: `DiffSynth 关键文件不符：${entry.file}` };
  }
  return { commit: manifest.commit, matches: true, message: "无 git 历史，关键文件内容符合固定 commit" };
}

// 轻量探测：只读版本与 BF16 能力，不分配显存、不常驻占卡。
export async function pythonProbe(python, trainerRoot) {
  const code = "import json,sys,torch; ok=torch.cuda.is_available(); print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.version.cuda,'cuda_available':ok,'gpu':torch.cuda.get_device_name(0) if ok else None,'vram_bytes':torch.cuda.get_device_properties(0).total_memory if ok else 0,'bf16_supported':bool(ok and torch.cuda.is_bf16_supported())}))";
  const result = await execFileAsync(python, ["-c", code], { cwd: trainerRoot ?? undefined, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}

export async function readQwenModelFiles(projectRoot) {
  const manifest = await readJson(path.join(projectRoot, "library", "lora-training", "qwen-image21-models.json"), { optional: true });
  if (!isRecord(manifest) || !Array.isArray(manifest.files) || manifest.files.some((file) => !isRecord(file) || typeof file.relative_path !== "string")) throw new LoraTrainingError(422, "invalid_qwen_model_manifest");
  return { repository: typeof manifest.repository === "string" ? manifest.repository : null, files: manifest.files };
}

// processor 前缀嵌套在 text_encoder 前缀内，按前缀长度从长到短匹配。
export function modelFileKind(base, relativePath) {
  const entries = Object.entries(base ?? {})
    .filter(([, dir]) => typeof dir?.relative_path === "string" && relativePath.startsWith(dir.relative_path))
    .sort((left, right) => right[1].relative_path.length - left[1].relative_path.length);
  return entries[0]?.[0] ?? null;
}

export async function readLoraTrainingEnvironment(projectRoot, config) {
  const manifest = await readJson(path.join(projectRoot, "library", "lora-training", "diffsynth.json"), { optional: true });
  const trainerRoot = configuredPath(projectRoot, config?.lora_training?.diffsynth?.trainer_root, "../story-canvas-trainer/DiffSynth-Studio");
  const python = configuredPath(projectRoot, config?.lora_training?.diffsynth?.python, "../story-canvas-trainer/DiffSynth-Studio/.venv/Scripts/python.exe");
  const captioning = await inspectCaptioningProvider(projectRoot, config);
  const upscaler = await readUpscaleModelStatus(projectRoot, config);
  const quality = await readMusiqStatus(projectRoot, config);
  const checks = [];
  let probe = null;
  const trainerRootExists = Boolean(trainerRoot && await exists(trainerRoot));
  const identity = trainerRootExists ? await resolveTrainerCommit(trainerRoot, manifest) : { commit: null, matches: false, message: "无法读取 DiffSynth commit" };
  const commit = identity.commit;
  checks.push({ id: "trainer_root", ok: trainerRootExists, message: trainerRootExists ? "DiffSynth 训练器目录可用" : "DiffSynth 训练器目录缺失" });
  checks.push({ id: "trainer_commit", ok: Boolean(commit && identity.matches), message: identity.message });
  const lockPath = configuredPath(projectRoot, manifest?.dependency_lock, path.join("app", "python", "diffsynth.lock"));
  checks.push({ id: "dependency_lock", ok: Boolean(lockPath && await exists(lockPath)), message: lockPath && await exists(lockPath) ? "训练依赖锁可用" : "训练依赖锁缺失" });
  const runnerPath = loraRunnerPath(projectRoot);
  const runnerExists = await exists(runnerPath);
  const runnerHash = runnerExists ? await sha256File(runnerPath) : null;
  checks.push({ id: "runner", ok: runnerExists, message: runnerExists ? "训练 runner 可用" : "训练 runner 缺失：app/python/qwen-image21-lora-runner.py" });
  try {
    probe = await pythonProbe(python, trainerRoot);
    checks.push({ id: "python", ok: manifest?.runtime?.python === probe.python, message: `Python ${probe.python}` });
    checks.push({ id: "torch", ok: manifest?.runtime?.torch === probe.torch, message: `Torch ${probe.torch}` });
    checks.push({ id: "cuda", ok: probe.cuda_available, message: probe.cuda_available ? `${probe.gpu}，CUDA ${probe.cuda}` : "CUDA 不可用" });
    checks.push({ id: "bf16", ok: probe.bf16_supported === true, message: probe.bf16_supported ? "GPU 支持 BF16 训练" : "GPU 不支持 BF16 训练" });
  } catch (error) {
    checks.push({ id: "python", ok: false, message: `训练 Python 不可用：${error.message}` });
  }
  return { available: checks.every((check) => check.ok), trainer_root: trainerRoot, python, manifest, commit, runtime: probe, runner: { name: QWEN_RUNNER_NAME, version: QWEN_RUNNER_VERSION, path: runnerPath, exists: runnerExists, sha256: runnerHash }, checks, captioning, optional_capabilities: { upscaler, quality } };
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
  const trainerRoot = configuredPath(projectRoot, config?.lora_training?.diffsynth?.trainer_root, "../story-canvas-trainer/DiffSynth-Studio");
  const python = configuredPath(projectRoot, config?.lora_training?.diffsynth?.python, "../story-canvas-trainer/DiffSynth-Studio/.venv/Scripts/python.exe");
  const diffsynthManifestPath = path.join(projectRoot, "library", "lora-training", "diffsynth.json");
  const diffsynthManifest = await readJson(diffsynthManifestPath, { optional: true });
  const modelManifestPath = path.join(projectRoot, "library", "lora-training", "qwen-image21-models.json");
  const modelManifest = await readJson(modelManifestPath, { optional: true });
  const captioning = config?.lora_training?.captioning;
  const captionerManifestPathValue = captionerManifestPath(projectRoot, captioning);
  const captionerManifest = captionerManifestPathValue ? await readJson(captionerManifestPathValue, { optional: true }) : null;
  const captionerRoot = captionerModelRoot(projectRoot, captioning, captionerManifest, config?.models_root);
  const upscalerManifestPath = path.join(projectRoot, upscaleModelManifestRelativePath);
  const modelsRoot = configuredPath(projectRoot, config?.models_root);
  const dependencies = new Set();
  const add = (target) => { if (target) dependencies.add(path.resolve(target)); };
  add(diffsynthManifestPath);
  add(modelManifestPath);
  add(upscalerManifestPath);
  add(python);
  add(loraRunnerPath(projectRoot));
  add(configuredPath(projectRoot, diffsynthManifest?.dependency_lock, path.join("app", "python", "diffsynth.lock")));
  if (trainerRoot) {
    add(path.join(trainerRoot, ".git", "HEAD"));
    add(path.join(trainerRoot, ".git", "index"));
  }
  if (modelsRoot) {
    for (const file of Array.isArray(modelManifest?.files) ? modelManifest.files : []) if (typeof file?.relative_path === "string") add(path.join(modelsRoot, file.relative_path));
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
    trainer_commit: trainerRoot ? (await resolveTrainerCommit(trainerRoot, diffsynthManifest)).commit : null,
    diffsynth_manifest: diffsynthManifest,
    model_manifest: modelManifest,
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
    if (recipe.family !== "qwen-image-2-1") continue;
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
  if (!Number.isInteger(next.max_pixels) || next.max_pixels < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["max_pixels"]);
  if (!Number.isInteger(next.network_dim) || next.network_dim < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["network_dim"]);
  if (typeof next.learning_rate !== "number" || !(next.learning_rate > 0)) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["learning_rate"]);
  if (!Number.isInteger(next.gradient_accumulation_steps) || next.gradient_accumulation_steps < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["gradient_accumulation_steps"]);
  if (!isRecord(next.optimizer) || !Array.isArray(next.optimizer.betas)) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["optimizer"]);
  if (!isRecord(next.scheduler)) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["scheduler"]);
  if (!isRecord(next.precision)) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["precision"]);
  if (typeof next.gradient_checkpointing !== "boolean") throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["gradient_checkpointing"]);
  if (!Array.isArray(next.lora_target_modules) || !next.lora_target_modules.length) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["lora_target_modules"]);
  return next;
}

export function semanticTrainingConfig(task, recipe) {
  const allowed = new Set(Object.keys(loraTrainingOverrideDefinitions));
  const next = structuredClone(recipe.semantic_config);
  for (const [key, value] of Object.entries(task.training_recipe.overrides ?? {})) {
    if (!allowed.has(key)) throw new LoraTrainingError(422, "unsupported_lora_training_parameter", [key]);
    next[key] = value;
  }
  // alpha 恒等于 rank；Micro Batch 固定 1，都不是独立旋钮。
  next.network_alpha = next.network_dim;
  next.micro_batch_size = 1;
  return validateSemanticConfig(next);
}

export function validateRunSettings(settings, semantic) {
  if (!isRecord(settings)) throw new LoraTrainingError(422, "missing_lora_training_run_settings");
  const allowed = new Set(["note", "max_train_steps", "save_every_n_steps", "seed", "gradient_accumulation_steps"]);
  if (settings.note !== undefined && typeof settings.note !== "string") throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["note"]);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknown.length) throw new LoraTrainingError(422, "unsupported_lora_training_parameter", unknown);
  for (const key of ["max_train_steps", "save_every_n_steps", "seed"]) if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", [key]);
  if (settings.save_every_n_steps > settings.max_train_steps) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["save_every_n_steps"]);
  if (settings.gradient_accumulation_steps !== semantic.gradient_accumulation_steps) throw new LoraTrainingError(422, "gradient_accumulation_mismatch", [{ expected: semantic.gradient_accumulation_steps, actual: settings.gradient_accumulation_steps }]);
  return settings;
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
    // v5 清单的 run 段与 v4 历史清单的 config 段都作为“上一次实际参数”展示。
    last_run: previousRun ? { id: previousRun.id, created_at: previousRun.created_at,
      status: previousRun.status.status, config: previousRun.manifest?.run ?? previousRun.manifest?.config ?? null } : null,
  };
}

export function preflightItemLabel(item) {
  const identity = item.asset_id ? `图片“${item.asset_id}”` : `图片项 ${item.id}`;
  return `${identity}（${item.file ?? item.id}）`;
}

export async function resolveModel(projectRoot, config, label, identity, { hash = true } = {}) {
  const root = configuredPath(projectRoot, config?.models_root);
  if (!root) return { label, identity, path: null, exists: false, sha256: null, size: null, matches: false };
  const target = path.resolve(root, identity?.relative_path ?? "");
  if (!isWithin(root, target)) throw new LoraTrainingError(422, "invalid_lora_training_model_path", [label]);
  const present = await exists(target);
  const size = present ? (await stat(target)).size : null;
  const actualHash = present && hash ? await sha256File(target) : null;
  const sizeMatches = !Number.isSafeInteger(identity?.size_bytes) || identity.size_bytes === size;
  return { label, identity, path: target, exists: present, sha256: actualHash, size, matches: present && sizeMatches && (!identity.sha256 || identity.sha256 === actualHash) };
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
  // 逐文件模型身份以仓库清单为准，按任务设置的 base 目录前缀归属到 kind。
  const models = [];
  const modelsRoot = configuredPath(projectRoot, config?.models_root);
  let modelManifest = null;
  try {
    modelManifest = await readQwenModelFiles(projectRoot);
  } catch {
    blockers.push({ code: "invalid_qwen_model_manifest", message: "Qwen 模型文件清单缺失或无效" });
  }
  if (modelManifest && !modelsRoot) blockers.push({ code: "models_root_not_configured", message: "未配置 models_root，无法校验模型文件" });
  if (modelManifest && modelsRoot) {
    for (const file of modelManifest.files) {
      const kind = modelFileKind(task.target.base, file.relative_path);
      if (!kind) continue;
      const identity = { relative_path: file.relative_path, sha256: file.sha256 ?? null, size_bytes: Number.isSafeInteger(file.size) ? file.size : null, source: modelManifest.repository };
      const resolved = await resolveModel(projectRoot, config, `${kind}:${file.relative_path}`, identity);
      models.push({ ...resolved, kind });
      if (!resolved.exists) blockers.push({ code: "model_missing", model: file.relative_path, message: `${kind} 模型文件缺失：${file.relative_path}` });
      else if (!identity.sha256) blockers.push({ code: "model_sha_unconfirmed", model: file.relative_path, message: `${file.relative_path} 清单缺少 SHA-256` });
      else if (!resolved.matches) blockers.push({ code: "model_sha_mismatch", model: file.relative_path, actual_sha256: resolved.sha256, message: `${file.relative_path} SHA-256 或大小不匹配` });
    }
    for (const kind of ["dit", "text_encoder", "vae", "processor"]) {
      if (!models.some((model) => model.kind === kind)) blockers.push({ code: "model_kind_unmapped", model: kind, message: `base.${kind} 目录前缀没有匹配任何模型清单文件` });
    }
  }
  const activeRuns = await activeRunStatuses(projectRoot);
  if (activeRuns.length) blockers.push({ code: "lora_training_active", message: "当前设备已有训练 run", runs: activeRuns });
  const recipe = await readTrainingRecipe(projectRoot, task.training_recipe.id);
  if (!recipe || recipe.family !== task.target.family) blockers.push({ code: "invalid_training_recipe", message: "训练方案缺失或模型家族不符" });
  let semanticConfig = null;
  if (recipe?.family === task.target.family) {
    try {
      semanticConfig = semanticTrainingConfig(task, recipe);
      runSettings = expandSavedRunSettings(task, semanticConfig, runSettings);
      validateRunSettings(runSettings, semanticConfig);
    } catch (error) {
      const message = error.code === "unsaved_lora_training_settings" ? "请先保存训练参数，再执行预检" : error.code === "gradient_accumulation_mismatch" ? "梯度累积与训练方案不一致，请先保存训练参数" : error.code === "missing_lora_training_run_settings" ? "请先填写本次训练的实验与执行参数" : "训练参数无效";
      blockers.push({ code: error.code ?? "invalid_lora_training_parameter", message });
    }
  }
  // 容量估算参考方案 §7：缓存 + 新旧恢复包共存 + 各保存节点的 LoRA 权重。
  const dimensionScale = (semanticConfig?.network_dim ?? 32) / 32;
  const cacheBytes = enabledItems.length * 8 * 1024 ** 2;
  const loraBytes = 200 * 1024 ** 2 * dimensionScale;
  const resumeBytes = 2 * (loraBytes + 2 * 2 * loraBytes);
  const checkpointCount = runSettings ? Math.ceil(runSettings.max_train_steps / runSettings.save_every_n_steps) + 1 : 2;
  const estimatedBytes = cacheBytes + resumeBytes + checkpointCount * loraBytes;
  const volume = await statfs(projectDirectory).catch(() => null);
  const availableDiskBytes = volume ? Number(volume.bavail) * Number(volume.bsize) : null;
  if (availableDiskBytes !== null && availableDiskBytes < estimatedBytes) blockers.push({ code: "insufficient_disk_space", message: `可用磁盘 ${Math.round(availableDiskBytes / 1024 ** 3)} GB，低于缓存与恢复包共存余量` });
  return { ready: blockers.length === 0, blockers, warnings, environment, models: models.map(({ path: _path, ...model }) => model), recipe: recipe ? { id: recipe.id, version: recipe.version, name: recipe.name, sha256: recipe.sha256 } : null, semantic_config: semanticConfig, run_settings: runSettings, dataset: { id: task.dataset_id, name: dataset.name }, estimated_disk_bytes: Math.round(estimatedBytes), available_disk_bytes: availableDiskBytes };
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

// 训练需要独占显存；只释放已配置本机 ComfyUI 的闲置模型，不中断生成任务。
export async function prepareLoraTrainingGpu(config) {
  const apiUrl = config?.comfyui_urls?.[0];
  if (!apiUrl) return;
  let response;
  try { response = await fetch(`${apiUrl}/queue`, { signal: AbortSignal.timeout(10_000) }); }
  catch { return; } // 本机 ComfyUI 未运行不影响训练。
  if (!response.ok) throw new LoraTrainingError(409, "comfyui_queue_unavailable");
  const queue = await response.json();
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new LoraTrainingError(409, "comfyui_queue_unavailable");
  if (queue.queue_running.length || queue.queue_pending.length) throw new LoraTrainingError(409, "comfyui_busy", ["请等待当前生成队列完成后再启动训练"]);
  const freed = await fetch(`${apiUrl}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) });
  if (!freed.ok) throw new LoraTrainingError(409, "comfyui_unload_failed");
}

function initialRunStatus() {
  return { version: 1, status: "starting", phase: null, step: 0, loss: null, lr: null, samples_seen: 0, eta_seconds: null, pid: null, process_started_at: null, exit_code: null, error: null, checkpoints: [], updated_at: new Date().toISOString() };
}

/**
 * 冻结一个新 run 的全部输入与参数并原子发布：
 * Training/<task>/<run>/{manifest.json, inputs/, resume/} 归档冻结事实，
 * Saved/Training/<task>/<run>/{cache/, control/, status.json} 是可清理工作区。
 */
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
  const archive = generatedRunRoot(projectDirectory, taskId, runId);
  const archiveStaging = path.join(datasetRoot(projectDirectory, taskId), "Saved", "staging", "lora-" + runId);
  await mkdir(temporary, { recursive: true });
  try {
    for (const name of ["cache", "control"]) await mkdir(path.join(temporary, name), { recursive: true });
    await mkdir(checkpointDirectory, { recursive: true });
    await mkdir(path.join(archiveStaging, "inputs"), { recursive: true });
    await mkdir(path.join(archiveStaging, "resume"), { recursive: true });
    const enabledGroups = dataset.groups.filter((group) => group.enabled);
    const enabledGroupIds = new Set(enabledGroups.map((group) => group.id));
    const groupById = new Map(enabledGroups.map((group) => [group.id, group]));
    const snapshots = [];
    for (const item of dataset.items.filter((entry) => entry.enabled && enabledGroupIds.has(entry.group_id))) {
      const files = itemPaths(projectDirectory, task.dataset_id, item);
      const extension = path.extname(files.image).toLowerCase();
      const imageTarget = path.join(archiveStaging, "inputs", `${item.id}${extension}`);
      const captionTarget = path.join(archiveStaging, "inputs", `${item.id}.txt`);
      await Promise.all([copyFile(files.image, imageTarget), copyFile(files.caption, captionTarget)]);
      snapshots.push({ item_id: item.id, asset_id: item.asset_id, group_id: item.group_id, source_file: item.file, image_file: `${item.id}${extension}`, caption_file: `${item.id}.txt`, image_sha256: await sha256File(imageTarget), caption_sha256: await sha256File(captionTarget) });
    }
    const sampling = { weights: snapshots.map((snapshot) => ({ item_id: snapshot.item_id, weight: groupById.get(snapshot.group_id).repeats })) };
    const runnerPath = loraRunnerPath(projectRoot);
    const runner = { name: QWEN_RUNNER_NAME, version: QWEN_RUNNER_VERSION, sha256: await sha256File(runnerPath) };
    const paths = {
      inputs_dir: path.join(archive, "inputs"),
      cache_dir: path.join(destination, "cache"),
      control_dir: path.join(destination, "control"),
      archive_dir: archive,
      resume_dir: path.join(archive, "resume"),
      events_file: path.join(destination, "events.jsonl"),
      log_file: path.join(destination, "console.log"),
      checkpoints_dir: checkpointDirectory,
      checkpoints_relative_path: checkpointsRelativePath,
      models_root: modelsRoot,
    };
    const execution = { executable: preflight.environment.python, argv: [runnerPath, "--manifest", path.join(archive, "manifest.json")] };
    const manifest = createLoraTrainingRunManifest({
      runId,
      taskId,
      task,
      dataset,
      snapshots,
      preflight,
      paths,
      execution,
      runner,
      sampling,
      resume: null,
    });
    await writeJsonAtomic(path.join(archiveStaging, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(temporary, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(temporary, "status.json"), initialRunStatus());
    await copyFile(path.join(temporary, "status.json"), path.join(archiveStaging, "result.json"));
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(archiveStaging, archive);
    await rename(temporary, destination);
    return { runId, runDirectory: destination, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(archiveStaging, { recursive: true, force: true });
    throw error;
  }
}

export async function freezeLoraTrainingRun(projectRoot, projectDirectory, taskId, config, { runSettings = null } = {}) {
  const preflight = await preflightLoraTraining(projectRoot, projectDirectory, taskId, config, { runSettings });
  if (!preflight.ready) throw new LoraTrainingError(409, "lora_training_preflight_failed", preflight);
  await prepareLoraTrainingGpu(config);
  return snapshotRun(projectRoot, projectDirectory, taskId, config, preflight);
}

/**
 * 续训冻结：沿用父 run 的全部冻结语义参数与输入副本，只改累计目标步数与备注。
 * 调用方（HTTP 串行层 + coordination admission）保证锁内无并发；这里再次校验
 * 来源快照仍是本任务最新完整状态。
 */
export async function freezeLoraTrainingResumeRun(projectRoot, projectDirectory, taskId, parentRunId, config, request = {}, { environment: injectedEnvironment = null } = {}) {
  const maxTrainSteps = request?.max_train_steps;
  if (!Number.isInteger(maxTrainSteps) || maxTrainSteps < 1) throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["max_train_steps"]);
  if (request?.note !== undefined && typeof request.note !== "string") throw new LoraTrainingError(422, "invalid_lora_training_parameter", ["note"]);
  if (typeof request?.source_snapshot_id !== "string" || !/^step-\d{6}$/.test(request.source_snapshot_id)) throw new LoraTrainingError(422, "invalid_lora_training_resume_source", ["source_snapshot_id"]);
  if (!sha256Pattern.test(request?.source_sha256 ?? "")) throw new LoraTrainingError(422, "invalid_lora_training_resume_source", ["source_sha256"]);
  const parentArchive = generatedRunRoot(projectDirectory, taskId, parentRunId);
  const parentManifest = await readJson(path.join(parentArchive, "manifest.json"), { optional: true });
  if (!parentManifest) throw new LoraTrainingError(404, "lora_training_run_not_found");
  if (parentManifest.version !== 5) throw new LoraTrainingError(409, "lora_training_resume_unsupported", ["Anima 历史记录不支持精确续训"]);
  assertLoraTrainingRunManifest(parentManifest, { taskId, runId: parentRunId });
  const pointer = await readJson(path.join(parentArchive, "resume", "latest.json"), { optional: true });
  if (!pointer || pointer.snapshot_id !== request.source_snapshot_id || pointer.sha256 !== request.source_sha256) {
    throw new LoraTrainingError(409, "lora_training_resume_source_stale", ["来源快照已不是本任务最新完整状态，请重新读取训练记录"]);
  }
  const snapshotState = await readJson(path.join(parentArchive, "resume", request.source_snapshot_id, "state.json"), { optional: true });
  if (!snapshotState || !Number.isInteger(snapshotState.step)) throw new LoraTrainingError(409, "lora_training_resume_source_missing", ["来源恢复包不完整"]);
  const sourceSnapshot = path.join(parentArchive, "resume", request.source_snapshot_id);
  if (await sha256File(path.join(sourceSnapshot, "state.json")) !== request.source_sha256) throw new LoraTrainingError(409, "lora_training_resume_source_stale");
  for (const name of ["lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json"]) {
    if (!snapshotState.files?.[name] || await sha256File(path.join(sourceSnapshot, name)).catch(() => null) !== snapshotState.files[name]) throw new LoraTrainingError(409, "lora_training_resume_source_missing", [name]);
  }
  const startStep = snapshotState.step;
  if (maxTrainSteps <= startStep) throw new LoraTrainingError(422, "lora_training_resume_target_not_advanced", [`累计目标步数必须大于已完成步数 ${startStep}`]);
  const environment = injectedEnvironment ?? await readCachedLoraTrainingEnvironment(projectRoot, config);
  if (!environment.available) throw new LoraTrainingError(409, "training_environment_unavailable", environment.checks.filter((check) => !check.ok).map((check) => check.message));
  if (environment.commit !== parentManifest.trainer.diffsynth_commit) throw new LoraTrainingError(409, "lora_training_trainer_changed", ["DiffSynth commit 与父 run 不一致，不能精确续训"]);
  if (environment.runner.sha256 !== parentManifest.trainer.runner.sha256) throw new LoraTrainingError(409, "lora_training_runner_changed", ["训练 runner 已变化，不能精确续训"]);
  const modelsRoot = configuredPath(projectRoot, config.models_root);
  if (!modelsRoot) throw new LoraTrainingError(409, "models_root_not_configured");
  for (const model of parentManifest.models) {
    const resolved = await resolveModel(projectRoot, config, `${model.kind}:${model.relative_path}`, { relative_path: model.relative_path, sha256: model.sha256, size_bytes: model.size_bytes });
    if (!resolved.exists || !resolved.matches) throw new LoraTrainingError(409, "lora_training_model_changed", [`${model.relative_path} 与父 run 冻结身份不符`]);
  }
  const activeRuns = await activeRunStatuses(projectRoot);
  if (activeRuns.length) throw new LoraTrainingError(409, "lora_training_active", activeRuns);
  await prepareLoraTrainingGpu(config);

  const runId = createId("run");
  const checkpointsRelativePath = path.posix.join("loras", "training", taskId, runId);
  const checkpointDirectory = path.join(modelsRoot, ...checkpointsRelativePath.split("/"));
  const runsDirectory = path.dirname(runRoot(projectDirectory, taskId, runId));
  const temporary = path.join(runsDirectory, `.${runId}.${randomBytes(4).toString("hex")}.tmp`);
  const destination = path.join(runsDirectory, runId);
  const archive = generatedRunRoot(projectDirectory, taskId, runId);
  const archiveStaging = path.join(datasetRoot(projectDirectory, taskId), "Saved", "staging", "lora-" + runId);
  await mkdir(temporary, { recursive: true });
  try {
    for (const name of ["cache", "control"]) await mkdir(path.join(temporary, name), { recursive: true });
    await mkdir(checkpointDirectory, { recursive: true });
    // 恢复包必须在父记录清理后仍可用：新 run 归档自己的冻结输入副本。
    await cp(path.join(parentArchive, "inputs"), path.join(archiveStaging, "inputs"), { recursive: true, errorOnExist: true });
    await mkdir(path.join(archiveStaging, "resume"), { recursive: true });
    await cp(sourceSnapshot, path.join(archiveStaging, "resume", request.source_snapshot_id), { recursive: true, errorOnExist: true });
    const paths = {
      inputs_dir: path.join(archive, "inputs"),
      cache_dir: path.join(destination, "cache"),
      control_dir: path.join(destination, "control"),
      archive_dir: archive,
      resume_dir: path.join(archive, "resume"),
      events_file: path.join(destination, "events.jsonl"),
      log_file: path.join(destination, "console.log"),
      checkpoints_dir: checkpointDirectory,
      checkpoints_relative_path: checkpointsRelativePath,
      models_root: modelsRoot,
    };
    const runnerPath = loraRunnerPath(projectRoot);
    const manifest = {
      version: 5,
      id: runId,
      task_id: taskId,
      dataset_id: parentManifest.dataset_id,
      created_at: new Date().toISOString(),
      task_name: parentManifest.task_name,
      dataset_name: parentManifest.dataset_name,
      family: parentManifest.family,
      prompt_family: parentManifest.prompt_family,
      usage_defaults: structuredClone(parentManifest.usage_defaults),
      description: parentManifest.description,
      activation_terms: structuredClone(parentManifest.activation_terms),
      items: structuredClone(parentManifest.items),
      groups: structuredClone(parentManifest.groups),
      models: structuredClone(parentManifest.models),
      trainer: {
        diffsynth_commit: environment.commit,
        python: environment.runtime.python,
        torch: environment.runtime.torch,
        gpu: environment.runtime.gpu ?? null,
        vram_bytes: environment.runtime.vram_bytes ?? 0,
        runner: { name: QWEN_RUNNER_NAME, version: QWEN_RUNNER_VERSION, sha256: environment.runner.sha256 },
      },
      recipe: structuredClone(parentManifest.recipe),
      semantic_config: structuredClone(parentManifest.semantic_config),
      run: {
        max_train_steps: maxTrainSteps,
        save_every_n_steps: parentManifest.run.save_every_n_steps,
        seed: parentManifest.run.seed,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
      sampling: structuredClone(parentManifest.sampling),
      resume: { parent_run_id: parentRunId, source_snapshot_id: request.source_snapshot_id, source_sha256: request.source_sha256, start_step: startStep },
      paths,
      execution: { executable: environment.python, argv: [runnerPath, "--manifest", path.join(archive, "manifest.json")] },
      seed: parentManifest.seed,
    };
    const errors = validateLoraTrainingRunManifest(manifest);
    if (errors.length) throw new LoraTrainingError(422, "invalid_lora_training_run_manifest", errors);
    await writeJsonAtomic(path.join(archiveStaging, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(temporary, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(temporary, "status.json"), initialRunStatus());
    await copyFile(path.join(temporary, "status.json"), path.join(archiveStaging, "result.json"));
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(archiveStaging, archive);
    await rename(temporary, destination);
    return { runId, runDirectory: destination, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(archiveStaging, { recursive: true, force: true });
    throw error;
  }
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
    freezeResume: implementation.freezeLoraTrainingResumeRun,
  });
}
