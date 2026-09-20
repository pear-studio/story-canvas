const sha256Pattern = /^[0-9a-f]{64}$/;
const idPatterns = Object.freeze({
  run: /^run-[a-f0-9]{12}$/,
  task: /^(?:lora|dataset)-[a-f0-9]{12}$/,
  dataset: /^dataset-[a-f0-9]{12}$/,
  item: /^item-[a-f0-9]{12}$/,
  asset: /^(?:asset-[a-f0-9]{12}|[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9]{3})$/,
  group: /^group-[a-f0-9]{12}$/,
});

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
  if (!["dit", "text_encoder", "vae", "llm_adapter"].includes(value.kind)) errors.push(`${label}.kind 无效`);
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
  if (!validateObject(value, label, ["sd_scripts_commit", "python", "torch", "cuda", "accelerate", "gpu", "vram_bytes"], errors)) return;
  for (const key of ["sd_scripts_commit", "python", "torch", "cuda", "accelerate", "gpu"]) validateNonEmptyString(value[key], `${label}.${key}`, errors);
  if (!Number.isSafeInteger(value.vram_bytes) || value.vram_bytes < 1) errors.push(`${label}.vram_bytes 必须是正整数`);
}

function validateRecipe(value, errors) {
  const label = "recipe";
  if (!validateObject(value, label, ["id", "version", "sha256", "overrides"], errors)) return;
  validateNonEmptyString(value.id, `${label}.id`, errors);
  validatePositiveInteger(value.version, `${label}.version`, errors);
  validateHash(value.sha256, `${label}.sha256`, errors);
  if (!validateObject(value.overrides, `${label}.overrides`, [], errors, ["resolution", "effective_batch_size", "network_dim", "network_alpha", "learning_rate"])) return;
  for (const key of ["resolution", "effective_batch_size", "network_dim", "network_alpha"]) if (Object.hasOwn(value.overrides, key)) validatePositiveInteger(value.overrides[key], `${label}.overrides.${key}`, errors);
  if (Object.hasOwn(value.overrides, "learning_rate") && (!isFiniteNumber(value.overrides.learning_rate) || value.overrides.learning_rate <= 0)) errors.push(`${label}.overrides.learning_rate 必须是正有限数`);
}

function validateSemanticConfig(value, errors) {
  const label = "semantic_config";
  if (!validateObject(value, label, ["resolution", "effective_batch_size", "network_dim", "network_alpha", "learning_rate", "optimizer_type"], errors)) return;
  for (const key of ["resolution", "effective_batch_size", "network_dim", "network_alpha"]) validatePositiveInteger(value[key], `${label}.${key}`, errors);
  if (!isFiniteNumber(value.learning_rate) || value.learning_rate <= 0) errors.push(`${label}.learning_rate 必须是正有限数`);
  validateNonEmptyString(value.optimizer_type, `${label}.optimizer_type`, errors);
}

function validateExperiment(value, errors) {
  const label = "experiment";
  if (!validateObject(value, label, ["max_train_steps", "save_every_n_steps", "seed"], errors)) return;
  validatePositiveInteger(value.max_train_steps, `${label}.max_train_steps`, errors);
  validatePositiveInteger(value.save_every_n_steps, `${label}.save_every_n_steps`, errors);
  validatePositiveInteger(value.seed, `${label}.seed`, errors);
  if (isPositiveInteger(value.max_train_steps) && isPositiveInteger(value.save_every_n_steps) && value.save_every_n_steps > value.max_train_steps) errors.push(`${label}.save_every_n_steps 不能大于 max_train_steps`);
}

function validateRunSettings(value, errors) {
  const label = "run_settings";
  if (value?.note !== undefined && typeof value.note !== "string") errors.push("run_settings.note 必须是字符串");
  const required = ["max_train_steps", "save_every_n_steps", "seed", "micro_batch_size", "gradient_accumulation_steps", "max_data_loader_n_workers"];
  required.push("blocks_to_swap");
  if (!validateObject(value, label, required, errors, [...required, "note"])) return;
  for (const key of ["max_train_steps", "save_every_n_steps", "seed", "micro_batch_size", "gradient_accumulation_steps", "max_data_loader_n_workers"]) validatePositiveInteger(value[key], `${label}.${key}`, errors);
  if (!Number.isSafeInteger(value.blocks_to_swap) || value.blocks_to_swap < 0) errors.push(`${label}.blocks_to_swap 必须是非负整数`);
  if (isPositiveInteger(value.max_train_steps) && isPositiveInteger(value.save_every_n_steps) && value.save_every_n_steps > value.max_train_steps) errors.push(`${label}.save_every_n_steps 不能大于 max_train_steps`);
}

