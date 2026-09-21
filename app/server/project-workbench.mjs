import { readPageIndex, pageRelativePath } from './pages-store.mjs';
import { resolveRenderRecipe } from "./render-task-contract.mjs";
import { defaultTextPageLayout } from "../shared/text-page-layout.mjs";
import { readScenes } from './prompt-inheritance-facts.mjs';
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { readCandidateGeneration, readGenerationCandidateRecords } from "./candidate-storage.mjs";
import { readFactDraft, saveFactDraft, pagePromptContextSha256 } from "./fact-drafts.mjs";
import {
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
  validateCharacterIndexDocument,
  validateCharacterProfileDocument,
  validateCharacterPromptDocument,
  validateCharacterVisualDocument,
} from "./character-files.mjs";
import { validateLetteringSettingsDocument } from "./lettering-settings.mjs";
import { createPageKey, encodePageKey } from "./page-key.mjs";
import { emptyLetteringDocument, validateLetteringDocument, validatePageLettering } from "./lettering-document.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { compileEffectiveRenderProfile } from "./render-profile-compiler.mjs";
import { resolveExactPageIdentity, PageRenderError } from "./page-render-resolver.mjs";
import {
  storyDialogueIdPattern,
  storyPageIdPattern,
  storyPromptCategories,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  storyNarrativeSpeakerIds,
  validateStoryOutlineDocument,
  validateStoryPageNarrativeDocument,
  validateStoryPagePromptDocument,
} from "./story-files.mjs";
import { factStorage as storage } from "./story-facts.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { candidateDetailProjection } from "./generation-details.mjs";

const promptKinds = new Set(["story", "character", "scene"]);

function fail(code, details = [], status = 422) {
  throw new PageRenderError(code, details, status);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(projectDirectory, relativePath, { optional = false } = {}) {
  const target = storage.targetPath(projectDirectory, relativePath);
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) {
    if (optional) return null;
    fail("project_fact_missing", [relativePath], 404);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("project_fact_path_invalid", [relativePath]);
  await storage.assertProjectFactBoundary(projectDirectory, projectDirectory, target, relativePath);
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) fail("project_fact_json_invalid", [relativePath, error.message]);
    throw error;
  }
}

function validated(value, validate, relativePath) {
  const errors = validate(value);
  if (errors.length) fail("project_fact_contract_invalid", errors.map((error) => `${relativePath}: ${error}`));
  return value;
}

function publicPrompt(prompt) {
  return { ...(prompt.reference_image ? { reference_image: prompt.reference_image } : {}), ...(prompt.scene_id ? { scene_id: prompt.scene_id, scene_variant_id: prompt.scene_variant_id } : {}), ...(prompt.inheritance ? { inheritance: structuredClone(prompt.inheritance) } : {}), ...Object.fromEntries(storyPromptCategories.map((category) => [category, structuredClone(prompt[category])])), ...(prompt.mode === undefined ? {} : { mode: prompt.mode }), ...(prompt.free === undefined ? {} : { free: structuredClone(prompt.free) }), ...(prompt.two_step === undefined ? {} : { two_step: structuredClone(prompt.two_step) }) };
}

function publicCharacterPrompt(prompt) {
  const result = structuredClone(prompt);
  delete result.$schema;
  return result;
}

async function readCharacters(projectDirectory) {
  const characterIndex = validated(
    await readJson(projectDirectory, "characters/index.json"),
    validateCharacterIndexDocument,
    "characters/index.json",
  );
  const characters = [];
  for (const characterId of characterIndex.characters) {
    const [profile, visual, prompt] = await Promise.all([
      readJson(projectDirectory, `characters/${characterId}.profile.json`),
      readJson(projectDirectory, `characters/${characterId}.visual.json`),
      readJson(projectDirectory, `characters/${characterId}.prompt.json`),
    ]);
    const profileValue = validated(profile, validateCharacterProfileDocument, `characters/${characterId}.profile.json`);
    const visualValue = validated(visual, validateCharacterVisualDocument, `characters/${characterId}.visual.json`);
    const promptValue = validated(prompt, validateCharacterPromptDocument, `characters/${characterId}.prompt.json`);
    characters.push({
      id: characterId,
      ...structuredClone(profileValue),
      profile_sha256: hashCanonicalJson(profileValue),
      visual: publicCharacterVisual(visualValue),
      visual_sha256: hashCanonicalJson(visualValue),
      prompt: structuredClone(promptValue),
      prompt_sha256: hashCanonicalJson(promptValue),
      pages: [],
    });
    delete characters.at(-1).$schema;
    delete characters.at(-1).visual.$schema;
    delete characters.at(-1).prompt.$schema;
  }
  return characters;
}

