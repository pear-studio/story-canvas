import assert from "node:assert/strict";
import test from "node:test";
import { placePromptSuggestions } from "../src/prompt-suggestion-placement.ts";

test("候选避开键盘并保留边距，向上展开以输入框上沿为锚点", () => {
  const panel = placePromptSuggestions({ top: 340, bottom: 390, left: 500, right: 650 }, { top: 100, left: 160, width: 520, height: 400 });
  assert.deepEqual(panel, { top: 336, left: 252, width: 420, maxHeight: 228, openAbove: true });
});

test("缩放后的窄视口限制候选宽度，不保留溢出的最小宽度", () => {
  const panel = placePromptSuggestions({ top: 120, bottom: 150, left: 90, right: 140 }, { top: 100, left: 80, width: 160, height: 500 });
  assert.deepEqual(panel, { top: 154, left: 88, width: 144, maxHeight: 280, openAbove: false });
});

test("输入框已离开可见区或上下空间不足时收起候选", () => {
  assert.equal(placePromptSuggestions({ top: 20, bottom: 60, left: 200, right: 300 }, { top: 100, left: 100, width: 400, height: 300 }), null);
  assert.equal(placePromptSuggestions({ top: 130, bottom: 180, left: 200, right: 300 }, { top: 100, left: 100, width: 400, height: 110 }), null);
});
