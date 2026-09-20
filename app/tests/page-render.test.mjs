import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import {SCENE_INDEX_SCHEMA_ID,SCENE_PROFILE_SCHEMA_ID,SCENE_VISUAL_SCHEMA_ID,SCENE_PROMPT_SCHEMA_ID} from '../server/scene-files.mjs';
import {PAGES_INDEX_SCHEMA_ID} from '../server/pages-store.mjs';
import { factFixture } from "./fact-fixture.mjs";
const { read: readStoryNarrativeDraft } = factFixture("story", "narrative");
const { read: readStoryPromptDraft, save: saveStoryPromptDraft } = factFixture("story", "prompt");
const { read: readCharacterPromptDraft, saveConfirmed: saveCharacterPromptDraft } = factFixture("character", "prompt");
const { read: readCharacterPagePromptDraft, save: saveCharacterPagePromptDraft } = factFixture("character", "page-prompt");
import { createServer } from "node:http";
import { createHttpRequestHandler } from "../server/http-app.mjs";
import { createProjectOperations } from "../server/project-operations.mjs";
import { pagePromptContextSha256 } from "../server/fact-drafts.mjs";
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
  CHARACTER_PAGE_GOAL_SCHEMA_ID,
  CHARACTER_PAGES_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID
} from "../server/character-files.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGES_INDEX_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  storyPromptCategories
} from "../server/story-files.mjs";
import { loadPromptDictionaryForRender } from "../server/prompt-dictionary-loader.mjs";


import { renameCharacterVariant } from "../server/character-facts.mjs";
import { capturePagePromptSnapshot, compilePageRenderInspectionContext } from "../server/page-render-resolver.mjs";
import { auditSavedPagePrompt, preparePromptWriteAudit } from "../server/prompt-write-audit.mjs";
import { handleWorkbenchRequest } from "../server/workbench-http.mjs";
import { inspectStoryCandidates, executeStoryCandidateRefresh } from "../server/story-candidate-refresh.mjs";

const sourceRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("圈选标签保存原文，冻结任务与复验使用无花括号的加权 Prompt；未知圈选只阻止生成", async context => {
  const fixture = await createFixture(context);
  const draft = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document.setting.push({ description: "a person with ({blue eyes}:0.8)" });
  await saveStoryPromptDraft(fixture.repositoryRoot, draft);
  const { task } = await compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, "page-001", { repositoryRoot: sourceRepositoryRoot });
  const stored = await readRenderTask(fixture.projectDirectory, task.id);
  const { validateFrozenRenderTask } = await import("../server/render-task-contract.mjs");
  const snapshot = await dictionary();
  validateFrozenRenderTask(stored.task, { dictionaryEntries: snapshot.entries, dictionaryIdentity: snapshot.identity });
  assert.match(stored.task.items[0].positive_prompt, /a person with \(blue eyes:0\.8\)/);
  assert.equal(stored.task.items[0].positive_prompt.includes("{"), false);
  const persisted = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  assert.equal(persisted.document.setting.at(-1).description, "a person with ({blue eyes}:0.8)");
  persisted.document.setting.at(-1).description = "a person with {this_tag_does_not_exist_123456}";
  await saveStoryPromptDraft(fixture.repositoryRoot, persisted);
  await assert.rejects(compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, "page-001", { repositoryRoot: sourceRepositoryRoot }), error => {
    assert.equal(error.code, "page_not_renderable");
    assert.match(JSON.stringify(error.details), /圈选标签不在词库中：this_tag_does_not_exist_123456/);
    return true;
  });
});

