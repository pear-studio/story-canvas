#!/usr/bin/env node
import { readJsonInput, requestWorkbench, runCommand } from "./workbench-client.mjs";

runCommand(async args => {
  const [method, route, ...rest] = args;
  if (!["GET", "POST", "PUT", "DELETE"].includes(method) || !route) throw new Error("用法：workbench:api -- <GET|POST|PUT|DELETE> /api/... [--body JSON文件|-] [--revision 已读取的版本] [--out 文件]");
  const options = { method };
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i + 1]) throw new Error("选项缺少值");
    if (rest[i] === "--body") options.body = await readJsonInput(rest[i + 1]);
    else if (rest[i] === "--revision") options.revision = rest[i + 1];
    else throw new Error(`未知选项：${rest[i]}`);
  }
  return requestWorkbench(route, options);
});
