import type { TaskCollection } from "./runtime-status";

export function comparisonRuntimeSyncPlan(
  records: Array<{ id: string }>,
  runtimeTasks: TaskCollection,
  projectId: string | null,
  previousActiveIds: Iterable<string> = [],
) {
  const known = new Set(records.map((record) => record.id));
  const current = new Set(runtimeTasks.tasks
    .filter((task) => task.project_id === projectId && task.purpose === "comparison")
    .map((task) => task.id));
  const previous = new Set(previousActiveIds);
  return {
    currentIds: [...current],
    unknownIds: [...current].filter((id) => !known.has(id)),
    disappearedIds: [...previous].filter((id) => !current.has(id)),
  };
}
