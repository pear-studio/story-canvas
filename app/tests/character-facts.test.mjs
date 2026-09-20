import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { PAGES_INDEX_SCHEMA_ID, readPageIndex } from "../server/pages-store.mjs";
import { factFixture, fixtureMutation } from "./fact-fixture.mjs";
const { read: readStoryNarrativeDraft, save: saveStoryNarrativeDraft } = factFixture("story", "narrative");
const { read: readStoryPromptDraft, save: saveStoryPromptDraft } = factFixture("story", "prompt");
const { read: readCharacterVisualDraft, save: saveCharacterVisualDraft } = factFixture("character", "visual");
const { read: readCharacterPromptDraft, saveConfirmed: saveCharacterPromptDraft } = factFixture("character", "prompt");
const { read: readCharacterLoraDraft, save: saveCharacterLoraDraft } = factFixture("character", "lora");
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
  CHARACTER_LORA_SCHEMA_ID,
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

async function writeJson(target, value) {
  if (path.basename(path.dirname(target)) === "pages" && path.basename(target) === "index.json" && value.by_sequence) {
    value = { $schema: PAGES_INDEX_SCHEMA_ID, pages: Object.entries(value.by_sequence).flatMap(([sequence_id, ids]) => ids.map(page_id => ({ page_id, owner_kind: "story", sequence_id }))) };
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function exists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

function emptyPrompt() {
  return Object.fromEntries(storyPromptCategories.map((category) => [category, []]));
}

function characterPrompt(characterId) {
  const prompt = emptyPrompt();
  // 片段带稳定 id:写入不会再分配新 id,上游指纹变化只能来自真实内容变化。
  prompt.subject.push({ tag: characterId, id: `token-${characterId === "ellen" ? "aa0000000001" : "bb0000000001"}` });
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: emptyPrompt(), lora: null },
    variants: {
      default: { prompt, loras: [], identity_disabled: [] },
      ...(characterId === "ellen" ? {
        uniform: { prompt: { ...emptyPrompt(), person: [{ description: "school uniform", id: "token-aa0000000002" }] }, loras: [], identity_disabled: [] },
      } : {}),
    },
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "character-fact-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
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
    ...emptyPrompt(),
    subject: [{ tag: "1girl", character_id: "ellen" }],
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
      description: `${characterId} 的基础外观。`,
      variants: characterId === "ellen"
        ? [{ id: "default", name: "默认", description: "基础外观。" }, { id: "uniform", name: "制服", description: "穿制服。" }]
        : [{ id: "default", name: "默认", description: "基础外观。" }],
    });
    await writeJson(path.join(charactersDirectory, `${characterId}.prompt.json`), characterPrompt(characterId));
  }
  registerFixtureProjects(repositoryRoot); return { repositoryRoot, projectId, projectDirectory, pagesDirectory, charactersDirectory };
}

test("Prompt read 修复 variant 结构但仍拒绝存续 identity 的 LoRA 变化", async (context) => {
  const fixture = await createFixture(context);
  const promptTarget = path.join(fixture.charactersDirectory, "ellen.prompt.json");
  const originalPrompt = await readJson(promptTarget);
  originalPrompt.identity.lora = { filename: "characters/ellen.safetensors", sha256: "a".repeat(64), weight: 0.8 };
  originalPrompt.variants.uniform.loras = [{ filename: "characters/uniform.safetensors", sha256: "b".repeat(64), weight: 0.7 }];
  await writeJson(promptTarget, originalPrompt);
  await writeJson(path.join(fixture.charactersDirectory, "ellen.visual.json"), {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "ellen 的基础外观。",
    variants: [{ id: "coat", name: "外套", description: "穿外套。" }],
  });

  const session = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(session.document);
  assert.deepEqual(Object.keys(draft.variants), ["coat"]);
  assert.deepEqual(draft.identity.lora, originalPrompt.identity.lora);
  assert.deepEqual(draft.variants.coat.loras, []);
  draft.variants.coat.prompt.setting.push({ description: "gentle mood" });
  session.document = structuredClone(draft);
  await saveCharacterPromptDraft(fixture.repositoryRoot, session);
  const persistedPrompt = await readJson(promptTarget);
  assert.deepEqual(Object.keys(persistedPrompt.variants), ["coat"]);
  assert.match(persistedPrompt.variants.coat.prompt.setting.at(-1).id, /^token-[a-f0-9]{12}$/);

  const invalidSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const invalidDraft = structuredClone(invalidSession.document);
  invalidDraft.identity.lora.weight = 0.9;
  invalidSession.document = structuredClone(invalidDraft);
  await assert.rejects(
    () => saveCharacterPromptDraft(fixture.repositoryRoot, invalidSession),
    (error) => error?.code === "character_prompt_lora_change_forbidden",
  );
  assert.equal((await readJson(promptTarget)).identity.lora.weight, 0.8);
});

