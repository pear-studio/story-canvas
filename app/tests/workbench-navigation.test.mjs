import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProject, readProjectCreationTemplate } from "../server/project-creation.mjs";
import { saveCharacterPrompt } from "../server/project-workbench.mjs";
import {
  createWorkbenchScene, createWorkbenchSceneVariant, moveWorkbenchSceneVariant, deleteWorkbenchSceneVariant,
  createWorkbenchPage, moveWorkbenchPage,
  createWorkbenchCharacter,
  createWorkbenchCharacterPage,
  createWorkbenchCharacterVariant,
  createWorkbenchChapter,
  createWorkbenchSequence,
  createWorkbenchStoryPage,
  createWorkbenchStoryPageFromTemplate,
  deleteWorkbenchCharacterPage,
  deleteWorkbenchCharacterVariant,
  deleteWorkbenchStoryPage,
  duplicateWorkbenchCharacterPage,
  duplicateWorkbenchStoryPage,
  moveWorkbenchChapter,
  moveWorkbenchCharacterPage,
  moveWorkbenchCharacterVariant,
  moveWorkbenchSequence,
  moveWorkbenchStoryPage,
} from "../server/workbench-navigation.mjs";
import { readStoryPagesIndex, readPageIndex } from "../server/pages-store.mjs";
import { STORY_PAGE_NARRATIVE_SCHEMA_ID } from "../server/story-files.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function createFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-navigation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../../library/visual-page-templates", import.meta.url), path.join(root, "library", "visual-page-templates"), { recursive: true });
  const session = await readProjectCreationTemplate(root, "navigation-story");
  const creation = structuredClone(session.document);
  creation.metadata.title = "导航语义测试";
  creation.outline = {
    synopsis: "两个情节单元用于验证页面移动。",
    chapters: [{
      id: "opening", title: "开场", summary: "建立开场。",
      sequences: [
        { id: "arrival", title: "抵达", summary: "角色抵达。" },
        { id: "meeting", title: "相遇", summary: "角色相遇。" },
      ],
    }],
  };
  creation.characters = [{
    id: "ellen", name: "艾莲", description: "主要角色。",
    visual_description: "红眼与短发。", variants: [{ id: "default", name: "默认", description: "基础形象。" }],
  }];
  session.document = structuredClone(creation);
  await createProject(root, session);
  registerFixtureProjects(root); return { root, projectId: "navigation-story", projectDirectory: path.join(root, "workspace", "navigation-story") };
}

test("右键新增在指定同级之后插入，错误锚点不改变页面索引", async context => {
  const { root, projectId, projectDirectory } = await createFixture(context);
  const ending = await createWorkbenchChapter(root, projectId, '结尾');
  const middle = await createWorkbenchChapter(root, projectId, '中段', 'opening');
  const sequence = await createWorkbenchSequence(root, projectId, 'opening', '中间单元', 'arrival');
  const outline = await readJson(path.join(projectDirectory, 'story/outline.json'));
  assert.deepEqual(outline.chapters.map(c => c.id), ['opening', middle.chapter_id, ending.chapter_id]);
  assert.deepEqual(outline.chapters[0].sequences.map(s => s.id), ['arrival', sequence.sequence_id, 'meeting']);
  const first = await createWorkbenchStoryPage(root, projectId, 'arrival');
  const last = await createWorkbenchStoryPage(root, projectId, 'arrival');
  const inserted = await createWorkbenchStoryPage(root, projectId, 'arrival', null, first.page_id);
  const indexPath = path.join(projectDirectory, 'pages/index.json');
  const before = await readStoryPagesIndex(projectDirectory);
  assert.deepEqual(before.by_sequence.arrival, [first.page_id, inserted.page_id, last.page_id]);
  await assert.rejects(createWorkbenchStoryPage(root, projectId, 'meeting', null, first.page_id), /page_anchor_not_found/);
  assert.deepEqual(await readStoryPagesIndex(projectDirectory), before);
  const a = await createWorkbenchCharacterPage(root, projectId, 'ellen', 'default');
  const z = await createWorkbenchCharacterPage(root, projectId, 'ellen', 'default');
  const between = await createWorkbenchCharacterPage(root, projectId, 'ellen', 'default', null, a.page_id);
  assert.deepEqual((await readPageIndex(projectDirectory)).pages.filter(p => p.owner_kind === 'character').map(p => p.page_id), [a.page_id, between.page_id, z.page_id]);
});

