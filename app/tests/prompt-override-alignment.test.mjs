import test from "node:test";
import assert from "node:assert/strict";

import { alignPromptOverridePieces, splitPromptOverrideText } from "../src/prompt-override-alignment.mjs";

test("删除中间 Prompt 片段时保留后续片段的身份", () => {
  const entries = ["masterpiece", "best quality", "detailed background", "full-page composition"].map((text) => ({ text }));
  const pieces = splitPromptOverrideText("masterpiece, best quality, full-page composition", ", ");
  assert.deepEqual(alignPromptOverridePieces(entries, pieces), ["masterpiece", "best quality", null, "full-page composition"]);
});
