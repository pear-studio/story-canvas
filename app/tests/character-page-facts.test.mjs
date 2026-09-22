import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { PAGES_INDEX_SCHEMA_ID } from "../server/pages-store.mjs";
import { factFixture, fixtureMutation } from "./fact-fixture.mjs";
const { read: readCharacterPromptDraft, saveConfirmed: saveCharacterPromptDraft } = factFixture("character", "prompt");
const { read: readCharacterPagesIndexDraft, save: saveCharacterPagesIndexDraft } = factFixture("character", "page-index");
const { read: readCharacterPageGoalDraft, save: saveCharacterPageGoalDraft } = factFixture("character", "page-goal");
const { read: readCharacterPagePromptDraft, save: saveCharacterPagePromptDraft } = factFixture("character", "page-prompt");
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {



  createCharacterPage as createCharacterPageDirect,



  deleteCharacterPage as deleteCharacterPageDirect
} from "../server/character-page-facts.mjs";

import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PAGE_GOAL_SCHEMA_ID,
  CHARACTER_PAGES_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID
} from "../server/character-files.mjs";
import { defaultLetteringSettings } from "../server/lettering-settings.mjs";
import { STORY_PAGE_PROMPT_SCHEMA_ID, STORY_PAGE_NARRATIVE_SCHEMA_ID } from "../server/story-files.mjs";

async function writeJson(target, value) {
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

function emptyPrompt(schema = STORY_PAGE_PROMPT_SCHEMA_ID) {
  return { $schema: schema, text: "" };
}

function characterPrompt(id, withVariant = false) {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    prompt_name: id,
    variants: {
      default: { text: `${id} 的基础形象。`, reference_images: [] },
      ...(withVariant ? { uniform: { text: "穿学校制服的艾莲。", reference_images: [] } } : {}),
    },
  };
}

async function createFixture(context, { templates = false } = {}) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "character-page-session-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  if (templates) {
    await cp(new URL("../../library/visual-page-templates", import.meta.url), path.join(repositoryRoot, "library", "visual-page-templates"), { recursive: true });
  }
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
  const charactersDirectory = path.join(projectDirectory, "characters");
  const pagesDirectory = path.join(projectDirectory, "pages");
  await mkdir(path.join(projectDirectory, "lettering"), { recursive: true });
  await writeJson(path.join(charactersDirectory, "index.json"), { $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["ellen", "guest"] });
  for (const id of ["ellen", "guest"]) {
    await writeJson(path.join(charactersDirectory, `${id}.profile.json`), {
      $schema: CHARACTER_PROFILE_SCHEMA_ID, name: id, description: `${id} profile`,
    });
    await writeJson(path.join(charactersDirectory, `${id}.visual.json`), {
      $schema: CHARACTER_VISUAL_SCHEMA_ID,
      description: `${id} visual`,
      variants: id === "ellen"
        ? [{ id: "default", name: "默认", description: "基础形象" }, { id: "uniform", name: "制服", description: "穿制服" }]
        : [{ id: "default", name: "默认", description: "基础形象" }],
    });
    await writeJson(path.join(charactersDirectory, `${id}.prompt.json`), characterPrompt(id, id === "ellen"));
  }
  await writeJson(path.join(pagesDirectory, "index.json"), {
    $schema: PAGES_INDEX_SCHEMA_ID,
    pages: [{ owner_kind: "character", page_id: "page-101", character_id: "ellen", variant_id: "uniform" }],
  });
  await writeJson(path.join(pagesDirectory, "page-101.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "制服", scene_description: "展示制服全身。", characters: [{ character_id: "ellen", variant_id: "uniform" }], dialogue: [],
  });
  await writeJson(path.join(pagesDirectory, "page-101.prompt.json"), {
    ...emptyPrompt(), text: "制服全身验证图。",
  });
  await writeJson(path.join(projectDirectory, "lettering", "settings.json"), {
    ...defaultLetteringSettings(),
    character_colors: { ellen: "#112233" },
  });
  registerFixtureProjects(repositoryRoot); return { repositoryRoot, projectId, projectDirectory, charactersDirectory, pagesDirectory };
}

