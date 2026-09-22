import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import {PAGES_INDEX_SCHEMA_ID} from '../server/pages-store.mjs';
import { defaultTextPageLayout } from "../shared/text-page-layout.mjs";
import { createStoryPage, deleteStoryPage } from "../server/story-facts.mjs";
import { deleteCharacter } from "../server/character-facts.mjs";
import { deleteCharacterPage } from "../server/character-page-facts.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PAGE_GOAL_SCHEMA_ID,
  CHARACTER_PAGES_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
} from "../server/character-files.mjs";
import { candidateFileRelativePath, publishCandidateResult } from "../server/candidate-storage.mjs";
import { warmMediaVariants } from "../server/media-variants.mjs";
import { deletePageCandidateById, deletePageCandidates } from "../server/candidate-delete.mjs";
import { compilePageRenderInspectionContext, compilePageRenderTarget } from "../server/page-render-resolver.mjs";
import { inspectionGenerationSignature } from "../server/generation-signature.mjs";
import { createCharacterPageKey, createStoryPageKey } from "../server/page-key.mjs";
import { createRenderTask, readRenderTask, updateRenderTask } from "../server/render-task-storage.mjs";
import { copyProject } from "../server/project-management.mjs";
import { createPageMediaReader, isPageMediaChange, readPageMedia } from "../server/page-media.mjs";
import { withCandidateMutationLock } from "../server/candidate-mutation-lock.mjs";
import {
  readPageCandidateDetail,
  readProjectWorkbenchView,
  saveCharacterProfile,
  saveCharacterPrompt as saveCharacterPromptDirect,
  saveCharacterVisual,
  saveLetteringSettings,
  savePageContent,
  savePageLettering,
  savePagePrompt,
  saveStorySummary,
} from "../server/project-workbench.mjs";
import { defaultLetteringSettings } from "../server/lettering-settings.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGES_INDEX_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
} from "../server/story-files.mjs";
import { factStorage as storage } from "../server/story-facts.mjs";

const saveCharacterPrompt = saveCharacterPromptDirect;
const sourceRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

