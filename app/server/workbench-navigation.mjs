import { readFactDraft, saveFactDraft } from "./fact-drafts.mjs";
import { randomBytes } from "node:crypto";

import { hashCanonicalJson } from "./workflow-definition.mjs";
import { characterIdPattern, characterVariantIdPattern } from "./character-files.mjs";

import {
  createCharacter,
  moveCharacter,
  deleteCharacter,
  deleteCharacterVariant,
  renameCharacterVariant,
} from "./character-facts.mjs";
export const moveWorkbenchCharacter = moveCharacter;
import { readProjectWorkbenchView } from "./project-workbench.mjs";
import { FactError } from "./story-facts.mjs";
import { createPage, duplicatePage, deletePage, movePage } from "./page-facts.mjs";
import { readPageEntry } from "./pages-store.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { createScene, deleteScene, deleteSceneVariant, renameSceneVariant, moveScene } from "./scene-facts.mjs";
import { sceneIdPattern } from "./scene-files.mjs";

function fail(code, details = []) {
  throw new FactError(code, details);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail("invalid_navigation_action", [`${label} 必须是非空字符串`]);
  return value.trim();
}

function requireEntityId(value, label, pattern, reserved) {
  if (typeof value !== "string" || !pattern.test(value) || reserved.has(value)) fail("invalid_navigation_action", [`${label} 只能使用小写字母、数字和连字符`]);
  return value;
}

