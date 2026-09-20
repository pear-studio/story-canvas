import assert from "node:assert/strict";
import test from "node:test";

const { selectedPagesGenerationReady, strictPromptContextRequested } = await import(`../src/generation-readiness.ts?test=${Date.now()}`);

test("严格 Prompt context 只在流程预览可见时读取", () => {
  assert.equal(strictPromptContextRequested({ surface: "page-workspace", activeTab: "visual" }), false);
  assert.equal(strictPromptContextRequested({ surface: "page-workspace", activeTab: "review" }), false);
  assert.equal(strictPromptContextRequested({ surface: "page-workspace", activeTab: "lettering" }), false);
  assert.equal(strictPromptContextRequested({ surface: "page-workspace", activeTab: "prompt" }), true);
});

test("角色编辑只在事实保存后刷新页面上下文审计", () => {
  assert.equal(strictPromptContextRequested({ surface: "character-editor", factState: "pending" }), false);
  assert.equal(strictPromptContextRequested({ surface: "character-editor", factState: "saving" }), false);
  assert.equal(strictPromptContextRequested({ surface: "character-editor", factState: "error" }), false);
  assert.equal(strictPromptContextRequested({ surface: "character-editor", factState: "saved" }), true);
});

test("多选页面把摘要中的 LoRA 未检查状态交给生成接口最终校验", () => {
  assert.equal(selectedPagesGenerationReady(true, [
    { compiledReady: true, loraAvailable: true },
    { compiledReady: true, loraAvailable: null },
  ]), true);
});

test("明确的页面或配置阻断仍会禁用多页生成", () => {
  assert.equal(selectedPagesGenerationReady(false, [{ compiledReady: true, loraAvailable: null }]), false);
  assert.equal(selectedPagesGenerationReady(true, []), false);
  assert.equal(selectedPagesGenerationReady(true, [{ compiledReady: false, loraAvailable: null }]), false);
  assert.equal(selectedPagesGenerationReady(true, [{ compiledReady: true, loraAvailable: false }]), false);
});