async function readRenderCapabilities(repositoryRoot, projectDirectory, projectDocument) {
  try {
    const compilation = await compileEffectiveRenderProfile({
      repositoryRoot,
      projectRoot: projectDirectory,
      profileId: projectDocument.default_render_profile,
    });
    if (compilation.blocked) {
      const details = compilation.override_resolution.conflicts.map((conflict) => conflict.target);
      return {
        candidates: { available: false, counts: [1, 2, 3], blocker: "render_profile_override_conflict", details },
        text_page: { dimensions: null, error: "渲染配置 override 存在冲突，文字页无法确定成品尺寸" },
      };
    }
    const operations = compilation.effective_profile.operations ?? {};
    const candidatesAvailable = Boolean(operations.candidates?.routes?.empty_latent);
    let textPage;
    try {
      const route = Object.values(operations.candidates?.routes ?? {})[0];
      if (!route?.recipe) throw new Error("渲染配置缺少候选 recipe，文字页无法确定成品尺寸");
      const { dimensions } = resolveRenderRecipe(route.recipe, projectDocument.canvas);
      textPage = { dimensions: { width: dimensions.final_width * 2, height: dimensions.final_height * 2 }, error: null };
    } catch (error) {
      textPage = { dimensions: null, error: error.message };
    }
    return {
      text_page: textPage,
      candidates: {
        available: candidatesAvailable,
        counts: [1, 2, 3],
        ...(candidatesAvailable ? {} : { blocker: "render_route_unavailable" }),
      },
    };
  } catch (error) {
    return {
      candidates: { available: false, counts: [1, 2, 3], blocker: error?.code ?? "render_profile_invalid" },
      text_page: { dimensions: null, error: "生成配置不可用，文字页无法确定成品尺寸" },
    };
  }
}

