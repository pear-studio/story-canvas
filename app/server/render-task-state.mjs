const activeTaskStatuses = new Set(["launching", "queued", "running"]);
const unfinishedItemStatuses = new Set(["queued", "running"]);

export function applyRecoveredRenderItemStatuses(items, statuses) {
  for (const item of items) {
    if (statuses.has(item.id) && item.status !== "discarded") item.status = statuses.get(item.id);
  }
  return items;
}

export function failedRenderTaskSnapshot(current, taskId, message, failedAt) {
  if (current && !activeTaskStatuses.has(current.status)) return null;
  return current
    ? {
        ...current,
        status: "failed",
        failed_at: failedAt,
        completed_at: undefined,
        error: message,
        items: Array.isArray(current.items)
          ? current.items.map((item) => unfinishedItemStatuses.has(item.status) ? { ...item, status: "failed" } : item)
          : [],
      }
    : {
        version: 2,
        id: taskId,
        status: "failed",
        created_at: failedAt,
        failed_at: failedAt,
        error: message,
        items: [],
      };
}