function validateExecutionConfig(value, errors) {
  const label = "execution_config";
  const required = ["micro_batch_size", "gradient_accumulation_steps", "effective_batch_size", "max_data_loader_n_workers"];
  required.push("blocks_to_swap");
  if (!validateObject(value, label, required, errors)) return;
  for (const key of ["micro_batch_size", "gradient_accumulation_steps", "effective_batch_size", "max_data_loader_n_workers"]) validatePositiveInteger(value[key], `${label}.${key}`, errors);
  if (!Number.isSafeInteger(value.blocks_to_swap) || value.blocks_to_swap < 0) errors.push(`${label}.blocks_to_swap 必须是非负整数`);
}

function validateTrainingConfig(value, errors) {
  const label = "config";
  const required = ["resolution", "max_train_steps", "train_batch_size", "network_dim", "network_alpha", "learning_rate", "optimizer_type", "save_every_n_steps", "seed", "gradient_accumulation_steps", "max_data_loader_n_workers"];
  required.push("blocks_to_swap");
  if (!validateObject(value, label, required, errors)) return;
  for (const key of ["resolution", "max_train_steps", "train_batch_size", "network_dim", "network_alpha", "save_every_n_steps", "seed", "gradient_accumulation_steps", "max_data_loader_n_workers"]) validatePositiveInteger(value[key], `${label}.${key}`, errors);
  if (!isFiniteNumber(value.learning_rate) || value.learning_rate <= 0) errors.push(`${label}.learning_rate 必须是正有限数`);
  validateNonEmptyString(value.optimizer_type, `${label}.optimizer_type`, errors);
  if (isPositiveInteger(value.max_train_steps) && isPositiveInteger(value.save_every_n_steps) && value.save_every_n_steps > value.max_train_steps) errors.push(`${label}.save_every_n_steps 不能大于 max_train_steps`);
  if (!Number.isSafeInteger(value.blocks_to_swap) || value.blocks_to_swap < 0) errors.push(`${label}.blocks_to_swap 必须是非负整数`);
}

function validateExecution(value, errors) {
  const label = "execution";
  if (!validateObject(value, label, ["executable", "argv"], errors)) return;
  validateNonEmptyString(value.executable, `${label}.executable`, errors);
  if (!Array.isArray(value.argv) || value.argv.length === 0) errors.push(`${label}.argv 必须是非空字符串数组`);
  else value.argv.forEach((entry, index) => validateNonEmptyString(entry, `${label}.argv[${index}]`, errors));
}

