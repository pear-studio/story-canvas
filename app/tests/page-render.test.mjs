import {writeQwenFixtureJson, qwenDocument} from './helpers/qwen-fixture.mjs';
import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import {SCENE_INDEX_SCHEMA_ID,SCENE_PROFILE_SCHEMA_ID,SCENE_VISUAL_SCHEMA_ID,SCENE_PROMPT_SCHEMA_ID} from '../server/scene-files.mjs';
import {PAGES_INDEX_SCHEMA_ID} from '../server/pages-store.mjs';
import { factFixture } from "./fact-fixture.mjs";
import { settingPromptSourceVersion } from '../server/prompt-source-context.mjs';

function sceneVersions(fixture, id, scene) {
  return { qwen: { [`scene:${id}:default`]: settingPromptSourceVersion({
    projectId: fixture.projectId, kind: 'scene', id, modelId: 'qwen', variantId: 'default',
    document: scene.prompt, visual: scene.visual,
  }) } };
}
const { read: readStoryNarrativeDraft } = factFixture("story", "narrative");
const { read: readStoryPromptDraft, save: saveStoryPromptDraft } = factFixture("story", "prompt");
const { read: readCharacterPromptDraft, save: saveCharacterPromptDraft } = factFixture("character", "prompt");
const { read: readCharacterPagePromptDraft, save: saveCharacterPagePromptDraft } = factFixture("character", "page-prompt");
import { createServer } from "node:http";
import { createHttpRequestHandler } from "../server/http-app.mjs";
import { createProjectOperations } from "../server/project-operations.mjs";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { publishCandidateResult, readGenerationCandidateRecords } from "../server/candidate-storage.mjs";
import { withCandidateMutationLock } from "../server/candidate-mutation-lock.mjs";
import { deletePageCandidate } from "../server/candidate-delete.mjs";
import { compileAndPersistPageRenderTask, compileAndPersistWorkbenchRenderTask, renderPage } from "../server/page-render.mjs";
import { inspectPageRender } from "../server/page-render-inspection.mjs";
import { readRenderTask, updateRenderTask } from "../server/render-task-storage.mjs";
import { runPersistedRenderTask } from "../server/render-project-runtime.mjs";
import { enqueueGenerationTask, generationReference, readGenerationQueue, waitForGenerationUnitTurn } from "../server/generation-queue.mjs";
import { compilePageRenderTarget, resolvePageForRender } from "../server/page-render-resolver.mjs";
import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID
} from "../server/character-files.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
} from "../server/story-files.mjs";

import { renameCharacterVariant } from "../server/character-facts.mjs";
import { capturePagePromptSnapshot, compilePageRenderInspectionContext } from "../server/page-render-resolver.mjs";
import { auditSavedPagePrompt, preparePromptWriteAudit } from "../server/prompt-write-audit.mjs";
import { handleWorkbenchRequest } from "../server/workbench-http.mjs";
import { inspectStoryCandidates, executeStoryCandidateRefresh } from "../server/story-candidate-refresh.mjs";
import { inspectionGenerationSignature, taskGenerationSignature } from "../server/generation-signature.mjs";
import { readPageRewriteState, rewriteSource, savePageRewriteResult } from "../server/page-rewrite.mjs";

const sourceRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const writeJson = writeQwenFixtureJson;

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

function pagePrompt(text = "", extra = {}) {
  return { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, text, ...extra };
}

function characterPrompt() {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    prompt_name: "艾莲",
    variants: {
      default: { text: "艾莲，银发少女，琥珀色眼睛。", reference_images: [] },
      uniform: { text: "艾莲，银发少女，穿深色学校制服。", reference_images: [] },
    },
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "page-render-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
  await mkdir(path.join(projectDirectory, "pages"), { recursive: true });
  await writeJson(path.join(projectDirectory, "project.json"), {
    format: "story-models-v1", title: "页面渲染测试", canvas: "2:3", default_render_profile: "qwen-image-2-1",
  });
  await writeJson(path.join(projectDirectory, "story", "outline.json"), {
    $schema: STORY_OUTLINE_SCHEMA_ID,
    synopsis: "艾莲抵达并展示制服。",
    chapters: [{
      id: "opening", title: "开场", summary: "抵达。",
      sequences: [{ id: "arrival", title: "抵达", summary: "进入画面。" }],
    }],
  });
  await writeJson(path.join(projectDirectory, "pages", "index.json"), {
    $schema: PAGES_INDEX_SCHEMA_ID, pages: [{page_id:"page-001",owner_kind:"story",sequence_id:"arrival"},{page_id:"page-101",owner_kind:"character",character_id:"ellen",variant_id:"default"}],
  });
  await writeJson(path.join(projectDirectory, "pages", "page-001.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "抵达",
    scene_description: "艾莲站在车站。",
    characters: [{ character_id: "ellen", variant_id: "uniform" }],
    dialogue: [{ id: "dialogue-aaaaaaaaaaaa", mode: "speech", speaker: "guest", text: "画外传来声音。" }],
  });
  await writeJson(path.join(projectDirectory, "pages", "page-001.prompt.json"), pagePrompt("艾莲站在站台边，望向远处的列车。"));
  await writeJson(path.join(projectDirectory, "characters", "index.json"), {
    $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["ellen", "guest"],
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.profile.json"), {
    $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "艾莲", description: "短篇故事主角。",
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.visual.json"), {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    variants: [{ id: "default", name: "默认" }, { id: "uniform", name: "制服" }],
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.prompt.json"), characterPrompt());
  await writeJson(path.join(projectDirectory, "characters", "guest.profile.json"), {
    $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "路人", description: "画外音。",
  });
  await writeJson(path.join(projectDirectory, "characters", "guest.visual.json"), {
    $schema: CHARACTER_VISUAL_SCHEMA_ID, variants: [{ id: "default", name: "默认" }],
  });
  await writeJson(path.join(projectDirectory, "characters", "guest.prompt.json"), {
    $schema: CHARACTER_PROMPT_SCHEMA_ID, prompt_name: "路人", variants: { default: { text: "", reference_images: [] } },
  });
  await writeJson(path.join(projectDirectory, "pages", "page-101.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "基础形象", scene_description: "展示艾莲的基础形象。", characters:[{character_id:"ellen",variant_id:"default"}], dialogue:[],
  });
  await writeJson(path.join(projectDirectory, "pages", "page-101.prompt.json"), pagePrompt("艾莲的基础形象验证图。"));
  registerFixtureProjects(repositoryRoot); return { repositoryRoot, projectId, projectDirectory };
}

async function serveCliFixture(context, fixture) {
  const operations = createProjectOperations({ projectRoot: fixture.repositoryRoot });
  const server = createServer(createHttpRequestHandler({ projectRoot: fixture.repositoryRoot, config: {}, projectOperations: operations }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeJson(path.join(fixture.repositoryRoot, "Config", "local.json"), { port: server.address().port });
  await cp(path.join(sourceRepositoryRoot, "app/scripts/workbench-client.mjs"), path.join(fixture.repositoryRoot, "app/scripts/workbench-client.mjs"));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    operations.close();
  });
}

async function prepareWriteAuditFixture(fixture) {
  await mkdir(path.join(fixture.repositoryRoot, "app"), { recursive: true });
  await cp(
    path.join(sourceRepositoryRoot, "app", "comfyui-endpoints.json"),
    path.join(fixture.repositoryRoot, "app", "comfyui-endpoints.json"),
  );
  for (const directory of ["render-profiles", "render-recipes", "workflows"]) {
    await cp(path.join(sourceRepositoryRoot, "library", directory), path.join(fixture.repositoryRoot, "library", directory), { recursive: true });
  }
}

async function saveReferenceMaterial(fixture, id, background = "#123456") {
  const sharp = (await import("sharp")).default;
  const { saveMaterial } = await import("../server/project-materials.mjs");
  const bytes = await sharp({ create: { width: 64, height: 96, channels: 3, background } }).png().toBuffer();
  const file = `reference-${id}.png`;
  await saveMaterial(fixture.projectDirectory, fixture.projectId, { file, title: "参考", encoding: "base64", content: bytes.toString("base64") });
  return { id: `ref-${id}`, file, title: "参考", bytes };
}

test("页面优化独立保存，源变化提示过期但仍可选择并冻结进生成任务", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const pageKey = { page_id: "page-001" };
  const source = await rewriteSource({ ...fixture, pageKey });
  const original = await readPageRewriteState({ ...fixture, pageKey });
  assert.equal(original.status, "missing");
  assert.equal(original.original_prompt, source.original_prompt);
  const rewrittenPrompt = "A silver-haired girl in a dark school uniform stands on a train platform.";
  const saved = await savePageRewriteResult({
    ...fixture, source,
    result: { rewritten_prompt: rewrittenPrompt, wh_ratio: "2:3" },
  });
  assert.equal(saved.status, "current");
  const inspection = await inspectPageRender({ ...fixture, pageKey, promptSource: "rewrite" });
  assert.equal(inspection.prompt.positive, rewrittenPrompt);
  assert.deepEqual(inspection.prompt.sections.map(section => section.kind), ["rewrite"]);
  const task = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, {
    page_key: pageKey, operation: "candidates", count: 1, prompt_source: "rewrite",
  }, { repositoryRoot: fixture.repositoryRoot });
  assert.equal(task.task.items[0].positive_prompt, rewrittenPrompt);
  assert.deepEqual(task.task.items[0].prompt_parts.sections.map(section => section.kind), ["rewrite"]);
  assert.equal(inspection.generation_signature, taskGenerationSignature(task.task, task.task.items[0]));
  const originalTask = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, {
    page_key: pageKey, operation: "candidates", count: 1, prompt_source: "original",
  }, { repositoryRoot: fixture.repositoryRoot });
  assert.equal(originalTask.task.items[0].positive_prompt, source.original_prompt);

  const promptFile = path.join(fixture.projectDirectory, "pages", "page-001.prompt.json");
  const prompt = await readJson(promptFile);
  prompt.models.qwen.text = "艾莲转身面向列车。";
  await writeJson(promptFile, prompt);
  assert.equal((await readPageRewriteState({ ...fixture, pageKey })).status, "stale");
  const staleInspection = await inspectPageRender({ ...fixture, pageKey, promptSource: "rewrite" });
  assert.equal(staleInspection.prompt.positive, rewrittenPrompt);
  const staleTask = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, {
    page_key: pageKey, operation: "candidates", count: 1, prompt_source: "rewrite",
  }, { repositoryRoot: fixture.repositoryRoot });
  assert.equal(staleTask.task.items[0].positive_prompt, rewrittenPrompt);
  assert.equal((await readPageRewriteState({ ...fixture, pageKey })).status, "stale");
  assert.equal(staleInspection.generation_signature, taskGenerationSignature(staleTask.task, staleTask.task.items[0]));
});

