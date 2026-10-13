const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 只合并调用方明确声明独立的字段；Prompt、数组和依赖变化保持整体判断。
export function reconcileDraft(baseline, draft, latest, fields = []) {
  if (same(draft, baseline) || same(draft, latest)) return { value: structuredClone(latest), discarded: false };
  if (same(baseline, latest)) return { value: structuredClone(draft), discarded: false };
  if (fields.length && [baseline, draft, latest].every(value => value && typeof value === 'object' && !Array.isArray(value))) {
    const value = structuredClone(latest);
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(draft)])) {
      if (same(baseline[key], draft[key])) continue;
      if (!fields.includes(key) || (!same(baseline[key], latest[key]) && !same(draft[key], latest[key]))) return { value: structuredClone(latest), discarded: true };
      value[key] = structuredClone(draft[key]);
    }
    return { value, discarded: false };
  }
  return { value: structuredClone(latest), discarded: true };
}
