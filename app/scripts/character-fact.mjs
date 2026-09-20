#!/usr/bin/env node
import { factCommand, navigation, runCommand } from "./workbench-client.mjs";
runCommand(async () => {
  const [kind, action, ...args] = process.argv.slice(2);
  if (["profile", "visual", "prompt", "lora", "page-index", "page-goal", "page-prompt"].includes(kind)
    && (action === "read" && args.length === (kind === "page-index" ? 1 : 2) || action === "save" && args.length === 1)) {
    return factCommand("character", kind, action, args);
  }
  if (kind === "character" && action === "create" && [2, 3].includes(args.length)) {
    return navigation(args[0], "create-character", { id: args[1], name: args[2] ?? args[1] });
  }
  if (kind === "character" && action === "delete" && args.length === 2) {
    return navigation(args[0], "delete-character", { character_id: args[1] });
  }
  if (kind === "page" && action === "create" && [2, 3, 4].includes(args.length)) {
    return navigation(args[0], "create-character-page", { character_id: args[1], variant_id: args[2], template_id: args[3] });
  }
  if (kind === "page" && ["delete", "duplicate"].includes(action) && args.length === 2) {
    return navigation(args[0], `${action}-character-page`, { page_id: args[1] });
  }
  throw new Error("用法：character:fact -- <profile|visual|prompt|lora|page-index|page-goal|page-prompt> read <project-id> [target-id] 或 save <JSON文件|->；character <create|delete> <project-id> <character-id> [name]；page create <project-id> <character-id> <variant-id> [template-id]；page <delete|duplicate> <project-id> <page-id>");
});
