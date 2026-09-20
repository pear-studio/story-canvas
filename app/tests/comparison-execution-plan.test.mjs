import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { handleComparisonRequest } from "../server/comparison-http.mjs";
import { recoverGenerationTasks, submitGenerationTask } from "../server/generation-lifecycle.mjs";
import { readWorkspaceTaskResults } from "../server/render-task-workspace.mjs";
import { cleanProjectRuntime } from "../server/project-runtime-cleanup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

import { createComparisonExperiment } from "../server/comparison-experiment.mjs";
import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
} from "../server/character-files.mjs";
import { preflightComparisonExperiment as preflight } from "../server/comparison-preflight.mjs";
import { importComparisonPage } from "../server/comparison-inputs.mjs";
async function preflightComparisonExperiment(options) {
  const input = await importComparisonPage({ repositoryRoot: options.repositoryRoot, projectDirectory: options.projectRoot, projectId: "fixture", pageKey, localConfig: options.localConfig });
  input.id = "sample";
  return preflight({ manifest: options.manifest, inputs: [input] });
}
import {
  claimNextComparisonCell,
  retryComparisonExperiment,
  publishComparisonCell,
  cancelComparisonExperiment,
  failComparisonExperiment,
  completeComparisonCell,
  createComparisonExperimentStorage,
  readComparisonExperimentStorage,
} from "../server/comparison-experiment-storage.mjs";
import { prepareComparisonExperimentExecution } from "../server/comparison-execution-plan.mjs";
import { readComparisonExperimentResult, runComparisonExperiment } from "../server/comparison-experiment-runtime.mjs";
import { completeGenerationTask, enqueueGenerationTask, generationReference, readGenerationQueue, waitForGenerationUnitTurn } from "../server/generation-queue.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  storyPromptCategories,
} from "../server/story-files.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pageKey = { page_id: "page-001" };
const minimalPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4), Buffer.from("IEND"), Buffer.alloc(4),
]);

function pagePrompt(subject = "traveler") {
  return {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    ...Object.fromEntries(storyPromptCategories.map((category) => [category, []])),
    subject: [{ description: subject }],
  };
}

function characterPrompt(lora = null) {
  const prompt = pagePrompt("hero");
  delete prompt.$schema;
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: Object.fromEntries(storyPromptCategories.map((category) => [category, []])), lora },
    variants: { default: { prompt, loras: [], identity_disabled: [] } },
  };
}