test("两步页面设置经事实保存和读取后进入冻结任务，中间图不进入候选输出", async context => {
  const fixture = await createFixture(context);
  const { savePagePrompt } = await import("../server/project-workbench.mjs");
  const { hashCanonicalJson } = await import("../server/workflow-definition.mjs");
  const { compileFrozenExecutionUnits, validateFrozenRenderTask } = await import("../server/render-task-contract.mjs");
  const dictionarySnapshot = await dictionary();
  const pageKey = { page_id: "page-001" };
  const { task } = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId, { page_key: pageKey, count: 2 }, { repositoryRoot: sourceRepositoryRoot });
  const document = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const { $schema, ...fields } = document.document;
  const saved = await savePagePrompt(fixture.repositoryRoot, fixture.projectId, {
    kind: "story", page_id: "page-001", expected_sha256: document.expected_sha256, expected_context_sha256: document.expected_context_sha256,
    prompt: { ...fields, two_step: { enabled: true, strength: 0.8 } },
  });
  assert.deepEqual(saved.prompt.two_step, { enabled: true, strength: 0.8 });
  assert.equal(Object.hasOwn((await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001")).document.two_step, "draft"), false);
  const resolved = await compilePageRenderTarget({ repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageKey, dictionaryEntries: dictionarySnapshot.entries });
  assert.equal(resolved.compiled_page.two_step.positive, resolved.compiled_page.positive_prompt);
  for (const [index, item] of task.items.entries()) item.two_step = { ...resolved.compiled_page.two_step, seed: 51001 + index };
  task.snapshot.execution_units = compileFrozenExecutionUnits({ items: task.items, purpose: "candidate", snapshot: task.snapshot, profile: task.snapshot.profile, canvas: task.snapshot.canvas, candidateBatch: false, taskId: task.id });
  task.snapshot.execution_units_sha256 = hashCanonicalJson(task.snapshot.execution_units);
  validateFrozenRenderTask(task, { dictionaryEntries: dictionarySnapshot.entries, dictionaryIdentity: dictionarySnapshot.identity });
  assert.deepEqual(task.snapshot.execution_units.map(unit => unit.two_step.seed), [51001, 51002]);
  for (const unit of task.snapshot.execution_units) {
    assert.deepEqual(unit.outputs.map(output => output.kind), ["candidate"]);
    assert.deepEqual(unit.intermediate_outputs.map(output => output.kind), ["draft", "depth"]);
    assert.match(unit.intermediate_outputs[0].file, /^Outputs\/tasks\//);
  }
});

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

function prompt(schema = STORY_PAGE_PROMPT_SCHEMA_ID) {
  return { $schema: schema, ...Object.fromEntries(storyPromptCategories.map((category) => [category, []])) };
}

function characterPrompt() {
  const base = prompt(undefined);
  delete base.$schema;
  base.subject = [{ description: "ellen identity" }];
  base.avoid = [{ description: "incorrect identity" }];
  const uniform = structuredClone(base);
  uniform.person.push({ description: "school uniform" });
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: Object.fromEntries(storyPromptCategories.map((category) => [category, []])), lora: null },
    variants: {
      default: { prompt: base, loras: [], identity_disabled: [] },
      uniform: {
        prompt: uniform,
        loras: [{ filename: "characters/ellen-uniform.safetensors", sha256: "a".repeat(64), weight: 0.8, trigger: "ellen_uniform" }],
        identity_disabled: [],
      },
    },
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "page-render-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
  await mkdir(path.join(projectDirectory, "pages"), { recursive: true });
  await mkdir(path.join(projectDirectory, "pages"), { recursive: true });
  await writeJson(path.join(projectDirectory, "project.json"), {
    title: "页面渲染测试", canvas: "2:3", default_render_profile: "anima-base-v1",
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
  await writeJson(path.join(projectDirectory, "pages", "page-001.prompt.json"), {
    ...prompt(),
    subject: [{ tag: "1girl" }, { description: "disabled subject", enabled: false }],
    setting: [{ description: "warm sunset light" }],
    avoid: [{ description: "crowded background" }],
  });
  await writeJson(path.join(projectDirectory, "characters", "index.json"), {
    $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["ellen", "guest"],
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.profile.json"), {
    $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "艾莲", description: "短篇故事主角。",
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.visual.json"), {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "银发少女。",
    variants: [{ id: "default", name: "默认", description: "基础形象。" }, { id: "uniform", name: "制服", description: "深色学校制服。" }],
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.prompt.json"), characterPrompt());
  await writeJson(path.join(projectDirectory, "pages", "page-101.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "基础形象", scene_description: "展示艾莲的基础形象。", characters:[{character_id:"ellen",variant_id:"default"}], dialogue:[],
  });
  await writeJson(path.join(projectDirectory, "pages", "page-101.prompt.json"), {
    ...prompt(), subject: [{ tag: "1girl" }], camera: [{ tag: "full_body" }],
  });
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

async function dictionary() {
  return loadPromptDictionaryForRender({}, sourceRepositoryRoot);
}

async function prepareWriteAuditFixture(fixture) {
  await mkdir(path.join(fixture.repositoryRoot, "app"), { recursive: true });
  await cp(
    path.join(sourceRepositoryRoot, "app", "comfyui-endpoints.json"),
    path.join(fixture.repositoryRoot, "app", "comfyui-endpoints.json"),
  );
  for (const directory of ["render-profiles", "prompt-policies", "render-recipes", "workflows"]) {
    await cp(path.join(sourceRepositoryRoot, "library", directory), path.join(fixture.repositoryRoot, "library", directory), { recursive: true });
  }
  const dictionaryRoot = path.join(fixture.repositoryRoot, "library", "prompt-dictionaries");
  await mkdir(dictionaryRoot, { recursive: true });
  await writeFile(path.join(dictionaryRoot, "danbooru.csv"), [
    "1girl", "1boy", "2girls", "solo", "standing", "full_body", "artist_name", "blurry", "jpeg_artifacts", "chromatic_aberration", "watermark",
  ].map((tag) => `${tag},0,10000,`).join("\n") + "\nlow_tag,0,500,\nrare_tag,0,10,\nartist_tag,1,10000,\n");
  await writeFile(path.join(dictionaryRoot, "zh.csv"), "standing,站立\n");
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
  changed.camera = [{ description: "close up" }];
  await writeJson(promptPath, changed);
  const [preview] = await inspectStoryCandidates({ ...options, pageKeys: [key] });
  assert.equal(preview.status, "ready");
  assert.equal(preview.matched, 0);
  assert.deepEqual(new Set(preview.candidate_ids), new Set(task.items.slice(0, 2).map((item) => item.candidate_id)));
  const request = { action: "clean", scope: "mismatch", page_key: key, expected_signature: preview.signature, candidate_ids: preview.candidate_ids };
  await writeJson(promptPath, { ...changed, camera: [{ description: "wide shot" }] });
  await assert.rejects(executeStoryCandidateRefresh(options, request), { code: "candidate_prompt_signature_stale" });
  assert.equal((await readGenerationCandidateRecords(fixture.projectDirectory)).length, 2);
  await writeJson(promptPath, changed);
  await publishCandidateResult(fixture.projectDirectory, task, task.items[2], png);
  assert.deepEqual(await executeStoryCandidateRefresh(options, request), { status: "deleted", count: 2 });
  assert.deepEqual((await readGenerationCandidateRecords(fixture.projectDirectory)).map((item) => item.candidate_id), [task.items[2].candidate_id]);
});

test("剧情补齐使用普通单页任务，执行前跳过活动任务和已经补齐的页面", async (context) => {
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
  assert.equal((await inspectStoryCandidates({ ...options, pageKeys: [key] }))[0].status, "active");
  const unexpectedLaunch = () => assert.fail("已有任务或相符候选时不能重复生成");
  assert.deepEqual(await executeStoryCandidateRefresh(options, value, unexpectedLaunch), { status: "skipped" });
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
  assert.deepEqual(await executeStoryCandidateRefresh(options, cleanAll), { status: "skipped" }, "清理全部仍跳过活动任务页面");
  await updateRenderTask(fixture.projectDirectory, allTask.id, (current) => { current.status = "failed"; current.items.forEach((item) => { item.status = "failed"; }); });
  await writeFile(path.join(fixture.projectDirectory, "pages/page-001.prompt.json"), "{broken");
  const [unavailable] = await inspectStoryCandidates({ ...options, pageKeys: [key] });
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.all_candidate_ids, [task.items[0].candidate_id]);
  assert.deepEqual(await executeStoryCandidateRefresh(options, cleanAll), { status: "deleted", count: 1 }, "无法编译时仍可清理全部，包括原来相符的候选");
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
  const dictionaryEntries = (await loadPromptDictionaryForRender({}, fixture.repositoryRoot)).entries;
  const request = { repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" }, dictionaryEntries };
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

test("两个页面 save 返回与渲染相同的完整审计，错误不撤销保存", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const entries = (await loadPromptDictionaryForRender({}, fixture.repositoryRoot)).entries;
  for (const [pageId, ownerKind, edit, write] of [
    ["page-001", "story", readStoryPromptDraft, saveStoryPromptDraft],
    ["page-101", "character", readCharacterPagePromptDraft, saveCharacterPagePromptDraft],
  ]) {
    const session = await edit(fixture.repositoryRoot, fixture.projectId, pageId);
    const draft = structuredClone(session.document);
    draft.person = [{ tag: "bad_action" }, { tag: "another_bad_action" }, { tag: "disabled_bad", enabled: false }, { tag: "low_tag" }, { tag: "rare_tag" }];
    draft.avoid.push({ description: ownerKind === "story" ? "school uniform" : "ellen identity" });
    session.document = structuredClone(draft);
    const result = await write(fixture.repositoryRoot, session);
    assert.equal(result.audit.status, "complete");
    assert.equal(result.audit.valid, false);
    const badTags = result.audit.errors.filter((item) => item.code === "prompt.danbooru.not_found");
    assert.deepEqual(badTags.map((item) => item.prompt_text), ["bad_action", "another_bad_action"]);
    assert.ok(badTags.every((item) => /^token-[a-f0-9]{12}$/.test(item.token_id)));
    assert.deepEqual(result.audit.warnings, [], "低频和极低频词不应产生警告");
    const conflict = result.audit.errors.find((item) => item.code === "prompt.fragment.positive_avoid_conflict");
    assert.match(conflict.related[0].path, ownerKind === "story" ? /\.variants\.uniform\.prompt\.person\[0\]$/ : /\.variants\.default\.prompt\.subject\[0\]$/);
    assert.equal((await readJson(result.target_file)).person[0].tag, "bad_action");
    const pageKey = { page_id: pageId };
    const inspection = await inspectPageRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey, dictionaryEntries: entries });
    assert.deepEqual(inspection.audit, result.audit);
    assert.equal(inspection.blockers.filter((item) => item.code === "prompt.danbooru.not_found").length, 2);
    assert.deepEqual(inspection.blockers.find((item) => item.code === conflict.code), conflict);
    assert.deepEqual(inspection.warnings, []);
    await assert.rejects(compilePageRenderTarget({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey, dictionaryEntries: entries }), { code: "page_not_renderable" });
  }
});

test("后置审计消费捕获快照，不读后续写入；通过结果也与 render 一致", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const draft = structuredClone(session.document);
  draft.person = [{ tag: "low_tag" }, { tag: "rare_tag" }];
  session.document = structuredClone(draft);
  const result = await saveStoryPromptDraft(fixture.repositoryRoot, session);
  const prepared = await preparePromptWriteAudit(fixture.repositoryRoot);
  const snapshot = await capturePagePromptSnapshot(fixture.projectDirectory, "page-001");
  const render = await compilePageRenderTarget({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: snapshot.page_key, dictionaryEntries: prepared.value.entries });
  assert.deepEqual(result.audit, { status: "complete", ...render.compiled_page.audit, diagnostics: [] });
  assert.equal(result.audit.valid, true);
  assert.deepEqual(result.audit.warnings, []);
  const later = await readJson(result.target_file);
  later.camera.push({ tag: "bad_later_camera" });
  await writeJson(result.target_file, later);
  const capturedResult = await auditSavedPagePrompt(fixture.repositoryRoot, fixture.projectDirectory, prepared, { value: snapshot });
  assert.deepEqual(capturedResult, result.audit);
});

test("词库和有效配置不可用时 write 仍保存，网页不伪造词条错误或审计通过", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const dictionaryEntries = (await loadPromptDictionaryForRender({}, fixture.repositoryRoot)).entries;
  await writeJson(path.join(fixture.repositoryRoot, "Config", "local.json"), { prompt_dictionary: { tags_file: "missing.csv" } });
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const result = await saveStoryPromptDraft(fixture.repositoryRoot, session);
  assert.equal(result.audit.status, "unavailable");
  assert.equal(result.audit.valid, undefined);
  assert.match(result.audit.diagnostics[0].message, /词库缺失/);
  await access(result.target_file);
  const unavailable = await inspectPageRender({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" }, config: { prompt_dictionary: { tags_file: "missing.csv" } } });
  assert.equal(unavailable.audit.status, "unavailable");
  assert.ok(unavailable.blockers.some((item) => item.code === "prompt_audit_unavailable"));
  assert.ok(!unavailable.blockers.some((item) => item.code === "prompt.danbooru.not_found"));
  await writeJson(path.join(fixture.repositoryRoot, "Config", "local.json"), {});
  await writeJson(path.join(fixture.projectDirectory, "project.json"), { title: "测试", canvas: "2:3", default_render_profile: "missing-profile" });
  const secondSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const second = await saveStoryPromptDraft(fixture.repositoryRoot, secondSession);
  assert.equal(second.audit.status, "unavailable");
  const inspection = await compilePageRenderInspectionContext({ repositoryRoot: fixture.repositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" }, dictionaryEntries });
  assert.equal(inspection.audit.status, "unavailable");
});

test("角色 write 独立审计各子设定，保留 ID 并使用统一角色预算", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  const session = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(session.document);
  draft.variants.default.prompt.person = Array.from({ length: 14 }, (_, index) => ({ description: `feature ${index}` }));
  draft.variants.default.prompt.person.push({ tag: "low_tag" }, { tag: "rare_tag" });
  draft.variants.uniform.prompt.person = [{ tag: "bad_variant_tag" }];
  session.document = structuredClone(draft);
  const result = await saveCharacterPromptDraft(fixture.repositoryRoot, session);
  assert.equal(result.audit.status, "complete");
  assert.equal(result.audit.variants.default.valid, true, "未超过统一的18条警告预算");
  assert.equal(result.audit.variants.default.warnings.length, 0);
  assert.equal(result.audit.variants.uniform.valid, false);
  const bad = result.audit.variants.uniform.errors.find((item) => item.prompt_text === "bad_variant_tag");
  assert.equal(bad.path, "characters/ellen.prompt.json.variants.uniform.prompt.person[0]");
  assert.match(bad.token_id, /^token-[a-f0-9]{12}$/);
  assert.ok(!result.audit.variants.default.errors.some((item) => item.prompt_text === "bad_variant_tag"));
  assert.deepEqual((await readJson(result.target_file)).variants.uniform.loras, draft.variants.uniform.loras);
});

test("网页实际路由使用严格审计词库，不受搜索 overlay 损坏影响", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await writeFile(path.join(fixture.repositoryRoot, "library", "prompt-dictionaries", "overlay.json"), "{broken");
  const pagePromptFile = path.join(fixture.projectDirectory, "pages", "page-001.prompt.json");
  const pagePrompt = await readJson(pagePromptFile);
  pagePrompt.person = [{ tag: "low_tag" }, { tag: "rare_tag" }];
  await writeJson(pagePromptFile, pagePrompt);
  const request = Readable.from([Buffer.from(JSON.stringify({ page_key: { page_id: "page-001" } }))]);
  request.method = "POST";
  let inspection;
  assert.equal(await handleWorkbenchRequest({
    request, decodedPath: "/api/projects/demo/workbench/page-render-inspection", projectRoot: fixture.repositoryRoot, config: {},
    readFacts: async (_projectId, operation) => ({ value: await operation({ projectDirectory: fixture.projectDirectory }) }),
    sendOperation: (_status, _result, body) => { inspection = body.inspection; },
  }), true);
  assert.equal(inspection.audit.status, "complete");
  assert.equal(inspection.audit.valid, true);
  assert.deepEqual(inspection.audit.warnings, [], "网页审计与写后审计、渲染共用不按词频警告的规则");
});

test("override 冲突的基础配置预览不得冒充有效配置审计通过", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), {
    version: 1, profiles: { "anima-base-v1": { changes: [{
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

test("三个真实 CLI 在审计有错误时输出可解析 JSON、退出0并清理会话", async (context) => {
  const fixture = await createFixture(context);
  await prepareWriteAuditFixture(fixture);
  await mkdir(path.join(fixture.repositoryRoot, "app", "scripts"), { recursive: true });
  await symlink(path.join(sourceRepositoryRoot, "app", "server"), path.join(fixture.repositoryRoot, "app", "server"), "junction");
  for (const script of ["story-page.mjs", "character-fact.mjs"]) await cp(path.join(sourceRepositoryRoot, "app", "scripts", script), path.join(fixture.repositoryRoot, "app", "scripts", script));
  await serveCliFixture(context, fixture);
  for (const [script, kind, id, edit] of [
    ["story-page.mjs", "prompt", "page-001", readStoryPromptDraft],
    ["character-fact.mjs", "page-prompt", "page-101", readCharacterPagePromptDraft],
    ["character-fact.mjs", "prompt", "ellen", readCharacterPromptDraft],
  ]) {
    const session = await edit(fixture.repositoryRoot, fixture.projectId, id);
    const draft = structuredClone(session.document);
    (draft.variants?.default?.prompt ?? draft).person = [{ tag: "bad_cli_tag" }];
    if (draft.variants) draft.identity.prompt.person = [{ description: "amber eyes" }];
    session.document = structuredClone(draft);
    const draftFile = path.join(fixture.repositoryRoot, "prompt-draft.json");
    await writeJson(draftFile, session);
    const run = () => promisify(execFile)(process.execPath, [path.join(fixture.repositoryRoot, 'app', 'scripts', script), kind, 'save', draftFile]);
    let cliResult;
    try { cliResult = await run(); }
    catch (error) {
      const response = JSON.parse(error.stderr);
      assert.equal(response.error, 'inheritance_confirmation_required');
      session.confirmation_sha256 = response.details[0].confirmation_sha256;
      await writeJson(draftFile, session);
      cliResult = await run();
    }
    const { stdout, stderr } = cliResult;
    const output = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(output.audit.status, "complete");
    assert.equal((output.audit.variants?.default ?? output.audit).valid, false);
    if (draft.variants) assert.deepEqual(output.identity_impact, { per_variant: { default: { lost_inheritance: [], new_inheritance: ["amber eyes"] }, uniform: { lost_inheritance: [], new_inheritance: ["amber eyes"] } } });
    await access(output.target_file);
  }
});

test("story resolver 按6类组合variant完整配置、LoRA、disabled与negative avoid", async (context) => {
  const fixture = await createFixture(context);
  const promptDictionary = await dictionary();
  const resolved = await resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
    dictionaryEntries: promptDictionary.entries,
  });
  assert.equal(resolved.kind, "story");
  assert.equal(resolved.compiled_page.positive_prompt, "masterpiece, best quality, score_7,\n1girl,\nellen_uniform, ellen identity, school uniform,\nwarm sunset light");
  assert.doesNotMatch(resolved.compiled_page.positive_prompt, /disabled subject/);
  assert.match(resolved.compiled_page.negative_prompt, /incorrect identity,\ncrowded background$/);
  assert.deepEqual(resolved.character_references, [{ character_id: "ellen", variant_id: "uniform" }]);
  assert.doesNotMatch(resolved.compiled_page.positive_prompt, /guest/, "画外speaker不注入角色Prompt");
  assert.deepEqual(resolved.compiled_page.loras.map(({ kind, owner, filename, weight }) => ({ kind, owner, filename, weight })), [
    { kind: "character", owner: "ellen", filename: "characters/ellen-uniform.safetensors", weight: 0.8 },
  ]);
  assert.equal(Object.hasOwn(resolved.compiled_page, "resolved_prompt_references"), false);
  for (const part of [...resolved.compiled_page.prompt_parts.positive, ...resolved.compiled_page.prompt_parts.negative]) {
    assert.equal(Object.hasOwn(part, "source"), false);
    assert.equal(Object.hasOwn(part, "source_id"), false);
  }
  assert.ok(resolved.compiled_page.prompt_parts.positive.some((part) => part.path.startsWith("pages/page-001.prompt.json.")));
});

test("character page resolver 仅要求当前 variant 配置完整，并使用规范PageKey", async (context) => {
  const fixture = await createFixture(context);
  const promptTarget = path.join(fixture.projectDirectory, "characters", "ellen.prompt.json");
  const document = await readJson(promptTarget);
  delete document.variants.uniform;
  await writeJson(promptTarget, document);
  const promptDictionary = await dictionary();
  const resolved = await resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-101",
    dictionaryEntries: promptDictionary.entries,
  });
  assert.equal(resolved.canonical_page_key, "v3/page-101");
  assert.match(resolved.compiled_page.positive_prompt, /1girl.*ellen identity.*full_body/s);
  assert.ok(
    resolved.compiled_page.prompt_parts.positive.some((part) => part.path.startsWith("characters/ellen.prompt.json.variants.default.prompt.")),
    "variant_id 直接选择对应配置",
  );
  assert.deepEqual(resolved.compiled_page.loras, []);
  await assert.rejects(resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
    dictionaryEntries: promptDictionary.entries,
  }), (error) => error.code === "page_not_renderable" && error.details.some((detail) => detail.includes("uniform")));
});

test("identity 按分类继承并支持权重调整，同文字来源冲突阻止生成", async (context) => {
  const fixture = await createFixture(context);
  const promptTarget = path.join(fixture.projectDirectory, "characters", "ellen.prompt.json");
  const document = await readJson(promptTarget);
  document.identity.prompt.person = [{ description: "shark tail" }, { description: "amber eyes" }];
  document.identity.prompt.person.push({ description: "upright posture" });
  document.identity.prompt.setting = [{ description: "calm presence" }];
  document.variants.uniform.prompt.person = [
    { description: "school uniform" },
    { description: "shark tail" },
  ];
  document.variants.uniform.identity_disabled = ["amber eyes", "calm presence"];
  document.variants.default.prompt.person = [
    { description: "amber eyes", enabled: false },
    { description: "disabled draft", enabled: false },
  ];
  await writeJson(promptTarget, document);
  const promptDictionary = await dictionary();

  await assert.rejects(() => resolvePageForRender({ repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageId: 'page-001', dictionaryEntries: promptDictionary.entries }), error => error.details.some(message => message.includes('重复词')));
  document.variants.uniform.prompt.person.pop();
  document.variants.uniform.identity_overrides = { 'shark tail': { weight: 1.2 } };
  await writeJson(promptTarget, document);
  const resolved = await resolvePageForRender({ repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageId: 'page-001', dictionaryEntries: promptDictionary.entries });
  assert.match(resolved.compiled_page.positive_prompt, /\(shark tail:1.2\).*school uniform/);
  assert.match(resolved.compiled_page.positive_prompt, /upright posture/, "身份 action 分类参与编译");
  assert.doesNotMatch(resolved.compiled_page.positive_prompt, /amber eyes/, "identity_disabled 排除身份同名片段");
  assert.doesNotMatch(resolved.compiled_page.positive_prompt, /calm presence/, "非外观分类也可按词关闭继承");
  const positiveParts = resolved.compiled_page.prompt_parts.positive;
  assert.deepEqual(
    positiveParts.filter((part) => part.prompt_text === "shark tail").map((part) => part.path),
    ["characters/ellen.prompt.json.identity.prompt.person[0]"],
    "权重调整仍保留基础词的来源路径",
  );
  assert.ok(positiveParts.some((part) => part.prompt_text === "school uniform" && part.path === "characters/ellen.prompt.json.variants.uniform.prompt.person[0]"));

  const baseResolved = await resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-101",
    dictionaryEntries: promptDictionary.entries,
  });
  assert.match(baseResolved.compiled_page.positive_prompt, /shark tail/);
  assert.match(baseResolved.compiled_page.positive_prompt, /amber eyes/, "关闭的同名本地词不冲突，仍使用身份词");
  assert.doesNotMatch(baseResolved.compiled_page.positive_prompt, /disabled draft/, "enabled:false 的自有片段不参与编译");
  const baseParts = baseResolved.compiled_page.prompt_parts.positive;
  assert.ok(baseParts.some((part) => part.prompt_text === "shark tail" && part.path === "characters/ellen.prompt.json.identity.prompt.person[0]"));
  assert.ok(baseParts.some((part) => part.prompt_text === "amber eyes" && part.path === "characters/ellen.prompt.json.identity.prompt.person[1]"));
  assert.ok(baseParts.some((part) => part.prompt_text === "upright posture" && part.path === "characters/ellen.prompt.json.identity.prompt.person[2]"));
  document.variants.default.prompt.person[0].enabled = true;
  await writeJson(promptTarget, document);
  await assert.rejects(resolvePageForRender({ repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageId: 'page-101', dictionaryEntries: promptDictionary.entries }), error => {
    assert.equal(error.details.filter(message => message.includes('重复词')).length, 1, '生效重复只检查一次');
    return true;
  });
});

test("identity.lora 与配置 loras 叠加解析并分别注入 trigger，同 filename 冲突阻止渲染", async (context) => {
  const fixture = await createFixture(context);
  const promptTarget = path.join(fixture.projectDirectory, "characters", "ellen.prompt.json");
  const document = await readJson(promptTarget);
  document.identity.lora = { filename: "characters/ellen.safetensors", sha256: "c".repeat(64), weight: 0.6, trigger: "ellen_joe" };
  await writeJson(promptTarget, document);
  const promptDictionary = await dictionary();

  const resolved = await resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
    dictionaryEntries: promptDictionary.entries,
  });
  assert.deepEqual(resolved.compiled_page.loras.map(({ kind, owner, filename, weight }) => ({ kind, owner, filename, weight })), [
    { kind: "character", owner: "ellen", filename: "characters/ellen.safetensors", weight: 0.6 },
    { kind: "character", owner: "ellen", filename: "characters/ellen-uniform.safetensors", weight: 0.8 },
  ]);
  assert.match(resolved.compiled_page.positive_prompt, /ellen_joe.*ellen_uniform/, "identity.lora 与配置 loras 的 trigger 都注入 positive");

  const baseResolved = await resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-101",
    dictionaryEntries: promptDictionary.entries,
  });
  assert.deepEqual(baseResolved.compiled_page.loras.map(({ filename, weight }) => ({ filename, weight })), [
    { filename: "characters/ellen.safetensors", weight: 0.6 },
  ]);
  assert.match(baseResolved.compiled_page.positive_prompt, /ellen_joe/);
  assert.doesNotMatch(baseResolved.compiled_page.positive_prompt, /ellen_uniform/);

  const conflicted = await readJson(promptTarget);
  conflicted.identity.lora = { filename: "characters/ellen-uniform.safetensors", sha256: "d".repeat(64), weight: 0.5 };
  await writeJson(promptTarget, conflicted);
  await assert.rejects(
    resolvePageForRender({
      repositoryRoot: sourceRepositoryRoot,
      projectDirectory: fixture.projectDirectory,
      pageId: "page-001",
      dictionaryEntries: promptDictionary.entries,
    }),
    (error) => error?.code === "page_not_renderable"
      && error.details?.some((detail) => /ellen-uniform\.safetensors.*配置冲突/.test(detail)),
  );
});

