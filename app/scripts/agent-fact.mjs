#!/usr/bin/env node
import { decodePageKey } from "../server/page-key.mjs";
import { readFactDraft, readJsonInput, readPromptContext, runCommand, saveFactDraft, savePromptContextDraft } from "./workbench-client.mjs";

runCommand(async args => {
  const [action, ...rest] = args;
  // 领域与 kind 的合法性以服务端为准，客户端不维护第二份枚举。
  if (action === "read" && (rest.length === 3 || rest.length === 4)) {
    return readFactDraft(rest[0], rest[1], rest[2], rest[3]);
  }
  if (action === "save" && rest.length === 3) {
    return saveFactDraft(rest[0], rest[1], await readJsonInput(rest[2]));
  }
  if (action === "prompt-context" && rest.length === 2) {
    return readPromptContext(rest[0], decodePageKey(rest[1]));
  }
  // 旧入口明确给升级指引；诊断上下文不再是可写草稿。
  if (action === "save-context" && rest.length === 1) {
    return savePromptContextDraft(await readJsonInput(rest[0]));
  }
  throw new Error("用法：fact:edit -- read <domain> <kind> <project-id> [target-id] [--out 文件]；save <domain> <kind> <JSON文件|-> [--out 回执文件]；prompt-context <project-id> <PageKey> [--out 文件]。Prompt 编辑改用 story-canvas.mjs 的 prompt.read/save，prompt-context 只读。直接 node 调用本脚本时不带 --");
});