function safeTensor() {
  const header = Buffer.from(JSON.stringify({ __metadata__: { format: "pt" }, weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([size, header, Buffer.alloc(4)]);
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-execution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "workspace", "fixture");
  const projectDirs = ["story", "pages", "characters"];
  const rootDirs = [path.join("library", "render-profiles"), path.join("library", "prompt-policies"), path.join("library", "render-recipes"), path.join("library", "workflows"), path.join("library", "prompt-dictionaries"), path.join("models", "diffusion_models"), path.join("models", "text_encoders"), path.join("models", "vae"), path.join("models", "loras")];
  await Promise.all([
    ...projectDirs.map((dir) => mkdir(path.join(projectRoot, dir), { recursive: true })),
    ...rootDirs.map((dir) => mkdir(path.join(root, dir), { recursive: true })),
  ]);
  const checkpoint = Buffer.from("checkpoint");
  const checkpointSha = createHash("sha256").update(checkpoint).digest("hex");
  const profile = JSON.parse(await readFile(path.join(sourceRoot, "library", "render-profiles", "anima-base-v1.json"), "utf8"));
  profile.id = "comparison-profile";
  profile.name = "比较测试";
  for (const [role, relativePath] of [["dit", "diffusion_models/base.safetensors"], ["text_encoder", "text_encoders/base.safetensors"], ["vae", "vae/base.safetensors"]]) {
    profile.models[role] = { ...profile.models[role], filename: "base.safetensors", relative_path: relativePath, sha256: checkpointSha };
  }
  profile.operations.candidates.routes.empty_latent.recipe = "comparison-candidate";
  const recipe = JSON.parse(await readFile(path.join(sourceRoot, "library", "render-recipes", "anima-base-v1-candidate.json"), "utf8"));
  recipe.id = "comparison-candidate";
  await Promise.all([
    writeFile(path.join(projectRoot, "project.json"), JSON.stringify({ title: "比较", canvas: "2:3", default_render_profile: profile.id })),
    writeFile(path.join(projectRoot, "story", "outline.json"), JSON.stringify({ $schema: STORY_OUTLINE_SCHEMA_ID, synopsis: "测试。", chapters: [{ id: "chapter-main", title: "正文", summary: "测试。", sequences: [{ id: "sequence-main", title: "场景", summary: "测试页。" }] }] })),
    writeFile(path.join(projectRoot, "pages", "index.json"), JSON.stringify({ $schema: "https://storyvisualizer.local/schemas/pages-index.schema.json", pages: [{ page_id: "page-001", owner_kind: "story", sequence_id: "sequence-main" }] })),
    writeFile(path.join(projectRoot, "pages", "page-001.content.json"), JSON.stringify({ $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "测试页", scene_description: "测试画面。", characters: [], dialogue: [] })),
    writeFile(path.join(projectRoot, "pages", "page-001.prompt.json"), JSON.stringify(pagePrompt())),
    writeFile(path.join(projectRoot, "characters", "index.json"), JSON.stringify({ $schema: CHARACTER_INDEX_SCHEMA_ID, characters: [] })),
    writeFile(path.join(root, "library", "render-profiles", `${profile.id}.json`), JSON.stringify(profile)),
    cp(path.join(sourceRoot, "library", "prompt-policies", "anima-v1.json"), path.join(root, "library", "prompt-policies", "anima-v1.json")),
    writeFile(path.join(root, "library", "render-recipes", `${recipe.id}.json`), JSON.stringify(recipe)),
    writeFile(path.join(root, "models", "diffusion_models", "base.safetensors"), checkpoint),
    writeFile(path.join(root, "models", "text_encoders", "base.safetensors"), checkpoint),
    writeFile(path.join(root, "models", "vae", "base.safetensors"), checkpoint),
    writeFile(path.join(root, "models", "loras", "test.safetensors"), safeTensor()),
    cp(path.join(sourceRoot, "library", "workflows", "anima-candidate-page.api.json"), path.join(root, "library", "workflows", "anima-candidate-page.api.json")),
    cp(path.join(sourceRoot, "library", "workflows", "anima-candidate-page.manifest.json"), path.join(root, "library", "workflows", "anima-candidate-page.manifest.json")),
    cp(path.join(sourceRoot, "library", "prompt-dictionaries", "danbooru.csv"), path.join(root, "library", "prompt-dictionaries", "danbooru.csv")),
    cp(path.join(sourceRoot, "library", "prompt-dictionaries", "zh.csv"), path.join(root, "library", "prompt-dictionaries", "zh.csv")),
  ]);
  const lora = await readFile(path.join(root, "models", "loras", "test.safetensors"));
  registerFixtureProjects(root); return { root, projectRoot, loraSha: createHash("sha256").update(lora).digest("hex"), loraSize: lora.length };
}

test("Agent 创建默认原样导入页面并自动生成输入轴，文本修改仍使用独立 inputs", async context => {
  const target = await fixture(context);
  let result, projectReads = 0;
  const args = {
    projectRoot: target.root, config: { models_root: "models" },
    response: { writeHead() {}, end(text) { result = JSON.parse(text); } },
    decodedPath: "/api/comparison-experiments",
    readFacts: async (id, read) => {
      assert.equal(id, "fixture"); projectReads++;
      return { value: await read({ projectDirectory: target.projectRoot }) };
    },
  };
  const create = body => handleComparisonRequest({ ...args, request: { method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } } });
  const original = await importComparisonPage({ repositoryRoot: target.root, projectDirectory: target.projectRoot, projectId: "fixture", pageKey, localConfig: args.config });
  await create({ id: "agent-default", page_import: { project_id: "fixture", page_keys: [pageKey] }, axes: [{ type: "cfg", values: [{ value_id: "four", label: "4", value: 4 }, { value_id: "six", label: "6", value: 6 }] }] });
  assert.equal(result.experiment.manifest.cells.length, 2);
  const saved = await readComparisonExperimentStorage(target.root, "agent-default");
  assert.deepEqual(saved.preflight.inputs[0].prompt, original.prompt);
  assert.deepEqual(saved.preflight.inputs[0].render, original.render);
  assert.deepEqual(saved.preflight.inputs[0].loras, original.loras);
  assert.equal(projectReads, 1);
  await rm(target.projectRoot, { recursive: true });
  const prepared = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: args.config, experimentId: "agent-default" });
  assert.equal(prepared.execution.cells[0].prompt.positive, original.prompt.positive);
  const changed = structuredClone(saved.preflight.inputs[0]);
  changed.prompt.positive = "a quiet garden";
  await create({ id: "agent-edited", inputs: [changed] });
  const edited = await readComparisonExperimentStorage(target.root, "agent-edited");
  assert.equal(edited.preflight.inputs[0].prompt.positive, "a quiet garden");
  assert.equal(edited.manifest.cells.length, 1);
  assert.equal(projectReads, 1);
  assert.equal((await readComparisonExperimentStorage(target.root, "agent-default")).preflight.inputs[0].prompt.positive, original.prompt.positive);
  await assert.rejects(create({ id: "ambiguous", inputs: [changed], page_import: { project_id: "fixture", page_keys: [pageKey] } }), { code: "comparison_input_source_conflict" });
});