test("流程预览临时编译无ID Prompt草稿，并把本机依赖缺失作为阻断返回", async (context) => {
  const fixture = await createFixture(context);
  const before = await readFile(path.join(fixture.projectDirectory, "pages", "page-001.prompt.json"), "utf8");
  const promptDictionary = await dictionary();
  const draft = prompt(undefined);
  delete draft.$schema;
  draft.subject = [{ tag: "1girl" }];
  draft.person = [{ tag: "standing" }];
  draft.setting = [{ description: "warm sunset light" }];
  draft.camera = [{ tag: "full_body" }];
  const inspection = await inspectPageRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageKey: { page_id: "page-001" },
    pagePromptDraft: draft,
    dictionaryEntries: promptDictionary.entries,
    config: {},
  });

  assert.match(inspection.prompt.positive, /1girl.*ellen_uniform.*ellen identity.*school uniform.*standing/s);
  assert.match(inspection.prompt.positive, /standing,\nwarm sunset light,\nfull_body$/);
  assert.equal(inspection.structured_import.positive, inspection.prompt.positive, "自由模式导入保留实际编译的分段文本");
  assert.equal(inspection.structured_import.negative, inspection.prompt.negative);
  assert.deepEqual(inspection.prompt.parts.by_category.person.map(part => part.prompt_text), ["school uniform", "standing"]);
  assert.deepEqual(inspection.characters.map(({ character_id, variant_id }) => ({ character_id, variant_id })), [
    { character_id: "ellen", variant_id: "uniform" },
  ]);
  assert.deepEqual(inspection.characters[0].loras.map(({ filename, weight }) => ({ filename, weight })), [
    { filename: "characters/ellen-uniform.safetensors", weight: 0.8 },
  ]);
  assert.ok(inspection.characters[0].loras.every((lora) => Object.hasOwn(lora, "diagnosis")), "每个 LoRA 都携带 diagnosis 字段");
  assert.equal(inspection.render.route.operation, "candidates");
  assert.equal(inspection.render.route.input_source, "empty_latent");
  assert.equal(inspection.render.recipe.source_id, inspection.render.route.recipe_source_id);
  assert.equal(inspection.render.workflow.id, inspection.render.route.workflow_id);
  assert.equal(inspection.canvas, "2:3");
  assert.equal(inspection.generation.profile_name, inspection.render.profile.name);
  assert.equal(inspection.generation.canvas, "2:3");
  assert.deepEqual(inspection.generation.parameters.dimensions, { width: 832, height: 1216 });
  assert.deepEqual(inspection.generation.models.map(({ role, filename }) => ({ role, filename })), [
    { role: "dit", filename: "anima-base-v1.0.safetensors" },
    { role: "text_encoder", filename: "qwen_3_06b_base.safetensors" },
    { role: "vae", filename: "qwen_image_vae.safetensors" },
  ]);
  assert.equal(inspection.generation.parameters.clip_skip, undefined, "统一生成详情不公开未实际生效的 CLIP skip");
  assert.equal(inspection.generation.prompt.positive, inspection.prompt.positive);
  assert.equal(inspection.ready, false, "本机未配置 models_root 时仍应返回可读 inspection");
  assert.ok(inspection.blockers.some((item) => item.code === "model_unavailable"));
  const remoteInspection = await inspectPageRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageKey: { page_id: "page-001" },
    pagePromptDraft: draft,
    dictionaryEntries: promptDictionary.entries,
    config: { comfyui_urls: ["http://windows-gpu:8188"] },
  });
  assert.equal(remoteInspection.ready, true, "远程模式应把模型和 LoRA 留给 Windows ComfyUI 在提交时验证");
  assert.equal(remoteInspection.blockers.some((item) => item.code === "model_unavailable" || item.code === "page_lora_unavailable"), false);
  assert.ok(Object.values(remoteInspection.render.profile_inspection.models).every((model) => model.reason === "remote_unverified"));
  assert.ok(remoteInspection.loras.every((lora) => lora.reason === "remote_unverified"));
  const malformedDraft = structuredClone(draft);
  malformedDraft.person = "standing";
  const malformed = await inspectPageRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageKey: { page_id: "page-001" },
    pagePromptDraft: malformedDraft,
    dictionaryEntries: promptDictionary.entries,
    config: {},
  });
  assert.ok(malformed.blockers.some((item) => item.code === "page_prompt_draft_invalid"));
  assert.match(malformed.prompt.positive, /1girl.*ellen identity/s, "无效分类应被临时正规化而不是让预览整体失败");
  assert.equal(await readFile(path.join(fixture.projectDirectory, "pages", "page-001.prompt.json"), "utf8"), before);
});

