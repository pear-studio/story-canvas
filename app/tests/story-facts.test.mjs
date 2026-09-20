import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { defaultSceneFacts, SCENE_INDEX_SCHEMA_ID } from "../server/scene-files.mjs";
import { PAGES_INDEX_SCHEMA_ID, storyPagesIndexProjection, readPageIndex } from "../server/pages-store.mjs";
import { factFixture, fixtureMutation } from "./fact-fixture.mjs";
import { readStoryContext } from "../server/story-facts.mjs";
const { read: readStoryOutlineDraft, save: saveStoryOutlineDraft } = factFixture("story", "outline");
const { read: readStoryPagesIndexDraft, save: saveStoryPagesIndexDraft } = factFixture("story", "index");
const { read: readStoryNarrativeDraft, save: saveStoryNarrativeDraft } = factFixture("story", "narrative");
const { read: readStoryPromptDraft, save: saveStoryPromptDraft } = factFixture("story", "prompt");
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELETED_STORY_PAGE_RETENTION_MS,
  STORY_LOCK_MALFORMED_GRACE_MS,
  cleanupDeletedStoryPages,





  createStoryPage as createStoryPageDirect,



  deleteStoryPage as deleteStoryPageDirect,
  factStorage
} from "../server/story-facts.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGES_INDEX_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  storyPromptCategories
} from "../server/story-files.mjs";
import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID
} from "../server/character-files.mjs";
import { LETTERING_SCHEMA_ID } from "../server/lettering-document.mjs";

async function writeJson(target, value) {
  if (path.basename(path.dirname(target)) === "pages" && path.basename(target) === "index.json" && value.by_sequence) {
    value = { $schema: PAGES_INDEX_SCHEMA_ID, pages: Object.entries(value.by_sequence).flatMap(([sequence_id, ids]) => ids.map(page_id => ({ page_id, owner_kind: "story", sequence_id }))) };
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  const value = JSON.parse(await readFile(target, "utf8"));
  return value.$schema === PAGES_INDEX_SCHEMA_ID ? storyPagesIndexProjection(value) : value;
}

async function exists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

function pagePrompt(characterId = null) {
  return { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, subject: [{ tag: "1girl", ...(characterId ? { character_id: characterId } : {}) }], person: [],  setting: [], camera: [], avoid: [] };
}

function characterPrompt() {
  const prompt = { subject: [], person: [],  setting: [], camera: [], avoid: [] };
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: structuredClone(prompt), lora: null },
    variants: {
      default: { prompt, loras: [], identity_disabled: [] },
      uniform: { prompt: structuredClone(prompt), loras: [], identity_disabled: [] },
    },
  };
}

