#!/usr/bin/env node
import { projectRoute, requestWorkbench, runCommand } from "./workbench-client.mjs";
runCommand(async () => {
  const [action, projectId, nextId, ...extra] = process.argv.slice(2);
  if (!projectId || extra.length || !(action === "copy" && !nextId || action === "rename" && nextId)) throw new Error("用法：project:copy -- <project-id> 或 project:rename -- <project-id> <new-id>");
  const { value } = await requestWorkbench(`${projectRoute(projectId)}/revision`);
  return (await requestWorkbench(`${projectRoute(projectId)}/${action}`, {
    method: "POST", revision: value.revision, ...(action === "rename" ? { body: { id: nextId } } : {}),
  })).value;
});
