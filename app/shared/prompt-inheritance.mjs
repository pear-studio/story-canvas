export const inheritanceCategories = ['population', "person", 'setting', 'camera', 'avoid'];
export const promptText = fragment => fragment.tag ?? fragment.description ?? fragment.prompt_text ?? '';
export const promptWord = text => String(text).toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
export const adjustmentKey = fragment => fragment.inheritance_key ?? `identity:${fragment.id}`;
export const characterSource = (id, variant) => `character:${id}:${variant}`;
export const sceneSource = (id, variant) => `scene:${id}:${variant}`;
export const emptyCategories = () => Object.fromEntries(inheritanceCategories.map(c => [c, []]));

export function applyInheritedPrompt(prompt, adjustments = {}) {
  return Object.fromEntries(inheritanceCategories.map(category => [category, (prompt?.[category] ?? []).map(fragment => {
    const adjustment = adjustments?.[adjustmentKey(fragment)];
    return { ...fragment,
      ...(Object.hasOwn(adjustment ?? {}, 'weight') ? { weight: adjustment.weight } : {}),
      ...(Object.hasOwn(adjustment ?? {}, 'enabled') ? { enabled: adjustment.enabled } : {}),
    };
  })]));
}

// 显式覆盖与有效值不同是两件事；与上游相等的固定值仍是覆盖。
export function inheritedOverrideCount(prompt, adjustments = {}) {
  let overridden = 0, total = 0;
  for (const category of inheritanceCategories) (prompt?.[category] ?? []).forEach(base => {
    total++;
    const item = adjustments?.[adjustmentKey(base)];
    if (Object.hasOwn(item ?? {}, 'weight') || Object.hasOwn(item ?? {}, 'enabled')) overridden++;
  });
  return { overridden, total };
}

// 检查与编译共用：先应用本层调整，再只取生效项；索引始终指向原数组。
// 不能先过滤关闭项，否则下游显式重新开启会丢失。
export function effectivePromptEntries(prompt, category, adjustments = {}) {
  const adjusted = applyInheritedPrompt({ [category]: prompt?.[category] ?? [] }, adjustments);
  return adjusted[category].flatMap((fragment, index) => fragment.enabled === false ? [] : [{ fragment, index }]);
}

export function variantPrompt(identity, variant) {
  const inherited = applyInheritedPrompt(identity.prompt, variant.identity_overrides);
  return Object.fromEntries(inheritanceCategories.map(c => [c, [
    ...inherited[c].map(f => ({ ...f, inheritance_key: `identity:${f.id}`, inheritance_source: '基础身份' })),
    ...(variant.prompt?.[c] ?? []).map(f => ({ ...f, inheritance_key: `variant:${f.id}`, inheritance_source: '子设定' })),
  ]]));
}

// 保留关闭项、稳定来源键与原始位置；启用不等于被模型消费（场景只消费 setting/avoid）。
export function resolvedSettingEntries(identity, variant, adjustments = {}, kind = 'character') {
  const prompt = applyInheritedPrompt(variantPrompt(identity ?? {prompt:{}}, variant), adjustments);
  return inheritanceCategories.flatMap(category => prompt[category].map((fragment, index) => ({
    fragment, category, index, key: adjustmentKey(fragment),
    layer: index < (identity?.prompt?.[category]?.length ?? 0) ? 'identity' : 'variant',
    source_index: index < (identity?.prompt?.[category]?.length ?? 0) ? index : index - (identity?.prompt?.[category]?.length ?? 0),
    enabled: fragment.enabled !== false,
    consumed: fragment.enabled !== false && (kind !== 'scene' || ['setting','avoid'].includes(category)),
  })));
}

export function validateAdjustments(value, label = '继承调整', { availableKeys, baselineAdjustments, layers = ['identity', 'variant'] } = {}) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} 必须是对象`];
  const available = availableKeys === undefined ? null : new Set(availableKeys);
  return Object.entries(value).flatMap(([key, item]) => {
    if (!/^(identity|variant):token-[a-f0-9]{12}$/.test(key) || !layers.includes(key.split(':')[0])) return [`${label}.${key} 必须使用有效的共享词来源 ID`];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [`${label}.${key} 必须是对象`];
    const errors = [];
    if (Object.keys(item).some(k => !['weight', 'enabled'].includes(k))) errors.push(`${label}.${key} 只允许调整权重和开关`);
    if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < 0.2 || item.weight > 10)) errors.push(`${label}.${key}.weight 必须在 0.2～10 之间`);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') errors.push(`${label}.${key}.enabled 必须是布尔值`);
    if (available && !available.has(key)) {
      const baseline = baselineAdjustments?.[key];
      const unchanged = baseline && Object.keys(item).length === Object.keys(baseline).length
        && Object.entries(item).every(([field, entry]) => Object.hasOwn(baseline, field) && baseline[field] === entry);
      if (!unchanged) errors.push(`${label}.${key} 的继承词不存在；只能原样保留已有失效调整或删除它`);
    }
    return errors;
  });
}

export function duplicatePromptWords(groups) {
  const seen = new Map(), errors = [];
  for (const { prompt, scope, label } of groups) for (const category of inheritanceCategories) for (const { fragment } of effectivePromptEntries(prompt, category)) {
    const word = promptWord(promptText(fragment));
    const key = promptDuplicateKey(category, fragment.character_id ?? fragment.role ?? scope, word);
    const source = fragment.inheritance_source ? `${label} · ${fragment.inheritance_source}` : label;
    if (seen.has(key)) errors.push(`重复词“${promptText(fragment)}”：${seen.get(key)} / ${source}。请删除本地重复词，在继承区调整权重和开关。`);
    else seen.set(key, source);
  }
  return errors;
}

export function promptDuplicateKey(category, owner, text) {
  return JSON.stringify([category === 'avoid' ? 'negative' : 'positive', ['setting','camera'].includes(category) ? 'environment' : owner, promptWord(text)]);
}