test("INT8 重写不保留图片标签时，最终 Prompt 仍按实际图片顺序补用途", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const reference = await saveReferenceMaterial(fixture, "11111111-1111-4111-8111-111111111111");
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.models.qwen.reference_images = [{ id: reference.id, file: reference.file, title: "参考", purpose: "构图参考" }];
  await saveStoryPromptDraft(fixture.repositoryRoot, draft);
  const pageKey = { page_id: "page-001" };
  const source = await rewriteSource({ ...fixture, pageKey });
  assert.equal(source.compiled_page.images.length, 1);
  const saved = await savePageRewriteResult({
    ...fixture, source,
    result: { rewritten_prompt: "The girl waits on the platform.", wh_ratio: "3:2" },
  });
  assert.equal(saved.status, "current");
  assert.match(saved.rewrite.rewritten_prompt, /^参考图用途：\n<image1>：构图参考。\n\nThe girl waits/);
  const inspection = await inspectPageRender({ ...fixture, pageKey, promptSource: "rewrite" });
  assert.equal(inspection.prompt.positive, saved.rewrite.rewritten_prompt);
  assert.deepEqual(inspection.prompt.images.map(image => ({ index: image.index, file: image.file, purpose: image.purpose })), [
    { index: 1, file: reference.file, purpose: '构图参考。' },
  ]);
  const originalInspection = await inspectPageRender({ ...fixture, pageKey });
  assert.deepEqual(originalInspection.prompt.images, inspection.prompt.images);
  assert.deepEqual(inspection.prompt.sections.map(section => section.kind), ["reference", "rewrite"]);
  const task = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, {
    page_key: pageKey, operation: "candidates", count: 1, prompt_source: "rewrite",
  }, { repositoryRoot: fixture.repositoryRoot });
  assert.equal(task.task.items[0].positive_prompt, saved.rewrite.rewritten_prompt);
  const document = await readJson(path.join(fixture.projectDirectory, "pages", "page-001.rewrite.json"));
  assert.equal(document.rewritten_prompt, "The girl waits on the platform.");
  assert.equal(document.engine, "qwen-pe-t2i-int8");
});

test("单张参考图使用“参考图：”约定，冻结输入贯通；源材料变化不改变排队输入", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const { uploadFrozenReferenceImage } = await import("../server/reference-image.mjs");
  const { validateFrozenRenderTask } = await import("../server/render-task-contract.mjs");
  const { saveMaterial } = await import("../server/project-materials.mjs");
  const sharp = (await import("sharp")).default;
  const narrativeFile = path.join(fixture.projectDirectory, "pages/page-001.content.json");
  const narrative = await readJson(narrativeFile); narrative.characters = [];
  await writeJson(narrativeFile, narrative);
  const reference = await saveReferenceMaterial(fixture, "11111111-1111-4111-8111-111111111111");
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.models.qwen.reference_images = [{ id: reference.id, file: reference.file, title: "参考", purpose: "画风参考" }];
  await saveStoryPromptDraft(fixture.repositoryRoot, draft);
  const { task, task_directory } = await compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, "page-001", { count: 3, repositoryRoot: fixture.repositoryRoot });
  validateFrozenRenderTask(task);
  assert.equal(task.items.length, 3);
  assert.equal(task.snapshot.execution_units.length, 3);
  assert.match(task.items[0].positive_prompt, /^参考图：画风参考。/);
  assert.doesNotMatch(task.items[0].positive_prompt, /<image1>/);
  assert.match(task.items[0].positive_prompt, /本页描述：\n艾莲站在站台边/);
  assert.equal(task.items[0].negative_prompt, "");
  assert.equal(task.items[0].render_route.input_source, "reference_image");
  const workflow = task.snapshot.execution_units[0].workflow.api;
  assert.equal(workflow["4"].inputs.prompt, task.items[0].positive_prompt);
  assert.equal(workflow["4"].inputs.negative_prompt, "");
  assert.deepEqual(workflow["7"].inputs.model, ["10", 0]);
  assert.deepEqual(workflow["10"].inputs.model, ["1", 0]);
  assert.equal(workflow["6"].inputs.width, 832);
  const identity = task.items[0].reference_images[0];
  const inspectSignature = async () => inspectionGenerationSignature(await compilePageRenderInspectionContext({
    repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: task.items[0].page_key,
  }));
  assert.equal(await inspectSignature(), taskGenerationSignature(task, task.items[0]));
  const frozen = await readFile(path.join(task_directory, "inputs", `${identity.sha256}.png`));
  await saveMaterial(fixture.projectDirectory, fixture.projectId, { file: reference.file, title: "替换", encoding: "base64", content: (await sharp(reference.bytes).negate().png().toBuffer()).toString("base64") });
  assert.notEqual(await inspectSignature(), taskGenerationSignature(task, task.items[0]), "同名参考图内容变化使旧候选不再匹配");
  let received;
  const server = createServer(async (request, response) => {
    const buffers = []; for await (const buffer of request) buffers.push(buffer);
    received = Buffer.concat(buffers);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ subfolder: "StoryCanvas/references", name: `${identity.sha256}.png` }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await uploadFrozenReferenceImage(url, task_directory, identity), workflow["20"].inputs.image);
  assert.ok(received.includes(frozen), "上传任务冻结图片，而非后来替换的材料");
  const tampered = structuredClone(task); tampered.items[0].reference_images[0].sha256 = "f".repeat(64);
  assert.throws(() => validateFrozenRenderTask(tampered), /指纹|变化|不一致/);
  await writeFile(path.join(task_directory, "inputs", `${identity.sha256}.png`), "broken");
  await assert.rejects(uploadFrozenReferenceImage(url, task_directory, identity), /校验失败/);
});

