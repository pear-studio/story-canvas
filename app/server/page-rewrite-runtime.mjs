import { encodePageKey } from './page-key.mjs';
import { ApiError } from './http-support.mjs';

// 每页只保留最近一次的轻量运行状态；结果仍由 page-rewrite 保存为项目事实。
const runs = new Map();
const key = (root, projectId, pageKey) => `${root}\0${projectId}\0${encodePageKey(pageKey)}`;

export function readPageRewriteProgress(root, projectId, pageKey) {
  const run = runs.get(key(root, projectId, pageKey));
  return run ? { ...run, elapsed_ms: (run.finished_at ?? Date.now()) - run.started_at } : null;
}

export async function trackPageRewrite(root, projectId, pageKey, operation) {
  const id = key(root, projectId, pageKey);
  const previous = runs.get(id);
  if (previous && !previous.finished_at) throw new ApiError(409, 'page_rewrite_running', ['本页正在重写，请等待当前任务完成']);
  const run = { phase: 'preparing', started_at: Date.now() };
  runs.set(id, run);
  try {
    const result = await operation(progress => Object.assign(run, progress));
    Object.assign(run, { phase: 'completed', finished_at: Date.now() });
    return result;
  } catch (error) {
    Object.assign(run, { phase: 'failed', finished_at: Date.now(), error: error.details?.[0] ?? error.message });
    throw error;
  }
}