function validateCrossFields(value, errors) {
  const pairs = [
    ["seed", value.seed, "experiment.seed", value.experiment?.seed],
    ["seed", value.seed, "run_settings.seed", value.run_settings?.seed],
    ["seed", value.seed, "config.seed", value.config?.seed],
    ["experiment.max_train_steps", value.experiment?.max_train_steps, "run_settings.max_train_steps", value.run_settings?.max_train_steps],
    ["experiment.save_every_n_steps", value.experiment?.save_every_n_steps, "run_settings.save_every_n_steps", value.run_settings?.save_every_n_steps],
    ["run_settings.micro_batch_size", value.run_settings?.micro_batch_size, "execution_config.micro_batch_size", value.execution_config?.micro_batch_size],
    ["run_settings.gradient_accumulation_steps", value.run_settings?.gradient_accumulation_steps, "execution_config.gradient_accumulation_steps", value.execution_config?.gradient_accumulation_steps],
    ["run_settings.max_data_loader_n_workers", value.run_settings?.max_data_loader_n_workers, "execution_config.max_data_loader_n_workers", value.execution_config?.max_data_loader_n_workers],
    ["run_settings.blocks_to_swap", value.run_settings?.blocks_to_swap, "execution_config.blocks_to_swap", value.execution_config?.blocks_to_swap],
    ["semantic_config.effective_batch_size", value.semantic_config?.effective_batch_size, "execution_config.effective_batch_size", value.execution_config?.effective_batch_size],
    ["experiment.max_train_steps", value.experiment?.max_train_steps, "config.max_train_steps", value.config?.max_train_steps],
    ["experiment.save_every_n_steps", value.experiment?.save_every_n_steps, "config.save_every_n_steps", value.config?.save_every_n_steps],
    ["run_settings.micro_batch_size", value.run_settings?.micro_batch_size, "config.train_batch_size", value.config?.train_batch_size],
    ["run_settings.gradient_accumulation_steps", value.run_settings?.gradient_accumulation_steps, "config.gradient_accumulation_steps", value.config?.gradient_accumulation_steps],
    ["run_settings.max_data_loader_n_workers", value.run_settings?.max_data_loader_n_workers, "config.max_data_loader_n_workers", value.config?.max_data_loader_n_workers],
    ["semantic_config.resolution", value.semantic_config?.resolution, "config.resolution", value.config?.resolution],
    ["semantic_config.network_dim", value.semantic_config?.network_dim, "config.network_dim", value.config?.network_dim],
    ["semantic_config.network_alpha", value.semantic_config?.network_alpha, "config.network_alpha", value.config?.network_alpha],
    ["semantic_config.learning_rate", value.semantic_config?.learning_rate, "config.learning_rate", value.config?.learning_rate],
    ["semantic_config.optimizer_type", value.semantic_config?.optimizer_type, "config.optimizer_type", value.config?.optimizer_type],
  ];
  for (const [leftLabel, left, rightLabel, right] of pairs) if (left !== undefined && right !== undefined && left !== right) errors.push(`${leftLabel} 必须与 ${rightLabel} 一致`);
  if (isPositiveInteger(value.run_settings?.micro_batch_size) && isPositiveInteger(value.run_settings?.gradient_accumulation_steps) && isPositiveInteger(value.semantic_config?.effective_batch_size) && value.run_settings.micro_batch_size * value.run_settings.gradient_accumulation_steps !== value.semantic_config.effective_batch_size) errors.push("run_settings.micro_batch_size × gradient_accumulation_steps 必须等于 semantic_config.effective_batch_size");
  if (isPositiveInteger(value.config?.train_batch_size) && isPositiveInteger(value.config?.gradient_accumulation_steps) && isPositiveInteger(value.semantic_config?.effective_batch_size) && value.config.train_batch_size * value.config.gradient_accumulation_steps !== value.semantic_config.effective_batch_size) errors.push("config.train_batch_size × gradient_accumulation_steps 必须等于 semantic_config.effective_batch_size");
  if (value.family === "anima" && value.run_settings?.blocks_to_swap !== undefined && value.config?.blocks_to_swap !== undefined && value.run_settings.blocks_to_swap !== value.config.blocks_to_swap) errors.push("run_settings.blocks_to_swap 必须与 config.blocks_to_swap 一致");
}

/**
 * 计划冻结与运行时之间唯一共享的训练事实快照。
 * 调用方必须先复制当前图片和 Caption，再传入已完成 preflight 的结果；
 * 运行时不得通过 task 或 dataset 重新解释这些值。
 */