test("独立 LoRA save 全量替换配置且无法携带 Prompt", async (context) => {
  const fixture = await createFixture(context);
  const session = await readCharacterLoraDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(session.document);
  assert.equal(draft.$schema, CHARACTER_LORA_SCHEMA_ID);
  assert.equal(Object.hasOwn(draft, "prompt"), false);
  assert.equal(draft.identity, null);
  assert.ok(Array.isArray(draft.variants.default) && Array.isArray(draft.variants.uniform), "每个配置投影为 loras 数组");
  draft.identity = { filename: "characters/ellen.safetensors", sha256: "a".repeat(64), weight: 0.8, trigger: "ellen" };
  draft.variants.uniform = [{ filename: "characters/ellen-uniform.safetensors", sha256: "b".repeat(64), weight: 0.7 }];
  session.document = structuredClone(draft);

  const result = await saveCharacterLoraDraft(fixture.repositoryRoot, session);
  const persisted = await readJson(result.target_file);
  assert.deepEqual(persisted.identity.lora, draft.identity);
  assert.deepEqual(persisted.variants.default.loras, []);
  assert.deepEqual(persisted.variants.uniform.loras, draft.variants.uniform);
  assert.deepEqual(persisted.variants.uniform.prompt.person, [{ description: "school uniform", id: "token-aa0000000002" }]);

  const invalidSession = await readCharacterLoraDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const invalid = structuredClone(invalidSession.document);
  invalid.prompt = emptyPrompt();
  invalidSession.document = structuredClone(invalid);
  await assert.rejects(
    () => saveCharacterLoraDraft(fixture.repositoryRoot, invalidSession),
    (error) => error?.code === "invalid_character_edit_document",
  );

  const visual = await readJson(path.join(fixture.charactersDirectory, "ellen.visual.json"));
  visual.variants.push({ id: "coat", name: "外套", description: "穿外套。" });
  await writeJson(path.join(fixture.charactersDirectory, "ellen.visual.json"), visual);
  await assert.rejects(
    () => readCharacterLoraDraft(fixture.repositoryRoot, fixture.projectId, "ellen"),
    (error) => error?.code === "character_lora_requires_prompt_repair",
  );
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
  assert.deepEqual(createdPrompt.identity, { prompt: emptyPrompt(), lora: null });
  assert.deepEqual(Object.keys(createdPrompt.variants), ["default"]);
  assert.deepEqual(createdPrompt.variants.default.loras, []);
  assert.deepEqual(createdPrompt.variants.default.identity_disabled, []);
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

test("角色配置与 variant 身份写入分别阻止陈旧 story Prompt/narrative 落盘", async (context) => {
  const fixture = await createFixture(context);
  const storyPromptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const characterPromptSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const characterPromptDraft = structuredClone(characterPromptSession.document);
  characterPromptDraft.variants.uniform.prompt.setting.push({ description: "warm mood" });
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

test("identity 删除的键对所有造型报告 lost_inheritance，无 diff 时报告为 null", async (context) => {
  const fixture = await createFixture(context);
  const promptTarget = path.join(fixture.charactersDirectory, "ellen.prompt.json");
  const original = await readJson(promptTarget);
  original.identity.prompt.person = [{ description: "amber eyes", id: "token-aa0000000003" }];
  await writeJson(promptTarget, original);

  // 删除涉及继承词时先要求确认，不写入任何文件。
  const blockedSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const blockedDraft = structuredClone(blockedSession.document);
  blockedDraft.identity.prompt.person = [];
  blockedDraft.variants.uniform.identity_disabled = ["amber eyes"];
  blockedSession.document = structuredClone(blockedDraft);
  await assert.rejects(
    () => factFixture("character", "prompt").save(fixture.repositoryRoot, blockedSession),
    (error) => error?.code === "inheritance_confirmation_required",
  );

  const session = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(session.document);
  draft.identity.prompt.person = [];
  session.document = structuredClone(draft);
  const result = await saveCharacterPromptDraft(fixture.repositoryRoot, session);
  assert.deepEqual(result.identity_impact, {
    per_variant: {
      default: { lost_inheritance: ["amber eyes"], new_inheritance: [] },
      uniform: { lost_inheritance: ["amber eyes"], new_inheritance: [] },
    },
  }, "能落盘的删除必然没有 identity_disabled 引用，对所有造型报告 lost_inheritance");

  const unchangedSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const unchangedDraft = structuredClone(unchangedSession.document);
  unchangedDraft.variants.default.prompt.setting.push({ description: "quiet mood" });
  unchangedSession.document = structuredClone(unchangedDraft);
  const unchanged = await saveCharacterPromptDraft(fixture.repositoryRoot, unchangedSession);
  assert.equal(unchanged.identity_impact, null, "identity.prompt 无 diff 时无影响报告");
});

test("identity 变化视为所有配置变化，使仅引用 base 配置的旧页面草稿失效", async (context) => {
  const fixture = await createFixture(context);
  // page-002 引用 default 造型；identity 之外的配置不变也必须被锁定。
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
    ...emptyPrompt(),
    subject: [{ tag: "1girl", character_id: "ellen" }],
  });

  const storyPromptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-002");
  const characterPromptSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const characterPromptDraft = structuredClone(characterPromptSession.document);
  characterPromptDraft.identity.prompt.person.push({ description: "upright posture" });
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
  const promptResult = await characterPromptWrite;
  assert.deepEqual(promptResult.identity_impact, {
    per_variant: {
      default: { lost_inheritance: [], new_inheritance: ["upright posture"] },
      uniform: { lost_inheritance: [], new_inheritance: ["upright posture"] },
    },
  });
  assert.deepEqual(
    (await readJson(path.join(fixture.charactersDirectory, "ellen.prompt.json"))).identity.prompt.person.map((fragment) => fragment.description),
    ["upright posture"],
  );
  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, storyPromptSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
});

test("identity.lora 变化同样使在途页面 Prompt 会话上游冲突", async (context) => {
  const fixture = await createFixture(context);
  const storyPromptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const loraSession = await readCharacterLoraDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const draft = structuredClone(loraSession.document);
  draft.identity = { filename: "characters/ellen.safetensors", sha256: "a".repeat(64), weight: 0.8, trigger: "ellen" };
  loraSession.document = structuredClone(draft);
  await saveCharacterLoraDraft(fixture.repositoryRoot, loraSession);
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
    Object.keys((await readJson(path.join(fixture.charactersDirectory, "ellen.prompt.json"))).variants),
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
    ...emptyPrompt(),
    subject: [{ tag: "1girl", character_id: "ellen" }],
  });

  const result = await renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform", "casual");
  assert.deepEqual({ character_id: result.character_id, old_id: result.old_id, new_id: result.new_id }, {
    character_id: "ellen", old_id: "uniform", new_id: "casual",
  });
  assert.deepEqual(result.updated_page_ids, ["page-001", "page-002"]);
  assert.deepEqual(result.visual.variants.map((variant) => variant.id), ["default", "casual"], "visual 条目位置不变");
  assert.equal(result.visual.variants[1].name, "制服");
  assert.deepEqual(Object.keys(result.prompt.variants), ["default", "casual"], "prompt 键序不变");
  assert.deepEqual(
    result.prompt.variants.casual.prompt.person,
    [{ description: "school uniform", id: "token-aa0000000002" }],
    "配置内容随键一起改名",
  );
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


test("子设定重命名同时更新跨归属画面引用、页面归属和继承调整", async context => {
  const fixture = await createFixture(context);
  const index = await readPageIndex(fixture.projectDirectory);
  index.pages[0] = { page_id: "page-001", owner_kind: "scene", scene_id: "station", variant_id: "night" };
  index.pages.push({ page_id: "page-002", owner_kind: "character", character_id: "ellen", variant_id: "uniform" });
  await writeJson(path.join(fixture.pagesDirectory, "index.json"), index);
  const source = await readJson(path.join(fixture.pagesDirectory, "page-001.content.json"));
  await writeJson(path.join(fixture.pagesDirectory, "page-002.content.json"), { ...source, characters: [], dialogue: [] });
  await writeJson(path.join(fixture.pagesDirectory, "page-002.prompt.json"), { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, ...emptyPrompt() });
  const prompt = await readJson(path.join(fixture.pagesDirectory, "page-001.prompt.json"));
  prompt.inheritance = { "character:ellen:uniform": { "person|school uniform": { weight: 0.5 } } };
  await writeJson(path.join(fixture.pagesDirectory, "page-001.prompt.json"), prompt);
  const result = await renameCharacterVariant(fixture.repositoryRoot, fixture.projectId, "ellen", "uniform", "casual");
  assert.deepEqual(result.updated_page_ids, ["page-001", "page-002"]);
  const nextIndex = await readPageIndex(fixture.projectDirectory);
  assert.equal(nextIndex.pages[0].variant_id, "night");
  assert.equal(nextIndex.pages[1].variant_id, "casual");
  assert.equal((await readJson(path.join(fixture.pagesDirectory, "page-001.content.json"))).characters[0].variant_id, "casual");
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "page-002.content.json"))).characters, []);
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "page-001.prompt.json"))).inheritance, {
    "character:ellen:casual": { "person|school uniform": { weight: 0.5 } },
  });
});
