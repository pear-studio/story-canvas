import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachTwoStep, depthRecipe, depthIntermediateOutputs } from "../server/two-step-generation.mjs";
import { saveDepthIntermediates, assertDepthDependencies, depthComfyUiUrls } from "../server/two-step-runtime.mjs";
import { buildWorkflow } from "../server/render-task-contract.mjs";
import { readWorkflowDefinition, hashCanonicalJson } from "../server/workflow-definition.mjs";
import { validateStoryPagePromptDocument, STORY_PAGE_PROMPT_SCHEMA_ID, storyPromptCategories } from "../server/story-files.mjs";
import { promptSignature } from "../server/render-task-storage.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const profile = JSON.parse(await readFile(path.join(root, "library/render-profiles/anima-base-v1.json"), "utf8"));
profile.style_loras = { style: { filename: "style.safetensors", sha256: "a".repeat(64), weight: 0.7 } };
const compiled = { ready: true, errors: [], positive_prompt: "three adults standing apart", negative_prompt: "blur" };

test("草稿自动跟随最终文本；覆盖只在启用时阻断来源变化，重置后恢复跟随", () => {
  const initial = attachTwoStep(compiled, { enabled: true, strength: 0.5 }, profile);
  assert.equal(initial.two_step.positive, compiled.positive_prompt);
  assert.equal(initial.two_step.negative, "blur");
  assert.deepEqual(initial.two_step.loras, [profile.style_loras.style]);
  const draft = { positive: "simple silhouette", base_sha256: initial.draft_base.base_sha256 };
  const changed = { ...compiled, positive_prompt: "three adults sitting apart" };
  const stale = attachTwoStep(changed, { enabled: true, strength: 0.8, draft }, profile);
  assert.equal(stale.two_step.positive, "simple silhouette");
  assert.deepEqual(stale.errors, ["草稿来源已变化，请重置或确认保留草稿"]);
  assert.equal(attachTwoStep(changed, { enabled: false, strength: 0.8, draft }, profile).ready, true);
  const kept = attachTwoStep(changed, { enabled: true, strength: 0.8, draft: { ...draft, base_sha256: hashCanonicalJson(changed.positive_prompt) } }, profile);
  assert.deepEqual(kept.errors, []);
  assert.equal(kept.two_step.positive, draft.positive);
  assert.equal(attachTwoStep(changed, { enabled: true, strength: 0.8 }, profile).two_step.positive, changed.positive_prompt);
  assert.match(attachTwoStep(compiled, { enabled: true, strength: 0.5 }, { ...profile, models: { dit: { sha256: "b".repeat(64) } } }).errors.join(), /仅支持 Anima Base/);
});

test("页面契约允许稀疏草稿，拒绝不完整覆盖和越界深度强度", () => {
  const prompt = { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, ...Object.fromEntries(storyPromptCategories.map(key => [key, []])), two_step: { enabled: false, strength: 0.5 } };
  assert.deepEqual(validateStoryPagePromptDocument(prompt), []);
  assert.match(validateStoryPagePromptDocument({ ...prompt, two_step: { enabled: true, strength: 1.1 } }).join(), /强度/);
  assert.match(validateStoryPagePromptDocument({ ...prompt, two_step: { enabled: true, strength: 0.5, draft: { positive: "draft" } } }).join(), /来源指纹/);
});

