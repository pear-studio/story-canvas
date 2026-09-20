export type TaskImageCounts = {
  running: number;
  queued: number;
};

export type TaskPageSummary = {
  page_id?: string | null;
  order: number | null;
  title: string | null;
  item_counts: { total: number };
};

export function remainingImageCount(tasks: Array<{ item_counts: TaskImageCounts }>) {
  return tasks.reduce((total, task) => total + task.item_counts.running + task.item_counts.queued, 0);
}

export function orderActiveTasks<T extends {
  created_at: string | null;
  item_counts: TaskImageCounts;
  progress?: { value: number; max: number } | null;
}>(tasks: T[]) {
  return [...tasks].sort((left, right) => {
    const samplingDifference = Number(Boolean(right.progress)) - Number(Boolean(left.progress));
    if (samplingDifference) return samplingDifference;
    const runningDifference = Number(right.item_counts.running > 0) - Number(left.item_counts.running > 0);
    if (runningDifference) return runningDifference;
    return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""), "en");
  });
}

export function workbenchDocumentTitle(projectTitle: string | null | undefined, tasks: Array<{ item_counts: TaskImageCounts }>) {
  const title = projectTitle?.trim() || "工作台";
  const remaining = remainingImageCount(tasks);
  return remaining > 0 ? `[${remaining}] ${title}` : title;
}

export function completedTaskPageLabel(task: {
  current_page_order: number | null;
  current_page_title: string | null;
  page_count: number;
}) {
  const title = task.current_page_title?.trim();
  const order = Number.isInteger(task.current_page_order) && Number(task.current_page_order) > 0
    ? String(task.current_page_order).padStart(2, "0")
    : "";
  const page = [order, title].filter(Boolean).join(" ") || (task.page_count > 0 ? `共 ${task.page_count} 页` : "页面未知");
  return task.page_count > 1 && (order || title) ? `${page} · 共 ${task.page_count} 页` : page;
}

export function taskPageLabel(page: Pick<TaskPageSummary, "page_id" | "order" | "title">) {
  const order = Number.isInteger(page.order) && Number(page.order) > 0 ? String(page.order).padStart(2, "0") : "";
  return [order, page.title?.trim()].filter(Boolean).join(" ") || page.page_id?.trim() || "未命名页面";
}

export function taskBatchLabel(purpose: "candidate" | "comparison", pages: TaskPageSummary[], total: number) {
  const purposeLabel = purpose === "comparison" ? "对比实验" : "候选图";
  if (!pages.length) return `${purposeLabel} · 未创建图片`;
  return pages.length > 1 ? `${purposeLabel} · ${pages.length} 页 / ${total} 张` : `${purposeLabel} · ${total} 张`;
}

export function taskPagePreview(pages: TaskPageSummary[], limit = 3) {
  const visible = pages.slice(0, limit).map(taskPageLabel).join("、");
  return pages.length > limit ? `${visible} 等 ${pages.length} 页` : visible;
}

export function formatTaskDuration(startedAt: string | null | undefined, endedAt: string | number | Date | null | undefined) {
  if (!startedAt || endedAt == null) return "";
  const start = new Date(startedAt).getTime();
  const end = endedAt instanceof Date ? endedAt.getTime() : typeof endedAt === "number" ? endedAt : new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function formatTaskMoment(value: string | null | undefined, now = new Date()) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
