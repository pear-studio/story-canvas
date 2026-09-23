#!/usr/bin/env node
import { factCommand, navigation, runCommand } from "./workbench-client.mjs";
runCommand(async args => {
  const [kind, action, ...rest] = args;
  if (["profile", "visual", "prompt", "page-index", "page-goal", "page-prompt"].includes(kind)
    && (action === "read" && rest.length === (kind === "page-index" ? 1 : 2) || action === "save" && rest.length === 1)) {
    return factCommand("character", kind, action, rest);
  }
  if (kind === "character" && action === "create" && [2, 3].includes(rest.length)) {
    return navigation(rest[0], "create-character", { id: rest[1], name: rest[2] ?? rest[1] });
  }
  if (kind === "character" && action === "delete" && rest.length === 2) {
    return navigation(rest[0], "delete-character", { character_id: rest[1] });
  }
  if (kind === "page" && action === "create" && [2, 3, 4].includes(rest.length)) {
    return navigation(rest[0], "create-character-page", { character_id: rest[1], variant_id: rest[2], template_id: rest[3] });
  }
  if (kind === "page" && ["delete", "duplicate"].includes(action) && rest.length === 2) {
    return navigation(rest[0], `${action}-character-page`, { page_id: rest[1] });
  }
  throw new Error("用法：character:fact -- <profile|visual|prompt|page-index|page-goal|page-prompt> read <project-id> [target-id] [--out 文件] 或 save <JSON文件|->；character <create|delete> <project-id> <character-id> [name]；page create <project-id> <character-id> <variant-id> [template-id]；page <delete|duplicate> <project-id> <page-id>");
});