test("工作台导航语义复用当前事实契约完成创建、移动、删除并拒绝删除仍被页面使用的子设定", async (context) => {
  const fixture = await createFixture(context);

  const chapter = await createWorkbenchChapter(fixture.root, fixture.projectId, "收场");
  assert.match(chapter.chapter_id, /^(?:chapter|ending|[a-z0-9-]+)$/);

  const createdPage = await createWorkbenchStoryPage(fixture.root, fixture.projectId, "arrival");
  await moveWorkbenchStoryPage(fixture.root, fixture.projectId, createdPage.page_id, "meeting");
  assert.deepEqual((await readStoryPagesIndex(fixture.projectDirectory)).by_sequence, { meeting: [createdPage.page_id] });
  await deleteWorkbenchStoryPage(fixture.root, fixture.projectId, createdPage.page_id);

  const templatedPage = await createWorkbenchStoryPageFromTemplate(
    fixture.root, fixture.projectId, "arrival", "upper-body-portrait", "ellen", "default",
  );
  const templatedNarrative = await readJson(templatedPage.content_file);
  const templatedPrompt = await readJson(templatedPage.prompt_file);
  assert.equal(templatedNarrative.title, "上半身肖像");
  assert.deepEqual(templatedNarrative.characters, [{ character_id: "ellen", variant_id: "default" }]);
  assert.match(templatedPrompt.camera[0].id, /^token-[a-f0-9]{12}$/);
  assert.equal(templatedPrompt.camera[0].description, "upper body");
  await deleteWorkbenchStoryPage(fixture.root, fixture.projectId, templatedPage.page_id);

  const variant = await createWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "casual", "便服");
  assert.equal(variant.variant_id, "casual", "新建子设定保留显式指定的稳定 ID");
  const promptTarget = path.join(fixture.projectDirectory, "characters", "ellen.prompt.json");
  const prompt = await readJson(promptTarget);
  assert.deepEqual(Object.keys(prompt.variants), ["default"], "新建 variant 只写上游 visual");
  prompt.variants[variant.variant_id] = structuredClone(prompt.variants.default);
  const visualTarget = path.join(fixture.projectDirectory, "characters", "ellen.visual.json");
  await saveCharacterPrompt(fixture.root, fixture.projectId, {
    character_id: "ellen", prompt, expected_sha256: hashCanonicalJson(await readJson(promptTarget)),
    expected_visual_sha256: hashCanonicalJson(await readJson(visualTarget)),
  });
  const characterPage = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", variant.variant_id, null);
  const secondCharacterPage = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", variant.variant_id, null);
  await moveWorkbenchCharacterPage(fixture.root, fixture.projectId, secondCharacterPage.page_id, variant.variant_id, characterPage.page_id);
  assert.deepEqual(
    (await readPageIndex(fixture.projectDirectory)).pages.filter(p => p.owner_kind === "character").map((page) => page.page_id),
    [secondCharacterPage.page_id, characterPage.page_id],
  );
  await assert.rejects(
    () => deleteWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", variant.variant_id),
    (error) => error?.code === "character_variant_still_in_use",
  );
  await deleteWorkbenchCharacterPage(fixture.root, fixture.projectId, characterPage.page_id);
  await deleteWorkbenchCharacterPage(fixture.root, fixture.projectId, secondCharacterPage.page_id);
  await deleteWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", variant.variant_id);
  assert.deepEqual((await readJson(path.join(fixture.projectDirectory, "characters", "ellen.visual.json"))).variants.map((variant) => variant.id), ["default"]);
  assert.deepEqual(Object.keys((await readJson(promptTarget)).variants), ["default"], "删除子设定会在同一动作中清理对应 Prompt/LoRA");
});