function narrative(title, characterId, variantId) {
  return {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title,
    scene_description: `${title}的画面目标。`,
    characters: [{ character_id: characterId, ...(variantId ? { variant_id: variantId } : {}) }],
    dialogue: [],
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "story-fact-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
  const pagesDirectory = path.join(projectDirectory, "pages");
  await mkdir(pagesDirectory, { recursive: true });
  await writeJson(path.join(projectDirectory, "story", "outline.json"), {
    $schema: STORY_OUTLINE_SCHEMA_ID,
    synopsis: "两个互不相关的叙事段。",
    chapters: [{
      id: "opening", title: "开场", summary: "建立两条线索。",
      sequences: [
        { id: "arrival", title: "抵达", summary: "艾莲抵达。" },
        { id: "waiting", title: "等待", summary: "路人等待。" },
      ],
    }],
  });
  await writeJson(path.join(pagesDirectory, "index.json"), {
    $schema: STORY_PAGES_INDEX_SCHEMA_ID,
    by_sequence: { arrival: ["page-001"], waiting: ["page-002"] },
  });
  await writeJson(path.join(pagesDirectory, "page-001.content.json"), narrative("抵达", "ellen", "uniform"));
  await writeJson(path.join(pagesDirectory, "page-001.prompt.json"), pagePrompt("ellen"));
  await writeJson(path.join(pagesDirectory, "page-002.content.json"), narrative("等待", "guest", "default"));
  await writeJson(path.join(pagesDirectory, "page-002.prompt.json"), pagePrompt("guest"));
  await writeJson(path.join(projectDirectory, "characters", "index.json"), {
    $schema: CHARACTER_INDEX_SCHEMA_ID,
    characters: ["ellen", "guest"],
  });
  for (const characterId of ["ellen", "guest"]) {
    await writeJson(path.join(projectDirectory, "characters", `${characterId}.profile.json`), {
      $schema: CHARACTER_PROFILE_SCHEMA_ID, name: characterId, description: `${characterId} 的非视觉设定。`,
    });
    await writeJson(path.join(projectDirectory, "characters", `${characterId}.visual.json`), {
      $schema: CHARACTER_VISUAL_SCHEMA_ID, description: `${characterId} 的基础外观。`,
      variants: characterId === "ellen"
        ? [{ id: "default", name: "默认", description: "基础外观。" }, { id: "uniform", name: "制服", description: "穿制服。" }]
        : [{ id: "default", name: "默认", description: "基础外观。" }],
    });
    await writeJson(path.join(projectDirectory, "characters", `${characterId}.prompt.json`), characterPrompt());
  }
  registerFixtureProjects(repositoryRoot); return { repositoryRoot, projectDirectory, pagesDirectory, projectId };
}

test("outline 按逻辑目标读写，局部更新不覆盖其他单元，移动归属使旧草稿失效", async context => {
  const fixture = await createFixture(context);
  const root = fixture.repositoryRoot;
  const id = fixture.projectId;
  const whole = factFixture("story", "outline");
  const sequence = factFixture("story", "sequence");
  const chapter = factFixture("story", "chapter");
  const synopsis = factFixture("story", "synopsis");
  const original = await whole.read(root, id);
  const arrival = await sequence.read(root, id, "arrival");
  const waiting = await sequence.read(root, id, "waiting");
  assert.deepEqual(arrival.document, { title: "抵达", summary: "艾莲抵达。" });
  waiting.document.summary = "路人在门口等待。";
  await sequence.save(root, waiting);
  arrival.document.title = "来到门口";
  await sequence.save(root, arrival);
  await assert.rejects(whole.save(root, original), { code: "fact_target_conflict" });
  const chapterDraft = await chapter.read(root, id, "opening");
  assert.deepEqual(Object.keys(chapterDraft.document).sort(), ["summary", "title"]);
  chapterDraft.document.summary = "门口相遇。";
  await chapter.save(root, chapterDraft);
  const synopsisDraft = await synopsis.read(root, id);
  synopsisDraft.document.synopsis = "一次简短相遇。";
  await synopsis.save(root, synopsisDraft);
  const contextView = await readStoryContext(root, id, "arrival");
  assert.equal(contextView.synopsis, "一次简短相遇。");
  assert.equal(contextView.chapter.summary, "门口相遇。");
  assert.deepEqual(contextView.chapter.sequences.map(item => [item.id, item.title, item.summary]), [
    ["arrival", "来到门口", "艾莲抵达。"], ["waiting", "等待", "路人在门口等待。"],
  ]);
  const pending = await sequence.read(root, id, "arrival");
  const moved = await whole.read(root, id);
  const [arrivalNode] = moved.document.chapters[0].sequences.splice(0, 1);
  moved.document.chapters.push({ id: "next", title: "下一章", summary: "继续。", sequences: [arrivalNode] });
  await whole.save(root, moved);
  await assert.rejects(sequence.save(root, pending), { code: "fact_upstream_conflict" });
  const fresh = await whole.read(root, id);
  assert.equal(fresh.document.chapters[0].sequences[0].summary, "路人在门口等待。");
  assert.equal(fresh.document.chapters[1].sequences[0].title, "来到门口");
});

test("读取不存在的页面返回 story_page_not_found，格式非法仍返回 invalid_story_page_id", async (context) => {
  const fixture = await createFixture(context);
  const root = fixture.repositoryRoot;
  const id = fixture.projectId;
  await assert.rejects(readStoryNarrativeDraft(root, id, "page-ffffffffffff"), { code: "story_page_not_found", status: 422 });
  await assert.rejects(readStoryPromptDraft(root, id, "page-ffffffffffff"), { code: "story_page_not_found", status: 422 });
  await assert.rejects(readStoryNarrativeDraft(root, id, "page-ZZZ"), { code: "invalid_story_page_id", status: 422 });
});

test("narrative save 接受画外speaker、生成 ID，保留缺失speaker以便修复", async (context) => {
  const fixture = await createFixture(context);
  const session = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const draft = structuredClone(session.document);
  draft.title = "抵达门口";
  draft.dialogue.push({ mode: "speech", speaker: "guest", text: "就是这里。" });
  session.document = structuredClone(draft);
  const visualTarget = path.join(fixture.projectDirectory, "characters", "ellen.visual.json");
  const visual = await readJson(visualTarget);
  visual.description = "艾莲的基础外观已经重新润色。";
  visual.variants[0].description = "制服的视觉说明也已改变。";
  await writeJson(visualTarget, visual);

  const result = await saveStoryNarrativeDraft(fixture.repositoryRoot, session);
  const persisted = await readJson(result.target_file);
  assert.equal(persisted.title, "抵达门口");
  assert.match(persisted.dialogue[0].id, /^dialogue-[a-f0-9]{12}$/);
  assert.deepEqual(persisted.characters.map((item) => item.character_id), ["ellen"], "画外speaker不会变成视觉角色");

  const invalidSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const invalidDraft = structuredClone(invalidSession.document);
  invalidDraft.dialogue.push({ mode: "speech", speaker: "ghost", text: "我不在项目角色中。" });
  invalidSession.document = structuredClone(invalidDraft);
  const missingResult = await saveStoryNarrativeDraft(fixture.repositoryRoot, invalidSession);
  assert.equal(missingResult.value.dialogue.at(-1).speaker, "ghost");
});

test("narrative 删除被排版引用的条目时拒绝保存，改文字或删除未引用条目不受影响", async (context) => {
  const fixture = await createFixture(context);
  const root = fixture.repositoryRoot;
  const id = fixture.projectId;
  const narrativeTarget = path.join(fixture.pagesDirectory, "page-001.content.json");
  const setup = await readStoryNarrativeDraft(root, id, "page-001");
  setup.document.dialogue.push(
    { mode: "speech", speaker: "ellen", text: "被排版引用的台词。" },
    { mode: "speech", speaker: "guest", text: "未被引用的台词。" },
  );
  const setupResult = await saveStoryNarrativeDraft(root, setup);
  const [referencedId, freeId] = (await readJson(setupResult.target_file)).dialogue.map((dialogue) => dialogue.id);
  await writeJson(path.join(fixture.projectDirectory, "lettering", "dialogue-layouts.json"), {
    $schema: LETTERING_SCHEMA_ID,
    version: 2,
    pages: [{ page: "page-001", items: [{ dialogue_id: referencedId, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }] }],
  });

  const blocked = await readStoryNarrativeDraft(root, id, "page-001");
  blocked.document.dialogue = blocked.document.dialogue.filter((dialogue) => dialogue.id !== referencedId);
  await assert.rejects(
    () => saveStoryNarrativeDraft(root, blocked),
    (error) => error?.code === "page_lettering_anchor_conflict"
      && error?.status === 409
      && error.details.some((detail) => detail.includes(referencedId) && detail.includes("请先调整排版")),
  );
  assert.equal((await readJson(narrativeTarget)).dialogue.length, 2, "拒绝时不得落盘");

  const reword = await readStoryNarrativeDraft(root, id, "page-001");
  reword.document.dialogue.find((dialogue) => dialogue.id === referencedId).text = "改写后的台词。";
  await saveStoryNarrativeDraft(root, reword);
  assert.equal((await readJson(narrativeTarget)).dialogue[0].text, "改写后的台词。");

  const removal = await readStoryNarrativeDraft(root, id, "page-001");
  removal.document.dialogue = removal.document.dialogue.filter((dialogue) => dialogue.id !== freeId);
  const removed = await saveStoryNarrativeDraft(root, removal);
  assert.deepEqual((await readJson(removed.target_file)).dialogue.map((dialogue) => dialogue.id), [referencedId]);
});

test("Prompt save 忽略其他页面和未引用角色变化", async (context) => {
  const fixture = await createFixture(context);
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const draft = structuredClone(session.document);
  draft.camera.push({ tag: "full_body" });
  session.document = structuredClone(draft);
  const unrelatedPage = path.join(fixture.pagesDirectory, "page-002.content.json");
  const unrelated = await readJson(unrelatedPage);
  unrelated.title = "继续等待";
  await writeJson(unrelatedPage, unrelated);
  const guestProfile = path.join(fixture.projectDirectory, "characters", "guest.profile.json");
  const guest = await readJson(guestProfile);
  guest.description = "无关角色的新说明。";
  await writeJson(guestProfile, guest);

  const result = await saveStoryPromptDraft(fixture.repositoryRoot, session);
  const persisted = await readJson(result.target_file);
  assert.equal(persisted.camera[0].tag, "full_body");
  assert.match(persisted.camera[0].id, /^token-[a-f0-9]{12}$/);
});

test("目标文件变化时拒绝陈旧保存", async (context) => {
  const fixture = await createFixture(context);
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const target = path.join(fixture.pagesDirectory, "page-001.prompt.json");
  const external = await readJson(target);
  external.setting.push({ description: "cold mood" });
  await writeJson(target, external);

  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, session),
    (error) => error?.code === "fact_target_conflict",
  );
  assert.deepEqual((await readJson(target)).setting, [{ description: "cold mood" }]);
});