export async function readProjectWorkbenchView(projectRoot, projectId) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const projectDocument = await readJson(project.projectDirectory, "project.json");
  const [outline, pagesIndex, characters, letteringSettings, letteringDocument, scenes] = await Promise.all([
    readJson(project.projectDirectory, "story/outline.json").then((value) => validated(value, validateStoryOutlineDocument, "story/outline.json")),
    readPageIndex(project.projectDirectory),
    readCharacters(project.projectDirectory),
    readJson(project.projectDirectory, "lettering/settings.json").then((value) => validated(value, validateLetteringSettingsDocument, "lettering/settings.json")),
    readJson(project.projectDirectory, "lettering/dialogue-layouts.json", { optional: true }),
    readScenes(project.projectDirectory),
  ]);
  const lettering = letteringDocument === null
    ? emptyLetteringDocument()
    : validated(letteringDocument, validateLetteringDocument, "lettering/dialogue-layouts.json");
  const letteringSha256 = hashCanonicalJson(lettering);
  const letteringByPage = new Map(lettering.pages.map((page) => [page.page, page]));
  const diagnostics = [];
  const knownSequenceIds = new Set(outline.chapters.flatMap((chapter) => chapter.sequences.map((sequence) => sequence.id)));
  const characterMap = new Map(characters.map(character => [character.id, character]));
  const sceneMap = new Map(scenes.scenes.map(scene => [scene.id, scene]));
  const pages = [], orphanPages = [];
  for (const membership of pagesIndex.pages) {
    const pageId = membership.page_id;
    const [narrative, prompt] = await Promise.all([
      readJson(project.projectDirectory, pageRelativePath(pageId, 'content')),
      readJson(project.projectDirectory, pageRelativePath(pageId, 'prompt')),
    ]);
    const content = validated(narrative, validateStoryPageNarrativeDocument, pageRelativePath(pageId, 'content'));
    const promptValue = validated(prompt, validateStoryPagePromptDocument, pageRelativePath(pageId, 'prompt'));
    for (const reference of content.characters) {
      const character = characterMap.get(reference.character_id);
      if (!character) diagnostics.push({ code: "dangling_story_character_reference", page_id: pageId, character_id: reference.character_id });
      else if (!character.visual.variants.some(variant => variant.id === reference.variant_id)) diagnostics.push({ code: "dangling_story_variant_reference", page_id: pageId, ...reference });
    }
    for (const speaker of storyNarrativeSpeakerIds(content)) if (!characterMap.has(speaker)) diagnostics.push({code:"dangling_story_dialogue_speaker",page_id:pageId,character_id:speaker});
    if (promptValue.scene_id) {
      const scene = sceneMap.get(promptValue.scene_id);
      if (!scene) diagnostics.push({code:"dangling_scene_reference",page_id:pageId,scene_id:promptValue.scene_id});
      else if (!scene.visual.variants.some(variant => variant.id === promptValue.scene_variant_id)) diagnostics.push({code:"dangling_scene_variant_reference",page_id:pageId,scene_id:promptValue.scene_id,variant_id:promptValue.scene_variant_id});
    }
    const page = {
      ...membership, kind: membership.owner_kind, owner: structuredClone(membership),
      owner_id: membership.character_id ?? membership.scene_id,
      page_key: createPageKey(pageId), title: content.title, scene_description: content.scene_description,
      page_kind: content.page_kind ?? null, body: content.body ?? '',
      ...(content.page_kind === 'text' ? {display_title:content.display_title ?? '',text_layout:structuredClone(content.text_layout ?? defaultTextPageLayout)} : {}),
      characters: structuredClone(content.characters), dialogue: structuredClone(content.dialogue),
      content_sha256: hashCanonicalJson(content),
      lettering: structuredClone(letteringByPage.get(pageId) ?? {page:pageId,items:[]}), layout_sha256:letteringSha256,
      prompt:publicPrompt(promptValue),prompt_sha256:hashCanonicalJson(promptValue),
      prompt_context_sha256:await pagePromptContextSha256(project.projectDirectory, membership.owner_kind,pageId).catch(()=>null),
    };
    pages.push(page);
    const owner = membership.owner_kind === 'character' ? characterMap.get(membership.character_id) : membership.owner_kind === 'scene' ? sceneMap.get(membership.scene_id) : null;
    const validOwner = membership.owner_kind === 'story' ? knownSequenceIds.has(membership.sequence_id) : Boolean(owner?.visual.variants.some(variant=>variant.id===membership.variant_id));
    if (!validOwner) {
      orphanPages.push(page);
      diagnostics.push({code:'dangling_page_owner',page_id:pageId,owner:structuredClone(membership)});
    } else if (owner) owner.pages.push(page);
  }
  for (const character of characters) {
    const visualVariants = new Set(character.visual.variants.map(variant => variant.id));
    const promptVariants = new Set(Object.keys(character.prompt.variants));
    for (const variantId of visualVariants) if (!promptVariants.has(variantId)) diagnostics.push({code:'missing_variant_prompt',character_id:character.id,variant_id:variantId});
    for (const variantId of promptVariants) if (!visualVariants.has(variantId)) diagnostics.push({code:'dangling_prompt_variant_reference',character_id:character.id,variant_id:variantId});
  }
  for (const characterId of Object.keys(letteringSettings.character_colors)) {
    if (!characterMap.has(characterId)) diagnostics.push({ code: "dangling_character_style_reference", character_id: characterId });
  }
  for (const character of characters) character.style = letteringSettings.character_colors[character.id]
    ? { display_color: letteringSettings.character_colors[character.id] }
    : null;
  const renderCapabilities = await readRenderCapabilities(path.resolve(projectRoot), project.projectDirectory, projectDocument);
  return {
    version: 5,
    pages, orphan_pages: orphanPages,
    scenes,
    scenes_sha256: hashCanonicalJson(scenes),
    project: {
      id: project.projectId,
      title: projectDocument.title ?? project.projectId,
      canvas: projectDocument.canvas ?? null,
      default_render_profile: projectDocument.default_render_profile ?? null,
      lettering_settings: structuredClone(letteringSettings),
      lettering_settings_sha256: hashCanonicalJson(letteringSettings),
    },
    outline: {
      synopsis: outline.synopsis,
      synopsis_sha256: hashCanonicalJson(outline.synopsis),
      chapters: outline.chapters.map((chapter) => ({
        id: chapter.id, title: chapter.title, summary: chapter.summary,
        summary_sha256: hashCanonicalJson(chapter.summary),
        sequences: chapter.sequences.map((sequence) => ({
          id: sequence.id, title: sequence.title, summary: sequence.summary,
          summary_sha256: hashCanonicalJson(sequence.summary),
          pages: pages.filter(page => page.kind === "story" && page.sequence_id === sequence.id),
        })),
      })),
    },
    characters,
    render_capabilities: renderCapabilities,
    diagnostics,
  };
}

