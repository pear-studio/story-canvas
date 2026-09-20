import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const finishedBusyStatuses = new Set(["queued", "upscaling", "lettering", "publishing"]);
export function finishedTaskSummary(job, projectId, projectTitle) {
  const status = finishedBusyStatuses.has(job.status) ? job.status === "queued" ? "queued" : "running" : job.status;
  const counts = { total: 1, available: Number(status === "completed"), skipped: 0, discarded: 0, cancelled: 0, running: Number(status === "running"), queued: Number(status === "queued"), failed: Number(status === "failed") };
  const page_key = { page_id: job.page_id };
  return { id: job.id, purpose: "finished", status, stage: job.status, project_id: projectId, project_title: projectTitle,
    created_at: job.created_at, started_at: job.started_at, completed_at: job.completed_at, failed_at: job.failed_at,
    error: job.error, progress: null, item_counts: counts,
    pages: [{ page_key, page_id: job.page_id, order: null, title: job.page_label ?? job.page_id, owner_label: null, item_counts: counts }],
    items: [{ id: job.id, page_key, status: status === "completed" ? "available" : status }], execution_units: [] };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// 生命周期和轻量轮询只读取运行记录，不加载排版、候选或 GPU 执行依赖。
export async function listFinishedJobs(directory) {
  const root = path.join(directory, "Saved", "finished");
  const files = await readdir(root).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  const jobs = [];
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const job = JSON.parse(await readFile(path.join(root, file), "utf8"));
    if (finishedBusyStatuses.has(job.status) && !alive(job.pid)) {
      job.status = "failed"; job.error = "服务已重启，成品输出中断，请重新输出";
    }
    jobs.push(job);
  }
  return jobs;
}
