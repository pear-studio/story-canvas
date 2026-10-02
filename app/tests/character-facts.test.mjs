import {writeQwenFixtureJson, qwenDocument} from './helpers/qwen-fixture.mjs';
import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { PAGES_INDEX_SCHEMA_ID, readPageIndex } from "../server/pages-store.mjs";
import { factFixture, fixtureMutation } from "./fact-fixture.mjs";
const { read: readStoryNarrativeDraft, save: saveStoryNarrativeDraft } = factFixture("story", "narrative");
const { read: readStoryPromptDraft, save: saveStoryPromptDraft } = factFixture("story", "prompt");
const { read: readCharacterVisualDraft, save: saveCharacterVisualDraft } = factFixture("character", "visual");
const { read: readCharacterPromptDraft, save: saveCharacterPromptDraft } = factFixture("character", "prompt");
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELETED_CHARACTER_RETENTION_MS,
  cleanupDeletedCharacters,
  createCharacter as createCharacterDirect,
  deleteCharacter as deleteCharacterDirect,
  deleteCharacterVariant as deleteCharacterVariantDirect,
  renameCharacterVariant as renameCharacterVariantDirect
} from "../server/character-facts.mjs";
import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID
} from "../server/character-files.mjs";

import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGES_INDEX_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
} from "../server/story-files.mjs";

