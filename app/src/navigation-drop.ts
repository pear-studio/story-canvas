export type NavigationDropPlacement = "before" | "after";

// 把落点（目标行 + before/after）换算成服务端锚点 before_id；
// 返回 undefined 表示无需发请求（自落点、目标不在组内或同组重排后顺序不变）。
export function navigationDropBeforeId(ids: string[], sourceId: string, sameGroup: boolean, targetId: string | null, placement: NavigationDropPlacement) {
  const remaining = ids.filter((id) => id !== sourceId);
  if (sameGroup && remaining.length !== ids.length - 1) return undefined;
  let beforeId: string | null = null;
  if (targetId !== null) {
    const index = remaining.indexOf(targetId);
    if (index < 0) return undefined;
    beforeId = placement === "before" ? remaining[index] : remaining[index + 1] ?? null;
  }
  if (sameGroup) {
    const next = [...remaining];
    next.splice(beforeId === null ? next.length : next.indexOf(beforeId), 0, sourceId);
    if (next.every((id, index) => id === ids[index])) return undefined;
  }
  return beforeId;
}
