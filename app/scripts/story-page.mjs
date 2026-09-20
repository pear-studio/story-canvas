#!/usr/bin/env node
import { factCommand, navigation, requestWorkbench, runCommand } from "./workbench-client.mjs";
runCommand(async () => {
  const [kind, action, ...args] = process.argv.slice(2);
  const projectKinds = ["outline", "index", "synopsis"];
  const targetKinds = ["chapter", "sequence", "narrative", "prompt", "text-sources"];
  if ([...projectKinds, ...targetKinds].includes(kind)
    && (action === "read" && args.length === (projectKinds.includes(kind) ? 1 : 2) || action === "save" && args.length === 1)) {
    return factCommand("story", kind, action, args);
  }
  if (kind === "context" && action === "read" && args.length === 2) {
    return (await requestWorkbench("/api/agent/story-context", { method: "POST", body: { project_id: args[0], sequence_id: args[1] } })).value;
  }
  if (kind === "page" && ["create", "delete", "duplicate"].includes(action) && args.length === 2) {
    return navigation(args[0], `${action}-story-page`, { [action === "create" ? "sequence_id" : "page_id"]: args[1] });
  }
  throw new Error("用法：story:page -- <outline|index|synopsis|chapter|sequence|narrative|prompt|text-sources> read <project-id> [target-id] 或 save <JSON文件|->（- 表示从 stdin 读草稿，read 输出可管道回写）；context read <project-id> <sequence-id>；page <create|delete|duplicate> <project-id> <sequence-id|page-id>。直接 node 调用本脚本时不带 --");
});
