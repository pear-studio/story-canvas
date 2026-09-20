#!/usr/bin/env node
import { readJsonInput, requestWorkbench, runCommand } from "./workbench-client.mjs";

runCommand(async () => {
  const [method, route, ...args] = process.argv.slice(2);
  if (!["GET", "POST", "PUT", "DELETE"].includes(method) || !route) throw new Error("用法：workbench:api -- <GET|POST|PUT|DELETE> /api/... [--body JSON文件|-] [--revision 已读取的版本]");
  const options = { method };
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error("选项缺少值");
    if (args[i] === "--body") options.body = await readJsonInput(args[i + 1]);
    else if (args[i] === "--revision") options.revision = args[i + 1];
    else throw new Error(`未知选项：${args[i]}`);
  }
  return requestWorkbench(route, options);
});
