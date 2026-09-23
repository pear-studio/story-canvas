#!/usr/bin/env node
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodePageKey } from "../server/page-key.mjs";
import { projectRoute, readPromptContext, requestWorkbench, runCommand } from "./workbench-client.mjs";

runCommand(async argv => {
  const [domain, action, projectId, input, ...args] = argv;
  if (!projectId || !input || !(domain === "render" && action === "page" || domain === "preview" && action === "page" || domain === "context" && action === "page" || domain === "candidate" && action === "delete")) {
    throw new Error("用法：visual:produce -- render page <project-id> <page-id|PageKey> [--count 1..3] [--seed N] [--wait]；context page <project-id> <PageKey> [--out 文件]；preview page <project-id> <page-id|PageKey>；candidate delete <project-id> <page-id|PageKey> <absolute-candidate-path|candidate-id>");
  }
  if (domain === "context") {
    if (args.length) throw new Error("context page 不接受额外选项");
    return readPromptContext(projectId, decodePageKey(input));
  }
  const key = decodePageKey(input);
  const base = `${projectRoute(projectId)}/workbench`;
  if (domain === "preview") {
    if (args.length) throw new Error("preview page 不接受额外选项");
    return (await requestWorkbench(`${base}/page-render-inspection`, { method: "POST", body: { page_key: key } })).value;
  }
  if (domain === "candidate") {
    if (args.length !== 1) throw new Error("删除候选需要一个候选 ID 或绝对图片路径");
    const { value } = await requestWorkbench(`${base}/page-media`, { method: "POST", body: { page_key: key } });
    const match = value.media.candidates.find(c => c.candidate_id === args[0] || path.resolve(c.absolute_file) === path.resolve(args[0]));
    if (!match) throw Object.assign(new Error("候选不存在"), { code: "candidate_not_found" });
    return (await requestWorkbench(`${base}/candidates/${encodeURIComponent(match.candidate_id)}`, { method: "DELETE", body: { page_key: key } })).value;
  }
  const body = { page_key: key, operation: "candidates", count: 1 };
  let wait = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--wait") wait = true;
    else if (["--count", "--seed"].includes(args[i]) && args[i + 1] !== undefined) {
      const field = args[i].slice(2);
      const number = Number(args[++i]);
      if (!Number.isSafeInteger(number)) throw new Error(`${field} 必须是整数`);
      body[field] = number;
    } else throw new Error(`未知或不完整选项：${args[i]}`);
  }
  const { value: { task } } = await requestWorkbench(`${base}/render`, { method: "POST", body });
  if (!wait) return task;
  try {
    for (;;) {
      const { value } = await requestWorkbench(`/api/tasks?tracked=${encodeURIComponent(projectId + "/" + task.task_id)}`);
      const current = value.tracked.find(item => item.id === task.task_id);
      if (!current) throw Object.assign(new Error("任务状态已不可用"), { code: "task_not_found" });
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        const { value: media } = await requestWorkbench(`${base}/page-media`, { method: "POST", body: { page_key: key } });
        const result = { ...task, status: current.status, candidate_paths: media.media.candidates.filter(c => c.task_id === task.task_id).map(c => c.absolute_file) };
        if (["failed", "cancelled"].includes(current.status)) throw Object.assign(new Error(`生成任务${current.status}`), { code: "render_task_" + current.status, details: result });
        return result;
      }
      await delay(1000);
    }
  } catch (error) {
    error.details ??= { task_id: task.task_id, task_directory: task.task_directory };
    throw error;
  }
});
