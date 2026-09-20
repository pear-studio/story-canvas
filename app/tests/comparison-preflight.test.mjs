import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { importComparisonPage, createBlankComparisonInput } from "../server/comparison-inputs.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createComparisonExperiment } from "../server/comparison-experiment.mjs";
import {
  assertComparisonPreflightPlan,
  preflightComparisonExperiment,
  validateComparisonPreflightPlan,
} from "../server/comparison-preflight.mjs";
import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
} from "../server/character-files.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  storyPromptCategories,
} from "../server/story-files.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";
import { defaultSceneFacts, SCENE_INDEX_SCHEMA_ID } from "../server/scene-files.mjs";
import { compileAndPersistWorkbenchRenderTask } from "../server/page-render.mjs";
import { inspectPageRender } from "../server/page-render-inspection.mjs";

const sourceRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const storyPageKey = { page_id: "page-001" };
const characterPageKey = { page_id: "page-002" };

function prompt(subject) {
  return {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    ...Object.fromEntries(storyPromptCategories.map((category) => [category, []])),
    subject: [{ description: subject }],
  };
}

function characterPrompt() {
  const base = prompt("hero");
  delete base.$schema;
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: Object.fromEntries(storyPromptCategories.map((category) => [category, []])), lora: null },
    variants: { default: { prompt: base, loras: [], identity_disabled: [] } },
  };
}

async function createFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-preflight-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "workspace", "fixture");
  await Promise.all([
    mkdir(path.join(projectRoot, "pages"), { recursive: true }),
    mkdir(path.join(projectRoot, "story"), { recursive: true }),
    mkdir(path.join(projectRoot, "characters"), { recursive: true }),
    mkdir(path.join(root, "library", "render-profiles"), { recursive: true }),
    mkdir(path.join(root, "library", "prompt-policies"), { recursive: true }),
    mkdir(path.join(root, "library", "render-recipes"), { recursive: true }),
    mkdir(path.join(root, "library", "workflows"), { recursive: true }),
    mkdir(path.join(root, "library", "prompt-dictionaries"), { recursive: true }),
    mkdir(path.join(root, "models", "diffusion_models"), { recursive: true }),
    mkdir(path.join(root, "models", "text_encoders"), { recursive: true }),
    mkdir(path.join(root, "models", "vae"), { recursive: true }),
  ]);
  const model = Buffer.from("checkpoint");
  const modelSha256 = createHash("sha256").update(model).digest("hex");
  const profile = JSON.parse(await readFile(path.join(sourceRepositoryRoot, "library", "render-profiles", "anima-base-v1.json"), "utf8"));
  profile.id = "comparison-profile";
  profile.name = "比较测试配置";
  for (const [role, relativePath] of [["dit", "diffusion_models/base.safetensors"], ["text_encoder", "text_encoders/base.safetensors"], ["vae", "vae/base.safetensors"]]) {
    profile.models[role] = { ...profile.models[role], filename: "base.safetensors", relative_path: relativePath, sha256: modelSha256 };
  }
  profile.operations.candidates.routes.empty_latent.recipe = "comparison-candidate";
  const recipe = JSON.parse(await readFile(path.join(sourceRepositoryRoot, "library", "render-recipes", "anima-base-v1-candidate.json"), "utf8"));
  recipe.id = "comparison-candidate";
  await Promise.all([
    writeFile(path.join(projectRoot, "project.json"), JSON.stringify({ title: "比较测试", canvas: "2:3", default_render_profile: profile.id })),
    writeFile(path.join(projectRoot, "story", "outline.json"), JSON.stringify({
      $schema: STORY_OUTLINE_SCHEMA_ID,
      synopsis: "比较剧情页与角色页。",
      chapters: [{ id: "chapter-main", title: "正文", summary: "比较。", sequences: [{ id: "sequence-main", title: "场景", summary: "页面。" }] }],
    })),
    writeFile(path.join(projectRoot, "pages", "index.json"), JSON.stringify({ $schema: "https://storyvisualizer.local/schemas/pages-index.schema.json", pages: [{ page_id: "page-001", owner_kind: "story", sequence_id: "sequence-main" }, { page_id: "page-002", owner_kind: "character", character_id: "hero", variant_id: "default" }] })),
    writeFile(path.join(projectRoot, "pages", "page-001.content.json"), JSON.stringify({ $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "旅人", scene_description: "旅人的画面。", characters: [], dialogue: [] })),
    writeFile(path.join(projectRoot, "pages", "page-001.prompt.json"), JSON.stringify(prompt("traveler"))),
    writeFile(path.join(projectRoot, "characters", "index.json"), JSON.stringify({ $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["hero"] })),
    writeFile(path.join(projectRoot, "characters", "hero.profile.json"), JSON.stringify({ $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "主角", description: "测试主角。" })),
    writeFile(path.join(projectRoot, "characters", "hero.visual.json"), JSON.stringify({ $schema: CHARACTER_VISUAL_SCHEMA_ID, description: "主角形象。", variants: [{ id: "default", name: "默认", description: "基础形象。" }] })),
    writeFile(path.join(projectRoot, "characters", "hero.prompt.json"), JSON.stringify(characterPrompt())),
    writeFile(path.join(projectRoot, "pages", "page-002.content.json"), JSON.stringify({ $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "肖像", scene_description: "主角肖像。", characters: [{ character_id: "hero", variant_id: "default" }], dialogue: [] })),
    writeFile(path.join(projectRoot, "pages", "page-002.prompt.json"), JSON.stringify(prompt("portrait"))),
    writeFile(path.join(root, "library", "render-profiles", `${profile.id}.json`), JSON.stringify(profile)),
    cp(path.join(sourceRepositoryRoot, "library", "prompt-policies", "anima-v1.json"), path.join(root, "library", "prompt-policies", "anima-v1.json")),
    writeFile(path.join(root, "library", "render-recipes", `${recipe.id}.json`), JSON.stringify(recipe)),
    writeFile(path.join(root, "models", "diffusion_models", "base.safetensors"), model),
    writeFile(path.join(root, "models", "text_encoders", "base.safetensors"), model),
    writeFile(path.join(root, "models", "vae", "base.safetensors"), model),
    cp(path.join(sourceRepositoryRoot, "library", "workflows", "anima-candidate-page.api.json"), path.join(root, "library", "workflows", "anima-candidate-page.api.json")),
    cp(path.join(sourceRepositoryRoot, "library", "workflows", "anima-candidate-page.manifest.json"), path.join(root, "library", "workflows", "anima-candidate-page.manifest.json")),
    cp(path.join(sourceRepositoryRoot, "library", "prompt-dictionaries", "danbooru.csv"), path.join(root, "library", "prompt-dictionaries", "danbooru.csv")),
    cp(path.join(sourceRepositoryRoot, "library", "prompt-dictionaries", "zh.csv"), path.join(root, "library", "prompt-dictionaries", "zh.csv")),
  ]);
  registerFixtureProjects(root); return { root, projectRoot, profile, modelSha256 };
}