const readOutline = (fixture) => readJson(path.join(fixture.projectDirectory, "story", "outline.json"));
const readStoryIndex = fixture => readStoryPagesIndex(fixture.projectDirectory);
const readCharacterPagesIndex = async fixture => ({ pages: (await readPageIndex(fixture.projectDirectory)).pages.filter(p => p.owner_kind === "character") });
const readVisual = (fixture, characterId) => readJson(path.join(fixture.projectDirectory, "characters", `${characterId}.visual.json`));

test("锚点移动覆盖章节、情节单元、剧情页与子设定，自我锚点是 no-op，缺失锚点报错", async (context) => {
  const fixture = await createFixture(context);
  const ending = await createWorkbenchChapter(fixture.root, fixture.projectId, "收场");

  await moveWorkbenchChapter(fixture.root, fixture.projectId, ending.chapter_id, "opening");
  assert.deepEqual((await readOutline(fixture)).chapters.map((chapter) => chapter.id), [ending.chapter_id, "opening"]);
  await moveWorkbenchChapter(fixture.root, fixture.projectId, ending.chapter_id, null);
  assert.deepEqual((await readOutline(fixture)).chapters.map((chapter) => chapter.id), ["opening", ending.chapter_id]);
  await moveWorkbenchChapter(fixture.root, fixture.projectId, "opening", "opening");
  assert.deepEqual((await readOutline(fixture)).chapters.map((chapter) => chapter.id), ["opening", ending.chapter_id], "自我锚点是合法 no-op");
  await assert.rejects(
    () => moveWorkbenchChapter(fixture.root, fixture.projectId, "opening", "missing-chapter"),
    (error) => error?.code === "story_chapter_not_found",
  );

  const farewell = await createWorkbenchSequence(fixture.root, fixture.projectId, ending.chapter_id, "告别");
  await moveWorkbenchSequence(fixture.root, fixture.projectId, "meeting", ending.chapter_id, null);
  let outline = await readOutline(fixture);
  assert.deepEqual(outline.chapters[0].sequences.map((sequence) => sequence.id), ["arrival"]);
  assert.deepEqual(outline.chapters[1].sequences.map((sequence) => sequence.id), [farewell.sequence_id, "meeting"], "跨 chapter 移动默认排到组尾");
  await moveWorkbenchSequence(fixture.root, fixture.projectId, "arrival", ending.chapter_id, "meeting");
  outline = await readOutline(fixture);
  assert.deepEqual(outline.chapters[1].sequences.map((sequence) => sequence.id), [farewell.sequence_id, "arrival", "meeting"], "跨 chapter 移动并定位到锚点前");
  await moveWorkbenchSequence(fixture.root, fixture.projectId, "arrival", ending.chapter_id, "arrival");
  assert.deepEqual((await readOutline(fixture)).chapters[1].sequences.map((sequence) => sequence.id),
    [farewell.sequence_id, "arrival", "meeting"], "自我锚点是合法 no-op");
  await assert.rejects(
    () => moveWorkbenchSequence(fixture.root, fixture.projectId, "arrival", ending.chapter_id, "missing-sequence"),
    (error) => error?.code === "story_sequence_not_found",
  );

  const firstPage = await createWorkbenchStoryPage(fixture.root, fixture.projectId, "arrival");
  const secondPage = await createWorkbenchStoryPage(fixture.root, fixture.projectId, "arrival");
  const thirdPage = await createWorkbenchStoryPage(fixture.root, fixture.projectId, "meeting");
  await moveWorkbenchStoryPage(fixture.root, fixture.projectId, secondPage.page_id, "meeting", thirdPage.page_id);
  assert.deepEqual((await readStoryIndex(fixture)).by_sequence, {
    arrival: [firstPage.page_id],
    meeting: [secondPage.page_id, thirdPage.page_id],
  }, "跨 sequence 移动到锚点前");
  await moveWorkbenchStoryPage(fixture.root, fixture.projectId, firstPage.page_id, "meeting", null);
  assert.deepEqual((await readStoryIndex(fixture)).by_sequence, {
    meeting: [secondPage.page_id, thirdPage.page_id, firstPage.page_id],
  }, "锚点为 null 跨 sequence 排到组尾");
  await moveWorkbenchStoryPage(fixture.root, fixture.projectId, firstPage.page_id, "meeting", secondPage.page_id);
  assert.deepEqual((await readStoryIndex(fixture)).by_sequence.meeting,
    [firstPage.page_id, secondPage.page_id, thirdPage.page_id], "组内锚点重排");
  await moveWorkbenchStoryPage(fixture.root, fixture.projectId, firstPage.page_id, "meeting", firstPage.page_id);
  assert.deepEqual((await readStoryIndex(fixture)).by_sequence.meeting,
    [firstPage.page_id, secondPage.page_id, thirdPage.page_id], "自我锚点是合法 no-op");
  await assert.rejects(
    () => moveWorkbenchStoryPage(fixture.root, fixture.projectId, firstPage.page_id, "meeting", "page-000000000000"),
    (error) => error?.code === "page_anchor_not_found",
  );
  await assert.rejects(
    () => moveWorkbenchStoryPage(fixture.root, fixture.projectId, firstPage.page_id, "arrival", thirdPage.page_id),
    (error) => error?.code === "page_anchor_not_found",
  );

  await createWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "casual", "便服");
  await createWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "formal", "正装");
  const variantIds = async () => (await readVisual(fixture, "ellen")).variants.map((variant) => variant.id);
  assert.deepEqual(await variantIds(), ["default", "casual", "formal"]);
  await moveWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "formal", "default");
  assert.deepEqual(await variantIds(), ["formal", "default", "casual"]);
  await moveWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "formal", null);
  assert.deepEqual(await variantIds(), ["default", "casual", "formal"], "锚点为 null 排到组尾");
  await moveWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "formal", "formal");
  assert.deepEqual(await variantIds(), ["default", "casual", "formal"], "自我锚点是合法 no-op");
  await assert.rejects(
    () => moveWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "formal", "missing-variant"),
    (error) => error?.code === "character_variant_not_found",
  );
});