test("Start 前冻结一 cell 一 workflow，并真正覆盖 seed/CFG/末尾 test LoRA", async (context) => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({
    id: "execution-plan",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "lora_config", values: [{ value_id: "baseline", label: "基线", value: "baseline" }, { value_id: "test", label: "测试", value: "test" }] },
      { type: "lora_weight", values: [{ value_id: "weight", label: "0.8", value: 0.8 }] },
      { type: "seed", values: [{ value_id: "seed", label: "固定", value: 123 }] },
      { type: "cfg", values: [{ value_id: "cfg", label: "CFG 7", value: 7 }] },
    ],
    registries: {
      loras: [{ id: "test-lora", kind: "raw", relative_path: "loras/test.safetensors", sha256: target.loraSha, size_bytes: target.loraSize, metadata: { format: "pt" } }],
      lora_configs: [{ id: "baseline", label: "基线", lora_ref: null }, { id: "test", label: "测试", lora_ref: "test-lora" }],
    },
  });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight, now: "2026-08-24T00:00:00.000Z" });
  const stored = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  assert.ok(stored.execution);
  assert.equal(stored.execution.cells.length, 2);
  for (const cell of stored.execution.cells) assert.equal(Object.hasOwn(cell, "uploads"), false);
  const baseline = stored.execution.cells.find((cell) => cell.loras.length === 0);
  const test = stored.execution.cells.find((cell) => cell.loras.length > 0);
  assert.equal(baseline.seed, 123);
  assert.equal(test.cfg, 7);
  assert.deepEqual(baseline.loras, []);
  assert.equal(test.loras.at(-1).filename, "test.safetensors");
  assert.equal(test.loras.at(-1).weight, 0.8);
  const sampler = Object.values(test.workflow.api).find((node) => node.class_type === "KSampler");
  assert.equal(sampler.inputs.seed, 123);
  assert.equal(sampler.inputs.cfg, 7);
  assert.equal(test.outputs[0].relative_path, `results/${test.id}/image.png`);
  await assert.rejects(prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id }), /已经存在/);
});

test("替换角色 LoRA 时基线保留原配置，候选只替换目标角色", async (context) => {
  const target = await fixture(context);
  const currentLora = safeTensor();
  const currentSha = createHash("sha256").update(currentLora).digest("hex");
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "测试页",
    scene_description: "测试画面。",
    characters: [{ character_id: "hero", variant_id: "default" }],
    dialogue: [],
  };
  await Promise.all([
    writeFile(path.join(target.root, "models", "loras", "current.safetensors"), currentLora),
    writeFile(path.join(target.projectRoot, "pages", "page-001.content.json"), JSON.stringify(narrative)),
    writeFile(path.join(target.projectRoot, "characters", "index.json"), JSON.stringify({ $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["hero"] })),
    writeFile(path.join(target.projectRoot, "characters", "hero.profile.json"), JSON.stringify({ $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "主角", description: "测试角色。" })),
    writeFile(path.join(target.projectRoot, "characters", "hero.visual.json"), JSON.stringify({ $schema: CHARACTER_VISUAL_SCHEMA_ID, description: "主角形象。", variants: [{ id: "default", name: "默认", description: "基础形象。" }] })),
    writeFile(path.join(target.projectRoot, "characters", "hero.prompt.json"), JSON.stringify(characterPrompt({ filename: "current.safetensors", sha256: currentSha, weight: 0.9, trigger: "current_hero" }))),
  ]);
  const manifest = createComparisonExperiment({
    id: "character-lora-replacement",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "lora_config", values: [{ value_id: "baseline", label: "基线", value: "baseline" }, { value_id: "test", label: "测试", value: "test" }] },
      { type: "lora_weight", values: [{ value_id: "weight", label: "1.0", value: 1 }] },
    ],
    registries: {
      loras: [{ id: "test-lora", kind: "raw", relative_path: "loras/test.safetensors", sha256: target.loraSha, size_bytes: target.loraSize, metadata: { format: "pt" } }],
      lora_configs: [
        { id: "baseline", label: "基线", lora_ref: null },
        { id: "test", label: "测试", lora_ref: "test-lora", application: { mode: "replace_character", target_character_id: "hero" } },
      ],
    },
  });
  const imported = await importComparisonPage({ repositoryRoot: target.root, projectDirectory: target.projectRoot, projectId: "fixture", pageKey, localConfig: { models_root: "models" } });
  imported.id = "sample";
  imported.prompt.positive = "portrait, current_hero, red hair\nsoft light,  detailed eyes\ncurrent_heroine";
  imported.loras[0].trigger_words = ["current_hero, red hair"];
  const frozen = preflight({ manifest, inputs: [imported] });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight: frozen, now: "2026-08-24T00:00:00.000Z" });
  const stored = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  const baseline = stored.execution.cells.find((cell) => cell.axis_values.lora_config === "baseline");
  const candidate = stored.execution.cells.find((cell) => cell.axis_values.lora_config === "test");
  assert.deepEqual(baseline.loras.map((lora) => [lora.filename, lora.kind, lora.owner]), [["current.safetensors", "character", "hero"]]);
  assert.match(baseline.prompt.positive, /current_hero/);
  assert.deepEqual(candidate.loras.map((lora) => [lora.filename, lora.kind, lora.owner]), [["test.safetensors", "character", "hero"]]);
  assert.equal(baseline.prompt.positive, imported.prompt.positive);
  assert.equal(candidate.prompt.positive, "portrait, \nsoft light,  detailed eyes\ncurrent_heroine");
});