function emptyPrompt(schema = STORY_PAGE_PROMPT_SCHEMA_ID) {
  return { $schema: schema, text: "" };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-workbench-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectId = "demo";
  const directory = path.join(root, "workspace", projectId);
  const storyPrompt = { ...emptyPrompt(), text: "艾莲走入柔和晨光。" };
  await writeJson(path.join(directory, "project.json"), {
    format: "story-free-text-v1", title: "短篇", canvas: "2:3", default_render_profile: "qwen-image-2-1",
  });
  await writeJson(path.join(directory, "story", "outline.json"), {
    $schema: STORY_OUTLINE_SCHEMA_ID, synopsis: "一次短暂相遇。",
    chapters: [{ id: "opening", title: "开场", summary: "角色相遇。", sequences: [{ id: "arrival", title: "抵达", summary: "艾莲出现。" }] }],
  });
  await writeJson(path.join(directory, "pages", "index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [{page_id:"page-001",owner_kind:"story",sequence_id:"arrival"},{page_id:"page-101",owner_kind:"character",character_id:"ellen",variant_id:"default"}] });
  await writeJson(path.join(directory, "pages", "page-001.content.json"), {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "抵达", scene_description: "艾莲走入晨光。", characters: [{ character_id: "ellen", variant_id: "default" }], dialogue: [],
  });
  await writeJson(path.join(directory, "pages", "page-001.prompt.json"), storyPrompt);
  await writeJson(path.join(directory, "characters", "index.json"), { $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["ellen"] });
  await writeJson(path.join(directory, "characters", "ellen.profile.json"), { $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "艾莲", description: "短篇主角。" });
  await writeJson(path.join(directory, "characters", "ellen.visual.json"), { $schema: CHARACTER_VISUAL_SCHEMA_ID, description: "银发少女。", variants: [{ id: "default", name: "默认", description: "基础形象。" }, { id: "casual", name: "便服", description: "日常便服。" }] });
  await writeJson(path.join(directory, "characters", "ellen.prompt.json"), {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    prompt_name: "艾莲",
    variants: {
      default: { text: "艾莲，银发少女。", reference_images: [] },
      casual: { text: "穿便服的艾莲。", reference_images: [] },
    },
  });
  await writeJson(path.join(directory, "pages", "page-101.content.json"), { $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "基础形象", scene_description: "展示艾莲基础形象。", characters:[{character_id:"ellen",variant_id:"default"}], dialogue:[] });
  await writeJson(path.join(directory, "pages", "page-101.prompt.json"), emptyPrompt());
  await writeJson(path.join(directory, "lettering", "dialogue-layouts.json"), { $schema: "https://storyvisualizer.local/schemas/lettering.schema.json", version: 2, pages: [] });
  await writeJson(path.join(directory, "lettering", "settings.json"), { ...defaultLetteringSettings(), font_size: 42, character_colors: { ellen: "#112233" } });

  const candidateId = "candidate-11111111-1111-4111-8111-111111111111";
  const candidateFile = candidateFileRelativePath(createStoryPageKey("page-001"), candidateId);
  const renderTask = {
    version: 2, id: "render-20260826T010203Z", project: projectId, purpose: "candidate", status: "queued",
    created_at: "2026-08-26T01:02:03.000Z",
    render_profile: "qwen-image-2-1",
    snapshot: {
      canvas: "2:3",
      effective_profile_sha256: "e".repeat(64),
      profile: {
        id: "qwen-image-2-1", name: "Qwen-Image-2.1", prompt: { text: "全局文字。" },
        models: { dit: { filename: "qwen.safetensors", kind: "dit", sha256: "a".repeat(64) } },
      },
      source_identity: { recipes: { "qwen-image-2-1-candidate": { sha256: "b".repeat(64) } } },
      execution_units: [{
        id: "unit-0001", item_ids: ["item-001"], batch: false, canonical_sha256: "c".repeat(64),
        render_route: { operation: "candidates", input_source: "empty_latent", recipe_source_id: "qwen-image-2-1-candidate", recipe_instance_id: `qwen-image-2-1-candidate@${"d".repeat(64)}`, workflow_id: "qwen-image-2-1-text" },
        recipe: { source_id: "qwen-image-2-1-candidate", instance_id: `qwen-image-2-1-candidate@${"d".repeat(64)}`, source_canonical_sha256: "f".repeat(64), resolved_parameters: { dimensions: { width: 960, height: 1440 }, steps: 30, cfg: 5, sampler: "euler", scheduler: "simple", clip_skip: 2 }, resolved_canonical_sha256: "1".repeat(64) },
        workflow: { source_id: "qwen-image-2-1-text", template_sha256: "2".repeat(64), manifest_sha256: "3".repeat(64), canonical_sha256: "4".repeat(64), api: { "1": { class_type: "KSampler" } } },
        outputs: [{ node_id: "9", image_index: 0, item_id: "item-001", file: candidateFile, promotion: { kind: "none" } }],
        extra_data: { extra_pnginfo: { storyvisualizer: { outputs: [{ item_id: "item-001", image_index: 0, declared_seed: 17, effective_seed: 17 }] } } },
      }],
    },
    items: [{
      id: "item-001", candidate_id: candidateId, page_key: createStoryPageKey("page-001"), file: candidateFile,
      absolute_file: "D:/stale/location.png", status: "queued", seed: 17,
      positive_prompt: "ellen, warm light", negative_prompt: "",
      prompt_parts: { sections: [{ kind: "page", text: "warm light" }] },
      loras: [{ kind: "character", owner: "ellen", filename: "ellen.safetensors", weight: 0.8, sha256: "6".repeat(64) }],
    }],
  };
  await createRenderTask(directory, renderTask, {
    project_title: "短篇",
    pages: [{ page_key: createStoryPageKey("page-001"), page_id: "page-001", order: 1, title: "抵达", owner_label: "抵达" }],
  });
  await updateRenderTask(directory, renderTask.id, (task) => {
    task.status = "completed";
    task.completed_at = "2026-08-26T01:02:13.000Z";
    task.items[0].status = "available";
    task.items[0].generated_at = "2026-08-26T01:02:13.000Z";
  });
  const completed = (await readRenderTask(directory, renderTask.id)).task;
  await publishCandidateResult(directory, completed, completed.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
  registerFixtureProjects(root); return { root, projectId, directory, candidateId, candidateFile, storyPrompt };
}

test("workbench只组织页面事实，候选媒体按完整PageKey独立读取", async (context) => {
  const current = await fixture(context);
  const view = await readProjectWorkbenchView(current.root, current.projectId);
  const page = view.outline.chapters[0].sequences[0].pages[0];
  assert.equal(view.outline.chapters[0].sequences[0].pages[0].title, "抵达");
  assert.equal(view.characters[0].pages[0].kind, "character");
  assert.equal(Object.hasOwn(page, "media"), false, "工作台事实响应不应扫描或内嵌派生媒体");
  const pageMedia = await readPageMedia(current.root, current.projectId, { page_key: page.page_key });
  assert.deepEqual(pageMedia.media.candidates.map(({ candidate_id, file, generated_at }) => ({ candidate_id, file, generated_at })), [{
    candidate_id: current.candidateId,
    file: current.candidateFile,
    generated_at: "2026-08-26T01:02:13.000Z",
  }]);
  assert.equal(Object.hasOwn(pageMedia.media.candidates[0], "absolute_path"), false, "浏览器媒体投影不公开本机绝对路径");
  await rm(path.join(current.directory, "Saved"), { recursive: true });
  assert.equal((await readPageCandidateDetail(current.root, current.projectId, { page_key: page.page_key, candidate_id: current.candidateId })).seed, 17);
  assert.deepEqual(
    (await readPageMedia(current.root, current.projectId, { page_key: page.page_key })).media.candidates.map((candidate) => candidate.candidate_id),
    [current.candidateId],
    "清理运行目录后列表与详情仍完整",
  );
  assert.equal(Object.hasOwn(view.outline.chapters[0].sequences[0].pages[0], "seed"), false, "页面事实不应暴露seed");
  const source = JSON.stringify(view);
  for (const forbidden of ["assessment", "criteria", "prompt_references", "visual_entities", "cover_page_id"]) {
    assert.equal(source.includes(`\"${forbidden}\"`), false, `view不应包含${forbidden}`);
  }
});

test("页面 Prompt 整段保存本页文字并阻止陈旧覆盖", async (context) => {
  const current = await fixture(context);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const prompt = structuredClone(page.prompt);
  prompt.text = "艾莲停在门口，半身镜头。";
  prompt.text_overrides = { "character:ellen:default": "本页覆盖的角色描述" };
  const result = await savePagePrompt(current.root, current.projectId, {
    kind: "story", page_id: "page-001", prompt, expected_sha256: page.prompt_sha256, expected_context_sha256: page.prompt_context_sha256,
  });
  const persisted = await readJson(path.join(current.directory, "pages", "page-001.prompt.json"));
  assert.equal(persisted.text, "艾莲停在门口，半身镜头。");
  assert.deepEqual(persisted.text_overrides, { "character:ellen:default": "本页覆盖的角色描述" });
  assert.equal(result.prompt.text, persisted.text);
  await assert.rejects(
    savePagePrompt(current.root, current.projectId, { kind: "story", page_id: "page-001", prompt, expected_sha256: page.prompt_sha256, expected_context_sha256: page.prompt_context_sha256 }),
    (error) => error?.code === "prompt_target_conflict" && error.status === 409,
  );
  assert.match(result.prompt_sha256, /^[a-f0-9]{64}$/);
});

test("角色 Prompt 一次保存 prompt_name 与各造型自由文本", async (context) => {
  const current = await fixture(context);
  const character = (await readProjectWorkbenchView(current.root, current.projectId)).characters[0];
  const prompt = structuredClone(character.prompt);
  prompt.prompt_name = "艾莲·乔";
  prompt.variants.default.text = "艾莲，银发少女，琥珀色眼睛。";
  prompt.variants.casual.text = "穿针织开衫的艾莲。";
  const result = await saveCharacterPrompt(current.root, current.projectId, {
    character_id: character.id,
    prompt,
    expected_sha256: character.prompt_sha256,
    expected_visual_sha256: character.visual_sha256,
  });
  const persisted = await readJson(path.join(current.directory, "characters", "ellen.prompt.json"));
  assert.equal(persisted.prompt_name, "艾莲·乔");
  assert.equal(persisted.variants.default.text, "艾莲，银发少女，琥珀色眼睛。");
  assert.equal(persisted.variants.casual.text, "穿针织开衫的艾莲。");
  assert.equal(result.prompt.prompt_name, "艾莲·乔");
  assert.equal(Object.hasOwn(result.prompt, "$schema"), false);
  assert.match(result.prompt_sha256, /^[a-f0-9]{64}$/);
});

test("角色 profile 与 visual 分文件保存并以各自目标SHA阻止陈旧覆盖", async (context) => {
  const current = await fixture(context);
  const character = (await readProjectWorkbenchView(current.root, current.projectId)).characters[0];
  assert.match(character.profile_sha256, /^[a-f0-9]{64}$/);
  assert.match(character.visual_sha256, /^[a-f0-9]{64}$/);

  const profile = { name: "艾莲·乔", description: "短篇主角，表面从容。" };
  const profileResult = await saveCharacterProfile(current.root, current.projectId, {
    character_id: character.id,
    profile,
    expected_sha256: character.profile_sha256,
  });
  assert.deepEqual(profileResult.profile, profile);
  assert.deepEqual(
    await readJson(path.join(current.directory, "characters", "ellen.profile.json")),
    { $schema: CHARACTER_PROFILE_SCHEMA_ID, ...profile },
  );
  await assert.rejects(
    saveCharacterProfile(current.root, current.projectId, {
      character_id: character.id,
      profile: { ...profile, description: "陈旧覆盖" },
      expected_sha256: character.profile_sha256,
    }),
    (error) => error?.code === "character_profile_target_conflict" && error.status === 409,
  );

  const visual = structuredClone(character.visual);

  visual.variants[0].name = "日常服";
  const visualResult = await saveCharacterVisual(current.root, current.projectId, {
    character_id: character.id,
    visual,
    expected_sha256: character.visual_sha256,
  });
  assert.deepEqual(visualResult.visual, visual);
  await assert.rejects(
    saveCharacterVisual(current.root, current.projectId, {
      character_id: character.id,
      visual,
      expected_sha256: character.visual_sha256,
    }),
    (error) => error?.code === "character_visual_target_conflict" && error.status === 409,
  );
});

test("角色 visual 内容入口拒绝结构变化，Prompt 允许缺少下游 variant 但拒绝悬空 key 与 visual 漂移", async (context) => {
  const current = await fixture(context);
  const character = (await readProjectWorkbenchView(current.root, current.projectId)).characters[0];
  await assert.rejects(
    saveCharacterVisual(current.root, current.projectId, {
      character_id: character.id,
      visual: {
        ...structuredClone(character.visual),
        variants: [
          ...structuredClone(character.visual.variants),
          { id: "uniform", name: "制服", description: "学校制服。" },
        ],
      },
      expected_sha256: character.visual_sha256,
    }),
    (error) => error?.code === "character_visual_structure_change_forbidden" && error.status === 409,
  );

  const promptWithoutVariant = structuredClone(character.prompt);
  delete promptWithoutVariant.variants.casual;
  const removedPrompt = await saveCharacterPrompt(current.root, current.projectId, {
    character_id: character.id,
    prompt: promptWithoutVariant,
    expected_sha256: character.prompt_sha256,
    expected_visual_sha256: character.visual_sha256,
  });
  assert.deepEqual(Object.keys(removedPrompt.prompt.variants), ["default"], "下游 Prompt 可以先于上游 visual variant 清理");

  const promptWithDanglingVariant = structuredClone(removedPrompt.prompt);
  promptWithDanglingVariant.variants.unknown = structuredClone(promptWithDanglingVariant.variants.default);
  await assert.rejects(
    saveCharacterPrompt(current.root, current.projectId, {
      character_id: character.id,
      prompt: promptWithDanglingVariant,
      expected_sha256: removedPrompt.prompt_sha256,
      expected_visual_sha256: character.visual_sha256,
    }),
    (error) => error?.code === "character_prompt_visual_conflict" && error.status === 409,
  );

  const visualFile = path.join(current.directory, "characters", "ellen.visual.json");
  const changedVisual = await readJson(visualFile);
  changedVisual.description = "另一个写入者已经修改视觉描述。";
  await writeJson(visualFile, changedVisual);
  await assert.rejects(
    saveCharacterPrompt(current.root, current.projectId, {
      character_id: character.id,
      prompt: structuredClone(removedPrompt.prompt),
      expected_sha256: removedPrompt.prompt_sha256,
      expected_visual_sha256: character.visual_sha256,
    }),
    (error) => error?.code === "character_prompt_visual_conflict" && error.status === 409,
  );
});

test("文字页：创建、内容保存携带正文、类型不可改写、生成被拒绝", async (context) => {
  const current = await fixture(context);
  const created = await createStoryPage(current.root, current.projectId, "arrival", { pageKind: "text" });
  const view = await readProjectWorkbenchView(current.root, current.projectId);
  const page = view.outline.chapters[0].sequences[0].pages.find((entry) => entry.page_id === created.page_id);
  assert.equal(page.page_kind, "text");
  assert.equal(page.body, "");
  const content = { title: "后记", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: "作者的话。", display_title: "", text_layout: { ...defaultTextPageLayout, body_font_size: 36, body_align: "left", position: "upper" } };
  const saved = await savePageContent(current.root, current.projectId, { page_key: page.page_key, content, expected_sha256: page.content_sha256 });
  assert.equal(saved.content.body, "作者的话。");
  const persisted = await readJson(path.join(current.directory, "pages", `${created.page_id}.content.json`));
  assert.equal(persisted.page_kind, "text");
  assert.equal(persisted.body, "作者的话。");
  assert.equal(persisted.title, "后记");
  assert.equal(persisted.display_title, "");
  assert.deepEqual(persisted.text_layout, content.text_layout);
  assert.deepEqual(saved.content.text_layout, content.text_layout);
  const reloaded = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages.find(entry => entry.page_id === created.page_id);
  assert.equal(reloaded.display_title, "");
  assert.deepEqual(reloaded.text_layout, content.text_layout);
  await assert.rejects(savePageContent(current.root, current.projectId, { page_key: page.page_key, content: { ...content, text_layout: { ...content.text_layout, body_font_size: 0 } }, expected_sha256: saved.content_sha256 }), error => error.code === "invalid_story_edit_document" && error.details.some(detail => detail.includes("body_font_size")));
  await assert.rejects(savePageContent(current.root, current.projectId, { page_key: page.page_key, content: { ...content, display_title: "新标题" }, expected_sha256: page.content_sha256 }), error => error.code === "page_content_target_conflict");
  await assert.rejects(
    savePageContent(current.root, current.projectId, { page_key: page.page_key, content: { ...content, page_kind: null }, expected_sha256: saved.content_sha256 }),
    (error) => error?.code === "invalid_page_content_update",
    "页面类型创建时定死,内容保存不得改写",
  );
  await assert.rejects(
    savePageContent(current.root, current.projectId, { page_key: page.page_key, content: { title: "后记", scene_description: "", characters: [], dialogue: [] }, expected_sha256: saved.content_sha256 }),
    (error) => error?.code === "invalid_page_content_update",
    "文字页必须携带 page_kind/body",
  );
  await assert.rejects(
    compilePageRenderTarget({ repositoryRoot: current.root, projectDirectory: current.directory, pageKey: page.page_key }),
    /text_page_not_renderable/,
  );
  const inspection = await compilePageRenderInspectionContext({ repositoryRoot: current.root, projectDirectory: current.directory, pageKey: page.page_key });
  assert.ok(inspection.blockers.some((blocker) => blocker.code === "text_page_not_renderable"));
});

test("页面内容保存补对白ID，旧目标被拒绝；删除被排版引用的对白被硬拦截", async (context) => {
  const current = await fixture(context);
  let page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const content = {
    title: "抵达门口",
    scene_description: "艾莲停在门前。",
    characters: [{ character_id: "ellen", variant_id: "default" }],
    dialogue: [{ mode: "thought", speaker: "ellen", text: "就在这里。" }],
  };
  const saved = await savePageContent(current.root, current.projectId, {
    page_key: page.page_key, content, expected_sha256: page.content_sha256,
  });
  const persistedPage = await readJson(path.join(current.directory, "pages", "page-001.content.json"));
  assert.equal(persistedPage.scene_description, content.scene_description);
  assert.equal(Object.hasOwn(persistedPage, "visual_goal"), false);
  assert.match(saved.content.dialogue[0].id, /^dialogue-[a-f0-9]{12}$/);
  assert.equal((await readJson(path.join(current.directory, "pages", "page-001.content.json"))).dialogue[0].id, saved.content.dialogue[0].id);
  await assert.rejects(
    savePageContent(current.root, current.projectId, { page_key: page.page_key, content, expected_sha256: page.content_sha256 }),
    (error) => error?.code === "page_content_target_conflict" && error.status === 409,
  );

  page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  await savePageLettering(current.root, current.projectId, {
    page_key: page.page_key,
    lettering: { items: [{ dialogue_id: saved.content.dialogue[0].id, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }] },
    expected_sha256: page.layout_sha256,
  });
  const withoutDialogue = { ...saved.content, dialogue: [] };
  await assert.rejects(
    savePageContent(current.root, current.projectId, { page_key: page.page_key, content: withoutDialogue, expected_sha256: saved.content_sha256 }),
    (error) => error?.code === "page_lettering_anchor_conflict" && error.status === 409
      && error.details.some((detail) => detail.includes(saved.content.dialogue[0].id) && detail.includes("请先调整排版")),
  );
  const persistedAfterBlock = await readJson(path.join(current.directory, "pages", "page-001.content.json"));
  assert.deepEqual(persistedAfterBlock.dialogue.map((dialogue) => dialogue.id), [saved.content.dialogue[0].id], "拒绝时不得落盘");
  const layouts = await readJson(path.join(current.directory, "lettering", "dialogue-layouts.json"));
  assert.equal(layouts.pages[0].items[0].dialogue_id, saved.content.dialogue[0].id, "上游保存不隐式改写下游布局");
});

test("页面内容写入返回超长画面内容警告，精简后警告清除且不污染项目事实", async (context) => {
  const current = await fixture(context);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const content = { title: page.title, scene_description: "重".repeat(31), characters: page.characters, dialogue: page.dialogue };
  const saved = await savePageContent(current.root, current.projectId, { page_key: page.page_key, content, expected_sha256: page.content_sha256 });
  assert.equal(saved.content.scene_description, content.scene_description);
  assert.equal(saved.warnings.length, 1);
  assert.equal(saved.warnings[0].code, "scene_description_too_long");
  assert.equal(saved.warnings[0].actual_length, 31);
  assert.equal(saved.warnings[0].max_length, 20);
  assert.equal(Object.hasOwn(await readJson(path.join(current.directory, "pages/page-001.content.json")), "warnings"), false);
  const shortened = await savePageContent(current.root, current.projectId, { page_key: page.page_key, content: { ...saved.content, scene_description: "停顿时的迟疑" }, expected_sha256: saved.content_sha256 });
  assert.deepEqual(shortened.warnings, []);
  assert.equal((await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0].scene_description, "停顿时的迟疑");
});

test("总览按目标独立保存摘要，保留页面与结构并拒绝过期或越界写入", async (context) => {
  const current = await fixture(context);
  const original = await readProjectWorkbenchView(current.root, current.projectId);
  const beforeOutline = await readJson(path.join(current.directory, "story/outline.json"));
  const beforePage = await readFile(path.join(current.directory, "pages/page-001.content.json"), "utf8");
  const beforeIndex = await readFile(path.join(current.directory, "pages/index.json"), "utf8");
  const beforePrompt = await readFile(path.join(current.directory, "pages/page-001.prompt.json"), "utf8");
  const chapter = original.outline.chapters[0];
  const sequence = chapter.sequences[0];
  const requests = [
    { target: { kind: "synopsis" }, text: "新的故事梗概。", expected_sha256: original.outline.synopsis_sha256 },
    { target: { kind: "chapter", id: chapter.id }, text: "新的章节摘要。", expected_sha256: chapter.summary_sha256 },
    { target: { kind: "sequence", id: sequence.id }, text: "新的情节摘要。", expected_sha256: sequence.summary_sha256 },
  ];
  for (const request of requests) {
    const result = await saveStorySummary(current.root, current.projectId, request);
    assert.deepEqual(result.target, request.target);
    assert.equal(result.text, request.text);
    await assert.rejects(saveStorySummary(current.root, current.projectId, request), error => error.code === "story_summary_target_conflict" && error.status === 409);
  }
  const expectedOutline = structuredClone(beforeOutline);
  expectedOutline.synopsis = requests[0].text;
  expectedOutline.chapters[0].summary = requests[1].text;
  expectedOutline.chapters[0].sequences[0].summary = requests[2].text;
  assert.deepEqual(await readJson(path.join(current.directory, "story/outline.json")), expectedOutline);
  assert.equal(await readFile(path.join(current.directory, "pages/page-001.content.json"), "utf8"), beforePage);
  assert.equal(await readFile(path.join(current.directory, "pages/index.json"), "utf8"), beforeIndex);
  assert.equal(await readFile(path.join(current.directory, "pages/page-001.prompt.json"), "utf8"), beforePrompt);
  const refreshed = await readProjectWorkbenchView(current.root, current.projectId);
  assert.equal(refreshed.outline.chapters[0].sequences[0].summary, requests[2].text);
  assert.equal(refreshed.outline.chapters[0].sequences[0].pages[0].title, original.outline.chapters[0].sequences[0].pages[0].title);
  await assert.rejects(saveStorySummary(current.root, current.projectId, { ...requests[0], text: " " }), error => error.code === "invalid_story_summary_update");
  await assert.rejects(saveStorySummary(current.root, current.projectId, { ...requests[0], pages: [] }), error => error.code === "invalid_story_summary_update");
  await assert.rejects(saveStorySummary(current.root, current.projectId, { ...requests[0], target: { kind: "page", id: "page-001" } }), error => error.code === "invalid_story_summary_update");
  await assert.rejects(saveStorySummary(current.root, current.projectId, { ...requests[2], target: { kind: "sequence", id: "missing" } }), error => error.code === "story_summary_target_not_found" && error.status === 404);
});

test("候选展示在候选写锁持有期间仍可并发读取", async (context) => {
  const current = await fixture(context);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  await withCandidateMutationLock(current.root, current.projectId, async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => readPageMedia(current.root, current.projectId, { page_key: page.page_key })));
    for (const result of results) assert.deepEqual(result.page_key, page.page_key);
  });
});