test("同页 narrative 与 Prompt 串行保存，Prompt 不会在 narrative 变化后陈旧落盘", async (context) => {
  const fixture = await createFixture(context);
  const narrativeSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const promptSession = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const narrativeDraft = structuredClone(narrativeSession.document);
  narrativeDraft.scene_description = "已经变化的页面目标。";
  narrativeSession.document = structuredClone(narrativeDraft);

  let releaseCommit;
  const holdCommit = new Promise((resolve) => { releaseCommit = resolve; });
  let reachedCommit;
  const commitReached = new Promise((resolve) => { reachedCommit = resolve; });
  const narrativeWrite = saveStoryNarrativeDraft(
    fixture.repositoryRoot,
    narrativeSession,
    { beforeCommit: async () => { reachedCommit(); await holdCommit; } },
  );
  await commitReached;

  const pendingSave = assert.rejects(() => saveStoryPromptDraft(fixture.repositoryRoot, promptSession), error => error?.code === "fact_upstream_conflict");
  releaseCommit();
  await pendingSave;
  await narrativeWrite;

  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, promptSession),
    (error) => error?.code === "fact_upstream_conflict",
  );

  const lockRoot = path.join(fixture.repositoryRoot, "Saved", "state", "fact-locks", fixture.projectId);
  await mkdir(lockRoot, { recursive: true });
  for (const [name, source] of [["fresh-empty", ""], ["fresh-malformed", "{broken"]]) {
    const target = path.join(lockRoot, `${name}.lock`);
    await writeFile(target, source, "utf8");
    await assert.rejects(
      () => factStorage.withResourceLock(fixture.repositoryRoot, fixture.projectId, name, name, async () => undefined),
      (error) => error?.code === "story_edit_target_busy",
    );
    assert.equal(await exists(target), true, "grace窗口内的空/畸形lock不能被竞争方删除");
    await unlink(target);
  }

  const oldMalformed = path.join(lockRoot, "old-malformed.lock");
  await writeFile(oldMalformed, "{broken", "utf8");
  const oldTime = new Date(Date.now() - STORY_LOCK_MALFORMED_GRACE_MS - 1_000);
  await utimes(oldMalformed, oldTime, oldTime);
  assert.equal(await factStorage.withResourceLock(
    fixture.repositoryRoot, fixture.projectId, "old-malformed", "old malformed", async () => "recovered",
  ), "recovered");
  assert.equal(await exists(oldMalformed), false, "超过grace的畸形lock可被安全回收");

  const replacedLock = path.join(lockRoot, "owner-replaced.lock");
  const successor = { pid: process.pid, token: "b".repeat(32), created_at: new Date().toISOString() };
  await factStorage.withResourceLock(
    fixture.repositoryRoot,
    fixture.projectId,
    "owner-replaced",
    "owner replaced",
    async () => writeJson(replacedLock, successor),
  );
  assert.deepEqual(await readJson(replacedLock), successor, "原holder释放时不得删除token不同的后继lock");
  await unlink(replacedLock);
});