test("角色与风格 LoRA 权重由独立轴控制且不需要无风格基线", async (context) => {
  const target = await fixture(context);
  const currentLora = safeTensor();
  const currentSha = createHash("sha256").update(currentLora).digest("hex");
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "测试页",
    scene_description: "测试画面。",
    characters: [{ character_id: "hero", variant_id: "default" }],
    dialogue: [],
  };
  await Promise.all([
    writeFile(path.join(target.root, "models", "loras", "current.safetensors"), currentLora),
    writeFile(path.join(target.projectRoot, "pages", "page-001.content.json"), JSON.stringify(narrative)),
    writeFile(path.join(target.projectRoot, "characters", "index.json"), JSON.stringify({ $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["hero"] })),
    writeFile(path.join(target.projectRoot, "characters", "hero.profile.json"), JSON.stringify({ $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "主角", description: "测试角色。" })),
    writeFile(path.join(target.projectRoot, "characters", "hero.visual.json"), JSON.stringify({ $schema: CHARACTER_VISUAL_SCHEMA_ID, description: "主角形象。", variants: [{ id: "default", name: "默认", description: "基础形象。" }] })),
    writeFile(path.join(target.projectRoot, "characters", "hero.prompt.json"), JSON.stringify(characterPrompt({ filename: "current.safetensors", sha256: currentSha, weight: 0.9, trigger: "current_hero" }))),
  ]);
  const manifest = createComparisonExperiment({
    id: "independent-lora-weights",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "lora_config", values: [{ value_id: "style", label: "画风", value: "style" }] },
      { type: "character_lora_weight", values: [{ value_id: "character-05", label: "0.5", value: 0.5 }, { value_id: "character-10", label: "1.0", value: 1 }] },
      { type: "lora_weight", values: [{ value_id: "style-10", label: "1.0", value: 1 }] },
    ],
    registries: {
      loras: [{ id: "style-lora", kind: "raw", relative_path: "loras/test.safetensors", sha256: target.loraSha, size_bytes: target.loraSize, metadata: { format: "pt" } }],
      lora_configs: [{ id: "style", label: "画风", lora_ref: "style-lora" }],
    },
  });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight, now: "2026-08-24T00:00:00.000Z" });
  const stored = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  assert.deepEqual(stored.execution.cells.map((cell) => cell.loras.map((lora) => [lora.kind, lora.weight])), [
    [["character", 0.5], ["comparison", 1]],
    [["character", 1], ["comparison", 1]],
  ]);
});

test("导入后删除来源项目与全局配置，仍使用冻结输入启动", async context => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({ id: "independent", axes: [{ type: "input", values: [{ value_id: "sample", label: "输入", value: "sample" }] }] });
  const frozen = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight: frozen });
  await rm(target.projectRoot, { recursive: true, force: true });
  await rm(path.join(target.root, "library"), { recursive: true, force: true });
  const record = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  assert.equal(record.execution.cells[0].prompt.positive, frozen.inputs[0].prompt.positive);
  assert.equal(record.execution.cells[0].input_id, "sample");
});