export async function saveStorySummary(projectRoot, projectId, value) {
  requireExactObject(value, ["target", "text", "expected_sha256"], "invalid_story_summary_update");
  if (!isRecord(value.target) || typeof value.text !== "string" || !value.text.trim()
    || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "")) fail("invalid_story_summary_update", [], 400);
  const { kind, id } = value.target;
  if (!["synopsis", "chapter", "sequence"].includes(kind)) fail("invalid_story_summary_update", [], 400);
  requireExactObject(value.target, kind === "synopsis" ? ["kind"] : ["kind", "id"], "invalid_story_summary_update");
  if (kind !== "synopsis" && (typeof id !== "string" || !id)) fail("invalid_story_summary_update", [], 400);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);

  const relativePath = "story/outline.json";
  const outline = validated(await readJson(project.projectDirectory, relativePath), validateStoryOutlineDocument, relativePath);
  const target = kind === "synopsis" ? outline : kind === "chapter"
    ? outline.chapters.find((chapter) => chapter.id === id)
    : outline.chapters.flatMap((chapter) => chapter.sequences).find((sequence) => sequence.id === id);
  if (!target) fail("story_summary_target_not_found", [id], 404);
  const field = kind === "synopsis" ? "synopsis" : "summary";
  if (hashCanonicalJson(target[field]) !== value.expected_sha256) fail("story_summary_target_conflict", [], 409);
  target[field] = value.text;
  validated(outline, validateStoryOutlineDocument, relativePath);
  await storage.writeJsonAtomic(storage.targetPath(project.projectDirectory, relativePath), outline);
  return { target: structuredClone(value.target), text: target[field], sha256: hashCanonicalJson(target[field]) };
}

function publicPageContent(kind, document) {
  return {
      title: document.title,
      scene_description: document.scene_description,
      characters: structuredClone(document.characters),
      dialogue: structuredClone(document.dialogue),
      // 仅文字页携带类型与正文，普通页保持原有四键契约。
      ...(document.page_kind === "text" ? { page_kind: "text", body: document.body ?? "", display_title: document.display_title ?? "", text_layout: structuredClone(document.text_layout ?? defaultTextPageLayout) } : {}),
    };
}

function contentRelativePath(kind, pageId) { return pageRelativePath(pageId, 'content'); }

