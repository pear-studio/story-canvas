import { validateReferenceEntries, validateReferenceOverrides } from "../shared/reference-images.mjs";
import { validateCameraSettings } from "../shared/camera-prompt.mjs";
import { validateAdjustments } from '../shared/prompt-inheritance.mjs';
import { NARRATION_CHARACTER_LIMIT } from "../shared/story-content-guidance.mjs";
export const STORY_OUTLINE_SCHEMA_ID = "https://storyvisualizer.local/schemas/story-outline.schema.json";
export const STORY_PAGES_INDEX_SCHEMA_ID = "https://storyvisualizer.local/schemas/story-pages-index.schema.json";
export const STORY_PAGE_NARRATIVE_SCHEMA_ID = "https://storyvisualizer.local/schemas/story-page-narrative.schema.json";
export const STORY_PAGE_PROMPT_SCHEMA_ID = "https://storyvisualizer.local/schemas/story-page-prompt.schema.json";
export const STORY_PAGE_TEXT_SOURCES_SCHEMA_ID = "https://storyvisualizer.local/schemas/story-page-text-sources.schema.json";

export const storyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const storyPageIdPattern = /^page-(?:\d{3}|[a-f0-9]{12})$/;
export const storyDialogueIdPattern = /^dialogue-[a-f0-9]{12}$/;
export const storyPromptCategories = Object.freeze(["subject","person","setting","camera","avoid"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, allowed, valuePath, errors) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
}