async function writeJson(target, value) {
  if (path.basename(path.dirname(target)) === "pages" && path.basename(target) === "index.json" && value.by_sequence) {
    value = { $schema: PAGES_INDEX_SCHEMA_ID, pages: Object.entries(value.by_sequence).flatMap(([sequence_id, ids]) => ids.map(page_id => ({ page_id, owner_kind: "story", sequence_id }))) };
  }
  await writeQwenFixtureJson(target,value);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function exists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

function characterPrompt(characterId) {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    prompt_name: characterId,
    variants: {
      default: { text: `${characterId} 的基础外观描述。`, reference_images: [] },
      ...(characterId === "ellen" ? {
        uniform: { text: "艾莲穿深色学校制服。", reference_images: [] },
      } : {}),
    },
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "character-fact-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
  await writeJson(path.join(projectDirectory,"project.json"),{format:"story-models-v1",title:"测试",canvas:"2:3",default_render_profile:"qwen-image-2-1"});
  const pagesDirectory = path.join(projectDirectory, "pages");
  const charactersDirectory = path.join(projectDirectory, "characters");
  await writeJson(path.join(projectDirectory, "story", "outline.json"), {
    $schema: STORY_OUTLINE_SCHEMA_ID,
    synopsis: "艾莲与路人的短篇。",
    chapters: [{ id: "opening", title: "开场", summary: "相遇。", sequences: [{ id: "arrival", title: "抵达", summary: "艾莲抵达。" }] }],
  });
  await writeJson(path.join(pagesDirectory, "index.json"), {
    $schema: STORY_PAGES_INDEX_SCHEMA_ID,
    by_sequence: { arrival: ["page-001"] },
  });
  await writeJson(path.join(pagesDirectory, "page-001.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "抵达",
    scene_description: "艾莲穿制服抵达。",
    characters: [{ character_id: "ellen", variant_id: "uniform" }],
    dialogue: [{ id: "dialogue-aaaaaaaaaaaa", mode: "speech", speaker: "ellen", text: "我到了。" }],
  });
  await writeJson(path.join(pagesDirectory, "page-001.prompt.json"), {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    text: "艾莲抵达车站。",
  });
  await writeJson(path.join(charactersDirectory, "index.json"), {
    $schema: CHARACTER_INDEX_SCHEMA_ID,
    characters: ["ellen", "guest"],
  });
  for (const characterId of ["ellen", "guest"]) {
    await writeJson(path.join(charactersDirectory, `${characterId}.profile.json`), {
      $schema: CHARACTER_PROFILE_SCHEMA_ID,
      name: characterId,
      description: `${characterId} 的非视觉设定。`,
    });
    await writeJson(path.join(charactersDirectory, `${characterId}.visual.json`), {
      $schema: CHARACTER_VISUAL_SCHEMA_ID,
      variants: characterId === "ellen"
        ? [{ id: "default", name: "默认" }, { id: "uniform", name: "制服" }]
        : [{ id: "default", name: "默认" }],
    });
    await writeJson(path.join(charactersDirectory, `${characterId}.prompt.json`), characterPrompt(characterId));
  }
  registerFixtureProjects(repositoryRoot); return { repositoryRoot, projectId, projectDirectory, pagesDirectory, charactersDirectory };
}

test("Prompt read 修复 variant 结构，保存保留 prompt_name 与自由文本", async (context) => {
  const fixture = await createFixture(context);
  const promptTarget = path.join(fixture.charactersDirectory, "ellen.prompt.json");
  await writeJson(path.join(fixture.charactersDirectory, "ellen.visual.json"), {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    variants: [{ id: "coat", name: "外套" }],
  });

  const session = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(session.document);
  assert.deepEqual(Object.keys(draft.models.qwen.variants), ["coat"]);
  assert.deepEqual(draft.models.qwen.variants.coat, { text: "", reference_images: [] });
  assert.equal(draft.models.qwen.prompt_name, "ellen");
  draft.models.qwen.variants.coat.text = "艾莲穿长外套。";
  session.document = structuredClone(draft);
  await saveCharacterPromptDraft(fixture.repositoryRoot, session);
  const persistedPrompt = await readJson(promptTarget);
  assert.deepEqual(Object.keys(persistedPrompt.models.qwen.variants), ["coat"]);
  assert.equal(persistedPrompt.models.qwen.variants.coat.text, "艾莲穿长外套。");
  assert.equal(persistedPrompt.models.qwen.prompt_name, "ellen");
});

test("Visual save 可移除多余 variant 并返回下游 dangling diagnostics", async (context) => {
  const fixture = await createFixture(context);
  const session = await readCharacterVisualDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(session.document);
  draft.variants = draft.variants.filter((variant) => variant.id === "default");
  session.document = structuredClone(draft);

  const result = await saveCharacterVisualDraft(fixture.repositoryRoot, session);
  assert.deepEqual(result.downstream_diagnostics.map((item) => item.code), [
    "dangling_prompt_variant_reference",
    "dangling_story_variant_reference",
  ]);
  assert.deepEqual((await readJson(result.target_file)).variants.map((variant) => variant.id), ["default"]);
});

test("character create 原子维护index，并与dangling speaker修复共享项目写入边界", async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(
    () => createCharacter(fixture.repositoryRoot, fixture.projectId, "broken", { beforeCommit: () => { throw new Error("stop before index"); } }),
    /stop before index/,
  );
  for (const suffix of ["profile", "visual", "prompt"]) assert.equal(await exists(path.join(fixture.charactersDirectory, `broken.${suffix}.json`)), false);
  assert.deepEqual((await readJson(path.join(fixture.charactersDirectory, "index.json"))).characters, ["ellen", "guest"]);

  const narrativeTarget = path.join(fixture.pagesDirectory, "page-001.content.json");
  const narrative = await readJson(narrativeTarget);
  narrative.dialogue = [{ id: "dialogue-bbbbbbbbbbbb", mode: "speech", speaker: "shop-owner", text: "欢迎。" }];
  await writeJson(narrativeTarget, narrative);
  const narrativeSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  let releaseCreate;
  let createReached;
  const createHeld = new Promise((resolve) => { releaseCreate = resolve; });
  const reachedCreate = new Promise((resolve) => { createReached = resolve; });
  const createPromise = createCharacter(fixture.repositoryRoot, fixture.projectId, "shop-owner", {
    name: "店主",
    beforeCommit: async () => { createReached(); await createHeld; },
  });
  await reachedCreate;
  const pendingSave = assert.rejects(() => saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeSession), error => error?.code === "fact_upstream_conflict");
  releaseCreate();
  await pendingSave;
  const result = await createPromise;
  await assert.rejects(
    () => saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
  assert.equal((await readJson(result.profile_file)).name, "店主");
  assert.deepEqual((await readJson(result.visual_file)).variants.map((variant) => variant.id), ["default"]);
  const createdPrompt = await readJson(result.prompt_file);
  assert.equal(createdPrompt.models.qwen.prompt_name, "店主");
  assert.deepEqual(createdPrompt.models.qwen.variants, { default: { text: "", reference_images: [] } });
  assert.deepEqual((await readJson(result.index_file)).characters, ["ellen", "guest", "shop-owner"]);
});

