// 方案保存可编辑值；梯度累积在 recipe overrides，备注只在运行时展开。
export const savedRunSettingKeys = Object.freeze([
  "max_train_steps", "save_every_n_steps", "seed",
]);

export function initialRunSettings() {
  return { max_train_steps: 2000, save_every_n_steps: 500, seed: 42 };
}

export function validateSavedRunSettings(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["run_defaults 必须是对象"];
  for (const key of Object.keys(value)) if (!savedRunSettingKeys.includes(key)) errors.push(`run_defaults.${key} 不支持`);
  for (const key of savedRunSettingKeys) {
    if (!Number.isInteger(value[key]) || value[key] < 1) errors.push(`run_defaults.${key} 无效`);
  }
  if (Number.isInteger(value.max_train_steps) && Number.isInteger(value.save_every_n_steps) && value.save_every_n_steps > value.max_train_steps) errors.push("保存间隔不能超过总步数");
  return errors;
}

export function expandSavedRunSettings(task, semantic, request = {}) {
  const values = { ...task.run_defaults, gradient_accumulation_steps: semantic.gradient_accumulation_steps };
  // 调用方只能增加本轮备注，不能绕过方案保存临时覆盖参数。
  for (const [key, value] of Object.entries(request ?? {})) {
    if (key === "note") continue;
    if (!Object.hasOwn(values, key) || values[key] !== value) throw Object.assign(new Error("请先保存训练参数"), { status: 422, code: "unsaved_lora_training_settings" });
  }
  if (request?.note !== undefined) values.note = request.note;
  return values;
}