test("比较运行时按 ordinal 串行执行并保存 PNG", async (context) => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({
    id: "runtime-success",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "seed", values: [{ value_id: "seed-a", label: "A", value: 11 }, { value_id: "seed-b", label: "B", value: 12 }] },
    ],
  });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  await recoverGenerationTasks(target.root);
  assert.deepEqual((await readGenerationQueue(target.root)).items, []);
  const order = [];
  const adapter = {
    resolveWorkflow: async (workflow) => workflow,
    submit: async ({ cell }) => { order.push(`submit-${cell.ordinal}`); return `prompt-${cell.ordinal}`; },
    wait: async (promptId) => ({ outputs: { "9": { images: [{ filename: `${promptId}.png` }] } } }),
    download: async () => minimalPng,
  };
  const completed = await runComparisonExperiment({ projectRoot: target.root, experimentId: manifest.id, modelsRoot: path.join(target.root, "models"), adapter });
  assert.equal(completed.status.status, "completed");
  assert.deepEqual(order, ["submit-0", "submit-1"]);
  const images = await readWorkspaceTaskResults(target.root, path.basename(target.projectRoot), manifest.id, "comparison");
  assert.deepEqual(images.map(image => image.id), completed.status.cells.map(cell => cell.id));
  assert.ok(images.every(image => image.url.includes(`/api/comparison-experiments/${manifest.id}/`)));
  for (const cell of completed.status.cells) {
    const submission = JSON.parse(await readFile(path.join(target.root, "Saved", "comparisons", manifest.id, "submissions", `${cell.id}.json`), "utf8"));
    assert.deepEqual(submission.stages.map(stage => [stage.phase, stage.status]), [["submit", "completed"], ["remote_wait", "completed"], ["download", "completed"], ["save", "completed"]]);
    assert.equal(submission.stages[2].item_id, cell.id);
    assert.equal(submission.stages[3].item_id, cell.id);
    assert.ok(submission.stages.every(stage => stage.ended_at >= stage.started_at && stage.duration_ms >= 0));
  }
  const liveFile = path.join(target.root, "Saved", "comparisons", manifest.id, "status.json");
  const stale = JSON.parse(await readFile(liveFile, "utf8"));
  stale.status = "running"; stale.cells.at(-1).status = "running"; stale.cells.at(-1).result = null;
  await writeFile(liveFile, JSON.stringify(stale));
  await writeFile(path.join(target.root, "Saved", "comparison-results", manifest.id, "result.json"), JSON.stringify(stale));
  await recoverGenerationTasks(target.root);
  assert.equal(JSON.parse(await readFile(liveFile, "utf8")).status, "completed");
  await cleanProjectRuntime(target.root);
  assert.equal((await readComparisonExperimentStorage(target.root, manifest.id)).status.status, "completed");
  await writeFile(path.join(target.root, "Saved", "comparison-results", manifest.id, "preflight.json"), "{broken", "utf8");
  const first = await readComparisonExperimentResult(target.root, manifest.id, manifest.cells[0].id);
  assert.deepEqual(first, minimalPng);
});

test("对比实验冻结配置无效时仍能记录失败并移出队列", async context => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({ id: "invalid-frozen-execution", created_at: "2026-08-24T00:00:00.000Z",
    axes: [{ type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] }] });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot,
    localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root,
    localConfig: { models_root: "models" }, experimentId: manifest.id });
  const reference = generationReference(null, manifest.id, "comparison", manifest.created_at);
  await submitGenerationTask(target.root, reference);
  await writeFile(path.join(target.root, "Saved", "comparison-results", manifest.id, "execution.json"), JSON.stringify({ version: -1 }));
  await assert.rejects(runComparisonExperiment({ projectRoot: target.root, experimentId: manifest.id,
    generationQueue: { repositoryRoot: target.root, reference } }), error => error.code === "invalid_comparison_execution_plan");
  const status = JSON.parse(await readFile(path.join(target.root, "Saved", "comparisons", manifest.id, "status.json"), "utf8"));
  assert.equal(status.status, "incomplete");
  assert.equal(status.cells[0].error.code, "invalid_comparison_execution_plan");
  assert.deepEqual((await readGenerationQueue(target.root)).items, []);
  await recoverGenerationTasks(target.root);
  assert.deepEqual((await readGenerationQueue(target.root)).items, []);
});

test("比较恢复只领取真实未完成 cell，最终 domain completed 后清理 lease", async (context) => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({
    id: "runtime-resume-remaining",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "seed", values: [{ value_id: "seed-a", label: "A", value: 11 }, { value_id: "seed-b", label: "B", value: 12 }] },
    ],
  });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  const first = await claimNextComparisonCell(target.root, manifest.id);
  await completeComparisonCell(target.root, manifest.id, first.id, { image: { relative_path: `results/${first.id}/image.png` } });

  // Simulate a restart after the first result was durably published: the
  // experiment is queued again, but its completed cell remains authoritative.
  const current = await readComparisonExperimentStorage(target.root, manifest.id);
  current.status.status = "queued";
  current.status.started_at = null;
  await writeFile(path.join(current.directory, "result.json"), JSON.stringify(current.status));
  await writeFile(path.join(target.root, "Saved", "comparisons", manifest.id, "status.json"), JSON.stringify(current.status));
  await enqueueGenerationTask(target.root, generationReference(null, manifest.id, "comparison", manifest.created_at));

  const submitted = [];
  const adapter = {
    resolveWorkflow: async (workflow) => workflow,
    submit: async ({ cell }) => { submitted.push(cell.ordinal); return `resume-prompt-${cell.ordinal}`; },
    wait: async () => ({ outputs: { "9": { images: [{ filename: "resume.png" }] } } }),
    download: async () => minimalPng,
  };
  const completed = await runComparisonExperiment({
    projectRoot: target.root,
    experimentId: manifest.id,
    modelsRoot: path.join(target.root, "models"),
    adapter,
    generationQueue: { repositoryRoot: target.root, reference: generationReference(null, manifest.id, "comparison", manifest.created_at) },
  });
  assert.deepEqual(submitted, [1]);
  assert.equal(completed.status.status, "completed");
  assert.deepEqual((await readGenerationQueue(target.root)).active, null);
  assert.equal((await readGenerationQueue(target.root)).items.length, 0);
});

