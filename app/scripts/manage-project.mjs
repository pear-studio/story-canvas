#!/usr/bin/env node
import { projectRoute, requestWorkbench, runCommand } from "./workbench-client.mjs";
runCommand(async args => {
  const [action, projectId, nextId, ...extra] = args;
  if (!projectId || extra.length || !(action === "copy" && !nextId || action === "rename" && nextId)) throw new Error("用法：project:copy -- <project-id> [--out 文件] 或 project:rename -- <project-id> <new-id> [--out 文件]");
  const { value } = await requestWorkbench(`${projectRoute(projectId)}/revision`);
  return (await requestWorkbench(`${projectRoute(projectId)}/${action}`, {
    method: "POST", revision: value.revision, ...(action === "rename" ? { body: { id: nextId } } : {}),
  })).value;
});
