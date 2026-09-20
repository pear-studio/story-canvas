import assert from "node:assert/strict";
import test from "node:test";
import { generationPromptSegments } from "../src/generation-prompt-segments.ts";

test("来源着色保留编译原文的换行、分隔符、重复片段和首尾空白", () => {
  const first = { text: "1girl", origin: "page" };
  const second = { text: "standing", origin: "character" };
  const third = { text: "standing", origin: "page" };
  const raw = " 1girl,\nstanding,\n\nstanding\n";
  const segments = generationPromptSegments(raw, [first, second, third]);
  assert.equal(segments.map(segment => segment.text).join(""), raw);
  assert.deepEqual(segments.filter(segment => segment.part).map(segment => segment.part), [first, second, third]);
  assert.deepEqual(segments.filter(segment => !segment.part).map(segment => segment.text), [" ", ",\n", ",\n\n", "\n"]);
});

test("缺少或不匹配的来源片段不改写实际 Prompt，自由文本原样显示", () => {
  const raw = "first line\nsecond line";
  assert.deepEqual(generationPromptSegments(raw, []), [{ text: raw }]);
  assert.deepEqual(generationPromptSegments(raw, [{ text: "missing" }]), [{ text: raw }]);
});