test("两步工作流的草稿隔离角色 LoRA，最终保持完整 LoRA 与采样设置", async () => {
  const definition = await readWorkflowDefinition(root, "anima-candidate-page");
  const recipe = { dimensions: { width: 896, height: 1152 }, steps: 32, cfg: 4, sampler: "er_sde", scheduler: "beta", denoise: 1 };
  const item = { id: "page.candidate-001", task: "test", candidate_id: "candidate-test", page_key: { page_id: "page-001" },
    seed: 41001, positive_prompt: compiled.positive_prompt, negative_prompt: compiled.negative_prompt,
    loras: [profile.style_loras.style, { filename: "role.safetensors", sha256: "b".repeat(64), weight: 0.9 }] };
  const plain = buildWorkflow(definition, profile, recipe, item);
  assert.equal(Object.values(plain).filter(node => node.class_type === "KSampler").length, 1);
  assert.equal(Object.values(plain).some(node => node.class_type === "ModelSamplingAuraFlow"), false);
  item.two_step = { ...attachTwoStep(compiled, { enabled: true, strength: 0.8 }, profile).two_step, seed: 51001 };
  const graph = buildWorkflow(definition, profile, recipe, item);
  const draft = Object.values(graph).find(node => node.class_type === "KSampler" && node.inputs.seed === 51001);
  const final = graph["7"];
  const chain = ref => { const names = []; while (ref) { const node = graph[ref[0]]; if (node.class_type === "LoraLoaderModelOnly") names.push(node.inputs.lora_name); ref = node.inputs.model; } return names; };
  assert.deepEqual(chain(draft.inputs.model), ["style.safetensors"]);
  assert.deepEqual(chain(final.inputs.model), ["role.safetensors", "style.safetensors"]);
  assert.equal(draft.inputs.steps, 16);
  assert.equal(final.inputs.steps, 32);
  assert.equal(final.inputs.seed, 41001);
  assert.equal(graph[final.inputs.model[0]].inputs.shift, 5);
  const control = graph[final.inputs.positive[0]];
  assert.equal(control.class_type, "ACN_AdvancedControlNetApply_v2");
  assert.equal(control.inputs.strength, 0.8);
  assert.deepEqual(control.inputs.vae_optional, ["3", 0]);
  const depth = graph[control.inputs.image[0]];
  assert.equal(depth.class_type, "DepthAnythingV2Preprocessor");
  assert.equal(depth.inputs.resolution, 896);
  assert.equal(graph["9"].class_type, "SaveImage");
  assert.deepEqual(depthIntermediateOutputs(graph, item).map(output => output.kind), ["draft", "depth"]);
  assert.equal(promptSignature(item), promptSignature({ ...item, two_step: { ...item.two_step, seed: 51002 } }));
  assert.notEqual(promptSignature(item), promptSignature({ ...item, two_step: { ...item.two_step, strength: 0.2 } }));
});

test("最终阶段失败仍保存中间结果，失败任务不需要产生最终候选", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "depth-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64");
  const outputs = ["draft", "depth"].map((kind, index) => ({ node_id: String(index), image_index: 0, kind, file: `Outputs/tasks/test/${kind}.png` }));
  const history = { status: { status_str: "error" }, outputs: { "0": { images: [{ filename: "draft.png" }] }, "1": { images: [{ filename: "depth.png" }] } } };
  await saveDepthIntermediates(directory, outputs, history, async () => bytes);
  for (const output of outputs) assert.deepEqual(await readFile(path.join(directory, output.file)), bytes);
  await assert.rejects(readFile(path.join(directory, "Outputs/tasks/test/final.png")), { code: "ENOENT" });
  await assert.rejects(saveDepthIntermediates(directory, outputs, history, async () => Buffer.from("broken")), /PNG 不完整/);
  assert.deepEqual(await readFile(path.join(directory, outputs[0].file)), bytes);
});

test("依赖缺失在连接 ComfyUI 或下载前阻断", async () => {
  assert.deepEqual(depthComfyUiUrls({ comfyui_urls: ["http://remote-comfy:8188", "http://127.0.0.1:8288"] }), ["http://127.0.0.1:8288"]);
  const config = { ...attachTwoStep(compiled, { enabled: true, strength: 0.5 }, profile).two_step, loras: [] };
  await assert.rejects(assertDepthDependencies(config, root, { models_root: "Saved/nonexistent-models", comfyui_root: "Saved/nonexistent-comfy", comfyui_urls: ["http://127.0.0.1:1"] }), /anima-vace-depth.*depth_anything_v2_vits/);
});