test("多参考图按角色、场景、本页顺序编号组装，附图无用途仍占位置", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const { defaultSceneFacts } = await import("../server/scene-files.mjs");
  const refs = [];
  for (let index = 0; index < 4; index += 1) {
    refs.push(await saveReferenceMaterial(fixture, `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`));
  }
  const character = await readJson(path.join(fixture.projectDirectory, "characters/ellen.prompt.json"));
  character.models.qwen.variants.uniform.reference_images = refs.slice(0, 2).map(({ id, file, title }) => ({ id, file, title }));
  await writeJson(path.join(fixture.projectDirectory, "characters/ellen.prompt.json"), character);
  const scene = defaultSceneFacts("station","车站",'qwen');
  scene.prompt.models.qwen.variants.default.text = "傍晚的城市车站。";
  scene.prompt.models.qwen.variants.default.reference_images = [{ id: refs[2].id, file: refs[2].file, title: refs[2].title }];
  for (const kind of ["profile", "visual", "prompt"]) await writeJson(path.join(fixture.projectDirectory, `scenes/station.${kind}.json`), scene[kind]);
  await writeJson(path.join(fixture.projectDirectory, "scenes/index.json"), { $schema: SCENE_INDEX_SCHEMA_ID, scenes: ["station"] });
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  Object.assign(draft.document.models.qwen, {
    scene_id: "station", scene_variant_id: "default",
    reference_images: [{ id: refs[3].id, file: refs[3].file, title: refs[3].title }],
    reference_overrides: { "character:ellen:uniform": refs.slice(0, 2).map((entry) => entry.id) },
  });
  await saveStoryPromptDraft(fixture.repositoryRoot, draft, { sourceVersions: sceneVersions(fixture, 'station', scene) });
  const resolved = await resolvePageForRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageId: "page-001" });
  const positive = resolved.compiled_page.positive_prompt;
  assert.match(positive, /艾莲：\n<image1>、<image2>：艾莲的身份与服装参考。\n艾莲，银发少女，穿深色学校制服。/);
  assert.match(positive, /车站：\n<image3>：车站的环境外观参考。\n傍晚的城市车站。/);
  assert.doesNotMatch(positive, /<image4>/, "未填用途的附图不生成说明");
  assert.deepEqual(resolved.compiled_page.images.map((image) => [image.index, image.source]), [
    [1, "character:ellen:uniform"], [2, "character:ellen:uniform"], [3, "scene:station:default"], [4, "page"],
  ]);
  const purpose = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  purpose.document.models.qwen.reference_images[0].purpose = "构图参考";
  await saveStoryPromptDraft(fixture.repositoryRoot, purpose);
  const withPurpose = await resolvePageForRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageId: "page-001" });
  assert.match(withPurpose.compiled_page.positive_prompt, /<image4>：构图参考。/);
});

test("整段覆盖不随上游更新，恢复继承后跟随上游最新值", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const options = { repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageId: "page-001" };
  const before = await resolvePageForRender(options);
  assert.match(before.compiled_page.positive_prompt, /艾莲，银发少女，穿深色学校制服。/);
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.models.qwen.text_overrides = { "character:ellen:uniform": "本页艾莲穿旅行斗篷。" };
  await saveStoryPromptDraft(fixture.repositoryRoot, draft);
  const overridden = await resolvePageForRender(options);
  assert.match(overridden.compiled_page.positive_prompt, /本页艾莲穿旅行斗篷。/);
  assert.doesNotMatch(overridden.compiled_page.positive_prompt, /穿深色学校制服/);
  const character = await readJson(path.join(fixture.projectDirectory, "characters/ellen.prompt.json"));
  character.models.qwen.variants.uniform.text = "艾莲换上红色冬季制服。";
  await writeJson(path.join(fixture.projectDirectory, "characters/ellen.prompt.json"), character);
  const upstreamChanged = await resolvePageForRender(options);
  assert.match(upstreamChanged.compiled_page.positive_prompt, /本页艾莲穿旅行斗篷。/, "override 不随上游更新");
  const restore = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  delete restore.document.models.qwen.text_overrides;
  await saveStoryPromptDraft(fixture.repositoryRoot, restore);
  const restored = await resolvePageForRender(options);
  assert.match(restored.compiled_page.positive_prompt, /艾莲换上红色冬季制服。/, "恢复继承后跟随上游最新值");
});

test("显式空覆盖保留名称与图片说明但不输出文字", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.models.qwen.text_overrides = { "character:ellen:uniform": "" };
  await saveStoryPromptDraft(fixture.repositoryRoot, draft);
  const resolved = await resolvePageForRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageId: "page-001" });
  assert.match(resolved.compiled_page.positive_prompt, /艾莲：\n/);
  assert.doesNotMatch(resolved.compiled_page.positive_prompt, /银发少女/);
  const section = resolved.compiled_page.sections.find((item) => item.kind === "character");
  assert.equal(section.text, "");
  assert.equal(section.prompt_name, "艾莲");
});

test("移除引用连带清理覆盖，场景切换删除旧场景覆盖，未出场覆盖拒绝保存", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const { defaultSceneFacts } = await import("../server/scene-files.mjs");
  const scene = defaultSceneFacts("station","车站",'qwen');
  for (const kind of ["profile", "visual", "prompt"]) await writeJson(path.join(fixture.projectDirectory, `scenes/station.${kind}.json`), scene[kind]);
  await writeJson(path.join(fixture.projectDirectory, "scenes/index.json"), { $schema: SCENE_INDEX_SCHEMA_ID, scenes: ["station"] });
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.models.qwen.scene_id = "station"; draft.document.models.qwen.scene_variant_id = "default";
  draft.document.models.qwen.text_overrides = { "character:ellen:uniform": "覆盖文字", "scene:station:default": "场景覆盖" };
  await saveStoryPromptDraft(fixture.repositoryRoot, draft, { sourceVersions: sceneVersions(fixture, 'station', scene) });
  const narrative = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  narrative.document.characters = [];
  const savedNarrative = await mutateSave(fixture, narrative);
  assert.equal(savedNarrative.page_prompt.models.qwen.text_overrides["character:ellen:uniform"], undefined, "移除引用清理角色覆盖");
  assert.equal(savedNarrative.page_prompt.models.qwen.text_overrides["scene:station:default"], "场景覆盖", "场景覆盖不受影响");
  const restored = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  restored.document.characters = [{ character_id: "ellen", variant_id: "uniform" }];
  await mutateSave(fixture, restored);
  const stale = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  stale.document.models.qwen.text_overrides = { "character:ellen:default": "未出场子设定" };
  await assert.rejects(saveStoryPromptDraft(fixture.repositoryRoot, stale), (error) => error.code === "invalid_story_edit_document" && error.details.some((detail) => detail.includes("未出场")));
  const switchScene = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  delete switchScene.document.models.qwen.scene_id; delete switchScene.document.models.qwen.scene_variant_id;
  await saveStoryPromptDraft(fixture.repositoryRoot, switchScene);
  const after = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  assert.equal(Object.hasOwn(after.document.models.qwen.text_overrides ?? {}, "scene:station:default"), false, "取消场景引用删除旧场景覆盖");
});

async function mutateSave(fixture, draft) {
  const { createProjectOperations } = await import("../server/project-operations.mjs");
  const operations = createProjectOperations({ projectRoot: fixture.repositoryRoot });
  try {
    const { saveFactDraft } = await import("../server/fact-drafts.mjs");
    return (await operations.mutateTargetFacts(fixture.projectId, () => saveFactDraft(fixture.repositoryRoot, {
      domain: "story", kind: "narrative", projectId: fixture.projectId, targetId: draft.target_id,
      document: draft.document, expectedSha256: draft.expected_sha256, expectedContextSha256: draft.expected_context_sha256,
      conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict",
    }))).value;
  } finally {
    operations.close();
  }
}