test("重命名子设定后页面渲染解析使用新 id 编译", async (context) => {
  const fixture = await createFixture(context);
  await renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform", "casual");
  const promptDictionary = await dictionary();
  const resolved = await resolvePageForRender({
    repositoryRoot: sourceRepositoryRoot,
    projectDirectory: fixture.projectDirectory,
    pageId: "page-001",
    dictionaryEntries: promptDictionary.entries,
  });
  assert.deepEqual(resolved.character_references, [{ character_id: "ellen", variant_id: "casual" }]);
  assert.match(resolved.compiled_page.positive_prompt, /1girl.*ellen_uniform.*ellen identity.*school uniform/s);
  assert.ok(
    resolved.compiled_page.prompt_parts.positive.some((part) => part.path.startsWith("characters/ellen.prompt.json.variants.casual.prompt.")),
    "编译路径指向重命名后的配置键",
  );
});

test("稳定页面ID拒绝重复，归属变化不改变生成引用；失效画面引用阻止生成", async context => {
  const fixture = await createFixture(context);
  const indexPath = path.join(fixture.projectDirectory,'pages/index.json');
  const index = await readJson(indexPath);
  index.pages.push({...index.pages[0]});
  await writeJson(indexPath,index);
  const options={repositoryRoot:sourceRepositoryRoot,projectDirectory:fixture.projectDirectory,pageId:'page-001',dictionaryEntries:(await dictionary()).entries};
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
  await assert.rejects(compileAndPersistPageRenderTask(fixture.repositoryRoot,fixture.projectId,'page-101',{count:4,repositoryRoot:sourceRepositoryRoot}),{code:'candidate_count_out_of_range'});
});