export async function savePageContent(projectRoot, projectId, value) {
  requireExactObject(value, ["page_key", "content", "expected_sha256", "confirmation_sha256"], "invalid_page_content_update");
  if (!isRecord(value.page_key) || !isRecord(value.content) || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "")) fail("invalid_page_content_update", [], 400);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const identity = await resolveExactPageIdentity(project.projectDirectory, value.page_key);
  const relativePath = contentRelativePath(identity.kind, identity.page_id);
  const current = await readJson(project.projectDirectory, relativePath);
  const isTextPage = current.page_kind === "text";
  // 页面类型创建时定死：普通剧情页保持原有四键契约，文字页必须携带 page_kind/body。
  requireExactObject(value.content, isTextPage ? ["title", "scene_description", "characters", "dialogue", "page_kind", "body", "display_title", "text_layout"] : ["title", "scene_description", "characters", "dialogue"], "invalid_page_content_update");
  if (isTextPage && (value.content.page_kind !== "text" || typeof value.content.body !== "string" || typeof value.content.display_title !== "string" || !isRecord(value.content.text_layout))) fail("invalid_page_content_update", [], 400);
  const document = isTextPage
    ? { $schema: current.$schema, title: value.content.title, scene_description: value.content.scene_description, characters: structuredClone(value.content.characters), dialogue: structuredClone(value.content.dialogue), page_kind: "text", body: value.content.body, display_title: value.content.display_title ?? "", text_layout: structuredClone(value.content.text_layout ?? defaultTextPageLayout) }
    : { $schema: current.$schema, ...structuredClone(value.content) };
  const saved = await saveFactDraft(projectRoot, {
    domain: "page", kind: "content",
    projectId, targetId: identity.page_id, document,
    expectedSha256: value.expected_sha256, conflictCode: "page_content_target_conflict", confirmationSha256: value.confirmation_sha256,
    beforeCommit: () => resolveExactPageIdentity(project.projectDirectory, value.page_key),
  });
  return { page_key: identity.page_key, content: publicPageContent(identity.kind, saved.value),
    ...(saved.inherited_prompt ? { prompt: publicPrompt(saved.inherited_prompt), prompt_sha256: hashCanonicalJson(saved.inherited_prompt) } : {}),
    content_sha256: hashCanonicalJson(saved.value),
    prompt_context_sha256: await pagePromptContextSha256(project.projectDirectory, identity.kind, identity.page_id).catch(() => null),
    warnings: saved.warnings ?? [], downstream_diagnostics: saved.downstream_diagnostics ?? [] };
}

export async function savePageLettering(projectRoot, projectId, value) {
  requireExactObject(value, ["page_key", "lettering", "expected_sha256"], "invalid_page_lettering_update");
  if (!isRecord(value.page_key) || !isRecord(value.lettering) || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "")) {
    fail("invalid_page_lettering_update", [], 400);
  }
  requireExactObject(value.lettering, ["items"], "invalid_page_lettering_update");
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const identity = await resolveExactPageIdentity(project.projectDirectory, value.page_key);

  const narrativePath = pageRelativePath(identity.page_id, "content");
  const narrative = validated(await readJson(project.projectDirectory, narrativePath), validateStoryPageNarrativeDocument, narrativePath);
  const relativePath = "lettering/dialogue-layouts.json";
  const current = validated(await readJson(project.projectDirectory, relativePath, { optional: true }) ?? emptyLetteringDocument(), validateLetteringDocument, relativePath);
  if (hashCanonicalJson(current) !== value.expected_sha256) fail("page_lettering_target_conflict", [identity.page_id], 409);
  const pageLayout = { page: identity.page_id, items: structuredClone(value.lettering.items) };
  const errors = validatePageLettering(pageLayout, { pageId: identity.page_id, dialogueIds: narrative.dialogue.map((dialogue) => dialogue.id) });
  const narrationIds = new Set(narrative.dialogue.filter((dialogue) => dialogue.mode === "narration").map((dialogue) => dialogue.id));
  if (pageLayout.items.some((item) => narrationIds.has(item.dialogue_id))) errors.push("旁白使用通栏字幕条，不保存布局");
  if (errors.length) fail("project_fact_contract_invalid", errors);
  const next = structuredClone(current);
  next.pages = next.pages.filter((page) => page.page !== identity.page_id);
  if (pageLayout.items.length) next.pages.push(pageLayout);
  const target = storage.targetPath(project.projectDirectory, relativePath);
  await storage.assertProjectFactBoundary(projectRoot, project.projectDirectory, target, relativePath);
  await storage.writeJsonAtomic(target, next);
  return {
    page_key: structuredClone(identity.page_key),
    lettering: structuredClone(pageLayout),
    layout_sha256: hashCanonicalJson(next),
  };
}

function requireExactObject(value, allowed, code) {
  if (!isRecord(value)) fail(code, [], 400);
  allowed = allowed.filter(key => key !== 'confirmation_sha256' || Object.hasOwn(value, key));
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) fail(code, [], 400);
}