test("剧情批量刷新只删除确认过的不符候选，Prompt 变化时拒绝执行", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const options = { projectRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, config: {} };
  const key = { page_id: "page-001" };
  const { task } = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, { page_key: key, count: 3 });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64");
  for (const item of task.items.slice(0, 2)) await publishCandidateResult(fixture.projectDirectory, task, item, png);
  await updateRenderTask(fixture.projectDirectory, task.id, (current) => { current.status = "completed"; current.items.forEach((item) => { item.status = "available"; }); });
  const [matching] = await inspectStoryCandidates({ ...options, pageKeys: [key] });
  assert.equal(matching.matched, 2);
  assert.deepEqual(matching.candidate_ids, []);
  const promptPath = path.join(fixture.projectDirectory, "pages/page-001.prompt.json");
  const changed = await readJson(promptPath);
  changed.models.qwen.text = "艾莲跑向列车。";
  await writeJson(promptPath, changed);
  const [preview] = await inspectStoryCandidates({ ...options, pageKeys: [key] });
  assert.equal(preview.status, "ready");
  assert.equal(preview.matched, 0);
  assert.deepEqual(new Set(preview.candidate_ids), new Set(task.items.slice(0, 2).map((item) => item.candidate_id)));
  const request = { action: "clean", scope: "mismatch", page_key: key, expected_signature: preview.signature, candidate_ids: preview.candidate_ids };
  await writeJson(promptPath, {...changed,models:{qwen:{...changed.models.qwen,text:'艾莲离开车站。'}}});
  await assert.rejects(executeStoryCandidateRefresh(options, request), { code: "candidate_generation_signature_stale" });
  assert.equal((await readGenerationCandidateRecords(fixture.projectDirectory)).length, 2);
  await writeJson(promptPath, changed);
  await publishCandidateResult(fixture.projectDirectory, task, task.items[2], png);
  assert.deepEqual(await executeStoryCandidateRefresh(options, request), { status: "deleted", count: 2 });
  assert.deepEqual((await readGenerationCandidateRecords(fixture.projectDirectory)).map((item) => item.candidate_id), [task.items[2].candidate_id]);
});

test("剧情补齐允许再次排队，已有相符候选则跳过补齐，活动任务不阻止旧候选清理", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const options = { projectRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, config: {} };
  const key = { page_id: "page-001" };
  const [preview] = await inspectStoryCandidates({ ...options, pageKeys: [key] });
  assert.equal(preview.status, "ready");
  assert.equal(preview.matched, 0);
  const value = { action: "generate", scope: "missing", count: 1, page_key: key, expected_signature: preview.signature };
  const request = Readable.from([Buffer.from(JSON.stringify(value))]);
  request.method = "POST";
  let result;
  let task;
  assert.equal(await handleWorkbenchRequest({ request, decodedPath: "/api/projects/demo/workbench/story-candidate-refresh", projectRoot: fixture.repositoryRoot, config: {},
    mutateDerived: async (_id, operation) => ({ value: await operation({ projectDirectory: fixture.projectDirectory, projectId: fixture.projectId }) }),
    workbenchRenderLauncher: async ({ value: input }) => {
      assert.deepEqual(input, { page_key: key, operation: "candidates", count: 1 });
      task = (await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, input)).task;
      return { task_id: task.id, status: "queued" };
    },
    sendOperation: (_status, _result, body) => { result = body; },
  }), true);
  assert.deepEqual(result, { status: "queued", task: { task_id: task.id, status: "queued" } });
  assert.equal(task.items.length, 1);
  assert.deepEqual(task.items[0].page_key, key);
  assert.equal((await inspectStoryCandidates({ ...options, pageKeys: [key] }))[0].status, "ready");
  const next = await executeStoryCandidateRefresh(options, value, async input => {
    const nextTask = (await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, input)).task;
    assert.notEqual(nextTask.id, task.id);
    assert.notEqual(nextTask.items[0].candidate_id, task.items[0].candidate_id);
    return { task_id: nextTask.id };
  });
  assert.equal(next.status, 'queued');
  const unexpectedLaunch = () => assert.fail("已有相符候选时无需再次补齐");
  await publishCandidateResult(fixture.projectDirectory, task, task.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
  await updateRenderTask(fixture.projectDirectory, task.id, (current) => { current.status = "completed"; current.items[0].status = "available"; });
  assert.deepEqual(await executeStoryCandidateRefresh(options, value, unexpectedLaunch), { status: "skipped" });
  let allTask;
  const allResult = await executeStoryCandidateRefresh(options, { ...value, scope: "all", count: 3 }, async (input) => {
    allTask = (await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, input)).task;
    return { task_id: allTask.id };
  });
  assert.deepEqual(allResult, { status: "queued", task: { task_id: allTask.id } });
  assert.equal(allTask.items.length, 3, "所有页面模式即使已有相符候选也按指定张数生成");
  const cleanAll = { action: "clean", scope: "all", page_key: key, candidate_ids: [task.items[0].candidate_id] };
  assert.deepEqual(await executeStoryCandidateRefresh(options, cleanAll), { status: "deleted", count: 1 }, "另一任务排队时仍可删除旧候选");
  await updateRenderTask(fixture.projectDirectory, allTask.id, (current) => { current.status = "failed"; current.items.forEach((item) => { item.status = "failed"; }); });
  await writeFile(path.join(fixture.projectDirectory, "pages/page-001.prompt.json"), "{broken");
  const [unavailable] = await inspectStoryCandidates({ ...options, pageKeys: [key] });
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.all_candidate_ids, []);
  assert.deepEqual(await executeStoryCandidateRefresh(options, cleanAll), { status: "skipped" }, "已清理集合不会重复删除");
  assert.deepEqual(await readGenerationCandidateRecords(fixture.projectDirectory), []);
  await assert.rejects(executeStoryCandidateRefresh(options, { ...value, scope: "all", count: 0 }), { code: "invalid_story_refresh_request" });
});

test("百页剧情分批检查保持顺序，坏 Prompt 只跳过对应页且角色页不进入刷新", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const directory = path.join(fixture.projectDirectory, "pages");
  const narrative = await readJson(path.join(directory, "page-001.content.json"));
  const pagePrompt = await readJson(path.join(directory, "page-001.prompt.json"));
  const keys = Array.from({ length: 100 }, (_, index) => ({ page_id: `page-${String(index + 1).padStart(3, "0")}` }));
  await writeJson(path.join(directory, "index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [...keys.map(key=>({...key,owner_kind:"story",sequence_id:"arrival"})),{page_id:"page-101",owner_kind:"character",character_id:"ellen",variant_id:"default"}] });
  for (const key of keys.slice(1)) {
    await writeJson(path.join(directory, `${key.page_id}.content.json`), { ...narrative, title: key.page_id });
    await writeJson(path.join(directory, `${key.page_id}.prompt.json`), pagePrompt);
  }
  await writeFile(path.join(directory, "page-050.prompt.json"), "{broken");
  const options = { projectRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, config: {} };
  const rows = [];
  for (let offset = 0; offset < keys.length; offset += 8) rows.push(...await inspectStoryCandidates({ ...options, pageKeys: keys.slice(offset, offset + 8) }));
  assert.deepEqual(rows.map((row) => row.page_key), keys);
  assert.deepEqual(rows.filter((row) => row.status !== "ready").map((row) => [row.page_key.page_id, row.status]), [["page-050", "unavailable"]]);
  assert.equal(rows.filter((row) => row.status === "ready" && row.matched === 0).length, 99);
  assert.deepEqual(await executeStoryCandidateRefresh(options, { action: "clean", scope: "mismatch", page_key: keys[49], expected_signature: "stale", candidate_ids: ["anything"] }), { status: "skipped" });
  await assert.rejects(inspectStoryCandidates({ ...options, pageKeys: keys }), { code: "invalid_story_refresh_request" });
  await assert.rejects(inspectStoryCandidates({ ...options, pageKeys: [{ page_id: "page-101" }] }), { code: "invalid_story_refresh_request" });
});

test("narrative CLI 写后报告画面内容超长警告，空白或超长文本仍保存并正常编译", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const request = { repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" } };
  const baseline = await compilePageRenderTarget(request);
  const scripts = path.join(fixture.repositoryRoot, "app", "scripts");
  await mkdir(scripts, { recursive: true });
  await symlink(path.join(sourceRepositoryRoot, "app", "server"), path.join(fixture.repositoryRoot, "app", "server"), "junction");
  await cp(path.join(sourceRepositoryRoot, "app", "scripts", "story-page.mjs"), path.join(scripts, "story-page.mjs"));
  await serveCliFixture(context, fixture);
  for (const [scene, warningLength] of [["", 0], ["重".repeat(19) + "🌟", 0], ["重".repeat(20) + "🌟", 21]]) {
    const session = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
    const draft = structuredClone(session.document);
    draft.scene_description = scene;
    session.document = structuredClone(draft);
    const draftFile = path.join(fixture.repositoryRoot, "narrative-draft.json");
    await writeJson(draftFile, session);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(scripts, "story-page.mjs"), "narrative", "save", draftFile]);
    const saved = JSON.parse(stdout);
    assert.equal(stderr, "");
    if (warningLength) {
      assert.equal(saved.warnings.length, 1);
      assert.equal(saved.warnings[0].code, "scene_description_too_long");
      assert.equal(saved.warnings[0].field, "scene_description");
      assert.equal(saved.warnings[0].actual_length, 21);
      assert.equal(saved.warnings[0].max_length, 20);
      assert.match(saved.warnings[0].message, /画面内容.*21.*20.*不影响保存或生成/);
    } else assert.deepEqual(saved.warnings, []);
    const persisted = await readJson(saved.target_file);
    assert.equal(persisted.scene_description, scene);
    assert.equal(Object.hasOwn(persisted, "warnings"), false);
    const render = await compilePageRenderTarget(request);
    assert.equal(render.compiled_page.ready, true);
    assert.equal(render.compiled_page.positive_prompt, baseline.compiled_page.positive_prompt);
    assert.equal(render.compiled_page.negative_prompt, baseline.compiled_page.negative_prompt);
  }
});