test("角色视觉页锚点移动支持同 variant 重排、跨 variant 移动并拒绝组外锚点", async (context) => {
  const fixture = await createFixture(context);
  const casual = await createWorkbenchCharacterVariant(fixture.root, fixture.projectId, "ellen", "casual", "便服");
  const promptTarget = path.join(fixture.projectDirectory, "characters", "ellen.prompt.json");
  const prompt = await readJson(promptTarget);
  prompt.variants[casual.variant_id] = structuredClone(prompt.variants.default);
  const visualTarget = path.join(fixture.projectDirectory, "characters", "ellen.visual.json");
  await saveCharacterPrompt(fixture.root, fixture.projectId, {
    character_id: "ellen", prompt, expected_sha256: hashCanonicalJson(await readJson(promptTarget)),
    expected_visual_sha256: hashCanonicalJson(await readJson(visualTarget)),
  });
  const first = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", "default", null);
  const second = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", "default", null);
  const third = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", "casual", null);
  const pageOrder = async () => (await readCharacterPagesIndex(fixture)).pages.map((page) => [page.page_id, page.variant_id]);

  await moveWorkbenchCharacterPage(fixture.root, fixture.projectId, second.page_id, "default", first.page_id);
  assert.deepEqual(await pageOrder(),
    [[second.page_id, "default"], [first.page_id, "default"], [third.page_id, "casual"]], "同 variant 锚点重排");
  const firstContent = await readJson(first.content_file);
  await moveWorkbenchCharacterPage(fixture.root, fixture.projectId, first.page_id, "casual", third.page_id);
  assert.deepEqual(await readJson(first.content_file), firstContent, "移动归属不改变画面角色引用");
  assert.deepEqual(await pageOrder(),
    [[second.page_id, "default"], [first.page_id, "casual"], [third.page_id, "casual"]], "跨 variant 移动到锚点前");
  await moveWorkbenchCharacterPage(fixture.root, fixture.projectId, third.page_id, "default", null);
  assert.deepEqual(await pageOrder(),
    [[second.page_id, "default"], [third.page_id, "default"], [first.page_id, "casual"]], "锚点为 null 排到目标 variant 组尾");
  await moveWorkbenchCharacterPage(fixture.root, fixture.projectId, second.page_id, "default", second.page_id);
  assert.deepEqual(await pageOrder(),
    [[second.page_id, "default"], [third.page_id, "default"], [first.page_id, "casual"]], "自我锚点是合法 no-op");
  await assert.rejects(
    () => moveWorkbenchCharacterPage(fixture.root, fixture.projectId, second.page_id, "default", "page-000000000000"),
    (error) => error?.code === "page_anchor_not_found",
  );
  await assert.rejects(
    () => moveWorkbenchCharacterPage(fixture.root, fixture.projectId, second.page_id, "default", first.page_id),
    (error) => error?.code === "page_anchor_not_found",
  );
  await createWorkbenchCharacter(fixture.root, fixture.projectId, "vivi", "薇薇");
  const foreign = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "vivi", "default", null);
  await assert.rejects(
    () => moveWorkbenchCharacterPage(fixture.root, fixture.projectId, second.page_id, "default", foreign.page_id),
    (error) => error?.code === "page_anchor_not_found",
  );
});

