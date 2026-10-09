export const referenceIdPattern = /^ref-[a-f0-9-]{36}$/;
export function validateReferenceEntries(entries, { allowPurpose = false } = {}) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return ['reference_images 必须是数组'];
  const errors = [];
  if (new Set(entries.map(e => e?.id)).size !== entries.length) errors.push('参考图 ID 重复');
  const allowedKeys = allowPurpose ? ['id', 'file', 'title', 'purpose', 'origin'] : ['id', 'file', 'title'];
  for (const e of entries) if (!e || !referenceIdPattern.test(e.id ?? '')
    || typeof e.title !== 'string' || !e.title.trim() || e.title.length > 200
    || !/^reference-[a-f0-9-]+\.png$/.test(e.file ?? '')
    || (allowPurpose && e.purpose !== undefined && (typeof e.purpose !== 'string' || !e.purpose.trim() || e.purpose.length > 200))
    || (e.origin !== undefined && (!allowPurpose || !/^page-(?:[a-f0-9]{12}|[0-9]{3})$/.test(e.origin?.page_id??'') || !/^candidate-[a-f0-9-]{36}$/.test(e.origin?.candidate_id??'') || Object.keys(e.origin).some(k=>!['page_id','candidate_id'].includes(k))))
    || Object.keys(e).some(k => !allowedKeys.includes(k))) errors.push('参考图条目无效');
  return errors;
}
export function validateReferenceOverrides(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['reference_overrides 必须是对象'];
  return Object.entries(value).flatMap(([source, ids]) =>
    !/^(character|scene):[a-z0-9-]+:[a-z0-9-]+$/.test(source) || !Array.isArray(ids)
      || ids.some(id => !referenceIdPattern.test(id)) || new Set(ids).size !== ids.length ? ['参考图选择无效：' + source] : []);
}

export function resolveReferenceEntries(groups, overrides = {}, local = []) {
  const result = [];
  for (const { source, entries } of groups) {
    const ids = overrides[source] ?? entries.slice(0, 1).map(e => e.id);
    for (const id of ids) {
      const entry = entries.find(e => e.id === id);
      if (!entry) throw new Error(`参考图已移除：${source}，请重新选择或恢复默认`);
      result.push({ ...entry, source });
    }
  }
  result.push(...local.map(e => ({ ...e, source: 'page' })));
  if (result.length > 10) throw new Error(`本页引用了 ${result.length} 张图片，最多支持 10 张，请取消部分图片`);
  return result;
}