test("两个页面 save 返回与渲染相同的审计，失效引用不撤销保存", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  for (const [pageId, edit, write] of [
    ["page-001", readStoryPromptDraft, saveStoryPromptDraft],
    ["page-101", readCharacterPagePromptDraft, saveCharacterPagePromptDraft],
  ]) {
    const session = await edit(fixture.repositoryRoot, fixture.projectId, pageId);
    session.document.models.qwen.text_overrides = undefined;
    delete session.document.models.qwen.text_overrides;
    const result = await write(fixture.repositoryRoot, session);
    assert.equal(result.audit.status, "complete");
    assert.equal(result.audit.valid, true);
    assert.deepEqual(result.audit.warnings, []);
    const pageKey = { page_id: pageId };
    const inspection = await inspectPageRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey });
    assert.deepEqual(inspection.audit, result.audit);
  }
  const narrativeFile = path.join(fixture.projectDirectory, "pages/page-101.content.json");
  const narrative = await readJson(narrativeFile);
  narrative.characters = [{ character_id: "ellen", variant_id: "missing" }];
  await writeJson(narrativeFile, narrative);
  const session = await readCharacterPagePromptDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  const result = await saveCharacterPagePromptDraft(fixture.repositoryRoot, session);
  assert.equal(result.audit.status, "complete");
  assert.equal(result.audit.valid, false, "失效引用进入审计错误但不撤销保存");
  await assert.rejects(compilePageRenderTarget({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-101" } }), { code: "page_not_renderable" });
});

test("后置审计消费捕获快照，不读后续写入；通过结果也与 render 一致", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const result = await saveStoryPromptDraft(fixture.repositoryRoot, session);
  const prepared = await preparePromptWriteAudit(fixture.repositoryRoot);
  const snapshot = await capturePagePromptSnapshot(fixture.projectDirectory, "page-001");
  const render = await compilePageRenderTarget({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: snapshot.page_key });
  assert.deepEqual(result.audit, { status: "complete", ...render.compiled_page.audit, diagnostics: [] });
  assert.equal(result.audit.valid, true);
  assert.deepEqual(result.audit.warnings, []);
  const later = await readJson(result.target_file);
  later.models.qwen.text = "后续写入的描述。";
  await writeJson(result.target_file, later);
  const capturedResult = await auditSavedPagePrompt(fixture.repositoryRoot, fixture.projectDirectory, prepared, { value: snapshot });
  assert.deepEqual(capturedResult, result.audit);
});

test("有效配置不可用时 write 仍保存，网页不伪造审计通过", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await writeJson(path.join(fixture.projectDirectory, "project.json"), { format: "story-models-v1", title: "测试", canvas: "2:3", default_render_profile: "missing-profile" });
  await writeJson(path.join(fixture.projectDirectory,'pages/page-001.render.json'),{version:1,model_id:'qwen',profile_id:'missing-profile',canvas:'2:3'});
  await writeJson(path.join(fixture.projectDirectory,'pages/page-101.render.json'),{version:1,model_id:'qwen',profile_id:'missing-profile',canvas:'2:3'});
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const result = await saveStoryPromptDraft(fixture.repositoryRoot, session);
  assert.equal(result.audit.status, "unavailable");
  await access(result.target_file);
  const inspection = await compilePageRenderInspectionContext({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" } });
  assert.equal(inspection.audit.status, "unavailable");
  assert.ok(inspection.blockers.some((item) => item.code === "prompt_audit_unavailable"));
});

test("角色 write 审计各子设定并保留原文", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const session = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  session.document.models.qwen.variants.uniform.text = "艾莲的制服自由文本，不做结构化限制。";
  const result = await saveCharacterPromptDraft(fixture.repositoryRoot, session);
  assert.equal(result.audit.status, "complete");
  assert.deepEqual(Object.keys(result.audit.variants), ["default", "uniform"]);
  assert.equal(result.audit.variants.uniform.valid, true);
  const persisted = await readJson(result.target_file);
  assert.equal(persisted.models.qwen.variants.uniform.text, "艾莲的制服自由文本，不做结构化限制。");
  assert.equal(persisted.models.qwen.prompt_name, "艾莲");
});

test("override 冲突的基础配置预览不得冒充有效配置审计通过", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), {
    version: 1, profiles: { "qwen-image-2-1": { changes: [{
      target: "operations.candidates.routes.empty_latent.recipe.steps",
      original: { exists: true, value: 1 }, project: { exists: true, value: 30 },
    }] } },
  });
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const result = await saveStoryPromptDraft(fixture.repositoryRoot, session);
  assert.equal(result.audit.status, "unavailable");
  assert.equal(result.audit.diagnostics[0].code, "render_profile_override_conflict", JSON.stringify(result.audit));
  const inspection = await inspectPageRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" } });
  assert.equal(inspection.audit.status, "unavailable");
  assert.ok(inspection.prompt.positive, "允许继续展示基础配置预览");
  assert.ok(inspection.blockers.some((item) => item.code === "prompt_audit_unavailable"));
});