test("duplicateStoryPage 复制 narrative/prompt、紧随源页插入 index 并复制嵌字布局", async (context) => {
  const fixture = await createFixture(context);
  const source = await createWorkbenchStoryPage(fixture.root, fixture.projectId, "arrival");
  const neighbor = await createWorkbenchStoryPage(fixture.root, fixture.projectId, "arrival");
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "雨夜对话",
    scene_description: "艾莲在屋檐下停步。",
    characters: [{ character_id: "ellen", variant_id: "default" }],
    dialogue: [{ id: "dialogue-aaaa00000001", mode: "speech", speaker: "ellen", text: "下雨了。" }],
  };
  await writeFile(source.content_file, `${JSON.stringify(narrative, null, 2)}\n`, "utf8");
  const prompt = await readJson(source.prompt_file);
  prompt.setting.push({ id: "token-aaaa00000001", description: "rain on eaves",  enabled: true });
  await writeFile(source.prompt_file, `${JSON.stringify(prompt, null, 2)}\n`, "utf8");
  const letteringTarget = path.join(fixture.projectDirectory, "lettering", "dialogue-layouts.json");
  const lettering = await readJson(letteringTarget);
  lettering.pages.push({
    page: source.page_id,
    items: [{ dialogue_id: "dialogue-aaaa00000001", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }],
  });
  await writeFile(letteringTarget, `${JSON.stringify(lettering, null, 2)}\n`, "utf8");

  const duplicated = await duplicateWorkbenchStoryPage(fixture.root, fixture.projectId, source.page_id);

  assert.notEqual(duplicated.page_id, source.page_id);
  assert.deepEqual(await readJson(path.join(fixture.projectDirectory, `pages/${duplicated.page_id}.content.json`)), { ...narrative, title: `${narrative.title} 副本` });
  assert.deepEqual(await readJson(path.join(fixture.projectDirectory, `pages/${duplicated.page_id}.prompt.json`)), prompt);
  assert.deepEqual((await readStoryIndex(fixture)).by_sequence.arrival,
    [source.page_id, duplicated.page_id, neighbor.page_id], "副本紧随源页");
  const layouts = await readJson(letteringTarget);
  assert.deepEqual(layouts.pages.map((page) => page.page), [source.page_id, duplicated.page_id]);
  assert.deepEqual(layouts.pages[1].items, lettering.pages[0].items, "嵌字条目复制且对白 id 引用仍有效");

  const duplicatedNeighbor = await duplicateWorkbenchStoryPage(fixture.root, fixture.projectId, neighbor.page_id);
  assert.deepEqual((await readStoryIndex(fixture)).by_sequence.arrival,
    [source.page_id, duplicated.page_id, neighbor.page_id, duplicatedNeighbor.page_id]);
  assert.deepEqual((await readJson(letteringTarget)).pages.map((page) => page.page),
    [source.page_id, duplicated.page_id], "源页没有嵌字条目时不新增");
  await assert.rejects(
    () => duplicateWorkbenchStoryPage(fixture.root, fixture.projectId, "page-000000000000"),
    (error) => error?.code === "page_not_found",
  );
});

