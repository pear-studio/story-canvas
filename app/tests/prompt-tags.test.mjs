import assert from "node:assert/strict";
import test from "node:test";
import { promptTagSpans, promptCompletionSpan, promptTagMarkerErrors } from "../shared/prompt-tags.mjs";
import { encodePromptFragment, compileCurrentPagePrompt } from "../server/models/anima/current-page-prompt.mjs";

const dictionary = [{ prompt_text: "blue eyes" }, { prompt_text: "dark background" }];
test("显式圈选要求非空、配对、无嵌套和已知标签，普通描述不查词库", () => {
  const known = tag => tag === "blue eyes";
  for (const text of ["{}", "{blue eyes", "blue eyes}", "{{blue eyes}}", "{(blue eyes:1.2)}"]) {
    assert.match(promptTagMarkerErrors(text, known)[0], /花括号/);
  }
  assert.deepEqual(promptTagMarkerErrors("{unknown}", known), ["圈选标签不在词库中：unknown"]);
  assert.deepEqual(promptTagMarkerErrors("a sentence with ({blue eyes}:1.2)", known), []);
  assert.deepEqual(promptTagMarkerErrors("a plain unknown description", known), []);
});
test("完整分段与句内花括号识别标签，不猜测普通句子或反向权重标记", () => {
  const text = "a person with blue eyes, (dark background:0.8)，a person with ({blue eyes}:0.8), {(blue eyes:0.8)}";
  assert.deepEqual(promptTagSpans(text).filter(s => dictionary.some(d => d.prompt_text === s.tag)).map(s => text.slice(s.start, s.end)), ["dark background", "{blue eyes}"]);
  assert.deepEqual(promptTagSpans("{{blue eyes}}"), []);
});

test("展示用花括号不进入最终 Prompt；未知或无效圈选由审计阻止生成", () => {
  const text = "a person with ({blue eyes}:0.8), {unknown}, {(blue eyes:0.8)}";
  const fragment = { prompt_type: "custom_description", prompt_text: text, weight: 1.2 };
  assert.equal(encodePromptFragment(fragment, dictionary), "(a person with (blue eyes:0.8), unknown, {(blue eyes:0.8)}:1.2)");
  assert.equal(fragment.prompt_text, text);
  assert.equal(encodePromptFragment({ ...fragment, weight: 1 }, null), "a person with (blue eyes:0.8), unknown, {(blue eyes:0.8)}");
  const compiled = compileCurrentPagePrompt({ pageId: "page-001", pageKey: { page_id: "page-001" }, pagePrompt: { setting: [{ description: text }] }, participantIds: [], dictionaryEntries: dictionary,
    profile: { id: "example", prompt: { family: "anima", category_order: ["population", "person", "setting", "camera"], avoidance_strategy: "negative_prompt", fragments: {} } } });
  assert.equal(compiled.positive_prompt, "a person with (blue eyes:0.8), unknown, {(blue eyes:0.8)}");
  assert.equal(compiled.audit.valid, false);
  assert.match(JSON.stringify(compiled.audit.errors), /unknown/);
  assert.equal(compiled.prompt_parts.positive[0].prompt_text, text);
});

test("补全范围只覆盖光标所在标签，保留花括号、权重和后续句子", () => {
  const text = "a person with ({blue ey}:0.8), dark background";
  const span = promptCompletionSpan(text, text.indexOf("ey}") + 2);
  assert.equal(span.query, "blue ey");
  assert.equal(text.slice(0, span.start) + "blue eyes" + text.slice(span.end), "a person with ({blue eyes}:0.8), dark background");
  assert.equal(promptCompletionSpan(",blue", 5).query, "blue");
  assert.equal(promptCompletionSpan("a person with {blue", 19).closeBrace, true);
});