test("重启后冻结契约预检失败会归档失败任务并放行后续队列", async (context) => {
  const fixture = await createFixture(context);
  const compiled = await compileAndPersistPageRenderTask(fixture.repositoryRoot, fixture.projectId, "page-001", { repositoryRoot: sourceRepositoryRoot });
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
  const result = await renderPage(
    fixture.repositoryRoot,
    fixture.projectId,
    "page-101",
    { count: 2, repositoryRoot: sourceRepositoryRoot },
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
  const compiled = await compileAndPersistWorkbenchRenderTask(
    fixture.repositoryRoot,
    fixture.projectId,
    { page_key: { page_id: "page-101" }, operation: "candidates", count: 3, seed: 41 },
    { repositoryRoot: sourceRepositoryRoot },
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
      { repositoryRoot: sourceRepositoryRoot },
    ),
    (error) => error?.code === "page_not_found" && error.status === 404,
  );
  await assert.rejects(
    compileAndPersistWorkbenchRenderTask(
      fixture.repositoryRoot,
      fixture.projectId,
      { page_key: { page_id: "page-101" }, operation: "upscale" },
      { repositoryRoot: sourceRepositoryRoot },
    ),
    (error) => error?.code === "invalid_workbench_render_request" && error.status === 400,
  );
});