test("媒体版本独立于任务历史窗口，缓存读取、跨页隔离和旧候选删除可收敛", async (context) => {
  const current = await fixture(context);
  let event;
  let clock = 0;
  let closed = false;
  const reader = createPageMediaReader({ projectRoot: current.root, now: () => clock,
    watchDirectory: (_directory, _options, callback) => { event = callback; return { on() {}, close() { closed = true; } }; },
  });
  context.after(() => reader.close());
  const story = { page_key: createStoryPageKey("page-001") };
  const character = { page_key: createCharacterPageKey("ellen", "page-101") };
  const first = await reader.read(current.projectId, story);
  assert.equal(first.media.candidates.length, 1);
  assert.strictEqual(await reader.read(current.projectId, story), first, "未变化直接复用投影");
  const other = await reader.read(current.projectId, character);
  assert.equal(other.media.candidates.length, 0);
  assert.equal(isPageMediaChange("Saved/render/progress/task.json"), false);
  assert.equal(isPageMediaChange("pages/page-001.prompt.json"), false);
  assert.equal(isPageMediaChange("Outputs\\pages\\page-001\\candidate\\result.json"), true);
  for (let index = 0; index < 9; index += 1) {
    const id = `render-20260828T01020${index}Z-${String(index).padStart(8, "0")}`;
    await createRenderTask(current.directory, { version: 2, id, project: current.projectId, purpose: "candidate", status: "queued", created_at: "2026-08-28T00:00:00Z", render_profile: "anima-base-v1", snapshot: {}, items: [] }, { project_title: "Demo", pages: [] });
    await updateRenderTask(current.directory, id, (task) => { task.status = "completed"; });
    event("rename", `Saved/render/history/${id}`);
  }
  assert.equal((await reader.read(current.projectId, story)).revision, first.revision, "其他任务不改变当前页版本");
  await deletePageCandidateById(current.root, current.projectId, story.page_key, current.candidateId);
  event("rename", current.candidateFile);
  const removed = await reader.read(current.projectId, story);
  assert.notEqual(removed.revision, first.revision);
  assert.equal(removed.media.candidates.length, 0, "旧任务删除无需进入最近历史");
  assert.equal((await reader.read(current.projectId, character)).revision, other.revision, "完整 PageKey 隔离");
  clock = 60_001;
  assert.equal((await reader.read(current.projectId, story)).revision, removed.revision, "补偿校验不制造假变化");
  reader.close(); assert.equal(closed, true);
});

