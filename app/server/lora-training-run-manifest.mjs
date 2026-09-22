import path from "node:path";

const sha256Pattern = /^[0-9a-f]{64}$/;
const idPatterns = Object.freeze({
  run: /^run-[a-f0-9]{12}$/,
  task: /^(?:lora|dataset)-[a-f0-9]{12}$/,
  dataset: /^dataset-[a-f0-9]{12}$/,
  item: /^item-[a-f0-9]{12}$/,
  asset: /^(?:asset-[a-f0-9]{12}|[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9]{3})$/,
  group: /^group-[a-f0-9]{12}$/,
});
const snapshotIdPattern = /^step-\d{6}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function validDate(value) {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isSafeRelativePath(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value === value.trim()
    && !value.startsWith("/")
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

function validateObject(value, label, requiredKeys, errors, allowedKeys = requiredKeys) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是对象`);
    return false;
  }
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) errors.push(`${label} 包含未支持字段：${key}`);
  for (const key of requiredKeys) if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} 缺少必需字段`);
  return true;
}

function validateNonEmptyString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} 必须是非空字符串`);
}

function validatePositiveInteger(value, label, errors) {
  if (!isPositiveInteger(value)) errors.push(`${label} 必须是正整数`);
}

function validateHash(value, label, errors) {
  if (!sha256Pattern.test(value ?? "")) errors.push(`${label} 必须是 64 位小写 SHA-256`);
}

function validateUsageDefaults(value, errors) {
  const label = "usage_defaults";
  if (!validateObject(value, label, ["clip_skip", "sampler", "scheduler", "steps", "cfg"], errors)) return;
  if (value.clip_skip !== null) validatePositiveInteger(value.clip_skip, `${label}.clip_skip`, errors);
  validateNonEmptyString(value.sampler, `${label}.sampler`, errors);
  validateNonEmptyString(value.scheduler, `${label}.scheduler`, errors);
  validatePositiveInteger(value.steps, `${label}.steps`, errors);
  if (!isFiniteNumber(value.cfg) || value.cfg < 0) errors.push(`${label}.cfg 必须是非负有限数`);
}

function validateModel(value, index, errors) {
  const label = `models[${index}]`;
  if (!validateObject(value, label, ["kind", "relative_path", "sha256", "size_bytes", "source"], errors)) return;
  if (!["dit", "text_encoder", "vae", "processor"].includes(value.kind)) errors.push(`${label}.kind 无效`);
  if (!isSafeRelativePath(value.relative_path)) errors.push(`${label}.relative_path 必须是安全的正斜杠相对路径`);
  validateHash(value.sha256, `${label}.sha256`, errors);
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0) errors.push(`${label}.size_bytes 必须是非负整数`);
  if (value.source !== null && (typeof value.source !== "string" || !value.source.trim())) errors.push(`${label}.source 必须是非空字符串或 null`);
}

function validateGroup(value, index, errors) {
  const label = `groups[${index}]`;
  if (!validateObject(value, label, ["id", "name", "enabled", "repeats"], errors)) return;
  if (!idPatterns.group.test(value.id ?? "")) errors.push(`${label}.id 无效`);
  validateNonEmptyString(value.name, `${label}.name`, errors);
  if (typeof value.enabled !== "boolean") errors.push(`${label}.enabled 必须是布尔值`);
  validatePositiveInteger(value.repeats, `${label}.repeats`, errors);
}

function validateItem(value, index, groupIds, itemIds, assetIds, errors) {
  const label = `items[${index}]`;
  if (!validateObject(value, label, ["item_id", "asset_id", "group_id", "source_file", "image_file", "caption_file", "image_sha256", "caption_sha256"], errors)) return;
  if (!idPatterns.item.test(value.item_id ?? "")) errors.push(`${label}.item_id 无效`);
  else if (itemIds.has(value.item_id)) errors.push(`${label}.item_id 重复：${value.item_id}`);
  else itemIds.add(value.item_id);
  if (!idPatterns.asset.test(value.asset_id ?? "")) errors.push(`${label}.asset_id 无效`);
  else if (assetIds.has(value.asset_id)) errors.push(`${label}.asset_id 重复：${value.asset_id}`);
  else assetIds.add(value.asset_id);
  if (!idPatterns.group.test(value.group_id ?? "")) errors.push(`${label}.group_id 无效`);
  else if (!groupIds.has(value.group_id)) errors.push(`${label}.group_id 引用了未知分组`);
  for (const key of ["source_file", "image_file", "caption_file"]) if (!isSafeRelativePath(value[key])) errors.push(`${label}.${key} 必须是安全的正斜杠相对路径`);
  validateHash(value.image_sha256, `${label}.image_sha256`, errors);
  validateHash(value.caption_sha256, `${label}.caption_sha256`, errors);
}

function validateTrainer(value, errors) {
  const label = "trainer";
  if (!validateObject(value, label, ["diffsynth_commit", "python", "torch", "gpu", "vram_bytes", "runner"], errors)) return;
  for (const key of ["diffsynth_commit", "python", "torch"]) validateNonEmptyString(value[key], `${label}.${key}`, errors);
  // CPU/toy 环境没有 GPU 身份；正式预检会单独阻断无 CUDA 的运行。
  if (value.gpu !== null && typeof value.gpu !== "string") errors.push(`${label}.gpu 必须是字符串或 null`);
  if (!Number.isSafeInteger(value.vram_bytes) || value.vram_bytes < 0) errors.push(`${label}.vram_bytes 必须是非负整数`);
  const runner = value.runner;
  if (!validateObject(runner, `${label}.runner`, ["name", "version", "sha256"], errors)) return;
  if (runner.name !== "qwen-image21-lora-runner") errors.push(`${label}.runner.name 必须为 qwen-image21-lora-runner`);
  validatePositiveInteger(runner.version, `${label}.runner.version`, errors);
  validateHash(runner.sha256, `${label}.runner.sha256`, errors);
}

function validateRecipe(value, errors) {
  const label = "recipe";
  if (!validateObject(value, label, ["id", "version", "sha256", "overrides"], errors)) return;
  validateNonEmptyString(value.id, `${label}.id`, errors);
  validatePositiveInteger(value.version, `${label}.version`, errors);
  validateHash(value.sha256, `${label}.sha256`, errors);
  if (!validateObject(value.overrides, `${label}.overrides`, [], errors, ["network_dim", "learning_rate", "gradient_accumulation_steps"])) return;
  for (const key of ["network_dim", "gradient_accumulation_steps"]) if (Object.hasOwn(value.overrides, key)) validatePositiveInteger(value.overrides[key], `${label}.overrides.${key}`, errors);
  if (Object.hasOwn(value.overrides, "learning_rate") && (!isFiniteNumber(value.overrides.learning_rate) || value.overrides.learning_rate <= 0)) errors.push(`${label}.overrides.learning_rate 必须是正有限数`);
}

function validateSemanticConfig(value, errors) {
  const label = "semantic_config";
  const required = ["max_pixels", "network_dim", "network_alpha", "learning_rate", "gradient_accumulation_steps", "micro_batch_size", "optimizer", "scheduler", "precision", "gradient_checkpointing", "lora_target_modules"];
  if (!validateObject(value, label, required, errors)) return;
  for (const key of ["max_pixels", "network_dim", "network_alpha", "gradient_accumulation_steps"]) validatePositiveInteger(value[key], `${label}.${key}`, errors);
  if (value.micro_batch_size !== 1) errors.push(`${label}.micro_batch_size 固定为 1`);
  if (isPositiveInteger(value.network_dim) && isPositiveInteger(value.network_alpha) && value.network_alpha !== value.network_dim) errors.push(`${label}.network_alpha 必须等于 network_dim`);
  if (!isFiniteNumber(value.learning_rate) || value.learning_rate <= 0) errors.push(`${label}.learning_rate 必须是正有限数`);
  const optimizer = value.optimizer;
  if (validateObject(optimizer, `${label}.optimizer`, ["type", "betas", "eps", "weight_decay"], errors)) {
    validateNonEmptyString(optimizer.type, `${label}.optimizer.type`, errors);
    if (!Array.isArray(optimizer.betas) || optimizer.betas.length !== 2 || optimizer.betas.some((beta) => !isFiniteNumber(beta) || beta <= 0 || beta >= 1)) errors.push(`${label}.optimizer.betas 必须是两个 (0,1) 区间有限数`);
    if (!isFiniteNumber(optimizer.eps) || optimizer.eps <= 0) errors.push(`${label}.optimizer.eps 必须是正有限数`);
    if (!isFiniteNumber(optimizer.weight_decay) || optimizer.weight_decay < 0) errors.push(`${label}.optimizer.weight_decay 必须是非负有限数`);
  }
  const scheduler = value.scheduler;
  if (validateObject(scheduler, `${label}.scheduler`, ["type", "factor", "total_iters"], errors)) {
    validateNonEmptyString(scheduler.type, `${label}.scheduler.type`, errors);
    if (!isFiniteNumber(scheduler.factor) || scheduler.factor <= 0) errors.push(`${label}.scheduler.factor 必须是正有限数`);
    if (!Number.isSafeInteger(scheduler.total_iters) || scheduler.total_iters < 0) errors.push(`${label}.scheduler.total_iters 必须是非负整数`);
  }
  const precision = value.precision;
  if (validateObject(precision, `${label}.precision`, ["base", "lora", "optimizer_state"], errors)) {
    for (const key of ["base", "lora", "optimizer_state"]) validateNonEmptyString(precision[key], `${label}.precision.${key}`, errors);
  }
  if (typeof value.gradient_checkpointing !== "boolean") errors.push(`${label}.gradient_checkpointing 必须是布尔值`);
  if (!Array.isArray(value.lora_target_modules) || value.lora_target_modules.length === 0) errors.push(`${label}.lora_target_modules 必须是非空字符串数组`);
  else value.lora_target_modules.forEach((entry, index) => validateNonEmptyString(entry, `${label}.lora_target_modules[${index}]`, errors));
}

function validateRun(value, errors) {
  const label = "run";
  if (value?.note !== undefined && typeof value.note !== "string") errors.push("run.note 必须是字符串");
  if (!validateObject(value, label, ["max_train_steps", "save_every_n_steps", "seed"], errors, ["max_train_steps", "save_every_n_steps", "seed", "note"])) return;
  for (const key of ["max_train_steps", "save_every_n_steps", "seed"]) validatePositiveInteger(value[key], `${label}.${key}`, errors);
  if (isPositiveInteger(value.max_train_steps) && isPositiveInteger(value.save_every_n_steps) && value.save_every_n_steps > value.max_train_steps) errors.push(`${label}.save_every_n_steps 不能大于 max_train_steps`);
}

function validateSampling(value, itemIds, errors) {
  const label = "sampling";
  if (!validateObject(value, label, ["weights"], errors)) return;
  if (!Array.isArray(value.weights)) {
    errors.push(`${label}.weights 必须是数组`);
    return;
  }
  const seen = new Set();
  value.weights.forEach((entry, index) => {
    const entryLabel = `${label}.weights[${index}]`;
    if (!validateObject(entry, entryLabel, ["item_id", "weight"], errors)) return;
    if (!idPatterns.item.test(entry.item_id ?? "")) errors.push(`${entryLabel}.item_id 无效`);
    else if (seen.has(entry.item_id)) errors.push(`${entryLabel}.item_id 重复：${entry.item_id}`);
    else {
      seen.add(entry.item_id);
      if (itemIds.size && !itemIds.has(entry.item_id)) errors.push(`${entryLabel}.item_id 不在 items 快照中`);
    }
    validatePositiveInteger(entry.weight, `${entryLabel}.weight`, errors);
  });
}

function validateResume(value, errors) {
  if (value === null) return;
  const label = "resume";
  if (!validateObject(value, label, ["parent_run_id", "source_snapshot_id", "source_sha256", "start_step"], errors)) return;
  if (!idPatterns.run.test(value.parent_run_id ?? "")) errors.push(`${label}.parent_run_id 无效`);
  if (!snapshotIdPattern.test(value.source_snapshot_id ?? "")) errors.push(`${label}.source_snapshot_id 必须是 step-NNNNNN 形式`);
  validateHash(value.source_sha256, `${label}.source_sha256`, errors);
  if (!Number.isSafeInteger(value.start_step) || value.start_step < 0) errors.push(`${label}.start_step 必须是非负整数`);
}

function validatePaths(value, errors) {
  const label = "paths";
  const absolute = ["inputs_dir", "cache_dir", "control_dir", "archive_dir", "resume_dir", "events_file", "log_file", "checkpoints_dir", "models_root"];
  if (!validateObject(value, label, [...absolute, "checkpoints_relative_path"], errors)) return;
  for (const key of absolute) {
    if (typeof value[key] !== "string" || !value[key].trim() || !path.isAbsolute(value[key])) errors.push(`${label}.${key} 必须是绝对路径`);
  }
  if (!isSafeRelativePath(value.checkpoints_relative_path)) errors.push(`${label}.checkpoints_relative_path 必须是安全的正斜杠相对路径`);
}

function validateExecution(value, errors) {
  const label = "execution";
  if (!validateObject(value, label, ["executable", "argv"], errors)) return;
  validateNonEmptyString(value.executable, `${label}.executable`, errors);
  if (!Array.isArray(value.argv) || value.argv.length === 0) errors.push(`${label}.argv 必须是非空字符串数组`);
  else value.argv.forEach((entry, index) => validateNonEmptyString(entry, `${label}.argv[${index}]`, errors));
}

/**
 * 计划冻结与运行时之间唯一共享的训练事实快照（v5，单一来源）。
 * 调用方必须先复制当前图片和 Caption 到 inputs_dir，再传入已完成 preflight 的结果；
 * 运行时不得通过 task 或 dataset 重新解释这些值。
 */
export function createLoraTrainingRunManifest({
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
  resume = null,
  createdAt = new Date().toISOString(),
}) {
  const manifest = {
    version: 5,
    id: runId,
    task_id: taskId,
    dataset_id: task.dataset_id,
    created_at: createdAt,
    task_name: task.name,
    dataset_name: dataset.name,
    family: task.target.family,
    prompt_family: task.target.prompt_family,
    usage_defaults: clone(task.target.usage_defaults),
    description: dataset.description,
    activation_terms: clone(dataset.activation_terms),
    items: clone(snapshots),
    groups: clone(dataset.groups.filter((group) => group.enabled)),
    models: preflight.models.map((model) => ({
      kind: model.kind,
      relative_path: model.identity.relative_path,
      sha256: model.sha256,
      size_bytes: model.size,
      source: model.identity.source ?? null,
    })),
    trainer: clone({
      diffsynth_commit: preflight.environment.commit,
      python: preflight.environment.runtime.python,
      torch: preflight.environment.runtime.torch,
      gpu: preflight.environment.runtime.gpu ?? null,
      vram_bytes: preflight.environment.runtime.vram_bytes ?? 0,
      runner: { name: runner.name, version: runner.version, sha256: runner.sha256 },
    }),
    recipe: clone({
      id: preflight.recipe.id,
      version: preflight.recipe.version,
      sha256: preflight.recipe.sha256,
      overrides: task.training_recipe.overrides,
    }),
    semantic_config: clone(preflight.semantic_config),
    run: {
      max_train_steps: preflight.run_settings.max_train_steps,
      save_every_n_steps: preflight.run_settings.save_every_n_steps,
      seed: preflight.run_settings.seed,
      ...(preflight.run_settings.note !== undefined ? { note: preflight.run_settings.note } : {}),
    },
    sampling: clone(sampling),
    resume: clone(resume),
    paths: clone(paths),
    execution: clone(execution),
    seed: preflight.run_settings.seed,
  };
  const errors = validateLoraTrainingRunManifest(manifest);
  if (errors.length) {
    const error = new Error(`无法建立 LoRA run manifest：${errors.join("；")}`);
    error.code = "invalid_lora_training_run_manifest";
    error.details = errors;
    throw error;
  }
  return manifest;
}

export function validateLoraTrainingRunManifest(value) {
  const errors = [];
  if (!isRecord(value)) return ["manifest 必须是 JSON 对象"];
  const allowedKeys = ["version", "id", "task_id", "dataset_id", "created_at", "task_name", "dataset_name", "family", "prompt_family", "usage_defaults", "description", "activation_terms", "items", "groups", "models", "trainer", "recipe", "semantic_config", "run", "sampling", "resume", "paths", "execution", "seed"];
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) errors.push(`manifest 包含未支持字段：${key}`);
  if (value.version !== 5) errors.push("version 必须为 5");
  if (!idPatterns.run.test(value.id ?? "")) errors.push("id 无效");
  if (!idPatterns.task.test(value.task_id ?? "")) errors.push("task_id 无效");
  if (!idPatterns.dataset.test(value.dataset_id ?? "")) errors.push("dataset_id 无效");
  if (!validDate(value.created_at)) errors.push("created_at 无效");
  validateNonEmptyString(value.task_name, "task_name", errors);
  validateNonEmptyString(value.dataset_name, "dataset_name", errors);
  if (value.family !== "qwen-image-2-1") errors.push("family 必须为 qwen-image-2-1");
  validateNonEmptyString(value.prompt_family, "prompt_family", errors);
  validateUsageDefaults(value.usage_defaults, errors);
  if (typeof value.description !== "string") errors.push("description 必须是字符串");

  if (!Array.isArray(value.activation_terms)) errors.push("activation_terms 必须是数组");
  else {
    const terms = new Set();
    value.activation_terms.forEach((term, index) => {
      if (typeof term !== "string" || !term.trim()) errors.push(`activation_terms[${index}] 必须是非空字符串`);
      else {
        const normalized = term.trim().toLocaleLowerCase("en");
        if (terms.has(normalized)) errors.push(`activation_terms[${index}] 重复`);
        terms.add(normalized);
      }
    });
  }

  const groupIds = new Set();
  if (!Array.isArray(value.groups)) errors.push("groups 必须是数组");
  else value.groups.forEach((group, index) => {
    validateGroup(group, index, errors);
    if (isRecord(group) && idPatterns.group.test(group.id ?? "")) {
      if (groupIds.has(group.id)) errors.push(`groups[${index}].id 重复：${group.id}`);
      groupIds.add(group.id);
    }
  });

  const itemIds = new Set();
  const assetIds = new Set();
  if (!Array.isArray(value.items)) errors.push("items 必须是数组");
  else value.items.forEach((item, index) => validateItem(item, index, groupIds, itemIds, assetIds, errors));

  const modelPaths = new Set();
  const modelKinds = new Set();
  if (!Array.isArray(value.models) || value.models.length === 0) errors.push("models 必须是非空数组");
  else value.models.forEach((model, index) => {
    validateModel(model, index, errors);
    if (isRecord(model)) {
      if (typeof model.kind === "string") modelKinds.add(model.kind);
      if (typeof model.relative_path === "string") {
        if (modelPaths.has(model.relative_path)) errors.push(`models[${index}].relative_path 重复：${model.relative_path}`);
        modelPaths.add(model.relative_path);
      }
    }
  });
  for (const kind of ["dit", "text_encoder", "vae", "processor"]) if (!modelKinds.has(kind)) errors.push(`manifest.models 缺少 ${kind} 文件`);

  validateTrainer(value.trainer, errors);
  validateRecipe(value.recipe, errors);
  validateSemanticConfig(value.semantic_config, errors);
  validateRun(value.run, errors);
  validateSampling(value.sampling, itemIds, errors);
  validateResume(value.resume, errors);
  validatePaths(value.paths, errors);
  validateExecution(value.execution, errors);
  validatePositiveInteger(value.seed, "seed", errors);
  if (isPositiveInteger(value.seed) && isPositiveInteger(value.run?.seed) && value.seed !== value.run.seed) errors.push("seed 必须与 run.seed 一致");
  if (isRecord(value.resume) && Number.isSafeInteger(value.resume.start_step) && isPositiveInteger(value.run?.max_train_steps) && value.resume.start_step >= value.run.max_train_steps) errors.push("resume.start_step 必须小于 run.max_train_steps");
  return [...new Set(errors)];
}