test("编辑内容验证失败时不覆盖目标", async (context) => {
  const fixture = await createFixture(context);
  const session = await readStoryPromptDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const invalid = structuredClone(session.document);
  delete invalid.avoid;
  session.document = structuredClone(invalid);
  const target = path.join(fixture.pagesDirectory, "page-001.prompt.json");
  const before = await readFile(target, "utf8");

  await assert.rejects(
    () => saveStoryPromptDraft(fixture.repositoryRoot, session),
    (error) => error?.code === "invalid_story_edit_document",
  );
  assert.equal(await readFile(target, "utf8"), before);

  session.document = structuredClone(pagePrompt("ellen"));

});



test("outline 写入允许下游 sequence 悬空并返回结构化诊断", async (context) => {
  const fixture = await createFixture(context);
  const narrativeSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  let releaseNarrative;
  const holdNarrative = new Promise((resolve) => { releaseNarrative = resolve; });
  let narrativeLocked;
  const narrativeLockReached = new Promise((resolve) => { narrativeLocked = resolve; });
  const narrativeWrite = saveStoryNarrativeDraft(
    fixture.repositoryRoot,
    narrativeSession,
    { beforeCommit: async () => { narrativeLocked(); await holdNarrative; } },
  );
  await narrativeLockReached;
  const session = await readStoryOutlineDraft(fixture.repositoryRoot, fixture.projectId);
  const draft = structuredClone(session.document);
  draft.chapters[0].sequences = draft.chapters[0].sequences.filter((sequence) => sequence.id !== "waiting");
  session.document = structuredClone(draft);

  let result;
  try {
    const pendingOutline = saveStoryOutlineDraft(fixture.repositoryRoot, session);
    releaseNarrative();
    result = await pendingOutline;
  } finally {
    releaseNarrative();
  }
  await narrativeWrite;
  assert.deepEqual(result.downstream_diagnostics, [{ code: "dangling_sequence_reference", sequence_id: "waiting" }]);
  assert.deepEqual((await readJson(result.target_file)).chapters[0].sequences.map((sequence) => sequence.id), ["arrival"]);
});