test("character delete 归档核心事实、记录位置并返回引用诊断", async (context) => {
  const fixture = await createFixture(context);
  const result = await deleteCharacter(fixture.repositoryRoot, fixture.projectId, "ellen");
  assert.deepEqual((await readJson(path.join(fixture.charactersDirectory, "index.json"))).characters, ["guest"]);
  assert.equal(await exists(path.join(result.archive_directory, "characters", "ellen.profile.json")), true);
  assert.deepEqual(result.downstream_diagnostics, [
    { code: "dangling_story_character_reference", page_id: "page-001", character_id: "ellen" },
    { code: "dangling_story_dialogue_speaker", page_id: "page-001", character_id: "ellen" },
  ]);
  const manifestPath = path.join(result.archive_directory, "deletion.json");
  const manifest = await readJson(manifestPath);
  assert.deepEqual({ ordinal: manifest.ordinal, previous: manifest.previous_character_id, next: manifest.next_character_id }, { ordinal: 0, previous: null, next: "guest" });

  const now = Date.now();
  manifest.deleted_at = new Date(now - DELETED_CHARACTER_RETENTION_MS - 1000).toISOString();
  await writeJson(manifestPath, manifest);
  assert.deepEqual(await cleanupDeletedCharacters(fixture.repositoryRoot, { now }), [result.archive_directory]);

  await assert.rejects(
    () => deleteCharacter(fixture.repositoryRoot, fixture.projectId, "guest", {
      beforeCommit: async ({ moved }) => {
        await rm(moved[0].destination);
        const error = new Error("forced index failure");
        error.code = "forced_index_failure";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error?.code, "character_delete_rollback_failed");
      assert.equal(error?.cause?.code, "forced_index_failure");
      assert.equal(error?.rollback_results?.some((item) => item.restored === false), true);
      assert.match(error.details.join("；"), /原始错误.*forced_index_failure.*未恢复/s);
      return true;
    },
  );
});

test("角色设定与 variant 身份写入分别阻止陈旧 story Prompt/narrative 落盘", async (context) => {
  const fixture = await createFixture(context);
  const storyPromptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const characterPromptSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const characterPromptDraft = structuredClone(characterPromptSession.document);
  characterPromptDraft.models.qwen.variants.uniform.text = "艾莲穿更新的制服。";
  characterPromptSession.document = structuredClone(characterPromptDraft);
  let releasePrompt;
  const holdPrompt = new Promise((resolve) => { releasePrompt = resolve; });
  let promptLocked;
  const promptLockReached = new Promise((resolve) => { promptLocked = resolve; });
  const characterPromptWrite = saveCharacterPromptDraft(
    fixture.repositoryRoot,
    characterPromptSession,
    { beforeCommit: async () => { promptLocked(); await holdPrompt; } },
  );
  await promptLockReached;
  {
    const pendingSave = assert.rejects(
      () => saveStoryPromptDraft(fixture.repositoryRoot, storyPromptSession), error => error?.code === "fact_upstream_conflict",
    );
    releasePrompt();
    await pendingSave;
  }
  await characterPromptWrite;
  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, storyPromptSession),
    (error) => error?.code === "fact_upstream_conflict",
  );

  const descriptionPromptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const descriptionVisualSession = await readCharacterVisualDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const descriptionDraft = structuredClone(descriptionVisualSession.document);
  descriptionDraft.variants.find(variant => variant.id === "uniform").name = "更新后的制服";
  descriptionVisualSession.document = structuredClone(descriptionDraft);
  let releaseDescription;
  const holdDescription = new Promise((resolve) => { releaseDescription = resolve; });
  let descriptionLocked;
  const descriptionLockReached = new Promise((resolve) => { descriptionLocked = resolve; });
  const descriptionWrite = saveCharacterVisualDraft(
    fixture.repositoryRoot,
    descriptionVisualSession,
    { beforeCommit: async () => { descriptionLocked(); await holdDescription; } },
  );
  await descriptionLockReached;
  {
    const pendingSave = assert.rejects(
      () => saveStoryPromptDraft(fixture.repositoryRoot, descriptionPromptSession), error => error?.code === "fact_upstream_conflict",
    );
    releaseDescription();
    await pendingSave;
  }
  await descriptionWrite;
  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, descriptionPromptSession),
    (error) => error?.code === "fact_upstream_conflict",
  );

  const narrativeSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const narrativeDraft = structuredClone(narrativeSession.document);
  narrativeDraft.characters = [{ character_id: "guest", variant_id: "default" }];
  narrativeSession.document = structuredClone(narrativeDraft);
  const visualSession = await readCharacterVisualDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const visualDraft = structuredClone(visualSession.document);
  visualDraft.variants = visualDraft.variants.filter((variant) => variant.id === "default");
  visualSession.document = structuredClone(visualDraft);
  let releaseVisual;
  const holdVisual = new Promise((resolve) => { releaseVisual = resolve; });
  let visualLocked;
  const visualLockReached = new Promise((resolve) => { visualLocked = resolve; });
  const visualWrite = saveCharacterVisualDraft(
    fixture.repositoryRoot,
    visualSession,
    { beforeCommit: async () => { visualLocked(); await holdVisual; } },
  );
  await visualLockReached;
  {
    const pendingSave = assert.rejects(
      () => saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeSession), error => error?.code === "fact_upstream_conflict",
    );
    releaseVisual();
    await pendingSave;
  }
  await visualWrite;
  await assert.rejects(
    () => saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
});