test("Prompt 语义 CLI 读写三种目标并返回审计，旧 CLI 给出迁移指引", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await mkdir(path.join(fixture.repositoryRoot, "app", "scripts"), { recursive: true });
  await symlink(path.join(sourceRepositoryRoot, "app", "server"), path.join(fixture.repositoryRoot, "app", "server"), "junction");
  for (const script of ["story-page.mjs", "character-fact.mjs", "story-canvas.mjs", "workbench-actions"]) await cp(path.join(sourceRepositoryRoot, "app", "scripts", script), path.join(fixture.repositoryRoot, "app", "scripts", script), { recursive: true });
  await serveCliFixture(context, fixture);
  const cli = path.join(fixture.repositoryRoot, 'app/scripts/story-canvas.mjs');
  const inputFile = path.join(fixture.repositoryRoot, 'prompt-input.json'), outputFile = path.join(fixture.repositoryRoot, 'prompt-output.json');
  const run = async (operation, args) => {
    await writeJson(inputFile, args);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, operation, '--args', inputFile, '--out', outputFile])
      .catch(async error => { throw new Error(`${operation}: ${await readFile(outputFile, 'utf8')}`, {cause:error}); });
    assert.equal(stderr, '');
    assert.ok(JSON.parse(stdout));
    return readJson(outputFile);
  };
  for (const [script, kind, id, edit] of [
    ["story-page.mjs", "prompt", "page-001", readStoryPromptDraft],
    ["character-fact.mjs", "page-prompt", "page-101", readCharacterPagePromptDraft],
    ["character-fact.mjs", "prompt", "ellen", readCharacterPromptDraft],
  ]) {
    const session = await edit(fixture.repositoryRoot, fixture.projectId, id);
    const draftFile = path.join(fixture.repositoryRoot, "prompt-draft.json");
    await writeJson(draftFile, session);
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(fixture.repositoryRoot, 'app', 'scripts', script), kind, 'save', draftFile]), error => {
      const result = JSON.parse(error.stderr);
      return error.code === 1 && result.error === 'prompt_editor_moved' && result.details[0].next.operation === 'prompt.read';
    });
    const target = id === 'ellen'
      ? {kind:'character',id,model_id:'qwen',scope:'variant',variant_id:'uniform'}
      : {kind:'page',id,model_id:'qwen'};
    const editable = await run('prompt.read', {project_id:fixture.projectId,target});
    const output = await run(editable.save.operation, {...editable.save.args,changes:{text:'斗篷与短裙。'}});
    assert.equal(output.saved, true);
    assert.equal(output.audit.status, "complete");
    assert.equal((await run('prompt.read', {project_id:fixture.projectId,target} )).document.text, '斗篷与短裙。');
  }
});

test("story resolver 默认省略全局文字并组装角色段与本页描述", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const resolved = await resolvePageForRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
  });
  assert.equal(resolved.kind, "story");
  assert.equal(resolved.compiled_page.positive_prompt, [
    "艾莲：\n艾莲，银发少女，穿深色学校制服。",
    "本页描述：\n艾莲站在站台边，望向远处的列车。",
  ].join("\n\n"));
  assert.equal(resolved.compiled_page.negative_prompt, "");
  assert.deepEqual(resolved.character_references, [{ character_id: "ellen", variant_id: "uniform" }]);
  assert.doesNotMatch(resolved.compiled_page.positive_prompt, /路人/, "画外speaker不注入角色Prompt");
  assert.deepEqual(resolved.compiled_page.loras, []);
  assert.deepEqual(resolved.compiled_page.sections.map((section) => section.kind), ["character", "page"]);
});

test("全局文字可由项目 override 整段替换或清空", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const options = { repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageId: "page-001" };
  const base = await import("../server/render-profile-compiler.mjs");
  const resolved = await base.readResolvedRenderProfile(fixture.repositoryRoot, "qwen-image-2-1");
  const originalText = resolved.resolved_profile.prompt.text;
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), {
    version: 1, profiles: { "qwen-image-2-1": { changes: [{
      target: "prompt.text", original: { exists: true, value: originalText }, project: { exists: true, value: "水彩画风。" },
    }] } },
  });
  const overridden = await resolvePageForRender(options);
  assert.match(overridden.compiled_page.positive_prompt, /^水彩画风。\n\n艾莲：/);
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), {
    version: 1, profiles: { "qwen-image-2-1": { changes: [{
      target: "prompt.text", original: { exists: true, value: originalText }, project: { exists: true, value: "" },
    }] } },
  });
  const cleared = await resolvePageForRender(options);
  assert.match(cleared.compiled_page.positive_prompt, /^艾莲：/, "清空全局文字时直接省略");
  assert.deepEqual(cleared.compiled_page.sections.map((section) => section.kind), ["character", "page"]);
});

test("character page resolver 使用规范PageKey与当前 variant 设定", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const promptTarget = path.join(fixture.projectDirectory, "characters", "ellen.prompt.json");
  const document = await readJson(promptTarget);
  delete document.models.qwen.variants.uniform;
  await writeJson(promptTarget, document);
  const resolved = await resolvePageForRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-101",
  });
  assert.equal(resolved.canonical_page_key, "v3/page-101");
  assert.match(resolved.compiled_page.positive_prompt, /艾莲，银发少女，琥珀色眼睛。/);
  await assert.rejects(resolvePageForRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
  }), (error) => error.code === "page_not_renderable" && error.details.some((detail) => detail.includes("uniform")));
});

test("流程预览临时编译草稿，并把本机依赖缺失作为阻断返回", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const before = await readFile(path.join(fixture.projectDirectory, "pages", "page-001.prompt.json"), "utf8");
  const draft = { text: "艾莲奔跑。" };
  const inspection = await inspectPageRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageKey: { page_id: "page-001" },
    pagePromptDraft: draft,
    config: {},
  });
  assert.match(inspection.prompt.positive, /本页描述：\n艾莲奔跑。/);
  assert.deepEqual(inspection.characters.map(({ character_id, variant_id }) => ({ character_id, variant_id })), [
    { character_id: "ellen", variant_id: "uniform" },
  ]);
  assert.equal(inspection.render.route.operation, "candidates");
  assert.equal(inspection.render.route.input_source, "empty_latent");
  assert.equal(inspection.render.recipe.source_id, inspection.render.route.recipe_source_id);
  assert.equal(inspection.render.workflow.id, inspection.render.route.workflow_id);
  assert.equal(inspection.canvas, "2:3");
  assert.equal(inspection.generation.profile_name, inspection.render.profile.name);
  assert.deepEqual(inspection.generation.models.map(({ role, filename }) => ({ role, filename })), [
    { role: "dit", filename: "qwen_image_2.1_int8_convrot.safetensors" },
    { role: "text_encoder", filename: "qwen3vl_8b_int8_convrot.safetensors" },
    { role: "vae", filename: "qwen_image_2.1_vae_bf16.safetensors" },
  ]);
  assert.equal(inspection.generation.prompt.positive, inspection.prompt.positive);
  assert.equal(inspection.ready, false, "本机未配置 models_root 时仍应返回可读 inspection");
  assert.ok(inspection.blockers.some((item) => item.code === "model_unavailable"));
  const remoteInspection = await inspectPageRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageKey: { page_id: "page-001" },
    pagePromptDraft: draft,
    config: { comfyui_urls: ["http://windows-gpu:8188"] },
  });
  assert.equal(remoteInspection.ready, true, "远程模式应把模型留给远程 ComfyUI 在提交时验证");
  assert.equal(remoteInspection.blockers.some((item) => item.code === "model_unavailable" || item.code === "page_lora_unavailable"), false);
  assert.ok(Object.values(remoteInspection.render.profile_inspection.models).every((model) => model.reason === "remote_unverified"));
  const malformed = await inspectPageRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageKey: { page_id: "page-001" },
    pagePromptDraft: { text: 42 },
    config: {},
  });
  assert.ok(malformed.blockers.some((item) => item.code === "page_prompt_draft_invalid"));
  assert.match(malformed.prompt.positive, /艾莲：/, "无效草稿被临时正规化而不是让预览整体失败");
  assert.equal(await readFile(path.join(fixture.projectDirectory, "pages", "page-001.prompt.json"), "utf8"), before);
});

test("重命名子设定后页面渲染解析使用新 id 编译", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform", "casual");
  const resolved = await resolvePageForRender({
    repositoryRoot: fixture.repositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
  });
  assert.deepEqual(resolved.character_references, [{ character_id: "ellen", variant_id: "casual" }]);
  assert.match(resolved.compiled_page.positive_prompt, /艾莲，银发少女，穿深色学校制服。/);
});