test("pages index 写入拒绝未知 sequence 与缺失页面配对", async (context) => {
  const fixture = await createFixture(context);
  const session = await readStoryPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  const draft = structuredClone(session.document);
  draft.by_sequence.arrival.push("page-abcdefabcdef");
  draft.by_sequence.removed = [];
  session.document = structuredClone(draft);

  await assert.rejects(
    () => saveStoryPagesIndexDraft(fixture.repositoryRoot, session),
    (error) => error?.code === "invalid_story_pages_index"
      && error.details.some((detail) => detail.includes("dangling_sequence_reference"))
      && error.details.some((detail) => detail.includes("missing_narrative_file")),
  );
});

test("page create 生成服务端 ID、完整文件对并追加到 sequence", async (context) => {
  const fixture = await createFixture(context);
  let failedCreatePaths;
  await assert.rejects(
    () => createStoryPage(fixture.repositoryRoot, fixture.projectId, "arrival", {
      beforeCommit: async (paths) => {
        failedCreatePaths = paths;
        const error = new Error("forced create failure");
        error.code = "forced_create_failure";
        throw error;
      },
    }),
    { code: "forced_create_failure" },
  );
  assert.equal(await exists(failedCreatePaths.prompt_file), false);
  assert.equal(await exists(failedCreatePaths.content_file), false);
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "index.json"))).by_sequence.arrival, ["page-001"]);

  const result = await createStoryPage(fixture.repositoryRoot, fixture.projectId, "arrival");

  assert.match(result.page_id, /^page-[a-f0-9]{12}$/);
  const narrative = await readJson(result.content_file);
  const prompt = await readJson(result.prompt_file);
  const pagesIndex = await readJson(result.index_file);
  assert.equal(narrative.title, "未命名页面");
  assert.equal(narrative.scene_description, "待补充画面内容。");
  assert.deepEqual(narrative.characters, []);
  assert.deepEqual(narrative.dialogue, []);
  assert.deepEqual(storyPromptCategories.map((category) => [category, prompt[category]]), storyPromptCategories.map((category) => [category, []]));
  assert.equal(pagesIndex.by_sequence.arrival.at(-1), result.page_id);
});