test("子设定文字变化使仅引用该造型的旧页面草稿失效", async (context) => {
  const fixture = await createFixture(context);
  await writeJson(path.join(fixture.pagesDirectory, "index.json"), {
    $schema: STORY_PAGES_INDEX_SCHEMA_ID,
    by_sequence: { arrival: ["page-001", "page-002"] },
  });
  await writeJson(path.join(fixture.pagesDirectory, "page-002.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "便装",
    scene_description: "艾莲穿便装出现。",
    characters: [{ character_id: "ellen", variant_id: "default" }],
    dialogue: [],
  });
  await writeJson(path.join(fixture.pagesDirectory, "page-002.prompt.json"), {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    text: "艾莲穿便装。",
  });

  const storyPromptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-002");
  const characterPromptSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const characterPromptDraft = structuredClone(characterPromptSession.document);
  characterPromptDraft.models.qwen.variants.default.text = "艾莲的新基础形象。";
  characterPromptSession.document = structuredClone(characterPromptDraft);
  let releasePrompt;
  const holdPrompt = new Promise((resolve) => { releasePrompt = resolve; });
  let promptLocked;
  const promptLockReached = new Promise((resolve) => { promptLocked = resolve; });
  const characterPromptWrite = saveCharacterPromptDraft(
    fixture.repositoryRoot,
    characterPromptSession,
    { beforeCommit: async () => { promptLocked(); await holdPrompt; } },
  );
  await promptLockReached;
  const pendingSave = assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, storyPromptSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
  releasePrompt();
  await pendingSave;
  await characterPromptWrite;
  assert.equal(
    (await readJson(path.join(fixture.charactersDirectory, "ellen.prompt.json"))).models.qwen.variants.default.text,
    "艾莲的新基础形象。",
  );
  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, storyPromptSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
});

test("禁止删除最后一个子设定，未被引用的多余子设定可删除", async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(
    () => deleteCharacterVariant(fixture.repositoryRoot, fixture.projectId, "guest", "default"),
    (error) => error?.code === "character_last_variant",
    "唯一子设定不可删除",
  );
  // ellen 的 default 未被任何页面引用，且仍有 uniform 剩余，可以删除。
  const result = await deleteCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "default");
  assert.equal(result.prompt_cleaned, true);
  assert.deepEqual(
    (await readJson(path.join(fixture.charactersDirectory, "ellen.visual.json"))).variants.map((variant) => variant.id),
    ["uniform"],
  );
  assert.deepEqual(
    Object.keys((await readJson(path.join(fixture.charactersDirectory, "ellen.prompt.json"))).models.qwen.variants),
    ["uniform"],
  );
  // 剩余 uniform 被 page-001 引用，不可删除。
  await assert.rejects(
    () => deleteCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform"),
    (error) => error?.code === "character_variant_still_in_use",
  );
});