test("比较运行时中途失败后停止后续 cell，重复启动被拒绝", async (context) => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({
    id: "runtime-failure",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "seed", values: [{ value_id: "seed-a", label: "A", value: 11 }, { value_id: "seed-b", label: "B", value: 12 }] },
    ],
  });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  const reference = generationReference(null, manifest.id, "comparison", manifest.created_at);
  await enqueueGenerationTask(target.root, reference);
  let queuePolls = 0;
  const comfyServer = createServer((request, response) => {
    if (request.url === "/queue") {
      queuePolls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    comfyServer.once("error", reject);
    comfyServer.listen(0, "127.0.0.1", resolve);
  });
  const comfyAddress = comfyServer.address();
  assert.ok(comfyAddress && typeof comfyAddress === "object");
  const comfyUrl = `http://127.0.0.1:${comfyAddress.port}`;
  context.after(async () => new Promise((resolve, reject) => comfyServer.close((error) => error ? reject(error) : resolve())));
  const order = [];
  const adapter = {
    resolveWorkflow: async (workflow) => workflow,
    submit: async ({ cell }) => { order.push(cell.ordinal); return `prompt-${cell.ordinal}`; },
    wait: async (promptId) => {
      if (promptId === "prompt-1") throw new Error("connection lost after ComfyUI accepted prompt");
      return { outputs: { "9": { images: [{ filename: "ok.png" }] } } };
    },
    download: async () => minimalPng,
  };
  await assert.rejects(runComparisonExperiment({
    projectRoot: target.root,
    experimentId: manifest.id,
    modelsRoot: path.join(target.root, "models"),
    adapter,
    apiUrl: comfyUrl,
    generationQueue: { repositoryRoot: target.root, reference },
  }), /connection lost/);
  assert.deepEqual(order, [0, 1]);
  assert.equal((await readGenerationQueue(target.root)).active, null);
  for (let attempt = 0; attempt < 100 && (!queuePolls || (await readGenerationQueue(target.root)).draining); attempt += 1) await delay(20);
  assert.ok(queuePolls > 0);
  assert.equal((await readGenerationQueue(target.root)).draining, false);
  await completeGenerationTask(target.root, reference);
  const nextReference = generationReference(null, "comparison-next", "comparison", "2026-08-24T00:00:01.000Z");
  await enqueueGenerationTask(target.root, nextReference);
  const nextLease = await waitForGenerationUnitTurn(target.root, nextReference, "next-cell", { pollMs: 1 });
  assert.ok(nextLease);
  await nextLease.release({ completed: true });
  const failed = await readComparisonExperimentStorage(target.root, manifest.id);
  assert.equal(failed.status.status, "incomplete");
  assert.equal(failed.status.cells[0].status, "completed");
  assert.equal(failed.status.cells[1].status, "incomplete");
  const failedSubmission = JSON.parse(await readFile(path.join(target.root, "Saved", "comparisons", manifest.id, "submissions", `${failed.status.cells[1].id}.json`), "utf8"));
  assert.deepEqual(failedSubmission.stages.map(stage => [stage.phase, stage.status]), [["submit", "completed"], ["remote_wait", "failed"]]);
  assert.match(failedSubmission.stages[1].error, /connection lost/);
  await assert.rejects(runComparisonExperiment({ projectRoot: target.root, experimentId: manifest.id, modelsRoot: path.join(target.root, "models"), adapter }), /已经启动或已结束/);
});