test("page index 可排序重绑定，但拒绝未知 owner/variant 与缺失文件配对", async (context) => {
  const fixture = await createFixture(context);
  const persistedIndex = await readJson(path.join(fixture.pagesDirectory, "index.json"));
  persistedIndex.pages[0].character_id = "missing";
  await writeJson(path.join(fixture.pagesDirectory, "index.json"), persistedIndex);
  const session = await readCharacterPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  const draft = structuredClone(session.document);
  draft.pages[0] = { page_id: "page-101", character_id: "guest", variant_id: "default" };
  session.document = structuredClone(draft);
  await saveCharacterPagesIndexDraft(fixture.repositoryRoot, session);
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "index.json"))).pages[0], { ...draft.pages[0], owner_kind: "character" });

  const unrelatedSession = await readCharacterPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  const ellenVisual = await readJson(path.join(fixture.charactersDirectory, "ellen.visual.json"));
  ellenVisual.description = "与 guest-only index 无关的新外观";
  await writeJson(path.join(fixture.charactersDirectory, "ellen.visual.json"), ellenVisual);
  await saveCharacterPagesIndexDraft(fixture.repositoryRoot, unrelatedSession);

  const invalidSession = await readCharacterPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  const invalid = structuredClone(invalidSession.document);
  invalid.pages[0].character_id = "missing";
  invalidSession.document = structuredClone(invalid);
  await assert.rejects(
    () => saveCharacterPagesIndexDraft(fixture.repositoryRoot, invalidSession),
    (error) => error?.code === "page_owner_not_found",
  );

  const pairingSession = await readCharacterPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  await rm(path.join(fixture.pagesDirectory, "page-101.prompt.json"));
  await assert.rejects(
    () => saveCharacterPagesIndexDraft(fixture.repositoryRoot, pairingSession),
    (error) => error?.code === "character_pages_pairing_mismatch",
  );
});
test("页面内容与 Prompt 分权写入，标题可编辑且归属移动不改变实际引用", async (context) => {
  const fixture = await createFixture(context);
  const promptBefore = await readJson(path.join(fixture.pagesDirectory, "page-101.prompt.json"));
  const goalSession = await readCharacterPageGoalDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  const goal = structuredClone(goalSession.document);
  goal.title = '制服站姿';
  goalSession.document = structuredClone(goal);
  await saveCharacterPageGoalDraft(fixture.repositoryRoot, goalSession);
  assert.deepEqual(await readJson(path.join(fixture.pagesDirectory, "page-101.prompt.json")), promptBefore);

  const promptSession = await readCharacterPagePromptDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  const prompt = structuredClone(promptSession.document);
  prompt.text = "换一个机位的制服全身。";
  promptSession.document = structuredClone(prompt);
  const guestVisual = await readJson(path.join(fixture.charactersDirectory, "guest.visual.json"));
  guestVisual.description = "无关 guest 变化";
  await writeJson(path.join(fixture.charactersDirectory, "guest.visual.json"), guestVisual);
  await saveCharacterPagePromptDraft(fixture.repositoryRoot, promptSession);
  assert.equal(
    (await readJson(path.join(fixture.pagesDirectory, "page-101.prompt.json"))).text,
    "换一个机位的制服全身。",
  );

  const conflictSession = await readCharacterPagePromptDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  const moved = await readCharacterPagesIndexDraft(fixture.repositoryRoot, fixture.projectId);
  moved.document.pages.find(p => p.page_id === 'page-101').variant_id = 'default';
  await saveCharacterPagesIndexDraft(fixture.repositoryRoot, moved);
  await saveCharacterPagePromptDraft(fixture.repositoryRoot, conflictSession);
  const content = await readJson(path.join(fixture.pagesDirectory, "page-101.content.json"));
  assert.equal(content.title, "制服站姿");
  assert.equal(content.characters[0].variant_id, "uniform");
  const stale = await readCharacterPagePromptDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  const editedContent = await readCharacterPageGoalDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  editedContent.document.scene_description = "换一个镜头。";
  await saveCharacterPageGoalDraft(fixture.repositoryRoot, editedContent);
  await assert.rejects(saveCharacterPagePromptDraft(fixture.repositoryRoot, stale), { code: "fact_upstream_conflict" });
});