test("page delete 归档页面事实与当前媒体并可在七天后清理", async (context) => {
  const fixture = await createFixture(context);
  const indexTarget = path.join(fixture.pagesDirectory, "index.json");
  const pagesIndex = await readJson(indexTarget);
  pagesIndex.by_sequence = { arrival: ["page-001", "page-002"] };
  await writeJson(indexTarget, pagesIndex);
  const canonicalCandidate = path.join(fixture.projectDirectory, "Outputs", "pages", "page-002", "candidate-a", "image.png");
  const canonicalOutput = path.join(fixture.projectDirectory, "Outputs", "pages", "page-002", "candidate-a", "generation.json");
  const legacyCandidate = path.join(fixture.projectDirectory, "candidates", "page-002", "legacy.png");
  for (const target of [canonicalCandidate, canonicalOutput, legacyCandidate]) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "media", "utf8");
  }

  const result = await deleteStoryPage(fixture.repositoryRoot, fixture.projectId, "page-002");
  assert.equal(await exists(path.join(fixture.pagesDirectory, "page-002.content.json")), false);
  assert.equal(await exists(path.join(result.archive_directory, "pages", "page-002.content.json")), true);
  assert.equal(await exists(path.join(result.archive_directory, "Outputs", "pages", "page-002", "candidate-a", "image.png")), true);
  assert.equal(await exists(path.join(result.archive_directory, "Outputs", "pages", "page-002", "candidate-a", "generation.json")), true);
  assert.equal(await exists(legacyCandidate), true);
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "index.json"))).by_sequence, { arrival: ["page-001"] });

  const manifestPath = path.join(result.archive_directory, "deletion.json");
  const manifest = await readJson(manifestPath);
  assert.deepEqual({
    sequence_id: manifest.sequence_id,
    ordinal: manifest.ordinal,
    previous_page_id: manifest.previous_page_id,
    next_page_id: manifest.next_page_id,
  }, {
    sequence_id: "arrival",
    ordinal: 1,
    previous_page_id: "page-001",
    next_page_id: null,
  });
  const now = Date.now();
  manifest.deleted_at = new Date(now - DELETED_STORY_PAGE_RETENTION_MS - 1000).toISOString();
  await writeJson(manifestPath, manifest);
  assert.deepEqual(await cleanupDeletedStoryPages(fixture.repositoryRoot, { now }), [result.archive_directory]);
  assert.equal(await exists(result.archive_directory), false);
});

test("结构与页面写入排队执行，归属变化后拒绝旧页面草稿", async (context) => {
  const fixture = await createFixture(context);
  const initialIndexTarget = path.join(fixture.pagesDirectory, "index.json");
  const initialIndex = await readJson(initialIndexTarget);
  initialIndex.by_sequence = { arrival: ["page-001", "page-002"] };
  await writeJson(initialIndexTarget, initialIndex);

  const reorderNarrativeSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  let releaseReorderNarrative;
  const holdReorderNarrative = new Promise((resolve) => { releaseReorderNarrative = resolve; });
  let reorderNarrativeLocked;
  const reorderNarrativeLockReached = new Promise((resolve) => { reorderNarrativeLocked = resolve; });
  const reorderNarrativeWrite = saveStoryNarrativeDraft(
    fixture.repositoryRoot,
    reorderNarrativeSession,
    { beforeCommit: async () => { reorderNarrativeLocked(); await holdReorderNarrative; } },
  );
  await reorderNarrativeLockReached;
  const reorderSession = await readStoryPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  const reorderDraft = structuredClone(reorderSession.document);
  reorderDraft.by_sequence.arrival.reverse();
  reorderSession.document = structuredClone(reorderDraft);
  try {
    const pendingReorder = saveStoryPagesIndexDraft(fixture.repositoryRoot, reorderSession);
    releaseReorderNarrative();
    await pendingReorder;
  } finally {
    releaseReorderNarrative();
  }
  await reorderNarrativeWrite;

  const narrativeSession = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const narrativeDraft = structuredClone(narrativeSession.document);
  narrativeDraft.title = "不能陈旧落盘";
  narrativeSession.document = structuredClone(narrativeDraft);
  const indexSession = await readStoryPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  const indexDraft = structuredClone(indexSession.document);
  indexDraft.by_sequence = { arrival: ["page-002"], waiting: ["page-001"] };
  indexSession.document = structuredClone(indexDraft);

  let releaseCommit;
  const holdCommit = new Promise((resolve) => { releaseCommit = resolve; });
  let reachedCommit;
  const commitReached = new Promise((resolve) => { reachedCommit = resolve; });
  const indexWrite = saveStoryPagesIndexDraft(
    fixture.repositoryRoot,
    indexSession,
    { beforeCommit: async () => { reachedCommit(); await holdCommit; } },
  );
  await commitReached;
  {
    const pendingSave = assert.rejects(
      () => saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeSession), error => error?.code === "fact_upstream_conflict",
    );
    releaseCommit();
    await pendingSave;
  }
  await indexWrite;
  await assert.rejects(
    () => saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
});

const createStoryPage = fixtureMutation(createStoryPageDirect);
const deleteStoryPage = fixtureMutation(deleteStoryPageDirect);