test("失败补跑沿用冻结输入，跳过稀疏已发布成果并保留原错误", async context => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({ id: "retry-sparse", axes: [
    { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
    { type: "seed", values: [1, 2, 3, 4].map(value => ({ value_id: `seed-${value}`, label: String(value), value })) },
  ] });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  const frozen = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  const submitted = [];
  const failure = Object.assign(new Error("simulated save failure"), { code: "EPERM" });
  const adapter = {
    submit: async ({ cell }) => { submitted.push(cell.ordinal); if (cell.ordinal === 1) throw failure; return `prompt-${cell.ordinal}`; },
    wait: async () => ({ outputs: { "9": { images: [{ filename: "test.png" }] } } }),
    download: async () => minimalPng,
  };
  await assert.rejects(runComparisonExperiment({ projectRoot: target.root, experimentId: manifest.id, modelsRoot: path.join(target.root, "models"), adapter }), value => value === failure);
  const failed = await readComparisonExperimentStorage(target.root, manifest.id);
  const archive = path.join(failed.directory, "result.json");
  const runtime = path.join(target.root, "Saved/comparisons", manifest.id, "status.json");
  const original = JSON.stringify(failed.status);
  const cell = frozen.execution.cells[3];
  const stale = structuredClone(failed.status);
  stale.cells[3].status = "running";
  await writeFile(archive, JSON.stringify(stale));
  await writeFile(runtime, JSON.stringify(stale));
  await publishComparisonCell(target.root, manifest.id, cell.id, minimalPng, {
    image: { relative_path: cell.outputs[0].relative_path, sha256: createHash("sha256").update(minimalPng).digest("hex"), byte_length: minimalPng.length },
    completed_at: new Date().toISOString(), generation: { prompt_id: "published-before-state" },
  }, { prompt_id: "published-before-state" });
  // 模拟发布成功、汇总状态保存失败。
  await writeFile(archive, original);
  await writeFile(runtime, original);
  const completedBefore = await readFile(path.join(failed.directory, "results", cell.id, "generation.json"));
  await writeFile(path.join(target.projectRoot, "pages/page-001.prompt.json"), "changed after freeze");
  const queued = await retryComparisonExperiment(target.root, manifest.id);
  assert.deepEqual(queued.status.cells.map(c => c.status), ["completed", "queued", "queued", "completed"]);
  assert.deepEqual(queued.execution, frozen.execution);
  assert.equal(queued.status.failures[0].cells[0].error.code, "EPERM");
  await assert.rejects(retryComparisonExperiment(target.root, manifest.id), { code: "comparison_retry_unavailable" });
  assert.equal(JSON.parse(await readFile(archive)).status, "queued");
  assert.ok(JSON.parse(await readFile(archive)).started_at, "补跑入队前中断仍保留启动意图");
  const reference = generationReference(null, manifest.id, "comparison", manifest.created_at);
  await submitGenerationTask(target.root, reference);
  submitted.length = 0;
  adapter.submit = async ({ cell }) => { submitted.push(cell.ordinal); return `retry-${cell.ordinal}`; };
  const result = await runComparisonExperiment({ projectRoot: target.root, experimentId: manifest.id, modelsRoot: path.join(target.root, "models"), adapter,
    generationQueue: { repositoryRoot: target.root, reference } });
  assert.deepEqual(submitted, [1, 2]);
  assert.equal(result.status.status, "completed");
  assert.equal(result.status.failures.length, 1);
  assert.deepEqual(await readFile(path.join(failed.directory, "results", cell.id, "generation.json")), completedBefore);
  assert.equal((await readGenerationQueue(target.root)).items.length, 0);
  assert.equal((await retryComparisonExperiment(target.root, manifest.id)).status.status, "completed");
  await writeFile(path.join(failed.directory, "results", cell.id, "image.png"), "broken");
  await assert.rejects(retryComparisonExperiment(target.root, manifest.id), { code: "comparison_result_invalid" });
});