export async function deletePageTextSource(projectRoot, projectId, value) {
  requireExactObject(value, ["page_id", "dialogue_id", "expected_sha256", "expected_context_sha256"], "invalid_text_source_delete");
  if (!storyPageIdPattern.test(value.page_id) || !storyDialogueIdPattern.test(value.dialogue_id ?? "")
    || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(value.expected_context_sha256 ?? "")) {
    fail("invalid_text_source_delete", [], 400);
  }
  const draft = await readFactDraft(projectRoot, { domain: "page", kind: "text-sources", projectId, targetId: value.page_id });
  if (!Object.hasOwn(draft.document, value.dialogue_id)) fail("text_source_not_found", [value.dialogue_id], 404);
  const document = structuredClone(draft.document);
  delete document[value.dialogue_id];
  const saved = await saveFactDraft(projectRoot, {
    domain: "page", kind: "text-sources", projectId, targetId: value.page_id, document,
    expectedSha256: value.expected_sha256, expectedContextSha256: value.expected_context_sha256,
    conflictCode: "text_source_target_conflict", contextConflictCode: "text_source_upstream_conflict",
  });
  return { page_id: value.page_id, text_sources: saved.value, text_sources_sha256: hashCanonicalJson(saved.value) };
}

export async function savePagePrompt(projectRoot, projectId, value) {
  requireExactObject(value, ["kind", "page_id", "prompt", "expected_sha256", "expected_context_sha256", "confirmation_sha256"], "invalid_page_prompt_update");
  const { kind, page_id: pageId, prompt, expected_sha256: expectedSha256 } = value;
  if (!promptKinds.has(kind) || typeof pageId !== "string" || !isRecord(prompt) || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) fail("invalid_page_prompt_update", [], 400);
  if (Object.keys(prompt).some(key => ![...storyPromptCategories, "mode", "free", "two_step", "reference_image", "scene_id", "scene_variant_id", "inheritance"].includes(key))) fail("invalid_page_prompt_update", [], 400);
  if (!/^[a-f0-9]{64}$/.test(value.expected_context_sha256 ?? "")) fail("invalid_page_prompt_update", [], 400);
  const saved = await saveFactDraft(projectRoot, {
    expectedContextSha256: value.expected_context_sha256,
    domain: "page", kind: "prompt",
    projectId, targetId: pageId, document: { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, ...structuredClone(prompt) },
    expectedSha256, conflictCode: "prompt_target_conflict", confirmationSha256: value.confirmation_sha256,
  });
  return { kind, page_id: pageId, prompt: publicPrompt(saved.value), prompt_sha256: hashCanonicalJson(saved.value), audit: saved.audit };
}

function sameOrderedStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function publicCharacterProfile(profile) {
  const result = structuredClone(profile);
  delete result.$schema;
  return result;
}

function publicCharacterVisual(visual) {
  const result = structuredClone(visual);
  delete result.$schema;
  delete result.description; delete result.base_description;
  result.variants = result.variants.map(({ id, name }) => ({ id, name }));
  return result;
}

export async function saveCharacterProfile(projectRoot, projectId, value) {
  requireExactObject(value, ["character_id", "profile", "expected_sha256"], "invalid_character_profile_update");
  if (typeof value.character_id !== "string" || !isRecord(value.profile) || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "")) fail("invalid_character_profile_update", [], 400);
  requireExactObject(value.profile, ["name", "description"], "invalid_character_profile_update");
  const saved = await saveFactDraft(projectRoot, {
    domain: "character", kind: "profile", projectId, targetId: value.character_id,
    document: { $schema: CHARACTER_PROFILE_SCHEMA_ID, ...structuredClone(value.profile) },
    expectedSha256: value.expected_sha256, conflictCode: "character_profile_target_conflict",
  });
  return { character_id: value.character_id, profile: publicCharacterProfile(saved.value), profile_sha256: hashCanonicalJson(saved.value) };
}