test("公共页面草稿不依赖归属存在，缺失引用与人物绑定可保留并修复", async context => {
  const fixture = await createFixture(context);
  const { repositoryRoot: root, projectId: id, projectDirectory, pagesDirectory } = fixture;
  const index = await readPageIndex(projectDirectory);
  index.pages[0] = { page_id: "page-001", owner_kind: "scene", scene_id: "removed", variant_id: "default" };
  await writeJson(path.join(pagesDirectory, "index.json"), index);
  await writeJson(path.join(projectDirectory, "characters", "index.json"), {
    $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["guest"],
  });
  const narrativeDraft = await readStoryNarrativeDraft(root, id, "page-001");
  narrativeDraft.document.title = "归属失效但仍能编辑";
  await saveStoryNarrativeDraft(root, narrativeDraft);
  const promptDraft = await readStoryPromptDraft(root, id, "page-001");
  promptDraft.document.subject.push({ tag: "smile", character_id: "absent" });
  const saved = await saveStoryPromptDraft(root, promptDraft);
  assert.equal(saved.value.subject.at(-1).character_id, "absent");
  assert.equal((await readStoryNarrativeDraft(root, id, "page-001")).document.title, "归属失效但仍能编辑");
});

test("剧情索引窄保存保留其他归属页面，其他归属变化不造成剧情目标冲突", async context => {
  const fixture = await createFixture(context);
  const { repositoryRoot: root, projectId: id, projectDirectory, pagesDirectory } = fixture;
  const draft = await readStoryPagesIndexDraft(root, id);
  const index = await readPageIndex(projectDirectory);
  const extra = { page_id: "page-003", owner_kind: "character", character_id: "ellen", variant_id: "uniform" };
  index.pages.push(extra);
  await writeJson(path.join(pagesDirectory, "index.json"), index);
  draft.document.by_sequence = { arrival: ["page-002", "page-001"] };
  await saveStoryPagesIndexDraft(root, draft);
  const persisted = await readPageIndex(projectDirectory);
  assert.deepEqual(persisted.pages.find(page => page.page_id === "page-003"), extra);
  assert.deepEqual(storyPagesIndexProjection(persisted).by_sequence, { arrival: ["page-002", "page-001"] });
});


test("页面 Prompt 只依赖所引场景子设定，场景缺失与恢复会使旧草稿失效", async context => {
  const fixture = await createFixture(context);
  const { repositoryRoot: root, projectId: id, projectDirectory, pagesDirectory } = fixture;
  const sceneIndexPath = path.join(projectDirectory, "scenes", "index.json");
  await writeJson(sceneIndexPath, { $schema: SCENE_INDEX_SCHEMA_ID, scenes: ["station", "street"] });
  for (const name of ["station", "street"]) {
    for (const [kind, value] of Object.entries(defaultSceneFacts(name, name))) {
      await writeJson(path.join(projectDirectory, "scenes", `${name}.${kind}.json`), value);
    }
  }
  const pagePromptPath = path.join(pagesDirectory, "page-001.prompt.json");
  await writeJson(pagePromptPath, { ...pagePrompt(), scene_id: "station", scene_variant_id: "default" });
  const unrelated = await readStoryPromptDraft(root, id, "page-001");
  const streetPath = path.join(projectDirectory, "scenes", "street.prompt.json");
  const street = await readJson(streetPath);
  street.identity.prompt.setting.push({ tag: "outdoors" });
  await writeJson(streetPath, street);
  unrelated.document.camera.push({ tag: "from_side" });
  await saveStoryPromptDraft(root, unrelated);
  const stale = await readStoryPromptDraft(root, id, "page-001");
  await writeJson(sceneIndexPath, { $schema: SCENE_INDEX_SCHEMA_ID, scenes: ["street"] });
  await assert.rejects(saveStoryPromptDraft(root, stale), { code: "fact_upstream_conflict" });
  const missing = await readStoryPromptDraft(root, id, "page-001");
  missing.document.camera.push({ tag: "from_above" });
  await saveStoryPromptDraft(root, missing);
  const restored = await readStoryPromptDraft(root, id, "page-001");
  await writeJson(sceneIndexPath, { $schema: SCENE_INDEX_SCHEMA_ID, scenes: ["station", "street"] });
  await assert.rejects(saveStoryPromptDraft(root, restored), { code: "fact_upstream_conflict" });
});
