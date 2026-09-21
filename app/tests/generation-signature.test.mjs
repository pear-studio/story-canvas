import test from "node:test";
import assert from "node:assert/strict";
import { conditionsSignature, generationConditions, inspectionGenerationSignature, taskGenerationSignature } from "../server/generation-signature.mjs";

function fixture() {
  return {
    profile: { models: { dit: { sha256: "a".repeat(64), filename: "base.safetensors" }, vae: { sha256: "b".repeat(64) } } },
    canvas: "2:3", recipe: { id: "test", steps: 25, cfg: 1, sampler: "euler", scheduler: "simple", resolutions: { "2:3": { width: 832, height: 1248 } } },
    workflow: { template_sha256: "c".repeat(64), manifest_sha256: "d".repeat(64) },
    item: { seed: 123, positive_prompt: "portrait", negative_prompt: "blur", loras: [{ sha256: "e".repeat(64), weight: 0.8 }, { sha256: "f".repeat(64), weight: 0.5 }], reference_images: [{ sha256: "1".repeat(64), material_file: "ref.png" }, { sha256: "3".repeat(64), material_file: "second.png" }] },
  };
}
const signature = value => conditionsSignature(generationConditions(value));

test("候选匹配涵盖模型、LoRA 身份/权重/顺序、参考图和实际生成参数", () => {
  const original = fixture();
  for (const change of [
    v => v.profile.models.dit.sha256 = "2".repeat(64),
    v => v.profile.models.vae.sha256 = "2".repeat(64),
    v => v.item.loras[0].sha256 = "2".repeat(64),
    v => v.item.loras[0].weight = 0.7,
    v => v.item.loras.reverse(),
    v => v.item.loras.pop(),
    v => v.item.reference_images[0].sha256 = "2".repeat(64),
    v => v.item.reference_images.reverse(),
    v => v.recipe.steps++,
    v => v.recipe.resolutions["2:3"].width = 1024,
    v => v.workflow.template_sha256 = "2".repeat(64),
    v => v.item.positive_prompt = "landscape",
  ]) {
    const changed = structuredClone(original); change(changed);
    assert.notEqual(signature(original), signature(changed), String(change));
  }
});

test("种子、名称、路径与未选画布不拆分候选组，缺少身份不能声称匹配", () => {
  const original = fixture(), renamed = fixture();
  renamed.item.seed++;
  renamed.profile.models.dit.filename = "renamed.safetensors";
  renamed.item.reference_images[0].material_file = "renamed.png";
  renamed.recipe.name = "改名";
  renamed.recipe.resolutions["1:1"] = { width: 1024, height: 1024 };
  assert.equal(signature(original), signature(renamed));
  delete renamed.item.loras[0].sha256;
  assert.equal(signature(renamed), null);
});

test("冻结任务与页面预览使用同一条件签名", () => {
  const v = fixture();
  const item = { ...v.item, render_route: { recipe_instance_id: "recipe", workflow_id: "workflow" } };
  const task = { snapshot: { profile: v.profile, canvas: v.canvas, recipes: { recipe: { parameters: v.recipe } }, workflows: { workflow: v.workflow } } };
  const context = { snapshot: { page_prompt: {} }, project: { canvas: v.canvas }, active_profile: v.profile,
    compiled_page: v.item, reference_images: v.item.reference_images, candidate_recipe: v.recipe, candidate_workflow: v.workflow };
  assert.equal(taskGenerationSignature(task, item), inspectionGenerationSignature(context));
  context.compiled_profile = { blocked: true };
  assert.equal(inspectionGenerationSignature(context), null, "基础配置预览不能作为匹配或清理依据");
  context.compiled_profile.blocked = false;
  context.reference_images = null;
  assert.equal(inspectionGenerationSignature(context), null);
});
