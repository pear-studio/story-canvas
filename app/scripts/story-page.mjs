#!/usr/bin/env node
import { factCommand, navigation, requestWorkbench, runCommand } from "./workbench-client.mjs";
runCommand(async args => {
  const [kind, action, ...rest] = args;
  const projectKinds = ["outline", "index", "synopsis"];
  const targetKinds = ["chapter", "sequence", "narrative", "prompt", "text-sources"];
  if ([...projectKinds, ...targetKinds].includes(kind)
    && (action === "read" && rest.length === (projectKinds.includes(kind) ? 1 : 2) || action === "save" && rest.length === 1)) {
    return factCommand("story", kind, action, rest);
  }
  if (kind === "context" && action === "read" && rest.length === 2) {
    return (await requestWorkbench("/api/agent/story-context", { method: "POST", body: { project_id: rest[0], sequence_id: rest[1] } })).value;
  }
  if (kind === "sequence" && action === "create" && rest.length === 3) {
    return navigation(rest[0], "create-sequence", { chapter_id: rest[1], title: rest[2] });
  }
  if (kind === "page" && ["create", "delete", "duplicate"].includes(action) && rest.length === 2) {
    return navigation(rest[0], `${action}-story-page`, { [action === "create" ? "sequence_id" : "page_id"]: rest[1] });
  }
  throw new Error("用法：story:page -- <outline|index|synopsis|chapter|sequence|narrative|prompt|text-sources> read <project-id> [target-id] [--out 文件] 或 save <JSON文件|->；context read <project-id> <sequence-id>；sequence create <project-id> <chapter-id> <标题> [--out 文件]；page <create|delete|duplicate> <project-id> <sequence-id|page-id>。直接 node 调用本脚本时不带 --");
});
