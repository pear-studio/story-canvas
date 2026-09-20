#!/usr/bin/env node
import { readJsonInput, requestWorkbench, runCommand } from "./workbench-client.mjs";
runCommand(async () => {
  const [action, argument, ...extra] = process.argv.slice(2);
  if (!["template", "create"].includes(action) || !argument || extra.length) throw new Error("用法：project:create -- template <project-id> 或 create <JSON文件|->");
  return (await requestWorkbench(`/api/agent/project-create/${action}`, {
    method: "POST", body: action === "template" ? { project_id: argument } : await readJsonInput(argument),
  })).value;
});
