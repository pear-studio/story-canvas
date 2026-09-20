// 方案保存可编辑值；梯度累积和备注只在运行时展开。
export const savedRunSettingKeys = Object.freeze([
  "max_train_steps", "save_every_n_steps", "seed", "micro_batch_size",
  "max_data_loader_n_workers", "blocks_to_swap",
]);

export function initialRunSettings() {
  return { max_train_steps: 400, save_every_n_steps: 100, seed: 20260917,
    micro_batch_size: 1, max_data_loader_n_workers: 2, blocks_to_swap: 4 };
}

export function validateSavedRunSettings(value, effectiveBatch) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["run_defaults 必须是对象"];
  for (const key of Object.keys(value)) if (!savedRunSettingKeys.includes(key)) errors.push(`run_defaults.${key} 不支持`);
  for (const key of savedRunSettingKeys) {
    if (!Number.isInteger(value[key]) || value[key] < (key === "blocks_to_swap" ? 0 : 1)) errors.push(`run_defaults.${key} 无效`);
  }
  if (value.save_every_n_steps > value.max_train_steps) errors.push("保存间隔不能超过总步数");
  if (effectiveBatch !== undefined && (!Number.isInteger(effectiveBatch / value.micro_batch_size) || effectiveBatch < value.micro_batch_size)) errors.push("有效 Batch 必须能被 Micro Batch 整除");
  return errors;
}

export function expandSavedRunSettings(task, semantic, request = {}) {
  const values = { ...task.run_defaults, gradient_accumulation_steps: semantic.effective_batch_size / task.run_defaults.micro_batch_size };
  // 调用方只能增加本轮备注，不能绕过方案保存临时覆盖参数。
  for (const [key, value] of Object.entries(request ?? {})) {
    if (key === "note") continue;
    if (!Object.hasOwn(values, key) || values[key] !== value) throw Object.assign(new Error("请先保存训练参数"), { status: 422, code: "unsaved_lora_training_settings" });
  }
  if (request?.note !== undefined) values.note = request.note;
  return values;
}