function readableId(label, prefix, occupied) {
  const slug = label.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const base = slug || prefix;
  if (!occupied.has(base) && base !== "main" && base !== "npc") return base;
  for (;;) {
    const candidate = `${base}-${randomBytes(3).toString("hex")}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

async function editFacts(projectRoot, projectId, domain, kind, targetId, change) {
  const draft = await readFactDraft(projectRoot, { domain, kind, projectId, targetId });
  const result = change(draft.document);
  const saved = await saveFactDraft(projectRoot, { domain, kind, projectId, targetId,
    document: draft.document, expectedSha256: draft.expected_sha256, expectedContextSha256: draft.expected_context_sha256,
    conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict" });
  return { ...saved, ...result };
}

function editStoryOutline(projectRoot, projectId, change) {
  return editFacts(projectRoot, projectId, "story", "outline", undefined, change);
}

function insertBeforeAnchor(list, item, anchorId, idOf, failMissingAnchor) {
  if (anchorId === null || anchorId === undefined) {
    list.push(item);
    return;
  }
  const anchorIndex = list.findIndex((entry) => idOf(entry) === anchorId);
  if (anchorIndex < 0) failMissingAnchor();
  list.splice(anchorIndex, 0, item);
}

function moveBeforeAnchor(list, itemIndex, anchorId, idOf, failMissingAnchor) {
  const item = list[itemIndex];
  if (anchorId !== null && anchorId !== undefined && idOf(item) === anchorId) return;
  list.splice(itemIndex, 1);
  insertBeforeAnchor(list, item, anchorId, idOf, failMissingAnchor);
}

function findChapter(outline, chapterId) {
  const index = outline.chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) fail("story_chapter_not_found", [String(chapterId)]);
  return { chapter: outline.chapters[index], index };
}

function findSequence(outline, sequenceId) {
  for (const [chapterIndex, chapter] of outline.chapters.entries()) {
    const sequenceIndex = chapter.sequences.findIndex((sequence) => sequence.id === sequenceId);
    if (sequenceIndex >= 0) return { chapter, chapterIndex, sequence: chapter.sequences[sequenceIndex], sequenceIndex };
  }
  fail("story_sequence_not_found", [String(sequenceId)]);
}

export async function createWorkbenchChapter(projectRoot, projectId, title, afterChapterId = null) {
  const cleanTitle = requireText(title, "章节标题");
  return editStoryOutline(projectRoot, projectId, (outline) => {
    const occupied = new Set(outline.chapters.map((chapter) => chapter.id));
    const chapterId = readableId(cleanTitle, "chapter", occupied);
    const position = afterChapterId === null ? outline.chapters.length : findChapter(outline, afterChapterId).index + 1;
    outline.chapters.splice(position, 0, { id: chapterId, title: cleanTitle, summary: "待补充章节梗概。", sequences: [] });
    return { chapter_id: chapterId };
  });
}

export async function renameWorkbenchChapter(projectRoot, projectId, chapterId, title) {
  const cleanTitle = requireText(title, "章节标题");
  return editStoryOutline(projectRoot, projectId, (outline) => { findChapter(outline, chapterId).chapter.title = cleanTitle; return { chapter_id: chapterId }; });
}

export async function moveWorkbenchChapter(projectRoot, projectId, chapterId, beforeChapterId = null) {
  return editStoryOutline(projectRoot, projectId, (outline) => {
    const { index } = findChapter(outline, chapterId);
    moveBeforeAnchor(outline.chapters, index, beforeChapterId, (chapter) => chapter.id,
      () => fail("story_chapter_not_found", [String(beforeChapterId)]));
    return { chapter_id: chapterId };
  });
}

export async function deleteWorkbenchChapter(projectRoot, projectId, chapterId) {
  return editStoryOutline(projectRoot, projectId, (outline) => {
    const { chapter, index } = findChapter(outline, chapterId);
    if (outline.chapters.length <= 1) fail("story_chapter_required", [chapterId]);
    if (chapter.sequences.length) fail("story_chapter_not_empty", [chapterId]);
    outline.chapters.splice(index, 1);
    return { chapter_id: chapterId };
  });
}

export async function createWorkbenchSequence(projectRoot, projectId, chapterId, title, afterSequenceId = null) {
  const cleanTitle = requireText(title, "Sequence 标题");
  return editStoryOutline(projectRoot, projectId, (outline) => {
    const { chapter } = findChapter(outline, chapterId);
    const occupied = new Set(outline.chapters.flatMap((entry) => entry.sequences.map((sequence) => sequence.id)));
    const sequenceId = readableId(cleanTitle, "sequence", occupied);
    const anchor = afterSequenceId === null ? null : chapter.sequences.findIndex(sequence => sequence.id === afterSequenceId);
    if (anchor === -1) fail("story_sequence_not_found", [String(afterSequenceId)]);
    chapter.sequences.splice(anchor === null ? chapter.sequences.length : anchor + 1, 0, { id: sequenceId, title: cleanTitle, summary: "待补充情节单元梗概。" });
    return { chapter_id: chapterId, sequence_id: sequenceId };
  });
}

export async function renameWorkbenchSequence(projectRoot, projectId, sequenceId, title) {
  const cleanTitle = requireText(title, "Sequence 标题");
  return editStoryOutline(projectRoot, projectId, (outline) => { findSequence(outline, sequenceId).sequence.title = cleanTitle; return { sequence_id: sequenceId }; });
}

export async function moveWorkbenchSequence(projectRoot, projectId, sequenceId, chapterId, beforeSequenceId = null) {
  return editStoryOutline(projectRoot, projectId, (outline) => {
    const source = findSequence(outline, sequenceId);
    const target = findChapter(outline, chapterId).chapter;
    const missingAnchor = () => fail("story_sequence_not_found", [String(beforeSequenceId)]);
    const idOf = (sequence) => sequence.id;
    if (source.chapter.id === target.id) {
      moveBeforeAnchor(target.sequences, source.sequenceIndex, beforeSequenceId, idOf, missingAnchor);
      return { sequence_id: sequenceId, chapter_id: target.id };
    }
    if (beforeSequenceId !== null && beforeSequenceId !== undefined
      && !target.sequences.some((sequence) => sequence.id === beforeSequenceId)) missingAnchor();
    source.chapter.sequences.splice(source.sequenceIndex, 1);
    insertBeforeAnchor(target.sequences, source.sequence, beforeSequenceId, idOf, missingAnchor);
    return { sequence_id: sequenceId, chapter_id: target.id };
  });
}

export async function deleteWorkbenchSequence(projectRoot, projectId, sequenceId) {
  const view = await readProjectWorkbenchView(projectRoot, projectId);
  const current = view.outline.chapters.flatMap((chapter) => chapter.sequences).find((sequence) => sequence.id === sequenceId);
  if (!current) fail("story_sequence_not_found", [sequenceId]);
  if (current.pages.length) fail("story_sequence_not_empty", [sequenceId]);
  return editStoryOutline(projectRoot, projectId, (outline) => {
    const { chapter, sequenceIndex } = findSequence(outline, sequenceId);
    chapter.sequences.splice(sequenceIndex, 1);
    return { sequence_id: sequenceId };
  });
}

export function createWorkbenchStoryPage(projectRoot, projectId, sequenceId, pageKind = null, afterPageId = null) {
  return createPage(projectRoot, projectId, { owner_kind: "story", sequence_id: sequenceId }, { pageKind, afterPageId });
}

export function createWorkbenchStoryPageFromTemplate(projectRoot, projectId, sequenceId, templateId, characterId, variantId, afterPageId = null) {
  return createPage(projectRoot, projectId, { owner_kind: "story", sequence_id: sequenceId }, { templateId, characterId, variantId, afterPageId });
}

export function deleteWorkbenchStoryPage(projectRoot, projectId, pageId) {
  return deletePage(projectRoot, projectId, pageId);
}

export function duplicateWorkbenchStoryPage(projectRoot, projectId, pageId) {
  return duplicatePage(projectRoot, projectId, pageId);
}

export async function moveWorkbenchStoryPage(projectRoot, projectId, pageId, sequenceId, beforePageId = null) {
  return movePage(projectRoot, projectId, pageId, { owner_kind: "story", sequence_id: sequenceId }, { beforePageId });
}

export async function createWorkbenchCharacter(projectRoot, projectId, characterId, name) {
  const cleanId = requireEntityId(characterId, "角色 ID", characterIdPattern, new Set(["npc"]));
  const cleanName = requireText(name, "角色显示名");
  return { ...(await createCharacter(projectRoot, projectId, cleanId, { name: cleanName })), character_id: cleanId };
}

export async function deleteWorkbenchCharacter(projectRoot, projectId, characterId) {
  return deleteCharacter(projectRoot, projectId, characterId);
}

function editCharacterVariants(projectRoot, projectId, characterId, change) {
  return editFacts(projectRoot, projectId, "character", "visual", characterId, change);
}

export async function createWorkbenchCharacterVariant(projectRoot, projectId, characterId, variantId, name, afterVariantId = null) {
  const cleanId = requireEntityId(variantId, "子设定 ID", characterVariantIdPattern, new Set(["main"]));
  const cleanName = requireText(name, "子设定名称");
  return editCharacterVariants(projectRoot, projectId, characterId, (visual) => {
    if (visual.variants.some((variant) => variant.id === cleanId)) fail("character_variant_already_exists", [characterId, cleanId]);
    const anchor = afterVariantId === null ? null : visual.variants.findIndex(variant => variant.id === afterVariantId);
    if (anchor === -1) fail("character_variant_not_found", [characterId, String(afterVariantId)]);
    visual.variants.splice(anchor === null ? visual.variants.length : anchor + 1, 0, { id: cleanId, name: cleanName });
    return { character_id: characterId, variant_id: cleanId };
  });
}

export async function deleteWorkbenchCharacterVariant(projectRoot, projectId, characterId, variantId) {
  return deleteCharacterVariant(projectRoot, projectId, characterId, variantId);
}

export async function moveWorkbenchCharacterVariant(projectRoot, projectId, characterId, variantId, beforeVariantId = null) {
  return editCharacterVariants(projectRoot, projectId, characterId, (visual) => {
    const index = visual.variants.findIndex((variant) => variant.id === variantId);
    if (index < 0) fail("character_variant_not_found", [characterId, variantId]);
    moveBeforeAnchor(visual.variants, index, beforeVariantId, (variant) => variant.id,
      () => fail("character_variant_not_found", [characterId, String(beforeVariantId)]));
    return { character_id: characterId, variant_id: variantId };
  });
}

export async function renameWorkbenchCharacterVariant(projectRoot, projectId, characterId, oldId, newId) {
  const renamed = await renameCharacterVariant(projectRoot, projectId, characterId, oldId, newId);
  const visual = structuredClone(renamed.visual);
  const prompt = structuredClone(renamed.prompt);
  delete visual.$schema;
  delete prompt.$schema;
  return {
    character_id: renamed.character_id,
    old_id: renamed.old_id,
    new_id: renamed.new_id,
    updated_page_ids: renamed.updated_page_ids,
    visual,
    visual_sha256: hashCanonicalJson(renamed.visual),
    prompt,
    prompt_sha256: hashCanonicalJson(renamed.prompt),
  };
}

export function createWorkbenchCharacterPage(projectRoot, projectId, characterId, variantId, templateId = null, afterPageId = null) {
  return createPage(projectRoot, projectId, { owner_kind: "character", character_id: characterId, variant_id: variantId }, { templateId, afterPageId });
}

export function deleteWorkbenchCharacterPage(projectRoot, projectId, pageId) {
  return deletePage(projectRoot, projectId, pageId);
}

export function duplicateWorkbenchCharacterPage(projectRoot, projectId, pageId) {
  return duplicatePage(projectRoot, projectId, pageId);
}

export async function moveWorkbenchCharacterPage(projectRoot, projectId, pageId, variantId, beforePageId = null) {
  const project = await resolveProjectLocation(projectRoot, projectId);
  const source = await readPageEntry(project.projectDirectory, pageId);
  if (source?.owner_kind !== "character") fail("character_page_not_found", [pageId]);
  return movePage(projectRoot, projectId, pageId, { owner_kind: "character", character_id: source.character_id, variant_id: variantId }, { beforePageId });
}

export { createPage as createWorkbenchPage, duplicatePage as duplicateWorkbenchPage, deletePage as deleteWorkbenchPage, movePage as moveWorkbenchPage };
export async function createWorkbenchScene(root, projectId, id, name) {
  requireEntityId(id, "场景 ID", sceneIdPattern, new Set());
  return createScene(root, projectId, id, { name: requireText(name, "场景显示名") });
}
export const deleteWorkbenchScene = deleteScene;
export const moveWorkbenchScene = moveScene;
export const deleteWorkbenchSceneVariant = deleteSceneVariant;
export async function renameWorkbenchSceneVariant(root, projectId, id, oldId, newId) {
  const renamed = await renameSceneVariant(root, projectId, id, oldId, newId);
  const visual = structuredClone(renamed.visual), prompt = structuredClone(renamed.prompt);
  delete visual.$schema; delete prompt.$schema;
  return { ...renamed, visual, prompt, visual_sha256: hashCanonicalJson(renamed.visual), prompt_sha256: hashCanonicalJson(renamed.prompt) };
}
export async function createWorkbenchSceneVariant(root, projectId, id, variantId, name, afterVariantId = null) {
  requireEntityId(variantId, "子设定 ID", characterVariantIdPattern, new Set(["main"]));
  const cleanName = requireText(name, "子设定名称");
  return editFacts(root, projectId, "scene", "visual", id, visual => {
    if (visual.variants.some(v => v.id === variantId)) fail("scene_variant_already_exists", [id, variantId]);
    const anchor = afterVariantId === null ? visual.variants.length - 1 : visual.variants.findIndex(v => v.id === afterVariantId);
    if (afterVariantId !== null && anchor < 0) fail("scene_variant_not_found", [id, afterVariantId]);
    visual.variants.splice(anchor + 1, 0, { id: variantId, name: cleanName });
    return { scene_id: id, variant_id: variantId };
  });
}
export async function moveWorkbenchSceneVariant(root, projectId, id, variantId, beforeVariantId = null) {
  return editFacts(root, projectId, "scene", "visual", id, visual => {
    const index = visual.variants.findIndex(v => v.id === variantId);
    if (index < 0) fail("scene_variant_not_found", [id, variantId]);
    moveBeforeAnchor(visual.variants, index, beforeVariantId, v => v.id, () => fail("scene_variant_not_found", [id, beforeVariantId]));
    return { scene_id: id, variant_id: variantId };
  });
}