test("稳定页面ID拒绝重复，归属变化不改变生成引用；失效画面引用阻止生成", async context => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const indexPath = path.join(fixture.projectDirectory,'pages/index.json');
  const index = await readJson(indexPath);
  index.pages.push({...index.pages[0]});
  await writeJson(indexPath,index);
  const options={repositoryRoot:fixture.repositoryRoot,projectDirectory:fixture.projectDirectory,pageId:'page-001'};
  await assert.rejects(resolvePageForRender(options), /重复/);
  index.pages.pop();
  index.pages[0]={page_id:'page-001',owner_kind:'character',character_id:'missing-owner',variant_id:'default'};
  await writeJson(indexPath,index);
  const resolved=await resolvePageForRender(options);
  assert.equal(resolved.canonical_page_key,'v3/page-001');
  assert.deepEqual(resolved.participant_ids,['ellen']);
  const contentPath=path.join(fixture.projectDirectory,'pages/page-001.content.json');
  const content=await readJson(contentPath);
  content.dialogue[0].speaker='ghost';
  await writeJson(contentPath,content);
  await resolvePageForRender(options); // 文案说话者不是图片生成依赖。
  content.characters[0].variant_id='missing';
  await writeJson(contentPath,content);
  await assert.rejects(resolvePageForRender(options),error=>error.code==='page_not_renderable' && error.details.some(message=>message.includes('missing')));
  delete content.characters[0].variant_id;
  await writeJson(contentPath,content);
  await assert.rejects(resolvePageForRender(options),{code:'project_fact_contract_invalid'});
  await assert.rejects(compileAndPersistPageRenderTask(fixture.repositoryRoot,fixture.projectId,'page-101',{count:4,repositoryRoot:fixture.repositoryRoot}),{code:'candidate_count_out_of_range'});
});

test("重启后冻结契约预检失败会归档失败任务并放行后续队列", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const compiled = await compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, "page-001", { repositoryRoot: fixture.repositoryRoot });
  const stored = await readRenderTask(fixture.projectDirectory, compiled.task.id);
  const manifestPath = path.join(stored.task_directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.task.snapshot.prompt_contract.sha256 = "0".repeat(64);
  await writeJson(manifestPath, manifest);
  const before = await readFile(manifestPath, "utf8");
  const reference = generationReference(fixture.projectId, compiled.task.id);
  const next = generationReference(fixture.projectId, "render-20990101T000000Z-12345678");
  await enqueueGenerationTask(fixture.repositoryRoot, reference);
  await enqueueGenerationTask(fixture.repositoryRoot, next);
  await assert.rejects(runPersistedRenderTask({
    projectRoot: fixture.projectDirectory, taskId: compiled.task.id,
    generationQueue: { repositoryRoot: fixture.repositoryRoot, reference },
  }), /Prompt 契约身份/);
  const failed = await readRenderTask(fixture.projectDirectory, compiled.task.id);
  assert.equal(failed.state.status, "failed");
  assert.match(failed.state.error, /Prompt 契约身份/);
  assert.ok(failed.state.items.every(item => item.status === "failed"));
  assert.equal(await readFile(path.join(failed.task_directory, "manifest.json"), "utf8"), before);
  assert.deepEqual((await readGenerationQueue(fixture.repositoryRoot)).items.map(item => item.task_id), [next.task_id]);
  const lease = await waitForGenerationUnitTurn(fixture.repositoryRoot, next, "next", { signal: AbortSignal.timeout(1000) });
  await lease.release({ completed: true });
});

test("render task和返回值都提供完整绝对候选路径", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const result = await renderPage(
    fixture.repositoryRoot,
    fixture.projectId,
    "page-101",
    { count: 2, repositoryRoot: fixture.repositoryRoot },
    { runTask: async ({ projectRoot, taskId }) => {
      const task = (await readRenderTask(projectRoot, taskId)).task;
      for (const item of task.items) {
        await mkdir(path.dirname(item.absolute_file), { recursive: true });
        await writeFile(item.absolute_file, "fake png");
      }
      await updateRenderTask(projectRoot, taskId, (current) => {
        current.status = "completed";
        for (const item of current.items) item.status = "available";
      });
    } },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.candidate_paths.length, 2);
  assert.equal(result.candidate_paths.every(path.isAbsolute), true);
  const task = (await readRenderTask(fixture.projectDirectory, result.task_id)).task;
  assert.deepEqual(task.items.map((item) => item.absolute_file), result.candidate_paths);
});

test("浏览器候选请求使用完整PageKey并按手动seed连续生成", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const compiled = await compileAndPersistWorkbenchRenderTask(
    fixture.repositoryRoot,
    fixture.projectId,
    { page_key: { page_id: "page-101" }, operation: "candidates", count: 3, seed: 41 },
    { repositoryRoot: fixture.repositoryRoot },
  );
  assert.deepEqual(compiled.task.items.map((item) => item.seed), [41, 42, 43]);
  assert.equal(Object.hasOwn(compiled.task.snapshot, "execution_input_bytes"), false);
  for (const unit of compiled.task.snapshot.execution_units) {
    assert.equal(Object.hasOwn(unit, "uploads"), false);
    assert.equal(unit.render_route.input_source, "empty_latent");
  }
  const persisted = await readRenderTask(fixture.projectDirectory, compiled.task.id);
  assert.equal(persisted.state.project_title, "页面渲染测试");
  assert.deepEqual(persisted.state.pages, [{
    page_key: { page_id: "page-101" },
    page_id: "page-101",
    owner_kind: "character",
    order: 1,
    title: "基础形象",
    owner_label: "艾莲",
  }]);
  await assert.rejects(
    compileAndPersistWorkbenchRenderTask(
      fixture.repositoryRoot,
      fixture.projectId,
      { page_key: { page_id: "page-999" }, operation: "candidates", count: 1 },
      { repositoryRoot: fixture.repositoryRoot },
    ),
    (error) => error?.code === "page_not_found" && error.status === 404,
  );
  await assert.rejects(
    compileAndPersistWorkbenchRenderTask(
      fixture.repositoryRoot,
      fixture.projectId,
      { page_key: { page_id: "page-101" }, operation: "upscale" },
      { repositoryRoot: fixture.repositoryRoot },
    ),
    (error) => error?.code === "invalid_workbench_render_request" && error.status === 400,
  );
});

test("候选删除共享锁且忽略旧选择缓存，同步discarded metadata", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const rendered = await renderPage(
    fixture.repositoryRoot,
    fixture.projectId,
    "page-101",
    { count: 1, repositoryRoot: fixture.repositoryRoot },
    { runTask: async ({ projectRoot, taskId }) => {
      const task = (await readRenderTask(projectRoot, taskId)).task;
      await publishCandidateResult(projectRoot, task, task.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
      await updateRenderTask(projectRoot, taskId, (current) => {
        current.status = "completed";
        current.items[0].status = "available";
      });
    } },
  );
  const task = (await readRenderTask(fixture.projectDirectory, rendered.task_id)).task;
  const [item] = task.items;
  const currentCandidatePath = item.absolute_file;
  let releaseSelection;
  let selectionEntered;
  const selectionGate = new Promise((resolve) => { releaseSelection = resolve; });
  const entered = new Promise((resolve) => { selectionEntered = resolve; });
  const selecting = withCandidateMutationLock(fixture.repositoryRoot, fixture.projectId, async () => {
    selectionEntered();
    await selectionGate;
    await writeJson(path.join(fixture.projectDirectory, "cache", "candidate-selection-state.json"), {
      version: 2,
      pages: { "v3/page-101": { candidate_id: item.candidate_id, file: item.file } },
    });
  });
  await entered;
  const blockedDelete = deletePageCandidate(fixture.repositoryRoot, fixture.projectId, "page-101", currentCandidatePath);
  await assert.rejects(blockedDelete, (error) => error?.code === "story_edit_target_busy");
  releaseSelection();
  await selecting;
  await assert.rejects(
    updateRenderTask(fixture.projectDirectory, task.id, (current) => {
      current.items[0].absolute_file = path.resolve(fixture.repositoryRoot, "stale-project-location", item.file);
    }),
    /不可变内容不能在状态更新时改变/,
  );
  const deleted = await deletePageCandidate(fixture.repositoryRoot, fixture.projectId, "page-101", currentCandidatePath);
  assert.equal(deleted.deleted_candidate_id, item.candidate_id);
  await assert.rejects(access(currentCandidatePath));
  const updated = (await readRenderTask(fixture.projectDirectory, rendered.task_id)).task;
  assert.equal(updated.items[0].status, "discarded");
  assert.match(updated.items[0].discarded_at, /^\d{4}-/);
  const availableAfterDelete = (await readGenerationCandidateRecords(fixture.projectDirectory))
    .find((candidate) => candidate.candidate_id === item.candidate_id && candidate.status === "available");
  assert.equal(availableAfterDelete, undefined, "已删除候选不会再次出现");
});