function loraRegistry() {
  return {
    loras: [{ id: "raw-test", kind: "raw", relative_path: "loras/test.safetensors", sha256: "a".repeat(64), size_bytes: 1, metadata: {} }],
    lora_configs: [{ id: "baseline", label: "基线", lora_ref: null }, { id: "test", label: "测试 LoRA", lora_ref: "raw-test" }],
  };
}

test("剧情和角色页一次性导入为可编辑文本，之后预检不读项目", async context => {
  const fixture = await createFixture(context);
  const inputs = await Promise.all([storyPageKey, characterPageKey].map(pageKey => importComparisonPage({ repositoryRoot: fixture.root, projectDirectory: fixture.projectRoot, projectId: "fixture", pageKey, localConfig: { models_root: "models" } })));
  assert.match(inputs[0].prompt.positive, /traveler/);
  assert.match(inputs[1].prompt.positive, /portrait/);
  assert.deepEqual(inputs[1].source.page_key, characterPageKey);
  inputs[0].prompt.positive = "edited plain text";
  await rm(fixture.projectRoot, { recursive: true, force: true });
  const manifest = createComparisonExperiment({ id: "imported", axes: [{ type: "input", values: inputs.map(input => ({ value_id: input.id, label: input.label, value: input.id })) }] });
  const plan = preflightComparisonExperiment({ manifest, inputs });
  assert.equal(plan.inputs[0].prompt.positive, "edited plain text");
  assert.equal(plan.cells.length, 2);
  assert.deepEqual(validateComparisonPreflightPlan(plan), []);
  const tampered = structuredClone(plan); tampered.inputs[0].prompt.positive = "other";
  assert.notDeepEqual(validateComparisonPreflightPlan(tampered), []);
  assert.throws(() => preflightComparisonExperiment({ manifest, inputs: [inputs[0]] }), /覆盖/);
});