export function createLoraTrainingRunManifest({
  runId,
  taskId,
  task,
  dataset,
  snapshots,
  preflight,
  finalConfig,
  execution,
  datasetToml,
  checkpointsRelativePath = null,
  createdAt = new Date().toISOString(),
}) {
  const manifest = {
    version: 4,
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
      kind: model.label,
      relative_path: model.identity.relative_path,
      sha256: model.sha256,
      size_bytes: model.size,
      source: model.identity.source ?? null,
    })),
    trainer: clone({
      sd_scripts_commit: preflight.environment.commit,
      python: preflight.environment.runtime.python,
      torch: preflight.environment.runtime.torch,
      cuda: preflight.environment.runtime.cuda,
      accelerate: preflight.environment.runtime.accelerate,
      gpu: preflight.environment.runtime.gpu,
      vram_bytes: preflight.environment.runtime.vram_bytes,
    }),
    recipe: clone({
      id: preflight.recipe.id,
      version: preflight.recipe.version,
      sha256: preflight.recipe.sha256,
      overrides: task.training_recipe.overrides,
    }),
    semantic_config: clone(preflight.semantic_config),
    experiment: {
      max_train_steps: preflight.run_settings.max_train_steps,
      save_every_n_steps: preflight.run_settings.save_every_n_steps,
      seed: preflight.run_settings.seed,
    },
    execution_config: {
      micro_batch_size: preflight.run_settings.micro_batch_size,
      gradient_accumulation_steps: preflight.run_settings.gradient_accumulation_steps,
      effective_batch_size: preflight.semantic_config.effective_batch_size,
      max_data_loader_n_workers: preflight.run_settings.max_data_loader_n_workers,
      ...(preflight.run_settings.blocks_to_swap !== undefined ? { blocks_to_swap: preflight.run_settings.blocks_to_swap } : {}),
    },
    run_settings: clone(preflight.run_settings),
    config: clone(finalConfig),
    dataset_toml_sha256: datasetToml.sha256,
    ...(typeof checkpointsRelativePath === "string" ? { checkpoints_relative_path: checkpointsRelativePath } : {}),
    execution: clone(execution),
    seed: finalConfig.seed,
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
  const allowedKeys = ["version", "id", "task_id", "dataset_id", "created_at", "task_name", "dataset_name", "family", "prompt_family", "usage_defaults", "description", "activation_terms", "items", "groups", "models", "trainer", "recipe", "semantic_config", "experiment", "execution_config", "run_settings", "config", "dataset_toml_sha256", "checkpoints_relative_path", "execution", "seed"];
  if (value.checkpoints_relative_path !== undefined && (typeof value.checkpoints_relative_path !== "string" || value.checkpoints_relative_path !== value.checkpoints_relative_path.trim() || value.checkpoints_relative_path.startsWith("/") || value.checkpoints_relative_path.includes("\\") || value.checkpoints_relative_path.split("/").includes(".."))) errors.push("checkpoints_relative_path 必须是安全的正斜杠相对路径");
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) errors.push(`manifest 包含未支持字段：${key}`);
  if (value.version !== 4) errors.push("version 必须为 4");
  if (!idPatterns.run.test(value.id ?? "")) errors.push("id 无效");
  if (!idPatterns.task.test(value.task_id ?? "")) errors.push("task_id 无效");
  if (!idPatterns.dataset.test(value.dataset_id ?? "")) errors.push("dataset_id 无效");
  if (!validDate(value.created_at)) errors.push("created_at 无效");
  validateNonEmptyString(value.task_name, "task_name", errors);
  validateNonEmptyString(value.dataset_name, "dataset_name", errors);
  if (value.family !== "anima") errors.push("family 必须为 anima");
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

  const modelKinds = [];
  if (!Array.isArray(value.models) || value.models.length === 0) errors.push("models 必须是非空数组");
  else value.models.forEach((model, index) => {
    validateModel(model, index, errors);
    if (isRecord(model) && typeof model.kind === "string") modelKinds.push(model.kind);
  });
  if (new Set(modelKinds).size !== modelKinds.length) errors.push("models.kind 不能重复");
  for (const kind of ["dit", "text_encoder", "vae"]) if (!modelKinds.includes(kind)) errors.push(`anima manifest.models 缺少 ${kind}`);
  if (modelKinds.some((kind) => !["dit", "text_encoder", "vae", "llm_adapter"].includes(kind))) errors.push("anima manifest.models 包含不支持的模型类型");

  validateTrainer(value.trainer, errors);
  validateRecipe(value.recipe, errors);
  validateSemanticConfig(value.semantic_config, errors);
  validateExperiment(value.experiment, errors);
  validateExecutionConfig(value.execution_config, errors);
  validateRunSettings(value.run_settings, errors);
  validateTrainingConfig(value.config, errors);
  validateHash(value.dataset_toml_sha256, "dataset_toml_sha256", errors);
  validateExecution(value.execution, errors);
  validatePositiveInteger(value.seed, "seed", errors);
  validateCrossFields(value, errors);
  return [...new Set(errors)];
}