test("page create 一次性转换显式模板，模板后续变化不回写页面", async (context) => {
  const fixture = await createFixture(context, { templates: true });
  const created = await createCharacterPage(fixture.repositoryRoot, fixture.projectId, "guest", "default", { templateId: "natural-standing-full-body" });
  assert.equal(created.template_id, "natural-standing-full-body");
  const goal = await readJson(created.content_file);
  const prompt = await readJson(created.prompt_file);
  assert.equal(goal.visual_goal, undefined);
  assert.ok(goal.title);
  assert.deepEqual(goal.characters, [{ character_id: 'guest', variant_id: 'default' }]);
  assert.match(prompt.text, /自然|站立|全身/, "模板展开为本页自由文本");

  const beforeInvalid = await readJson(path.join(fixture.pagesDirectory, "index.json"));
  await writeFile(path.join(fixture.repositoryRoot, "library", "visual-page-templates", "catalog.json"), "{ broken", "utf8");
  await assert.rejects(
    () => createCharacterPage(fixture.repositoryRoot, fixture.projectId, "guest", "default", { templateId: "natural-standing-full-body" }),
    (error) => error?.code === "page_template_invalid" && error.details.some((detail) => /JSON/.test(detail)),
  );
  assert.deepEqual(await readJson(path.join(fixture.pagesDirectory, "index.json")), beforeInvalid);

  await rm(path.join(fixture.repositoryRoot, "library", "visual-page-templates"), { recursive: true, force: true });
  assert.deepEqual(await readJson(created.content_file), goal);
  assert.deepEqual(await readJson(created.prompt_file), prompt);
});

test("page delete 归档事实与稳定页面 ID 的媒体", async (context) => {
  const fixture = await createFixture(context);
  const candidate = path.join(fixture.projectDirectory, "Outputs", "pages", "page-101", "cand-a", "image.png");
  const output = path.join(fixture.projectDirectory, "Outputs", "pages", "page-101", "cand-a", "generation.json");
  await mkdir(path.dirname(candidate), { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(candidate, "candidate");
  await writeFile(output, "output");

  const result = await deleteCharacterPage(fixture.repositoryRoot, fixture.projectId, "page-101");
  assert.deepEqual((await readJson(path.join(fixture.pagesDirectory, "index.json"))).pages, []);
  assert.equal(await exists(path.join(result.archive_directory, "pages", "page-101.content.json")), true);
  assert.equal(await exists(path.join(result.archive_directory, "Outputs", "pages", "page-101", "cand-a", "image.png")), true);
  const manifest = await readJson(path.join(result.archive_directory, "deletion.json"));
  assert.deepEqual({ owner: manifest.character_id, variant: manifest.variant_id, ordinal: manifest.ordinal }, { owner: "ellen", variant: "uniform", ordinal: 0 });
});

test("角色配置写入与实际引用它的 character-page Prompt 串行保存", async (context) => {
  const fixture = await createFixture(context);
  const pageSession = await readCharacterPagePromptDraft(fixture.repositoryRoot, fixture.projectId, "page-101");
  const characterSession = await readCharacterPromptDraft(fixture.repositoryRoot, fixture.projectId, "ellen");
  const characterDraft = structuredClone(characterSession.document);
  characterDraft.variants.uniform.text = "穿更新制服的艾莲。";
  characterSession.document = structuredClone(characterDraft);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const locked = new Promise((resolve) => { reached = resolve; });
  const write = saveCharacterPromptDraft(fixture.repositoryRoot, characterSession, {
    beforeCommit: async () => { reached(); await held; },
  });
  await locked;
  {
    const pendingSave = assert.rejects(
      () => saveCharacterPagePromptDraft(fixture.repositoryRoot, pageSession), error => error?.code === "fact_upstream_conflict",
    );
    release();
    await pendingSave;
  }
  await write;
  await assert.rejects(
    () => saveCharacterPagePromptDraft(fixture.repositoryRoot, pageSession),
    (error) => error?.code === "fact_upstream_conflict",
  );
});

const createCharacterPage = fixtureMutation(createCharacterPageDirect);
const deleteCharacterPage = fixtureMutation(deleteCharacterPageDirect);