test("候选删除共享锁且忽略旧选择缓存，同步discarded metadata", async (context) => {
  const fixture = await createFixture(context);
  const rendered = await renderPage(
    fixture.repositoryRoot,
    fixture.projectId,
    "page-101",
    { count: 1, repositoryRoot: sourceRepositoryRoot },
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


test("自由模式保存双份内容并将原文和独立 LoRA 冻结到真实工作流，缺触发词仅警告", async context => {
  const fixture = await createFixture(context);
  const { savePagePrompt } = await import("../server/project-workbench.mjs");
  const { hashCanonicalJson } = await import("../server/workflow-definition.mjs");
  const { validateFrozenRenderTask } = await import("../server/render-task-contract.mjs");
  const dictionarySnapshot = await dictionary();
  const target = path.join(fixture.projectDirectory, "pages/page-001.prompt.json");
  const original = await readJson(target);
  const { $schema, ...fields } = original;
  const baseRequest = { repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" }, dictionaryEntries: dictionarySnapshot.entries };
  const base = (await inspectPageRender({ ...baseRequest, config: {} })).structured_import;
  const free = { base_sha256: base.base_sha256, positive: "三个角色互相搀扶。\n(arbitrary prose:1.2), entirely_unknown_tag", negative: "不要额外的手臂\n自由负向", loras: [{ filename: "custom.safetensors", sha256: "b".repeat(64), weight: 0.65, trigger: "custom_trigger" }] };
  const saved = await savePagePrompt(fixture.repositoryRoot, fixture.projectId, { kind: "story", page_id: "page-001", expected_sha256: hashCanonicalJson(original), expected_context_sha256: await pagePromptContextSha256(fixture.projectDirectory, "story", "page-001"), prompt: { ...fields, mode: "free", free } });
  assert.deepEqual(saved.prompt.free, free);
  assert.deepEqual(saved.prompt.subject.map(({ id, ...fragment }) => fragment), original.subject);
  const request = { repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" }, dictionaryEntries: dictionarySnapshot.entries };
  const compiled = await compilePageRenderTarget(request);
  assert.equal(compiled.compiled_page.positive_prompt, free.positive);
  assert.equal(compiled.compiled_page.negative_prompt, free.negative);
  assert.deepEqual(compiled.page_loras, [{ ...free.loras[0], kind: "free", owner: "page-001" }]);
  assert.deepEqual(compiled.compiled_page.audit.errors, []);
  assert.equal(compiled.compiled_page.audit.warnings[0].code, "free_lora_trigger_missing");
  const taskResult = await compileAndPersistWorkbenchRenderTask(fixture.repositoryRoot, fixture.projectId,
    { page_key: request.pageKey, operation: "candidates", count: 1 }, { repositoryRoot: sourceRepositoryRoot });
  const task = taskResult.task;
  assert.equal(task.items[0].positive_prompt, free.positive);
  assert.deepEqual(task.items[0].loras, compiled.page_loras);
  validateFrozenRenderTask(task, { dictionaryEntries: dictionarySnapshot.entries, dictionaryIdentity: dictionarySnapshot.identity });
  const serialized = JSON.stringify(task.snapshot.execution_units);
  assert.ok(serialized.includes("custom.safetensors"));
  assert.ok(!serialized.includes("ellen-uniform.safetensors"));
  const tampered = structuredClone(task);
  tampered.items[0].positive_prompt = "changed";
  assert.throws(() => validateFrozenRenderTask(tampered, { dictionaryEntries: dictionarySnapshot.entries, dictionaryIdentity: dictionarySnapshot.identity }), /自由 Prompt|变化|不一致/);
  const inspection = await inspectPageRender({ ...request, config: {} });
  assert.equal(inspection.generation.prompt_mode, "free");
  assert.ok(inspection.structured_import.positive.includes("ellen identity"));
  assert.ok(inspection.structured_import.loras.some(lora => lora.filename === "characters/ellen-uniform.safetensors"));
  const switched = await savePagePrompt(fixture.repositoryRoot, fixture.projectId, { kind: "story", page_id: "page-001", expected_sha256: saved.prompt_sha256, expected_context_sha256: await pagePromptContextSha256(fixture.projectDirectory, "story", "page-001"), prompt: { ...saved.prompt, mode: "structured" } });
  assert.deepEqual(switched.prompt.free, free);
  assert.ok((await compilePageRenderTarget(request)).compiled_page.positive_prompt.includes("ellen identity"));
});


test("自定义默认不存重复内容，来源变化阻止生成，确认与重置分别保留或移除覆盖", async context => {
  const fixture = await createFixture(context);
  const { savePagePrompt } = await import("../server/project-workbench.mjs");
  const { hashCanonicalJson } = await import("../server/workflow-definition.mjs");
  const dictionarySnapshot = await dictionary();
  const target = path.join(fixture.projectDirectory, "pages/page-001.prompt.json");
  const request = { repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: { page_id: "page-001" }, dictionaryEntries: dictionarySnapshot.entries };
  const inspect = () => inspectPageRender({ ...request, config: {} });
  let current = await readJson(target);
  async function save(patch) {
    const { $schema, ...prompt } = current;
    await savePagePrompt(fixture.repositoryRoot, fixture.projectId, { kind: "story", page_id: "page-001", expected_sha256: hashCanonicalJson(current), expected_context_sha256: await pagePromptContextSha256(fixture.projectDirectory, "story", "page-001"), prompt: JSON.parse(JSON.stringify({ ...prompt, ...patch })) });
    current = await readJson(target);
  }
  const base = (await inspect()).structured_import;
  await save({ mode: "free" });
  assert.equal(Object.hasOwn(current, "free"), false);
  assert.equal((await compilePageRenderTarget(request)).compiled_page.positive_prompt, base.positive);
  const custom = { positive: "a custom composition", negative: "", loras: [] };
  await assert.rejects(save({ free: custom }), error => JSON.stringify(error.details).includes("base_sha256"));
  await save({ free: { ...custom, base_sha256: base.base_sha256 } });
  assert.equal((await compilePageRenderTarget(request)).compiled_page.positive_prompt, custom.positive);
  const subject = [...current.subject, { description: "beside a quiet river" }];
  await save({ subject });
  await assert.rejects(compilePageRenderTarget(request), error => JSON.stringify(error.details).includes("结构化基础已变化"));
  const changed = (await inspect()).structured_import;
  assert.notEqual(changed.base_sha256, base.base_sha256);
  assert.equal(current.free.positive, custom.positive);
  await save({ mode: "structured" });
  assert.ok((await compilePageRenderTarget(request)).compiled_page.positive_prompt.includes("beside a quiet river"));
  await save({ mode: "free", free: { ...custom, base_sha256: changed.base_sha256 } });
  assert.equal((await compilePageRenderTarget(request)).compiled_page.positive_prompt, custom.positive);
  // 重置已保存的覆盖需要保存删除，模式和结构化编辑均保留。
  await save({ free: undefined });
  assert.equal(current.mode, "free");
  assert.equal(Object.hasOwn(current, "free"), false);
  assert.ok(current.subject.some(fragment => fragment.description === "beside a quiet river"));
  assert.equal((await compilePageRenderTarget(request)).compiled_page.positive_prompt, changed.positive);
});


test("自定义基础指纹只跟随最终文本和 LoRA，不跟随片段来源说明", async () => {
  const { structuredPromptBase } = await import("../server/current-page-prompt.mjs");
  const compiled = { missing: [], errors: [], positive_prompt: "a scene", negative_prompt: "blur", loras: [{ filename: "style.safetensors", sha256: "a".repeat(64), weight: 1 }], prompt_parts: { id: "first" } };
  const profile = { style_loras: { style: { ...compiled.loras[0], trigger: "style_token" } } };
  const base = structuredPromptBase(compiled, profile);
  assert.equal(structuredPromptBase({ ...compiled, prompt_parts: { id: "renamed" } }, profile).base_sha256, base.base_sha256);
  assert.notEqual(structuredPromptBase({ ...compiled, negative_prompt: "noise" }, profile).base_sha256, base.base_sha256);
  assert.notEqual(structuredPromptBase({ ...compiled, loras: [{ ...compiled.loras[0], weight: 0.8 }] }, profile).base_sha256, base.base_sha256);
  assert.notEqual(structuredPromptBase(compiled, { style_loras: { style: { ...profile.style_loras.style, trigger: "new_token" } } }).base_sha256, base.base_sha256);
});


test("编辑上下文展开各层覆盖和关闭项，使用项目有效配置，草稿可保存且拒绝过期依赖", async t => {
  const fixture = await createFixture(t);
  const { readPromptEditContext } = await import("../server/prompt-edit-context.mjs");
  const { readResolvedRenderProfile } = await import("../server/render-profile-compiler.mjs");
  const { readFactDraft, saveFactDraft } = await import("../server/fact-drafts.mjs");
  const characterFile = path.join(fixture.projectDirectory, "characters/ellen.prompt.json");
  const character = await readJson(characterFile);
  character.identity.prompt.person = [{ description: "silver hair", weight: 1.2 }, { description: "blue eyes" }];
  character.variants.uniform.identity_overrides = { "silver hair": { enabled: false, weight: 0.7 }, "blue eyes": { enabled: false } };
  await writeJson(characterFile, character);
  await writeJson(path.join(fixture.projectDirectory, "scenes/index.json"), {$schema:SCENE_INDEX_SCHEMA_ID,scenes:['station']});
  await writeJson(path.join(fixture.projectDirectory, "scenes/station.profile.json"), {$schema:SCENE_PROFILE_SCHEMA_ID,name:'车站',description:''});
  await writeJson(path.join(fixture.projectDirectory, "scenes/station.visual.json"), {$schema:SCENE_VISUAL_SCHEMA_ID,variants:[{id:'default',name:'默认'}]});
  const scenePrompt=prompt(); delete scenePrompt.$schema;
  await writeJson(path.join(fixture.projectDirectory, "scenes/station.prompt.json"), {$schema:SCENE_PROMPT_SCHEMA_ID,identity:{prompt:scenePrompt,lora:null},variants:{default:{prompt:{...scenePrompt,setting:[{description:'quiet station',weight:1.1}]},identity_disabled:[],loras:[]}}});
  const pageFile = path.join(fixture.projectDirectory, "pages/page-001.prompt.json");
  const page = await readJson(pageFile);
  page.scene_id = "station"; page.scene_variant_id = "default";
  page.inheritance = { "character:ellen:uniform": { "silver hair": { enabled: true, weight: 0.9 } }, "scene:station:default": { "quiet station": { enabled: false } } };
  await writeJson(pageFile, page);
  const base = await readResolvedRenderProfile(sourceRepositoryRoot, "anima-base-v1");
  const fragmentId = Object.keys(base.resolved_profile.prompt.fragments)[0];
  const original = base.resolved_profile.prompt.fragments[fragmentId];
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), { version: 1, profiles: { "anima-base-v1": { changes: [{
    target: `prompt.fragments.${fragmentId}`, original: { exists: true, value: original }, project: { exists: true, value: { ...original, prompt_text: "soft watercolor" } },
  }] } } });
  const options = { projectRoot: fixture.repositoryRoot, repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, pageKey: "v3/page-001" };
  const result = await readPromptEditContext(options);
  assert.equal(result.context.status, "complete", "无需本机模型或 ComfyUI 即可完整读取");
  const identity = result.context.inherited.find(group => group.path.endsWith("identity.prompt"));
  assert.deepEqual(identity.fragments[0].fragment, { description: "silver hair", weight: 1.2 });
  assert.deepEqual(identity.fragments[0].after_identity, { weight: 0.7, enabled: false });
  assert.deepEqual(identity.fragments[0].effective, { weight: 0.9, enabled: true });
  assert.deepEqual(identity.fragments[1].effective, { weight: 1, enabled: false });
  const scene = result.context.inherited.find(group => group.source === "scene:station:default" && group.path.includes("variants.default"));
  assert.deepEqual(scene.fragments[0].effective, { weight: 1.1, enabled: false });
  assert.match(result.context.final.positive, /\(silver hair:0\.9\)/);
  assert.doesNotMatch(result.context.final.positive, /blue eyes|quiet station/);
  assert.match(result.context.final.positive, /soft watercolor/);
  assert.equal(result.context.profile.overrides[0].target, `prompt.fragments.${fragmentId}`);
  assert.deepEqual(result.draft, await readFactDraft(fixture.repositoryRoot, { domain: "story", kind: "prompt", projectId: fixture.projectId, targetId: "page-001" }));
  const compiled = await compilePageRenderInspectionContext({ repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: options.pageKey, dictionaryEntries: (await dictionary()).entries });
  assert.equal(result.context.final.positive, compiled.compiled_page.positive_prompt);
  const save = draft => saveFactDraft(fixture.repositoryRoot, { domain: "story", kind: "prompt", projectId: fixture.projectId, targetId: "page-001", document: draft.document, expectedSha256: draft.expected_sha256, expectedContextSha256: draft.expected_context_sha256, conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict" });
  await save(result.draft);
  const fresh = await readPromptEditContext(options);
  character.identity.prompt.person[0].weight = 1.4;
  await writeJson(characterFile, character);
  await assert.rejects(save(fresh.draft), error => error.code === "fact_upstream_conflict");
});

test("编辑上下文覆盖角色页、自定义和两步实际来源，配置缺失明确返回不完整", async t => {
  const fixture = await createFixture(t);
  const { readPromptEditContext } = await import("../server/prompt-edit-context.mjs");
  const { structuredPromptBase } = await import("../server/current-page-prompt.mjs");
  const options = { projectRoot: fixture.repositoryRoot, repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, projectId: fixture.projectId, pageKey: "v3/page-101" };
  const initial = await readPromptEditContext(options);
  assert.deepEqual(initial.save, { domain: "page", kind: "prompt" });
  assert.equal(initial.draft.target_id, "page-101");
  const c = await compilePageRenderInspectionContext({ repositoryRoot: sourceRepositoryRoot, projectDirectory: fixture.projectDirectory, pageKey: options.pageKey, dictionaryEntries: (await dictionary()).entries });
  const page = initial.draft.document;
  page.mode = "free";
  page.free = { ...structuredPromptBase(c.compiled_page, c.active_profile, c.snapshot.characters), positive: "a quiet portrait", negative: "", loras: [] };
  await writeJson(path.join(fixture.projectDirectory, "pages/page-101.prompt.json"), page);
  const free = await readPromptEditContext(options);
  assert.equal(free.context.final.positive, "a quiet portrait");
  assert.equal(free.context.final.mode, "free");
  page.two_step = { enabled: true, strength: 0.5 };
  await writeJson(path.join(fixture.projectDirectory, "pages/page-101.prompt.json"), page);
  const two = await readPromptEditContext(options);
  assert.equal(two.context.final.draft_stage.positive, "a quiet portrait");
  assert.equal(two.context.final.positive, "a quiet portrait");
  assert.equal(two.context.inherited_usage, "structured_base_only");
  page.two_step.draft = { positive: "simple silhouette", base_sha256: two.context.final.draft_base.base_sha256 };
  await writeJson(path.join(fixture.projectDirectory, "pages/page-101.prompt.json"), page);
  const changedStage = await readPromptEditContext(options);
  assert.equal(changedStage.context.final.draft_stage.positive, "simple silhouette");
  assert.equal(changedStage.context.final.positive, "a quiet portrait");
  const { readResolvedRenderProfile } = await import("../server/render-profile-compiler.mjs");
  const base = await readResolvedRenderProfile(sourceRepositoryRoot, "anima-base-v1");
  const fragmentId = Object.keys(base.resolved_profile.prompt.fragments)[0];
  await writeJson(path.join(fixture.projectDirectory, "render-profile.override.json"), { version: 1, profiles: { "anima-base-v1": { changes: [{
    target: `prompt.fragments.${fragmentId}`, original: { exists: false }, project: { exists: true, value: { ...base.resolved_profile.prompt.fragments[fragmentId], prompt_text: "changed style" } },
  }] } } });
  const conflict = await readPromptEditContext(options);
  assert.equal(conflict.context.status, "incomplete");
  assert.equal(conflict.context.final, null, "配置冲突时不能把基础预览冒充实际输出");
  assert.equal(conflict.context.profile.conflicts[0].target, `prompt.fragments.${fragmentId}`);
  await writeJson(path.join(fixture.projectDirectory, "project.json"), { title: "测试", canvas: "2:3", default_render_profile: "missing-profile" });
  const incomplete = await readPromptEditContext(options);
  assert.equal(incomplete.context.status, "incomplete");
  assert.equal(incomplete.context.final, null);
  assert.ok(incomplete.context.diagnostics.some(item => item.code === "prompt_audit_unavailable"));
  assert.equal(incomplete.draft.document.free.positive, "a quiet portrait");
});
