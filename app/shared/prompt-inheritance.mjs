export const inheritanceCategories = ['subject', "person", 'setting', 'camera', 'avoid'];
export const promptText = fragment => fragment.tag ?? fragment.description ?? fragment.prompt_text ?? '';
export const promptWord = text => String(text).toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
export const adjustmentKey = (fragment, category = fragment.category) => (category === 'avoid' ? 'negative:' : '') + promptWord(promptText(fragment));
export const characterSource = (id, variant) => `character:${id}:${variant}`;
export const sceneSource = (id, variant) => `scene:${id}:${variant}`;
export const emptyCategories = () => Object.fromEntries(inheritanceCategories.map(c => [c, []]));

export function applyInheritedPrompt(prompt, adjustments = {}, disabled = []) {
  const off = new Set(disabled.map(promptWord));
  return Object.fromEntries(inheritanceCategories.map(category => [category, (prompt?.[category] ?? []).map(fragment => {
    const key = adjustmentKey(fragment, category);
    return { ...fragment, ...(off.has(promptWord(promptText(fragment))) ? { enabled: false } : {}), ...adjustments[key] };
  })]));
}

// 检查与编译共用：先应用本层调整，再只取生效项；索引始终指向原数组。
// 不能先过滤关闭项，否则下游显式重新开启会丢失。
export function effectivePromptEntries(prompt, category, adjustments = {}) {
  const adjusted = applyInheritedPrompt({ [category]: prompt?.[category] ?? [] }, adjustments);
  return adjusted[category].flatMap((fragment, index) => fragment.enabled === false ? [] : [{ fragment, index }]);
}

export function variantPrompt(identity, variant) {
  const inherited = applyInheritedPrompt(identity.prompt, variant.identity_overrides, variant.identity_disabled);
  return Object.fromEntries(inheritanceCategories.map(c => [c, [...inherited[c].map(f => ({ ...f, inheritance_source: '基础身份' })), ...(variant.prompt[c] ?? []).map(f => ({ ...f, inheritance_source: '子设定' }))]]));
}

export function validateAdjustments(value, label = '继承调整') {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} 必须是对象`];
  return Object.entries(value).flatMap(([key, item]) => {
    if (!key || key !== promptWord(key) || !item || typeof item !== 'object' || Array.isArray(item)) return [`${label}.${key} 无效`];
    const errors = [];
    if (Object.keys(item).some(k => !['weight', 'enabled'].includes(k))) errors.push(`${label}.${key} 只允许调整权重和开关`);
    if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < 0.2 || item.weight > 10)) errors.push(`${label}.${key}.weight 必须在 0.2～10 之间`);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') errors.push(`${label}.${key}.enabled 必须是布尔值`);
    return errors;
  });
}

// 追踪已有词条的正文修改；无 ID 的历史词条只能按原文匹配，不猜测替换关系。
export function promptChanges(before, after) {
  const flatten = prompt => inheritanceCategories.flatMap(category => (prompt?.[category] ?? []).map(fragment => ({ category, ...fragment })));
  const old = flatten(before), next = flatten(after);
  const changes = [];
  for (const a of old) {
    const b = next.find(b => a.id ? b.id === a.id : adjustmentKey(b) === adjustmentKey(a));
    if (!b || promptText(a) !== promptText(b) || (a.weight ?? 1) !== (b.weight ?? 1) || (a.enabled !== false) !== (b.enabled !== false) || a.category !== b.category) changes.push({ before: a, after: b ?? null });
  }
  for (const b of next) if (!old.some(a => b.id && a.id ? a.id === b.id : adjustmentKey(a) === adjustmentKey(b))) changes.push({ before: null, after: b });
  return changes;
}

export function updateAdjustments(adjustments = {}, changes) {
  const next = structuredClone(adjustments);
  // 先移除旧键再写入新键，避免交换两个词时覆盖旧值。
  for (const { before } of changes) if (before) delete next[adjustmentKey(before)];
  for (const { before, after, resetWeight, resetEnabled } of changes) {
    if (!before || !after) continue;
    const item = { ...adjustments[adjustmentKey(before)] };
    if (resetWeight || (before.weight ?? 1) !== (after.weight ?? 1)) delete item.weight;
    if (resetEnabled || (before.enabled !== false) !== (after.enabled !== false)) delete item.enabled;
    if (Object.keys(item).length) next[adjustmentKey(after)] = item;
  }
  return next;
}

export function duplicatePromptWords(groups) {
  const seen = new Map(), errors = [];
  for (const { prompt, scope, label } of groups) for (const category of inheritanceCategories) for (const { fragment } of effectivePromptEntries(prompt, category)) {
    const word = promptWord(promptText(fragment));
    const owner = ['setting', 'camera'].includes(category) ? 'environment' : fragment.character_id ?? fragment.role ?? scope;
    const key = `${category === 'avoid' ? 'negative' : 'positive'}:${owner}:${word}`;
    const source = fragment.inheritance_source ? `${label} · ${fragment.inheritance_source}` : label;
    if (seen.has(key)) errors.push(`重复词“${promptText(fragment)}”：${seen.get(key)} / ${source}。请删除本地重复词，在继承区调整权重和开关。`);
    else seen.set(key, source);
  }
  return errors;
}