test("媒体与数量通知丢失后周期补偿，缺失文件不计数", async (context) => {
  const current = await fixture(context);
  let clock = 0;
  const reader = createPageMediaReader({ projectRoot: current.root, now: () => clock, watchDirectory: () => { throw new Error("unsupported"); } });
  context.after(() => reader.close());
  const request = { page_key: createStoryPageKey("page-001") };
  const first = await reader.read(current.projectId, request);
  assert.deepEqual((await reader.counts(current.projectId)).counts, { "v3/page-001": 1 });
  // 此用例验证通知补偿；等待 fixture 发布时的预热结束，避免 Windows 文件占用干扰。
  await warmMediaVariants(current.directory, candidateFileRelativePath(request.page_key, current.candidateId));
  await rm(path.join(current.directory, candidateFileRelativePath(request.page_key, current.candidateId)));
  clock = 60_001;
  const [media, counts] = await Promise.all([reader.read(current.projectId, request), reader.counts(current.projectId)]);
  assert.notEqual(media.revision, first.revision);
  assert.deepEqual(media.media.candidates, []);
  assert.deepEqual(counts.counts, {});
});

test("成果发布立即刷新，不依赖任务available标记", async (context) => {
  const current = await fixture(context);
  let event;
  const reader = createPageMediaReader({ projectRoot: current.root, watchDirectory: (_directory, _options, callback) => {
    event = callback; return { on() {}, close() {} };
  } });
  context.after(() => reader.close());
  const pageKey = createStoryPageKey("page-001");
  const candidateId = "candidate-22222222-2222-4222-8222-222222222222";
  const file = candidateFileRelativePath(pageKey, candidateId);
  const id = "render-20260829T010203Z-eeeeeeee";
  await createRenderTask(current.directory, { version: 2, id, project: current.projectId, purpose: "candidate", status: "queued", created_at: "2026-08-29T00:00:00Z", render_profile: "anima-base-v1", snapshot: {}, items: [{ id: "item-001", candidate_id: candidateId, page_key: pageKey, file, status: "queued", seed: 2 }] }, { project_title: "Demo", pages: [] });
  const before = await reader.read(current.projectId, { page_key: pageKey });
  const task = (await readRenderTask(current.directory, id)).task;
  await publishCandidateResult(current.directory, task, task.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
  event("rename", file);
  await assert.rejects(deletePageCandidateById(current.root, current.projectId, pageKey, candidateId), error => error.code === "candidate_task_active");
  await assert.rejects(deleteStoryPage(current.root, current.projectId, pageKey.page_id), error => error.code === "page_has_active_render");
  await assert.rejects(deleteCharacter(current.root, current.projectId, "ellen"), error => error.code === "page_has_active_render");
  assert.deepEqual((await readJson(path.join(current.directory, "characters", "index.json"))).characters, ["ellen"]);
  await deleteCharacterPage(current.root, current.projectId, "page-101");
  const published = await reader.read(current.projectId, { page_key: pageKey });
  assert.notEqual(published.revision, before.revision);
  assert.equal(published.media.candidates.length, 2);
});

test("短暂写锁释放后继续操作，不重复执行写入", async (context) => {
  const current = await fixture(context);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const acquired = new Promise((resolve) => { entered = resolve; });
  const first = withCandidateMutationLock(current.root, current.projectId, async () => { entered(); await gate; });
  await acquired;
  let writes = 0;
  const waiting = withCandidateMutationLock(current.root, current.projectId, async () => { writes += 1; });
  const timer = setTimeout(release, 80);
  try { await Promise.all([first, waiting]); } finally { clearTimeout(timer); release(); }
  assert.equal(writes, 1);
});

test("爱心文案与各自的字号、旋转、种子通过现有保存链路完整往返", async (context) => {
  const current = await fixture(context);
  let page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const saved = await savePageContent(current.root, current.projectId, {
    page_key: page.page_key, expected_sha256: page.content_sha256,
    content: { title: page.title, scene_description: page.scene_description, characters: page.characters, dialogue: [{mode:"heart",text:"呜"},{mode:"heart",speaker:"ellen",text:"嗯嗯"}] },
  });
  page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const items = saved.content.dialogue.map((line,i)=>({dialogue_id:line.id,box:{x:.1+i*.3,y:.2,w:.3,h:.1},heart:{font_size:i?64:48,rotation:i?15:-8,seed:i?123:703}}));
  await savePageLettering(current.root,current.projectId,{page_key:page.page_key,expected_sha256:page.layout_sha256,lettering:{items}});
  const reloaded = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  assert.deepEqual(reloaded.dialogue,saved.content.dialogue);
  assert.deepEqual(reloaded.lettering.items,items);
});

test("单页嵌字只替换目标布局，不依赖生成图片", async (context) => {
  const current = await fixture(context);
  const narrativeFile = path.join(current.directory, "pages", "page-001.content.json");
  const narrative = await readJson(narrativeFile);
  narrative.dialogue = [{ id: "dialogue-a1b2c3d4e5f6", mode: "speech", speaker: "ellen", text: "到了。" }];
  await writeJson(narrativeFile, narrative);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const items = [{ dialogue_id: narrative.dialogue[0].id, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }];
  const saved = await savePageLettering(current.root, current.projectId, {
    page_key: page.page_key, lettering: { items }, expected_sha256: page.layout_sha256,
  });
  assert.deepEqual(saved.lettering.items, items);
  await assert.rejects(
    savePageLettering(current.root, current.projectId, { page_key: page.page_key, lettering: { items: [] }, expected_sha256: page.layout_sha256 }),
    (error) => error?.code === "page_lettering_target_conflict" && error.status === 409,
  );

});

test("旁白固定在底部字幕条，布局拒绝保存旁白位置", async (context) => {
  const current = await fixture(context);
  const narrativeFile = path.join(current.directory, "pages", "page-001.content.json");
  const narrative = await readJson(narrativeFile);
  narrative.dialogue = [{ id: "dialogue-a1b2c3d4e5f6", mode: "narration", text: "夜幕降临。" }];
  await writeJson(narrativeFile, narrative);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  await assert.rejects(
    savePageLettering(current.root, current.projectId, {
      page_key: page.page_key, expected_sha256: page.layout_sha256,
      lettering: { items: [{ dialogue_id: "dialogue-a1b2c3d4e5f6", box: { x: 0.1, y: 0.8, w: 0.6, h: 0.1 } }] },
    }),
    (error) => error?.code === "project_fact_contract_invalid" && error.details?.some((detail) => detail.includes("旁白")),
  );
});

test("候选详情可读且清理与当前 Prompt 不符的候选，不再存在选用保护", async (context) => {
  const current = await fixture(context);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  const detail = await readPageCandidateDetail(current.root, current.projectId, { page_key: page.page_key, candidate_id: current.candidateId });
  assert.deepEqual(Object.keys(detail).sort(), ["candidate_id", "completed_at", "created_at", "generation", "seed"]);
  assert.deepEqual({ candidate_id: detail.candidate_id, seed: detail.seed }, { candidate_id: current.candidateId, seed: 17 });
  assert.equal(detail.generation.profile_name, "Qwen-Image-2.1");
  assert.equal(detail.generation.canvas, "2:3");
  assert.deepEqual(detail.generation.parameters, {
    dimensions: { width: 960, height: 1440 }, steps: 30, cfg: 5, sampler: "euler", scheduler: "simple",
  });
  assert.deepEqual(detail.generation.models, [{ role: "dit", filename: "qwen.safetensors" }]);
  assert.deepEqual(detail.generation.loras, [{ kind: "character", owner: "ellen", filename: "ellen.safetensors", weight: 0.8, trigger: null }]);
  assert.equal(detail.generation.prompt.sections[0].text, "warm light");
  for (const hidden of ["task_id", "sha256", "execution_unit", "submission", "workflow", "render_route", "prompt_variation"]) {
    assert.equal(JSON.stringify(detail).includes(`\"${hidden}\"`), false, `候选详情投影不应公开 ${hidden}`);
  }

  for (const directory of ["render-profiles", "render-recipes", "workflows"]) {
    await cp(path.join(sourceRepositoryRoot, "library", directory), path.join(current.root, "library", directory), { recursive: true });
  }
  const renderContext = await compilePageRenderInspectionContext({
    repositoryRoot: current.root, projectDirectory: current.directory, pageKey: page.page_key,
  });
  const compiled = renderContext.compiled_page;
  assert.ok(compiled, "当前页面 Prompt 应能编译");
  const matchingId = "candidate-33333333-3333-4333-8333-333333333333";
  const matchingFile = candidateFileRelativePath(page.page_key, matchingId);
  await createRenderTask(current.directory, {
    version: 2, id: "render-20260830T010203Z", project: current.projectId, purpose: "candidate", status: "queued",
    created_at: "2026-08-30T01:02:03.000Z", render_profile: "qwen-image-2-1", snapshot: {
      profile: renderContext.active_profile, canvas: renderContext.project.canvas,
      recipes: { [renderContext.candidate_route.recipe_instance_id]: { parameters: renderContext.candidate_recipe } },
      workflows: { [renderContext.candidate_route.workflow_id]: renderContext.candidate_workflow },
    },
    items: [{
      id: "item-001", render_route: renderContext.candidate_route, loras: compiled.loras, candidate_id: matchingId, page_key: page.page_key, file: matchingFile, status: "queued", seed: 23,
      positive_prompt: compiled.positive_prompt, negative_prompt: compiled.negative_prompt,
    }],
  }, { project_title: "短篇", pages: [] });
  await updateRenderTask(current.directory, "render-20260830T010203Z", (task) => { task.status = "completed"; task.items[0].status = "available"; });
  const matchingTask = (await readRenderTask(current.directory, "render-20260830T010203Z")).task;
  const published = await publishCandidateResult(current.directory, matchingTask, matchingTask.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
  assert.equal(published.generation_signature, inspectionGenerationSignature(renderContext));
  assert.notEqual(published.generation_signature, "stale-generation-signature", "两个候选的 Prompt 签名应不同");

  await assert.rejects(
    deletePageCandidates(current.root, current.projectId, { page_key: page.page_key, all: true }),
    (error) => error?.code === "invalid_candidate_delete_request",
  );
  await assert.rejects(
    deletePageCandidates(current.root, current.projectId, {
      page_key: page.page_key, generation_mismatch: true,
      expected_signature: "stale-generation-signature",
    }),
    (error) => error?.code === "candidate_generation_signature_stale" && error.status === 409,
    "计数签名与服务端重算结果不一致时拒绝删除",
  );
  const overridePath = path.join(current.directory, "render-profile.override.json");
  const model = renderContext.active_profile.models.dit;
  const change = { target: "models.dit", original: { exists: true, value: model },
    project: { exists: true, value: { ...model, sha256: "f".repeat(64) } } };
  await writeFile(overridePath, JSON.stringify({ version: 1, profiles: { "qwen-image-2-1": { changes: [change] } } }));
  await assert.rejects(deletePageCandidates(current.root, current.projectId, {
    page_key: page.page_key, generation_mismatch: true, expected_signature: inspectionGenerationSignature(renderContext),
  }), { code: "candidate_generation_signature_stale" }, "模型变化而 Prompt 不变也不能沿用旧清理确认");
  change.original.value = { ...model, sha256: "e".repeat(64) };
  await writeFile(overridePath, JSON.stringify({ version: 1, profiles: { "qwen-image-2-1": { changes: [change] } } }));
  await assert.rejects(deletePageCandidates(current.root, current.projectId, {
    page_key: page.page_key, generation_mismatch: true, expected_signature: inspectionGenerationSignature(renderContext),
  }), { code: "current_prompt_unavailable" }, "配置冲突时不能用基础预览清理候选");
  await rm(overridePath);
  const cleanup = await deletePageCandidates(current.root, current.projectId, {
    page_key: page.page_key, generation_mismatch: true,
    expected_signature: inspectionGenerationSignature(renderContext),
  });
  assert.deepEqual(cleanup.deleted_candidate_ids, [current.candidateId]);
  assert.deepEqual(
    (await readPageMedia(current.root, current.projectId, { page_key: page.page_key })).media.candidates.map((candidate) => candidate.candidate_id),
    [matchingId],
  );
  const idle = await deletePageCandidates(current.root, current.projectId, { page_key: page.page_key, generation_mismatch: true });
  assert.deepEqual(idle.deleted_candidate_ids, [], "没有不符候选时不删除任何图片");
});

test("完整嵌字设置一次保存排版与角色颜色，并拒绝过期草稿", async (context) => {
  const current = await fixture(context);
  const initial = await readProjectWorkbenchView(current.root, current.projectId);
  const next = structuredClone(initial.project.lettering_settings);
  next.font_size = 36;
  next.character_colors.ellen = "#123456";
  const saved = await saveLetteringSettings(current.root, current.projectId, { settings: next, expected_sha256: initial.project.lettering_settings_sha256 });
  assert.deepEqual(await readJson(path.join(current.directory, "lettering", "settings.json")), next);
  assert.equal(saved.settings.font_size, 36);
  const reloaded = await readProjectWorkbenchView(current.root, current.projectId);
  assert.equal(reloaded.project.lettering_settings.font_size, 36);
  assert.equal(reloaded.characters[0].style.display_color, "#123456");
  await assert.rejects(
    () => saveLetteringSettings(current.root, current.projectId, { settings: initial.project.lettering_settings, expected_sha256: initial.project.lettering_settings_sha256 }),
    (error) => error?.code === "lettering_settings_conflict",
  );
});

test("数量与当前页共用单个索引：归档、Windows通知、并发和无关变化", async (context) => {
  const current = await fixture(context);
  let event;
  let watchers = 0;
  const reader = createPageMediaReader({ projectRoot: current.root, watchDirectory: (_dir, _options, callback) => {
    watchers += 1; event = callback; return { on() {}, close() {} };
  } });
  context.after(() => reader.close());
  const request = { page_key: createStoryPageKey("page-001") };
  const [counts, media] = await Promise.all([reader.counts(current.projectId), reader.read(current.projectId, request)]);
  assert.equal(watchers, 1);
  assert.equal(counts.counts["v3/page-001"], media.media.candidates.length);
  assert.strictEqual(await reader.counts(current.projectId), counts, "首个无revision消费者不会强制扫描");
  event("rename", "Outputs/characters/ellen/other.png");
  assert.equal((await reader.counts(current.projectId)).revision, counts.revision, "版本只由实际数量决定");
  await deletePageCandidateById(current.root, current.projectId, request.page_key, current.candidateId);
  event("rename", current.candidateFile.replaceAll("/", String.fromCharCode(92)));
  const [nextMedia, nextCounts] = await Promise.all([reader.read(current.projectId, request), reader.counts(current.projectId)]);
  assert.deepEqual(nextCounts.counts, {});
  assert.deepEqual(nextMedia.media.candidates, []);
});

test("项目复制只保留事实与输入，不携带候选、选用输出或任务缓存", async (context) => {
  const current = await fixture(context);
  await writeJson(path.join(current.directory, "cache", "candidate-selection-state.json"), { version: 2, pages: {} });
  await mkdir(path.join(current.directory, "output", "base"), { recursive: true });
  await writeFile(path.join(current.directory, "output", "base", "old.png"), "派生图");
  await mkdir(path.join(current.directory, "materials"), { recursive: true });
  await writeFile(path.join(current.directory, "materials", "reference.png"), "必要参考");
  const copied = await copyProject(current.root, current.projectId);
  const directory = path.join(current.root, "workspace", copied.id);
  for (const name of ["Outputs", "Saved", "cache", "output"]) {
    await assert.rejects(readFile(path.join(directory, name)), (error) => error.code === "ENOENT");
  }
  assert.equal(await readFile(path.join(directory, "materials", "reference.png"), "utf8"), "必要参考");
  assert.deepEqual(await readJson(path.join(directory, "pages", "page-001.prompt.json")), await readJson(path.join(current.directory, "pages", "page-001.prompt.json")));
  assert.ok(await readFile(path.join(current.directory, candidateFileRelativePath(createStoryPageKey("page-001"), current.candidateId))), "复制不触碰源候选");
});


test("删除角色后仍可编辑剧情页移除悬空引用，不要求先恢复已删除角色", async context => {
  const current = await fixture(context);
  const page = (await readProjectWorkbenchView(current.root, current.projectId)).outline.chapters[0].sequences[0].pages[0];
  await deleteCharacter(current.root, current.projectId, "ellen");
  const saved = await savePageContent(current.root, current.projectId, {
    page_key: page.page_key, expected_sha256: page.content_sha256,
    content: { title: "空镜", scene_description: "门口无人。", characters: [], dialogue: [] },
  });
  assert.deepEqual(saved.content.characters, []);
  assert.deepEqual(saved.content.dialogue, []);
  assert.equal((await readJson(path.join(current.directory, "pages/page-001.content.json"))).scene_description, "门口无人。");
});

test('参考图迭代保留 ID，默认/多选跟随，冲突不留垃圾，使用中禁止删除', async t => {
  const { root, directory, projectId } = await fixture(t);
  const sharp = (await import('sharp')).default;
  const { readdir, access } = await import('node:fs/promises');
  const { readReferenceLibrary, mutateReferenceLibrary } = await import('../server/reference-library.mjs');
  const { resolveReferenceEntries } = await import('../shared/reference-images.mjs');
  const { renameCharacterVariant, deleteCharacterVariant } = await import('../server/character-facts.mjs');
  const target = { kind: 'character', id: 'ellen', variant_id: 'default' };
  const image = async color => (await sharp({ create: { width: 16, height: 24, channels: 3, background: color } }).png().toBuffer()).toString('base64');
  let library = await readReferenceLibrary(root, projectId, target);
  const mutate = async value => library = await mutateReferenceLibrary(root, directory, projectId, { target, expected_sha256: library.sha256, ...value });
  await mutate({ action: 'save', title: '正面', content: await image('#123456') });
  const first = library.entries[0], source = 'character:ellen:default';
  await mutate({ action: 'save', title: '侧面', content: await image('#456789') });
  const second = library.entries[1];
  const resolve = selection => resolveReferenceEntries([{ source, entries: library.entries }], selection);
  assert.equal(resolve()[0].id, first.id);
  const beforeFiles = await readdir(path.join(directory, 'materials'));
  await assert.rejects(mutate({ action: 'save', expected_sha256: 'stale', content: await image('#ffffff') }), /reference_library_conflict/);
  assert.deepEqual(await readdir(path.join(directory, 'materials')), beforeFiles);
  await assert.rejects(mutate({ action: 'save', title: '   ', content: await image('#ffffff') }));
  assert.deepEqual(await readdir(path.join(directory, 'materials')), beforeFiles, '事实保存失败会清理预先写入的新图');
  await mutate({ action: 'reorder', ids: [second.id, first.id] });
  assert.equal(resolve()[0].id, second.id);
  assert.equal(resolve({ [source]: [first.id] })[0].file, first.file);
  assert.equal(resolve({ [source]: [] }).length, 0);
  await mutate({ action: 'save', id: first.id, content: await image('#112233') });
  const replacement = library.entries.find(e => e.id === first.id);
  assert.notEqual(replacement.file, first.file);
  assert.equal(resolve({ [source]: [first.id] })[0].file, replacement.file);
  await assert.rejects(access(path.join(directory, 'materials', first.file)), /ENOENT/);
  const promptFile = path.join(directory, 'pages/page-001.prompt.json');
  const pagePrompt = await readJson(promptFile); pagePrompt.reference_overrides = { [source]: [first.id] }; await writeJson(promptFile, pagePrompt);
  await assert.rejects(mutate({ action: 'delete', id: first.id }), error => error.code === 'reference_image_in_use' && error.details.includes('pages/page-001.prompt.json'));
  await access(path.join(directory, 'materials', replacement.file));
  await renameCharacterVariant(root, projectId, 'ellen', 'default', 'renamed');
  const updated = await readJson(promptFile);
  assert.deepEqual(updated.reference_overrides, { 'character:ellen:renamed': [first.id] });
  target.variant_id = 'casual'; library = await readReferenceLibrary(root, projectId, target);
  await mutate({ action: 'save', content: await image('#223344') });
  const removed = library.entries[0];
  await deleteCharacterVariant(root, projectId, 'ellen', 'casual');
  await assert.rejects(access(path.join(directory, 'materials', removed.file)), /ENOENT/);
});

test('候选提升为参考图后可独立清理，删除页面同时清理附加图片', async t => {
  const { root, directory, projectId, candidateId } = await fixture(t);
  const { readReferenceLibrary, mutateReferenceLibrary } = await import('../server/reference-library.mjs');
  const { access } = await import('node:fs/promises');
  const target = { kind: 'page', id: 'page-001' };
  const before = await readReferenceLibrary(root, projectId, target);
  const result = await mutateReferenceLibrary(root, directory, projectId, { target, expected_sha256: before.sha256, action: 'save', candidate_id: candidateId, page_key: { page_id: 'page-001' } });
  const image = path.join(directory, 'materials', result.entries[0].file);
  await deletePageCandidateById(root, projectId, { page_id: 'page-001' }, candidateId);
  await access(image);
  await deleteStoryPage(root, projectId, 'page-001');
  await assert.rejects(access(image), /ENOENT/);
});


test('Agent事实保存也保护手动引用并清理移除的参考图', async t => {
 const {root,directory,projectId}=await fixture(t);
 const {readReferenceLibrary,mutateReferenceLibrary}=await import('../server/reference-library.mjs');
 const {readFactDraft,saveFactDraft}=await import('../server/fact-drafts.mjs');
 const {access}=await import('node:fs/promises');const sharp=(await import('sharp')).default;
 const target={kind:'character',id:'ellen',variant_id:'default'};
 const initial=await readReferenceLibrary(root,projectId,target);
 const library=await mutateReferenceLibrary(root,directory,projectId,{target,expected_sha256:initial.sha256,action:'save',content:(await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer()).toString('base64')});
 const entry=library.entries[0],pageFile=path.join(directory,'pages/page-001.prompt.json');
 const page=await readJson(pageFile);page.reference_overrides={'character:ellen:default':[entry.id]};await writeJson(pageFile,page);
 const args={projectId,domain:'character',kind:'prompt',targetId:'ellen'};
 const save=async()=>{const draft=await readFactDraft(root,args);draft.document.variants.default.reference_images=[];return saveFactDraft(root,{...args,document:draft.document,expectedSha256:draft.expected_sha256,expectedContextSha256:draft.expected_context_sha256});};
 await assert.rejects(save(),e=>e.code==='reference_image_in_use');await access(path.join(directory,'materials',entry.file));
 page.reference_overrides={};await writeJson(pageFile,page);await save();
 await assert.rejects(access(path.join(directory,'materials',entry.file)),{code:'ENOENT'});
});
