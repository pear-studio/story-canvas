const activeStatuses = new Set(['queued', 'launching', 'running']);

export function taskHistoryMoment(task) {
  if (activeStatuses.has(task.status)) return task.created_at;
  return task.status === 'failed' || task.status === 'incomplete'
    ? task.failed_at ?? task.completed_at ?? task.created_at
    : task.completed_at ?? task.failed_at ?? task.created_at;
}

export function taskHistoryKey(task) {
  const moment = taskHistoryMoment(task);
  const time = moment ? new Date(moment).toISOString() : '';
  return `${time}/${task.purpose}/${task.id}/${task.project_id ?? 'global'}`;
}

export function compareTaskHistory(left, right) {
  const a = taskHistoryKey(left), b = taskHistoryKey(right);
  return a < b ? 1 : a > b ? -1 : 0;
}