function checkNonemptyText(value, valuePath, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${valuePath} 必须是非空字符串`);
}

function sequenceIdsFromOutline(outline) {
  return (Array.isArray(outline?.chapters) ? outline.chapters : [])
    .flatMap((chapter) => Array.isArray(chapter?.sequences) ? chapter.sequences : [])
    .map((sequence) => sequence?.id)
    .filter((id) => typeof id === "string");
}

function indexedPages(pagesIndex) {
  if (!isRecord(pagesIndex?.by_sequence)) return [];
  return Object.entries(pagesIndex.by_sequence).flatMap(([sequenceId, pageIds]) => (
    Array.isArray(pageIds) ? pageIds.map((pageId) => ({ sequenceId, pageId })) : []
  ));
}

export function validateStoryOutlineDocument(outline) {
  const errors = [];
  if (!isRecord(outline)) return ["outline 必须是 JSON 对象"];
  checkExactKeys(outline, ["$schema", "synopsis", "chapters"], "outline", errors);
  if (outline.$schema !== STORY_OUTLINE_SCHEMA_ID) errors.push("outline.$schema 不匹配");
  checkNonemptyText(outline.synopsis, "outline.synopsis", errors);
  if (!Array.isArray(outline.chapters) || outline.chapters.length === 0) errors.push("outline.chapters 必须是非空数组");
  else outline.chapters.forEach((chapter, chapterIndex) => {
    const chapterPath = `outline.chapters[${chapterIndex}]`;
    if (!isRecord(chapter)) { errors.push(`${chapterPath} 必须是对象`); return; }
    checkExactKeys(chapter, ["id", "title", "summary", "sequences"], chapterPath, errors);
    if (!storyIdPattern.test(chapter.id ?? "")) errors.push(`${chapterPath}.id 不是有效可读 ID`);
    checkNonemptyText(chapter.title, `${chapterPath}.title`, errors);
    checkNonemptyText(chapter.summary, `${chapterPath}.summary`, errors);
    if (!Array.isArray(chapter.sequences)) errors.push(`${chapterPath}.sequences 必须是数组`);
    else chapter.sequences.forEach((sequence, sequenceIndex) => {
      const sequencePath = `${chapterPath}.sequences[${sequenceIndex}]`;
      if (!isRecord(sequence)) { errors.push(`${sequencePath} 必须是对象`); return; }
      checkExactKeys(sequence, ["id", "title", "summary"], sequencePath, errors);
      if (!storyIdPattern.test(sequence.id ?? "")) errors.push(`${sequencePath}.id 不是有效可读 ID`);
      checkNonemptyText(sequence.title, `${sequencePath}.title`, errors);
      checkNonemptyText(sequence.summary, `${sequencePath}.summary`, errors);
    });
  });
  return [...errors, ...validateStoryOutlineSemantics(outline)];
}

export function validateStoryPagesIndexDocument(pagesIndex) {
  const errors = [];
  if (!isRecord(pagesIndex)) return ["pages index 必须是 JSON 对象"];
  checkExactKeys(pagesIndex, ["$schema", "by_sequence"], "pages index", errors);
  if (pagesIndex.$schema !== STORY_PAGES_INDEX_SCHEMA_ID) errors.push("pages index.$schema 不匹配");
  if (!isRecord(pagesIndex.by_sequence)) errors.push("pages index.by_sequence 必须是对象");
  else for (const [sequenceId, pageIds] of Object.entries(pagesIndex.by_sequence)) {
    if (!storyIdPattern.test(sequenceId)) errors.push(`pages index.by_sequence 包含无效 sequence ID：${sequenceId}`);
    if (!Array.isArray(pageIds)) errors.push(`pages index.by_sequence.${sequenceId} 必须是数组`);
    else pageIds.forEach((pageId, pageIndex) => {
      if (!storyPageIdPattern.test(pageId ?? "")) errors.push(`pages index.by_sequence.${sequenceId}[${pageIndex}] 不是有效页面 ID`);
    });
  }
  return [...errors, ...validateStoryPagesIndexSemantics(pagesIndex)];
}

export function validateStoryOutlineSemantics(outline) {
  const errors = [];
  const chapterIds = new Set();
  const sequenceIds = new Set();
  for (const [chapterIndex, chapter] of (Array.isArray(outline?.chapters) ? outline.chapters : []).entries()) {
    if (typeof chapter?.id === "string") {
      if (chapterIds.has(chapter.id)) errors.push(`chapters[${chapterIndex}].id 重复：${chapter.id}`);
      chapterIds.add(chapter.id);
    }
    for (const [sequenceIndex, sequence] of (Array.isArray(chapter?.sequences) ? chapter.sequences : []).entries()) {
      if (typeof sequence?.id !== "string") continue;
      if (sequenceIds.has(sequence.id)) errors.push(`chapters[${chapterIndex}].sequences[${sequenceIndex}].id 在故事中重复：${sequence.id}`);
      sequenceIds.add(sequence.id);
    }
  }
  return errors;
}

export function validateStoryPagesIndexSemantics(pagesIndex) {
  const errors = [];
  const pageOwners = new Map();
  for (const { sequenceId, pageId } of indexedPages(pagesIndex)) {
    if (pageOwners.has(pageId)) errors.push(`页面 ${pageId} 同时属于 ${pageOwners.get(pageId)} 和 ${sequenceId}`);
    else pageOwners.set(pageId, sequenceId);
  }
  return errors;
}

export function validateStoryPageNarrativeSemantics(narrative) {
  const errors = [];
  const characterIds = new Set();
  for (const [index, character] of (Array.isArray(narrative?.characters) ? narrative.characters : []).entries()) {
    if (typeof character?.character_id !== "string") continue;
    if (characterIds.has(character.character_id)) errors.push(`characters[${index}].character_id 重复：${character.character_id}`);
    characterIds.add(character.character_id);
  }
  const dialogueIds = new Set();
  for (const [index, dialogue] of (Array.isArray(narrative?.dialogue) ? narrative.dialogue : []).entries()) {
    if (typeof dialogue?.id === "string") {
      if (dialogueIds.has(dialogue.id)) errors.push(`dialogue[${index}].id 重复：${dialogue.id}`);
      dialogueIds.add(dialogue.id);
    }
  }
  return errors;
}

// narrative.characters only describes visible render participants. A project
// character may own offscreen dialogue without becoming a visual reference.
export function storyNarrativeSpeakerIds(narrative) {
  return [...new Set((Array.isArray(narrative?.dialogue) ? narrative.dialogue : [])
    .filter((dialogue) => dialogue?.mode !== "narration" && dialogue?.speaker !== "npc")
    .map((dialogue) => dialogue?.speaker)
    .filter((speaker) => typeof speaker === "string"))];
}

export function validateStoryPageNarrativeDocument(narrative) {
  const errors = [];
  if (!isRecord(narrative)) return ["narrative 必须是 JSON 对象"];
  checkExactKeys(narrative, ["$schema", "title", "scene_description", "characters", "dialogue", "page_kind", "body", "display_title", "text_layout"], "narrative", errors);
  if (narrative.$schema !== STORY_PAGE_NARRATIVE_SCHEMA_ID) errors.push("narrative.$schema 不匹配");
  const isTextPage = narrative.page_kind !== undefined;
  if (isTextPage && narrative.page_kind !== "text") errors.push("narrative.page_kind 目前只支持 text");
  if (narrative.body !== undefined && (!isTextPage || typeof narrative.body !== "string")) errors.push("narrative.body 仅文字页使用，必须是字符串");
  if (narrative.display_title !== undefined && (!isTextPage || typeof narrative.display_title !== "string")) errors.push("narrative.display_title 仅文字页使用，必须是字符串");
  if (narrative.text_layout !== undefined) {
    const layout = narrative.text_layout;
    if (!isTextPage || !isRecord(layout)) errors.push("narrative.text_layout 仅文字页使用，必须是对象");
    else {
      checkExactKeys(layout, ["title_font_size", "body_font_size", "title_align", "body_align", "position"], "narrative.text_layout", errors);
      for (const key of ["title_font_size", "body_font_size"]) {
        if (!Number.isInteger(layout[key]) || layout[key] < 12 || layout[key] > 192) errors.push(`narrative.text_layout.${key} 必须是 12 到 192 的整数`);
      }
      for (const key of ["title_align", "body_align"]) if (!["left", "center", "right"].includes(layout[key])) errors.push(`narrative.text_layout.${key} 无效`);
      if (!["upper", "center", "lower"].includes(layout.position)) errors.push("narrative.text_layout.position 无效");
    }
  }
  checkNonemptyText(narrative.title, "narrative.title", errors);
  if (typeof narrative.scene_description !== "string") errors.push("narrative.scene_description 必须是字符串");
  if (!Array.isArray(narrative.characters)) errors.push("narrative.characters 必须是数组");
  else narrative.characters.forEach((character, index) => {
    const valuePath = `narrative.characters[${index}]`;
    if (!isRecord(character)) { errors.push(`${valuePath} 必须是对象`); return; }
    checkExactKeys(character, ["character_id", "variant_id"], valuePath, errors);
    if (!storyIdPattern.test(character.character_id ?? "")) errors.push(`${valuePath}.character_id 不是有效可读 ID`);
    if (!storyIdPattern.test(character.variant_id ?? "") || character.variant_id === "main") errors.push(`${valuePath}.variant_id 不是有效 variant ID`);
  });
  if (!Array.isArray(narrative.dialogue)) errors.push("narrative.dialogue 必须是数组");
  else narrative.dialogue.forEach((dialogue, index) => {
    const valuePath = `narrative.dialogue[${index}]`;
    if (!isRecord(dialogue)) { errors.push(`${valuePath} 必须是对象`); return; }
    checkExactKeys(dialogue, ["id", "mode", "speaker", "text", "position"], valuePath, errors);
    if (!storyDialogueIdPattern.test(dialogue.id ?? "")) errors.push(`${valuePath}.id 不是有效对白 ID`);
    if (!new Set(["narration", "speech", "thought", "heart"]).has(dialogue.mode)) errors.push(`${valuePath}.mode 无效`);
    if (dialogue.mode === "narration" && dialogue.speaker !== undefined) errors.push(`${valuePath} 的旁白不能设置 speaker`);
    if (dialogue.position !== undefined) {
      if (dialogue.mode !== "narration") errors.push(`${valuePath}.position 仅旁白可以设置`);
      else if (!new Set(["top", "bottom"]).has(dialogue.position)) errors.push(`${valuePath}.position 必须是 top 或 bottom`);
    }
    if ((dialogue.mode === "speech" || dialogue.mode === "thought" || dialogue.mode === "heart" && dialogue.speaker !== undefined) && !storyIdPattern.test(dialogue.speaker ?? "")) errors.push(`${valuePath}.speaker 必须是有效角色 ID 或 npc`);
    if (dialogue.mode === "thought" && dialogue.speaker === "npc") errors.push(`${valuePath} 的 NPC 不能使用心理活动`);
    checkNonemptyText(dialogue.text, `${valuePath}.text`, errors);
    if (dialogue.mode === "narration" && typeof dialogue.text === "string") {
      const length = [...dialogue.text].length;
      if (length > NARRATION_CHARACTER_LIMIT) errors.push(`${valuePath}.text 旁白不能超过 ${NARRATION_CHARACTER_LIMIT} 字，当前 ${length} 字`);
    }
  });
  const narrationCount = (Array.isArray(narrative.dialogue) ? narrative.dialogue : [])
    .filter((dialogue) => isRecord(dialogue) && dialogue.mode === "narration").length;
  if (narrationCount > 1) errors.push(`narrative.dialogue 每页至多一条旁白，当前有 ${narrationCount} 条`);
  if (isTextPage) {
    if (Array.isArray(narrative.characters) && narrative.characters.length) errors.push("文字页 narrative.characters 必须为空");
    if (Array.isArray(narrative.dialogue) && narrative.dialogue.length) errors.push("文字页 narrative.dialogue 必须为空");
  }
  return [...errors, ...validateStoryPageNarrativeSemantics(narrative)];
}

export const storyPromptFragmentIdPattern = /^token-[a-f0-9]{12}$/;

function validatePromptFragment(fragment, valuePath, errors) {
  if (!isRecord(fragment)) { errors.push(`${valuePath} 必须是对象`); return; }
  checkExactKeys(fragment, ["id", "tag", "description", "camera_settings", "character_id", "weight", "enabled"], valuePath, errors);
  if (fragment.id !== undefined && !storyPromptFragmentIdPattern.test(fragment.id)) errors.push(`${valuePath}.id 不是有效 Prompt 片段 ID`);
  const textKeys = ["tag", "description"].filter((key) => Object.hasOwn(fragment, key));
  if (textKeys.length !== 1) errors.push(`${valuePath} 必须且只能包含 tag、description 之一`);
  else checkNonemptyText(fragment[textKeys[0]], `${valuePath}.${textKeys[0]}`, errors);
  if (fragment.camera_settings !== undefined) { try { validateCameraSettings(fragment.camera_settings); } catch (error) { errors.push(`${valuePath}.camera_settings: ${error.message}`); } }
  if (fragment.character_id !== undefined && !storyIdPattern.test(fragment.character_id)) errors.push(`${valuePath}.character_id 不是有效可读 ID`);
  if (fragment.weight !== undefined && (typeof fragment.weight !== "number" || !Number.isFinite(fragment.weight))) errors.push(`${valuePath}.weight 必须是有限数字`);
  if (fragment.enabled !== undefined && typeof fragment.enabled !== "boolean") errors.push(`${valuePath}.enabled 必须是布尔值`);
}

export function preparePromptForPersistence(prompt, { baselinePrompt, createFragmentId } = {}) {
  const prepared = structuredClone(prompt);
  const baselineIds = new Set(storyPromptCategories.flatMap((category) => (
    Array.isArray(baselinePrompt?.[category]) ? baselinePrompt[category] : []
  )).map((fragment) => fragment?.id).filter((id) => typeof id === "string"));
  const occupiedIds = new Set(baselineIds);
  const submittedIds = new Set();
  for (const category of storyPromptCategories) {
    for (const [index, fragment] of (Array.isArray(prepared?.[category]) ? prepared[category] : []).entries()) {
      if (!isRecord(fragment)) continue;
      if (fragment.id !== undefined) {
        if (!baselineIds.has(fragment.id)) throw new TypeError(`${category}[${index}] 的新增 Prompt 片段不允许指定 id`);
        if (submittedIds.has(fragment.id)) throw new TypeError(`${category}[${index}] 的 Prompt 片段 id 重复`);
        submittedIds.add(fragment.id);
        occupiedIds.add(fragment.id);
        continue;
      }
      if (typeof createFragmentId !== "function") throw new TypeError("新增 Prompt 片段需要 createFragmentId");
      const fragmentId = createFragmentId([...occupiedIds]);
      if (!storyPromptFragmentIdPattern.test(fragmentId) || occupiedIds.has(fragmentId)) {
        throw new TypeError("createFragmentId 必须返回未占用的有效 Prompt 片段 ID");
      }
      fragment.id = fragmentId;
      submittedIds.add(fragmentId);
      occupiedIds.add(fragmentId);
    }
  }
  return prepared;
}

export function validateStoryPagePromptDocument(prompt) {
  const errors = [];
  if (!isRecord(prompt)) return ["prompt 必须是 JSON 对象"];
  if (prompt.scene_id !== undefined && !storyIdPattern.test(prompt.scene_id)) errors.push('scene_id 无效');
  if (prompt.scene_variant_id !== undefined && (!storyIdPattern.test(prompt.scene_variant_id) || prompt.scene_variant_id === 'main')) errors.push('scene_variant_id 无效');
  if ((prompt.scene_id === undefined) !== (prompt.scene_variant_id === undefined)) errors.push('scene_id 和 scene_variant_id 必须同时提供');
  if (prompt.inheritance !== undefined) {
    if (!isRecord(prompt.inheritance)) errors.push('inheritance 必须是对象');
    else for (const [source, adjustments] of Object.entries(prompt.inheritance)) {
      if (!/^(character:[a-z0-9-]+:[a-z0-9-]+|scene:[a-z0-9-]+:[a-z0-9-]+)$/.test(source)) errors.push('继承来源无效：' + source);
      errors.push(...validateAdjustments(adjustments, source));
    }
  }
  checkExactKeys(prompt, ["$schema", "reference_images", "reference_overrides", "scene_id", "scene_variant_id", "inheritance", ...storyPromptCategories], "prompt", errors);
  errors.push(...validateReferenceEntries(prompt.reference_images), ...validateReferenceOverrides(prompt.reference_overrides));
  if (prompt.$schema !== STORY_PAGE_PROMPT_SCHEMA_ID) errors.push("prompt.$schema 不匹配");
  for (const category of storyPromptCategories) {
    if (!Array.isArray(prompt[category])) errors.push(`prompt.${category} 必须是数组`);
    else prompt[category].forEach((fragment, index) => validatePromptFragment(fragment, `prompt.${category}[${index}]`, errors));
  }
  return errors;
}

// text-sources 是 keyed by dialogue_id 的可选参考索引，空文档约定为 {}，
// 因此 $schema 可选（出现时必须匹配），不要求必填。
export function validateStoryPageTextSourcesDocument(textSources) {
  const errors = [];
  if (!isRecord(textSources)) return ["text-sources 必须是 JSON 对象"];
  if (textSources.$schema !== undefined && textSources.$schema !== STORY_PAGE_TEXT_SOURCES_SCHEMA_ID) {
    errors.push("text-sources.$schema 不匹配");
  }
  for (const [dialogueId, entry] of Object.entries(textSources)) {
    if (dialogueId === "$schema") continue;
    const valuePath = `text-sources[${dialogueId}]`;
    if (!storyDialogueIdPattern.test(dialogueId)) { errors.push(`${valuePath} 的 key 不是有效对白 ID`); continue; }
    if (!isRecord(entry)) { errors.push(`${valuePath} 必须是对象`); continue; }
    checkExactKeys(entry, ["source_file", "offset", "original_sentence"], valuePath, errors);
    checkNonemptyText(entry.source_file, `${valuePath}.source_file`, errors);
    if (!Number.isInteger(entry.offset) || entry.offset < 0) errors.push(`${valuePath}.offset 必须是非负整数`);
    checkNonemptyText(entry.original_sentence, `${valuePath}.original_sentence`, errors);
  }
  return errors;
}

export function promptCharacterIds(prompt) {
  const ids = new Set();
  for (const category of storyPromptCategories) {
    for (const fragment of (Array.isArray(prompt?.[category]) ? prompt[category] : [])) {
      if (typeof fragment?.character_id === "string") ids.add(fragment.character_id);
    }
  }
  return [...ids];
}

/**
 * Edit-session narrative may omit IDs only for newly added dialogue. The write layer
 * calls this seam before validating against the persisted narrative schema, which
 * intentionally continues to require every dialogue ID.
 */
export function prepareStoryPageNarrativeForPersistence(
  narrative,
  { baselineNarrative = { dialogue: [] }, createDialogueId } = {},
) {
  const prepared = structuredClone(narrative);
  const baselineIds = new Set((Array.isArray(baselineNarrative?.dialogue) ? baselineNarrative.dialogue : [])
    .map((dialogue) => dialogue?.id)
    .filter((id) => typeof id === "string"));
  const occupiedIds = new Set(baselineIds);
  for (const [index, dialogue] of (Array.isArray(prepared?.dialogue) ? prepared.dialogue : []).entries()) {
    if (!isRecord(dialogue)) continue;
    if (dialogue.id !== undefined) {
      if (!baselineIds.has(dialogue.id)) throw new TypeError(`dialogue[${index}] 的新增对白不允许指定 id`);
      occupiedIds.add(dialogue.id);
      continue;
    }
    if (typeof createDialogueId !== "function") throw new TypeError("新增对白需要 createDialogueId");
    const dialogueId = createDialogueId([...occupiedIds]);
    if (!storyDialogueIdPattern.test(dialogueId) || occupiedIds.has(dialogueId)) {
      throw new TypeError("createDialogueId 必须返回未占用的有效对白 ID");
    }
    dialogue.id = dialogueId;
    occupiedIds.add(dialogueId);
  }
  return prepared;
}

export function diagnoseStoryPageFiles({ outline, pagesIndex, narrativePageIds = [], promptPageIds = [] }) {
  const diagnostics = [];
  const knownSequences = new Set(sequenceIdsFromOutline(outline));
  const indexed = indexedPages(pagesIndex);
  const indexedPageIds = new Set(indexed.map(({ pageId }) => pageId));
  const narrativeIds = new Set(narrativePageIds);
  const promptIds = new Set(promptPageIds);

  for (const sequenceId of Object.keys(isRecord(pagesIndex?.by_sequence) ? pagesIndex.by_sequence : {})) {
    if (!knownSequences.has(sequenceId)) diagnostics.push({ code: "dangling_sequence_reference", sequence_id: sequenceId });
  }

  const allPageIds = new Set([...indexedPageIds, ...narrativeIds, ...promptIds]);
  for (const pageId of allPageIds) {
    if (!narrativeIds.has(pageId)) diagnostics.push({ code: "missing_narrative_file", page_id: pageId });
    if (!promptIds.has(pageId)) diagnostics.push({ code: "missing_prompt_file", page_id: pageId });
    if (!indexedPageIds.has(pageId)) diagnostics.push({ code: "unindexed_page_file", page_id: pageId });
  }
  return diagnostics;
}