test("编辑上下文返回引用、整段覆盖与最终文本", async t => {
  const fixture = await createFixture(t);
  await prepareWriteAuditFixture(fixture);
  const { readPromptEditContext } = await import("../server/prompt-edit-context.mjs");
  const { readFactDraft, saveFactDraft } = await import("../server/fact-drafts.mjs");
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.models.qwen.text_overrides = { "character:ellen:uniform": "本页覆盖的完整描述" };
  await saveStoryPromptDraft(fixture.repositoryRoot, draft);
  const options = { projectRoot: fixture.repositoryRoot, repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, pageKey: "v3/page-001" };
  const result = await readPromptEditContext(options);
  assert.equal(result.context.status, "complete", "无需本机模型或 ComfyUI 即可完整读取");
  assert.deepEqual(result.save, { domain: "page", kind: "prompt" });
  assert.equal(result.context.global_text.source, "profile");
  assert.equal(result.context.global_text.text, "");
  assert.deepEqual(result.context.references.map((reference) => [reference.source, reference.kind]), [["character:ellen:uniform", "character"]]);
  const reference = result.context.references[0];
  assert.equal(reference.prompt_name, "艾莲");
  assert.equal(reference.current_text, "艾莲，银发少女，穿深色学校制服。");
  assert.equal(reference.override, "本页覆盖的完整描述");
  assert.equal(reference.effective_text, "本页覆盖的完整描述");
  assert.deepEqual(reference.selected_image_ids, []);
  assert.equal(result.context.page.text, "艾莲站在站台边，望向远处的列车。");
  assert.match(result.context.final.positive, /本页覆盖的完整描述/);
  assert.equal(result.context.final.negative, "");
  assert.deepEqual(result.context.final.images, []);
  assert.deepEqual(result.context.final.sections.map((section) => section.kind), ["character", "page"]);
  assert.deepEqual(result.draft, await readFactDraft(fixture.repositoryRoot, { domain: "story", kind: "prompt", projectId: fixture.projectId, targetId: "page-001" }));
  const compiled = await compilePageRenderInspectionContext({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: options.pageKey });
  assert.equal(result.context.final.positive, compiled.compiled_page.positive_prompt);
  assert.deepEqual(result.context.configuration.effective_loras,compiled.compiled_page.loras);
  const save = draft => saveFactDraft(fixture.repositoryRoot, { domain: "story", kind: "prompt", projectId: fixture.projectId, targetId: "page-001", document: draft.document, expectedSha256: draft.expected_sha256, expectedContextSha256: draft.expected_context_sha256, conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict" });
  await save(result.draft);
  const fresh = await readPromptEditContext(options);
  const characterFile = path.join(fixture.projectDirectory, "characters/ellen.prompt.json");
  const character = await readJson(characterFile);
  character.models.qwen.variants.uniform.text = "上游变化后的描述。";
  await writeJson(characterFile, character);
  await assert.rejects(save(fresh.draft), error => error.code === "fact_upstream_conflict");
});

test("编辑上下文覆盖角色页实际来源，配置缺失明确返回不完整", async t => {
  const fixture = await createFixture(t);
  await prepareWriteAuditFixture(fixture);
  const { readPromptEditContext } = await import("../server/prompt-edit-context.mjs");
  const options = { projectRoot: fixture.repositoryRoot, repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, pageKey: "v3/page-101" };
  const initial = await readPromptEditContext(options);
  assert.deepEqual(initial.save, { domain: "page", kind: "prompt" });
  assert.equal(initial.draft.target_id, "page-101");
  assert.equal(initial.context.references[0].source, "character:ellen:default");
  const { readResolvedRenderProfile } = await import("../server/render-profile-compiler.mjs");
  const base = await readResolvedRenderProfile(fixture.repositoryRoot, "qwen-image-2-1");
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), { version: 1, profiles: { "qwen-image-2-1": { changes: [{
    target: "prompt.text", original: { exists: false }, project: { exists: true, value: "changed style" },
  }] } } });
  const conflict = await readPromptEditContext(options);
  assert.equal(conflict.context.status, "incomplete");
  assert.equal(conflict.context.configuration.effective_loras,null);
  assert.equal(conflict.context.final, null, "配置冲突时不能把基础预览冒充实际输出");
  assert.equal(conflict.context.diagnostics.filter((item) => item.code === "render_profile_override_conflict").length > 0, true);
  await writeJson(path.join(fixture.projectDirectory, "project.json"), { format: "story-models-v1", title: "测试", canvas: "2:3", default_render_profile: "missing-profile" });
  await writeJson(path.join(fixture.projectDirectory,'pages/page-001.render.json'),{version:1,model_id:'qwen',profile_id:'missing-profile',canvas:'2:3'});
  await writeJson(path.join(fixture.projectDirectory,'pages/page-101.render.json'),{version:1,model_id:'qwen',profile_id:'missing-profile',canvas:'2:3'});
  const incomplete = await readPromptEditContext(options);
  assert.equal(incomplete.context.status, "incomplete");
  assert.equal(incomplete.context.final, null);
  assert.ok(incomplete.context.diagnostics.some(item => item.code === "prompt_audit_unavailable"));
  void base;
});

test('十张参考图按角色、场景、本页顺序冻结并连接，十一张拒绝', async t => {
  const fixture = await createFixture(t);
  await prepareWriteAuditFixture(fixture);
  const { defaultSceneFacts } = await import('../server/scene-files.mjs');
  const refs = [];
  for (let i = 0; i < 10; i++) {
    refs.push(await saveReferenceMaterial(fixture, `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, { r: i * 20, g: 100, b: 50 }));
  }
  const character = await readJson(path.join(fixture.projectDirectory, 'characters/ellen.prompt.json'));
  character.models.qwen.variants.uniform.reference_images = refs.slice(0, 5).map(({ id, file, title }) => ({ id, file, title }));
  await writeJson(path.join(fixture.projectDirectory, 'characters/ellen.prompt.json'), character);
  const scene = defaultSceneFacts('room','房间','qwen');
  scene.prompt.models.qwen.variants.default.reference_images = refs.slice(5, 9).map(({ id, file, title }) => ({ id, file, title }));
  for (const kind of ['profile', 'visual', 'prompt']) await writeJson(path.join(fixture.projectDirectory, `scenes/room.${kind}.json`), scene[kind]);
  await writeJson(path.join(fixture.projectDirectory, 'scenes/index.json'), { $schema: SCENE_INDEX_SCHEMA_ID, scenes: ['room'] });
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, 'page-001');
  Object.assign(draft.document.models.qwen, { scene_id: 'room', scene_variant_id: 'default', reference_images: refs.slice(9).map(({ id, file, title }) => ({ id, file, title })), reference_overrides: { 'character:ellen:uniform': refs.slice(0,5).map(r=>r.id), 'scene:room:default': refs.slice(5,9).map(r=>r.id) } });
  await saveStoryPromptDraft(fixture.repositoryRoot, draft, { sourceVersions: sceneVersions(fixture, 'room', scene) });
  const { task, task_directory } = await compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, 'page-001', { count: 1, repositoryRoot: fixture.repositoryRoot });
  assert.deepEqual(task.items[0].reference_images.map(r=>r.material_file), refs.map(r=>r.file));
  const workflow = task.snapshot.execution_units[0].workflow.api;
  for (let i = 0; i < 10; i++) {
    const node = workflow['4'].inputs[`images.image_${i+1}`][0];
    assert.equal(workflow[node].inputs.image, `StoryCanvas/references/${task.items[0].reference_images[i].sha256}.png`);
    await access(path.join(task_directory, 'inputs', task.items[0].reference_images[i].sha256 + '.png'));
  }
  const { validateFrozenRenderTask } = await import('../server/render-task-contract.mjs');
  validateFrozenRenderTask(task);
  const next = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, 'page-001');
  next.document.models.qwen.reference_images.push({ id: refs[0].id, file: refs[0].file, title: refs[0].title });
  await saveStoryPromptDraft(fixture.repositoryRoot, next);
  await assert.rejects(compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, 'page-001', { repositoryRoot: fixture.repositoryRoot }), (error) => error.code === "page_not_renderable" && error.details.some((detail) => /最多支持 10/.test(detail)));
});