export async function saveCharacterVisual(projectRoot, projectId, value) {
  requireExactObject(value, ["character_id", "visual", "expected_sha256"], "invalid_character_visual_update");
  if (typeof value.character_id !== "string" || !isRecord(value.visual) || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "")) fail("invalid_character_visual_update", [], 400);
  requireExactObject(value.visual, ["description", "variants", "base_description"].filter(key => key === "variants" || Object.hasOwn(value.visual, key)), "invalid_character_visual_update");
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const current = await readJson(project.projectDirectory, `characters/${value.character_id}.visual.json`);
  if (hashCanonicalJson(current) !== value.expected_sha256) fail("character_visual_target_conflict", [], 409);
  if (!Array.isArray(value.visual.variants) || !sameOrderedStrings(current.variants.map(v => v.id), value.visual.variants.map(v => v.id))) fail("character_visual_structure_change_forbidden", [], 409);
  const saved = await saveFactDraft(projectRoot, {
    domain: "character", kind: "visual", projectId, targetId: value.character_id,
    document: { $schema: CHARACTER_VISUAL_SCHEMA_ID, ...structuredClone(value.visual) },
    expectedSha256: value.expected_sha256, conflictCode: "character_visual_target_conflict",
  });
  return { character_id: value.character_id, visual: publicCharacterVisual(saved.value), visual_sha256: hashCanonicalJson(saved.value), downstream_diagnostics: saved.downstream_diagnostics };
}

export async function saveCharacterPrompt(projectRoot, projectId, value) {
  requireExactObject(value, ["character_id", "prompt", "expected_sha256", "expected_visual_sha256", "confirmation_sha256"], "invalid_character_prompt_update");
  if (typeof value.character_id !== "string" || !isRecord(value.prompt) || !/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(value.expected_visual_sha256 ?? "")) fail("invalid_character_prompt_update", [], 400);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const checkVisual = async () => {
    const visual = await readJson(project.projectDirectory, `characters/${value.character_id}.visual.json`);
    if (hashCanonicalJson(visual) !== value.expected_visual_sha256) fail("character_prompt_visual_conflict", [], 409);
    const unknown = Object.keys(value.prompt.variants ?? {}).filter(id => !visual.variants.some(v => v.id === id));
    if (unknown.length) fail("character_prompt_visual_conflict", unknown, 409);
  };
  await checkVisual();
  const saved = await saveFactDraft(projectRoot, {
    domain: "character", kind: "prompt", projectId, targetId: value.character_id,
    document: { $schema: CHARACTER_PROMPT_SCHEMA_ID, ...structuredClone(value.prompt) },
    expectedSha256: value.expected_sha256, conflictCode: "prompt_target_conflict",
    allowLoraChanges: true, beforeCommit: checkVisual, confirmationSha256: value.confirmation_sha256,
  });
  return {
    character_id: value.character_id, prompt: publicCharacterPrompt(saved.value), prompt_sha256: hashCanonicalJson(saved.value),
    identity_impact: saved.identity_impact, audit: saved.audit, downstream_diagnostics: saved.downstream_diagnostics
  };
}

export async function readPageCandidateDetail(projectRoot, projectId, value) {
  requireExactObject(value, ["page_key", "candidate_id"], "invalid_candidate_detail_request");
  if (!isRecord(value.page_key) || typeof value.candidate_id !== "string") fail("invalid_candidate_detail_request", [], 400);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const identity = await resolveExactPageIdentity(project.projectDirectory, value.page_key);
  const canonical = encodePageKey(identity.page_key);
  const records = await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
  const matches = records.filter((record) => record.candidate_id === value.candidate_id && encodePageKey(record.page_key) === canonical);
  if (matches.length !== 1) fail(matches.length ? "candidate_record_ambiguous" : "candidate_not_found", [value.candidate_id], matches.length ? 409 : 404);
  const record = matches[0];
  return candidateDetailProjection(await readCandidateGeneration(project.projectDirectory, record.page_key, record.candidate_id));
}

export async function saveLetteringSettings(projectRoot, projectId, value) {
  requireExactObject(value, ["settings", "expected_sha256"], "invalid_lettering_settings_update");
  if (!/^[a-f0-9]{64}$/.test(value.expected_sha256 ?? "")) fail("invalid_lettering_settings_update", [], 400);
  const errors = validateLetteringSettingsDocument(value.settings);
  if (errors.length) fail("invalid_lettering_settings", errors);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);

  const relativePath = "lettering/settings.json";
  const current = validated(await readJson(project.projectDirectory, relativePath), validateLetteringSettingsDocument, relativePath);
  if (hashCanonicalJson(current) !== value.expected_sha256) fail("lettering_settings_conflict", [], 409);
  const next = structuredClone(value.settings);
  await storage.writeJsonAtomic(storage.targetPath(project.projectDirectory, relativePath), next);
  return { settings: next, sha256: hashCanonicalJson(next) };
}
