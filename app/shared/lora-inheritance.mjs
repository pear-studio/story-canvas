// LoRA 继承只保存本层新增项与权重/开关覆盖；上游身份和触发词保持实时读取。
export function mergeInheritedLoras(inherited = [], local = [], overrides = {}) {
  const values = new Map(inherited.map(value => [value.filename, value]));
  for (const value of local) values.set(value.filename, value);
  return [...values.values()].map(value => ({ ...value, ...(overrides[value.filename] ?? {}) }));
}
export function settingLoras(identity, variant) {
  return mergeInheritedLoras(identity?.lora ? [identity.lora] : [], variant?.loras, variant?.lora_overrides);
}
export function validateLoraOverrides(value, label = 'lora_overrides') {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} 必须是对象`];
  return Object.entries(value).flatMap(([key, item]) => {
    if (!key || !item || typeof item !== 'object' || Array.isArray(item)) return [`${label}.${key} 无效`];
    const errors = [];
    if (Object.keys(item).some(key => !['weight', 'enabled'].includes(key))) errors.push(`${label}.${key} 只允许 weight 和 enabled`);
    if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < -2 || item.weight > 2)) errors.push(`${label}.${key}.weight 必须在 -2 到 2 之间`);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') errors.push(`${label}.${key}.enabled 必须是布尔值`);
    return errors;
  });
}