test("补跑拒绝取消、损坏计划与成果；零完成实验可经 HTTP 补跑且防止重复启动", async context => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({ id: "retry-http", axes: [
    { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
    { type: "seed", values: [1, 2].map(value => ({ value_id: `seed-${value}`, label: String(value), value })) },
  ] });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: "models" }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  await failComparisonExperiment(target.root, manifest.id, new Error("missing plan"));
  await assert.rejects(retryComparisonExperiment(target.root, manifest.id), { code: "comparison_execution_order" });
  // 测试夹具回到未开始状态以准备合法冻结计划。
  const archive = path.join(target.root, "Saved/comparison-results", manifest.id, "result.json");
  const runtime = path.join(target.root, "Saved/comparisons", manifest.id, "status.json");
  const state = JSON.parse(await readFile(archive));
  state.status = "queued"; state.cells.forEach(c => { c.status = "queued"; c.error = null; });
  await writeFile(archive, JSON.stringify(state)); await writeFile(runtime, JSON.stringify(state));
  const frozen = await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: "models" }, experimentId: manifest.id });
  await failComparisonExperiment(target.root, manifest.id, new Error("before first cell"));
  const executionFile = path.join(frozen.directory, "execution.json");
  const executionText = await readFile(executionFile, "utf8");
  await writeFile(executionFile, executionText.replace('"canonical_sha256": "', '"canonical_sha256": "0'));
  await assert.rejects(retryComparisonExperiment(target.root, manifest.id));
  assert.equal(JSON.parse(await readFile(archive)).status, "incomplete");
  await writeFile(executionFile, executionText);
  const active = new Map();
  let release, response, starts = 0;
  const worker = new Promise(resolve => { release = resolve; });
  const request = {
    request: { method: "POST" }, decodedPath: `/api/comparison-experiments/${manifest.id}/retry`,
    projectRoot: target.root, response: { writeHead() {}, end(body) { response = JSON.parse(body); } }, config: { comfyui_urls: ["http://127.0.0.1:8188"], models_root: "models" },
    mutateDerived: async (_id, fn) => ({ value: await fn({ projectDirectory: target.projectRoot }) }),
    sendOperation: (_code, _result, value) => { response = value; }, activeComparisonProcesses: active,
    generationScheduler: { start: () => { starts++; return worker; } },
  };
  await handleComparisonRequest(request);
  assert.equal(response.started, true);
  assert.equal(response.experiment.status.status, "queued");
  assert.equal(JSON.parse(await readFile(archive)).status, "queued", "零完成也必须清除旧归档终态");
  assert.equal(active.size, 1);
  await assert.rejects(handleComparisonRequest(request), { code: "comparison_experiment_already_running" });
  assert.equal(starts, 1);
  release(); await delay(0);
  await assert.rejects(handleComparisonRequest(request), { code: "comparison_experiment_already_running" });
  const reference = generationReference(null, manifest.id, "comparison", manifest.created_at);
  await completeGenerationTask(target.root, reference);
  // 失败收尾写不进去时，磁盘仍是 running，但执行器和队列已经退出。
  const orphan = JSON.parse(await readFile(runtime));
  orphan.status = "running"; orphan.cells[0].status = "running";
  await writeFile(archive, JSON.stringify(orphan)); await writeFile(runtime, JSON.stringify(orphan));
  await handleComparisonRequest({ ...request, request: { method: "GET" }, decodedPath: `/api/comparison-experiments/${manifest.id}`,
    readFacts: async (_id, fn) => ({ value: await fn({ projectDirectory: target.projectRoot }) }) });
  assert.equal(response.experiment.retry_available, true);
  await handleComparisonRequest(request);
  assert.equal(response.experiment.status.failures.at(-1).reason, "executor_missing");
  await delay(0);
  await completeGenerationTask(target.root, reference);
  await cancelComparisonExperiment(target.root, manifest.id);
  await assert.rejects(retryComparisonExperiment(target.root, manifest.id), { code: "comparison_retry_unavailable" });

  // 模拟已有成功成果缺失，恢复必须明确拒绝而不是跳过或覆盖。
  state.status = "incomplete"; state.cells[0].status = "completed"; state.cells[1].status = "incomplete";
  await writeFile(archive, JSON.stringify(state)); await writeFile(runtime, JSON.stringify(state));
  await assert.rejects(retryComparisonExperiment(target.root, manifest.id), { code: "comparison_result_not_ready" });
  assert.equal(JSON.parse(await readFile(archive)).status, "incomplete");
});

for (const failures of [1, 2]) test(`最终成果已保存后队列释放失败 ${failures} 次，不吞错误且保留成果`, async context => {
  const target = await fixture(context);
  const manifest = createComparisonExperiment({ id: `release-failure-${failures}`, axes: [
    { type: 'input', values: [{ value_id: 'page', label: '页面', value: 'sample' }] },
  ] });
  const preflight = await preflightComparisonExperiment({ repositoryRoot: target.root, projectRoot: target.projectRoot, localConfig: { models_root: 'models' }, manifest });
  await createComparisonExperimentStorage({ projectRoot: target.root, manifest, preflight });
  await prepareComparisonExperimentExecution({ repositoryRoot: target.root, projectRoot: target.root, localConfig: { models_root: 'models' }, experimentId: manifest.id });
  const reference = generationReference(null, manifest.id, 'comparison', manifest.created_at);
  await enqueueGenerationTask(target.root, reference);
  const rename = fs.rename;
  const failure = Object.assign(new Error('simulated release persistence failure'), { code: 'EPERM' });
  let attempts = 0;
  let mocked;
  const adapter = {
    submit: async () => 'release-test',
    wait: async () => ({ outputs: { '9': { images: [{ filename: 'test.png' }] } } }),
    download: async () => minimalPng,
  };
  try {
    await assert.rejects(runComparisonExperiment({ projectRoot: target.root, experimentId: manifest.id,
      modelsRoot: path.join(target.root, 'models'), adapter,
      generationQueue: { repositoryRoot: target.root, reference },
      onCell: () => {
        mocked = context.mock.method(fs, 'rename', async (from, to) => {
          if (to === path.join(target.root, 'Saved', 'comfyui-queue.json') && ++attempts <= failures) throw failure;
          return rename(from, to);
        });
        syncBuiltinESMExports();
      },
    }), error => error === failure);
  } finally { mocked?.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(attempts >= 2, 'finally 必须使用同一凭证重试释放');
  const saved = await readComparisonExperimentStorage(target.root, manifest.id);
  assert.equal(saved.status.status, 'completed');
  assert.equal(saved.status.cells[0].status, 'completed');
  const queue = await readGenerationQueue(target.root);
  if (failures === 1) {
    assert.equal(queue.active, null);
    assert.equal(queue.items.length, 0);
  } else {
    assert.equal(queue.active.task_id, manifest.id, '持续写入失败不能伪装为已释放');
    await completeGenerationTask(target.root, reference, { leaseToken: queue.active.lease_token });
  }
});
