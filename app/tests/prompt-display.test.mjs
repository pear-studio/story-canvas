import assert from "node:assert/strict";
import test from "node:test";

import { normalizedPromptDisplay, promptDictionaryBatches, promptDisplayText } from "../src/prompt-display.ts";

test("Danbooru 展示文本优先使用运行时词库翻译并回退规范化英文", () => {
  const fragment = { prompt_type: "danbooru", prompt_text: "wide_shot" };
  assert.equal(promptDisplayText(fragment, { wide_shot: "宽景" }), "宽景");
  assert.equal(promptDisplayText(fragment), "wide shot");
  assert.equal(normalizedPromptDisplay("  wide_shot  "), "wide shot");
});

test("普通描述显示原文，不接受词库覆盖", () => {
  const fragment = { prompt_type: "custom_description", prompt_text: "bell keeper" };
  assert.equal(promptDisplayText(fragment, { "bell keeper": "错误覆盖" }), "bell keeper");
});

test("运行时词库查询按服务端上限内的小批次切分并保持顺序", () => {
  const prompts = Array.from({ length: 501 }, (_, index) => `tag-${index}`);
  const batches = promptDictionaryBatches(prompts);
  assert.deepEqual(batches.map((batch) => batch.length), [200, 200, 101]);
  assert.deepEqual(batches.flat(), prompts);
});