test("duplicateCharacterPage 复制 goal/prompt 并紧随源条目插入 index", async (context) => {
  const fixture = await createFixture(context);
  const source = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", "default", null);
  const neighbor = await createWorkbenchCharacterPage(fixture.root, fixture.projectId, "ellen", "default", null);
  const goal = await readJson(source.content_file);
  goal.title = "原视觉页";
  goal.scene_description = "红眼短发的标准立绘。";
  await writeFile(source.content_file, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
  const prompt = await readJson(source.prompt_file);
  prompt.person.push({ id: "token-bbbb00000001", description: "short red hair",  enabled: true });
  await writeFile(source.prompt_file, `${JSON.stringify(prompt, null, 2)}\n`, "utf8");

  const duplicated = await duplicateWorkbenchCharacterPage(fixture.root, fixture.projectId, source.page_id);


  assert.notEqual(duplicated.page_id, source.page_id);
  assert.deepEqual(await readJson(path.join(fixture.projectDirectory, `pages/${duplicated.page_id}.content.json`)), { ...goal, title: `${goal.title} 副本` });
  assert.deepEqual(await readJson(path.join(fixture.projectDirectory, `pages/${duplicated.page_id}.prompt.json`)), prompt);
  assert.deepEqual((await readCharacterPagesIndex(fixture)).pages.map((page) => page.page_id),
    [source.page_id, duplicated.page_id, neighbor.page_id], "副本紧随源条目");
  await assert.rejects(
    () => duplicateWorkbenchCharacterPage(fixture.root, fixture.projectId, "page-000000000000"),
    (error) => error?.code === "page_not_found",
  );
});


test("场景导航管理子设定，共同页面移动仅改变归属", async context => {
  const fixture = await createFixture(context);
  const { root, projectId, projectDirectory } = fixture;
  await createWorkbenchScene(root, projectId, "station", "车站");
  await createWorkbenchSceneVariant(root, projectId, "station", "night", "夜晚");
  await moveWorkbenchSceneVariant(root, projectId, "station", "night", "default");
  assert.deepEqual((await readJson(path.join(projectDirectory, "scenes/station.visual.json"))).variants.map(v => v.id), ["night", "default"]);
  const page = await createWorkbenchPage(root, projectId, { owner_kind: "scene", scene_id: "station", variant_id: "night" });
  const prompt = await readJson(page.prompt_file), content = await readJson(page.content_file);
  assert.equal(prompt.scene_id, "station"); assert.equal(prompt.scene_variant_id, "night");
  await moveWorkbenchPage(root, projectId, page.page_id, { owner_kind: "character", character_id: "ellen", variant_id: "default" });
  assert.deepEqual(await readJson(page.prompt_file), prompt);
  assert.deepEqual(await readJson(page.content_file), content);
  await assert.rejects(deleteWorkbenchSceneVariant(root, projectId, "station", "night"), error => error.code === "scene_variant_still_in_use");
  const entry = (await readPageIndex(projectDirectory)).pages.find(p => p.page_id === page.page_id);
  assert.deepEqual(entry, { page_id: page.page_id, owner_kind: "character", character_id: "ellen", variant_id: "default" });
});