test("空白输入不需要 workspace、页面或词库，完整文本及LoRA身份必须有效", async context => {
  const fixture = await createFixture(context);
  await rm(fixture.projectRoot, { recursive: true, force: true });
  const input = await createBlankComparisonInput(fixture.root, fixture.profile.id);
  const manifest = createComparisonExperiment({ id: "blank", axes: [{ type: "input", values: [{ value_id: input.id, label: "文本", value: input.id }] }] });
  assert.throws(() => preflightComparisonExperiment({ manifest, inputs: [input] }), { code: "invalid_comparison_input" });
  input.prompt.positive = "a landscape";
  const plan = preflightComparisonExperiment({ manifest, inputs: [input] });
  assert.equal(plan.inputs[0].source, null);
  input.loras.push({ filename: "../other.safetensors", sha256: "a".repeat(64), weight: 1 });
  assert.throws(() => preflightComparisonExperiment({ manifest, inputs: [input] }), { code: "invalid_comparison_input" });
});

test("场景 LoRA 从页面导入实验与冻结正式任务，删除设定后检查仍可返回诊断", async context => {
  const fixture = await createFixture(context);
  const scene = defaultSceneFacts("station", "车站");
  scene.prompt.identity.prompt.setting = [{ description: "station platform" }];
  scene.prompt.identity.lora = { filename: "station.safetensors", sha256: "a".repeat(64), weight: 0.8, trigger: "station_token" };
  scene.prompt.variants.default.loras = [{ filename: "night.safetensors", sha256: "b".repeat(64), weight: 0.6, trigger: "night_token" }];
  await mkdir(path.join(fixture.projectRoot, "scenes"));
  await writeFile(path.join(fixture.projectRoot, "scenes/index.json"), JSON.stringify({ $schema: SCENE_INDEX_SCHEMA_ID, scenes: ["station"] }));
  for (const kind of ["profile", "visual", "prompt"]) await writeFile(path.join(fixture.projectRoot, `scenes/station.${kind}.json`), JSON.stringify(scene[kind]));
  await writeFile(path.join(fixture.projectRoot, "pages/page-001.prompt.json"), JSON.stringify({ ...prompt("traveler"), scene_id: "station", scene_variant_id: "default" }));
  const input = await importComparisonPage({ repositoryRoot: fixture.root, projectDirectory: fixture.projectRoot, projectId: "fixture", pageKey: storyPageKey, localConfig: {} });
  assert.deepEqual(input.loras.map(lora => lora.kind), ["scene", "scene"]);
  assert.deepEqual(input.loras.map(lora => lora.trigger_words), [["station_token"], ["night_token"]]);
  const profileFile = path.join(fixture.root, `library/render-profiles/${fixture.profile.id}.json`);
  const profile = JSON.parse(await readFile(profileFile, "utf8"));
  profile.style_loras = { shared: { ...scene.prompt.identity.lora, trigger: "style_token" } };
  await writeFile(profileFile, JSON.stringify(profile));
  const sharedInput = await importComparisonPage({ repositoryRoot: fixture.root, projectDirectory: fixture.projectRoot, projectId: "fixture", pageKey: storyPageKey, localConfig: {} });
  assert.equal(sharedInput.loras[0].kind, "style");
  assert.deepEqual(sharedInput.loras[0].trigger_words, ["station_token", "style_token"]);
  assert.deepEqual(sharedInput.loras[1].trigger_words, ["night_token"]);
  await writeFile(profileFile, JSON.stringify(fixture.profile));
  const { task } = await compileAndPersistWorkbenchRenderTask(fixture.root, "fixture", { page_key: storyPageKey, count: 1 });
  assert.deepEqual(task.items[0].loras.map(lora => lora.kind), ["scene", "scene"]);
  assert.equal(task.items[0].loras[0].activation_triggers[0].kind, "scene");
  await writeFile(path.join(fixture.projectRoot, "scenes/index.json"), JSON.stringify({ $schema: SCENE_INDEX_SCHEMA_ID, scenes: [] }));
  const inspection = await inspectPageRender({ repositoryRoot: fixture.root, projectDirectory: fixture.projectRoot, pageKey: storyPageKey, config: { comfyui_urls: ["http://192.0.2.1:8188"] } });
  assert.match(JSON.stringify(inspection), /场景不存在|找不到场景|scene_dangling/);
});