test("重命名子设定联动更新 visual、prompt 与全部引用，键序与位置不变", async (context) => {
  const fixture = await createFixture(context);
  // page-002 同时引用 uniform，验证多页面引用一起改写。
  await writeJson(path.join(fixture.pagesDirectory, "index.json"), {
    $schema: STORY_PAGES_INDEX_SCHEMA_ID,
    by_sequence: { arrival: ["page-001", "page-002"] },
  });
  await writeJson(path.join(fixture.pagesDirectory, "page-002.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "再登场",
    scene_description: "艾莲再次穿制服出现。",
    characters: [{ character_id: "ellen", variant_id: "uniform" }],
    dialogue: [],
  });
  await writeJson(path.join(fixture.pagesDirectory, "page-002.prompt.json"), {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    text: "艾莲再次登场。",
  });

  const result = await renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform", "casual");
  assert.deepEqual({ character_id: result.character_id, old_id: result.old_id, new_id: result.new_id }, {
    character_id: "ellen", old_id: "uniform", new_id: "casual",
  });
  assert.deepEqual(result.updated_page_ids, ["page-001", "page-002"]);
  assert.deepEqual(result.visual.variants.map((variant) => variant.id), ["default", "casual"], "visual 条目位置不变");
  assert.equal(result.visual.variants[1].name, "制服");
  assert.deepEqual(Object.keys(result.prompt.models.qwen.variants), ["default", "casual"], "prompt 键序不变");
  assert.equal(result.prompt.models.qwen.variants.casual.text, "艾莲穿深色学校制服。", "配置内容随键一起改名");
  for (const pageId of ["page-001", "page-002"]) {
    const narrative = await readJson(path.join(fixture.pagesDirectory, `${pageId}.content.json`));
    assert.deepEqual(narrative.characters, [{ character_id: "ellen", variant_id: "casual" }]);
  }

  await assert.rejects(
    () => renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "default", "casual"),
    (error) => error?.code === "character_variant_already_exists",
    "新 id 与现有子设定冲突",
  );
  await assert.rejects(
    () => renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "default", "main"),
    (error) => error?.code === "invalid_character_variant_id",
    "main 仍然是禁止 id",
  );
  await assert.rejects(
    () => renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "default", "Invalid ID"),
    (error) => error?.code === "invalid_character_variant_id",
    "非法 id 报错",
  );
  await assert.rejects(
    () => renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "missing", "other"),
    (error) => error?.code === "character_variant_not_found",
    "oldId 不存在报错",
  );
  await assert.rejects(
    () => renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "default", "default"),
    (error) => error?.code === "invalid_character_variant_id",
    "新旧 id 相同报错",
  );
});

const createCharacter = fixtureMutation(createCharacterDirect);
const deleteCharacter = fixtureMutation(deleteCharacterDirect);
const deleteCharacterVariant = fixtureMutation(deleteCharacterVariantDirect);
const renameCharacterVariant = fixtureMutation(renameCharacterVariantDirect);

for (const [text, withReferences] of [["本页覆盖", true], ["", true], ["", false]]) {
test(`子设定重命名同时更新跨归属画面引用、页面归属和覆盖键：${JSON.stringify({ text, withReferences })}`, async context => {
  const fixture = await createFixture(context);
  const index = await readPageIndex(fixture.projectDirectory);
  index.pages[0] = { page_id: "page-001", owner_kind: "scene", scene_id: "station", variant_id: "night" };
  index.pages.push({ page_id: "page-002", owner_kind: "character", character_id: "ellen", variant_id: "uniform" });
  await writeJson(path.join(fixture.pagesDirectory, "index.json"), index);
  const source = await readJson(path.join(fixture.pagesDirectory, "page-001.content.json"));
  await writeJson(path.join(fixture.pagesDirectory, "page-002.content.json"), { ...source, characters: [], dialogue: [] });
  await writeJson(path.join(fixture.pagesDirectory, "page-002.prompt.json"), { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, text: "" });
  const prompt = await readJson(path.join(fixture.pagesDirectory, "page-001.prompt.json"));
  prompt.models.qwen.text_overrides = { "character:ellen:uniform": text };
  if (withReferences) prompt.models.qwen.reference_overrides = { "character:ellen:uniform": [] };
  else delete prompt.reference_overrides;
  await writeJson(path.join(fixture.pagesDirectory, "page-001.prompt.json"), prompt);
  const result = await renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform", "casual");
  assert.deepEqual(result.updated_page_ids, ["page-001", "page-002"]);
  const nextIndex = await readPageIndex(fixture.projectDirectory);
  assert.equal(nextIndex.pages[0].variant_id, "night");
  assert.equal(nextIndex.pages[1].variant_id, "casual");
  assert.equal((await readJson(path.join(fixture.pagesDirectory, "page-001.content.json"))).characters[0].variant_id, "casual");
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "page-002.content.json"))).characters, []);
  const renamed = await readJson(path.join(fixture.pagesDirectory, "page-001.prompt.json"));
  assert.deepEqual(renamed.models.qwen.text_overrides, { "character:ellen:casual": text });
  assert.deepEqual(renamed.models.qwen.reference_overrides, withReferences ? { "character:ellen:casual": [] } : undefined);
});
}
