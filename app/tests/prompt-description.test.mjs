import assert from "node:assert/strict";
import test from "node:test";
import { inlinePromptWeights } from "../shared/inline-prompt-weight.mjs";
import { auditPromptFragments } from "../server/prompt-audit.mjs";
import { encodePromptFragment } from "../server/current-page-prompt.mjs";

test("多层显式权重保留层级，外层片段权重只包裹一次", () => {
  const text = "(a girl with (blue eyes:1.3):1.2)\n(soft light:2.5)";
  const parsed = inlinePromptWeights(text);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.weights, [1.3, 1.2, 2.5]);
  assert.equal(parsed.plain, "a girl with blue eyes\nsoft light");
  const fragment = { prompt_type: "custom_description", prompt_text: text, weight: 1.1 };
  assert.deepEqual(auditPromptFragments([{ fragment, source_kind: "page", category: "person" }]).errors, []);
  assert.equal(encodePromptFragment(fragment), `(${text}:1.1)`);
});

test("普通括号与标点按字面编译，允许 Unicode、多行和显式权重混排", () => {
  const text = "柔光，窗边。\n(hero (young)), [背景] — (blue eyes:1.3)";
  const fragment = { prompt_type: "custom_description", prompt_text: text };
  assert.deepEqual(auditPromptFragments([{ fragment }]).errors, []);
  assert.equal(encodePromptFragment(fragment), "柔光，窗边。\n\\(hero \\(young\\)\\), \\[背景\\] — (blue eyes:1.3)");
  assert.equal(inlinePromptWeights(String.raw`hero \(young\), (blue eyes:1.3)`).encoded, String.raw`hero \(young\), (blue eyes:1.3)`);
});

test("放宽描述仍拒绝损坏的权重表达式、空文本和越界外层权重", () => {
  for (const text of ["(blue eyes:0)", "((blue eyes:2):NaN)", "(blue eyes:2", "blue eyes)", "(:2)", "<lora:test:1>", "(blue eyes:-1)", "(blue eyes:1:2)"]) {
    assert.equal(inlinePromptWeights(text).valid, false, text);
    assert.ok(auditPromptFragments([{fragment:{prompt_type:"custom_description",prompt_text:text}}]).errors.some(e=>e.code === "prompt.fragment.inline_weight_forbidden"), text);
  }
  assert.ok(auditPromptFragments([{fragment:{prompt_type:"custom_description",prompt_text:" \n "}}]).errors.some(e=>e.code === "prompt.fragment.text_empty"));
  assert.ok(auditPromptFragments([{fragment:{prompt_type:"custom_description",prompt_text:"blue eyes",weight:11}}]).errors.some(e=>e.code === "prompt.fragment.weight_invalid"));
});
