import { validateCameraSettings } from "../shared/camera-prompt.mjs";
import { adjustmentKey, validateAdjustments, promptWord } from '../shared/prompt-inheritance.mjs';
import {
  STORY_PAGE_PROMPT_SCHEMA_ID,
  preparePromptForPersistence,
  storyPromptFragmentIdPattern,
  storyNarrativeSpeakerIds,
  storyPageIdPattern,
  validateStoryPagePromptDocument,
} from "./story-files.mjs";

export const CHARACTER_INDEX_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-index.schema.json";
export const CHARACTER_PROFILE_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-profile.schema.json";
export const CHARACTER_VISUAL_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-visual.schema.json";
export const CHARACTER_PROMPT_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-prompt.schema.json";
export const CHARACTER_LORA_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-lora.schema.json";
export const CHARACTER_PAGES_INDEX_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-pages-index.schema.json";
export const CHARACTER_PAGE_GOAL_SCHEMA_ID = "https://storyvisualizer.local/schemas/character-page-goal.schema.json";

// 角色视觉页与剧情页共享同一份页面 Prompt 契约，不建立第二套分类或片段规则。
export const CHARACTER_PAGE_PROMPT_SCHEMA_ID = STORY_PAGE_PROMPT_SCHEMA_ID;

export const characterIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const characterVariantIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, allowed, valuePath, errors) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
}

function checkNonemptyText(value, valuePath, errors, maxLength = null) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${valuePath} 必须是非空字符串`);
  else if (maxLength !== null && value.length > maxLength) errors.push(`${valuePath} 不能超过 ${maxLength} 个字符`);
}

function validatePromptFragment(fragment, valuePath, errors) {
  if (!isRecord(fragment)) { errors.push(`${valuePath} 必须是对象`); return; }
  checkExactKeys(fragment, ["id", "tag", "description", "camera_settings", "weight", "enabled"], valuePath, errors);
  if (fragment.id !== undefined && !storyPromptFragmentIdPattern.test(fragment.id)) errors.push(`${valuePath}.id 不是有效 Prompt 片段 ID`);
  const textKeys = ["tag", "description"].filter((key) => Object.hasOwn(fragment, key));
  if (textKeys.length !== 1) errors.push(`${valuePath} 必须且只能包含 tag、description 之一`);
  else checkNonemptyText(fragment[textKeys[0]], `${valuePath}.${textKeys[0]}`, errors);
  if (fragment.camera_settings !== undefined) { try { validateCameraSettings(fragment.camera_settings); } catch (error) { errors.push(`${valuePath}.camera_settings: ${error.message}`); } }
  if (fragment.weight !== undefined && (typeof fragment.weight !== "number" || !Number.isFinite(fragment.weight))) errors.push(`${valuePath}.weight 必须是有限数字`);
  if (fragment.enabled !== undefined && typeof fragment.enabled !== "boolean") errors.push(`${valuePath}.enabled 必须是布尔值`);
}

const promptCategories = ["subject","person","setting","camera","avoid"];

function validatePrompt(value, valuePath, errors) {
  if (!isRecord(value)) { errors.push(`${valuePath} 必须是对象`); return; }
  checkExactKeys(value, promptCategories, valuePath, errors);
  for (const category of promptCategories) {
    if (!Array.isArray(value[category])) errors.push(`${valuePath}.${category} 必须是数组`);
    else value[category].forEach((fragment, index) => validatePromptFragment(fragment, `${valuePath}.${category}[${index}]`, errors));
  }
}

function validateLora(value, valuePath, errors) {
  if (value === null) return;
  if (!isRecord(value)) { errors.push(`${valuePath} 必须是 null 或对象`); return; }
  checkExactKeys(value, ["filename", "sha256", "weight", "trigger"], valuePath, errors);
  if (typeof value.filename !== "string"
    || !/^(?!\s)(?!.*\s$)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\:]).+$/.test(value.filename)) errors.push(`${valuePath}.filename 无效`);
  if (!/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) errors.push(`${valuePath}.sha256 无效`);
  if (typeof value.weight !== "number" || !Number.isFinite(value.weight) || value.weight < -2 || value.weight > 2) errors.push(`${valuePath}.weight 必须在 -2 到 2 之间`);
  if (value.trigger !== undefined) checkNonemptyText(value.trigger, `${valuePath}.trigger`, errors);
}

export function validateCharacterIndexDocument(characterIndex) {
  const errors = [];
  if (!isRecord(characterIndex)) return ["character index 必须是对象"];
  checkExactKeys(characterIndex, ["$schema", "characters"], "character index", errors);
  if (characterIndex.$schema !== CHARACTER_INDEX_SCHEMA_ID) errors.push("character index.$schema 不匹配");
  if (!Array.isArray(characterIndex.characters)) errors.push("character index.characters 必须是数组");
  else characterIndex.characters.forEach((characterId, index) => {
    if (!characterIdPattern.test(characterId ?? "") || characterId === "npc") errors.push(`character index.characters[${index}] 不是有效角色 ID`);
  });
  return [...errors, ...validateCharacterIndexSemantics(characterIndex)];
}

export function validateCharacterProfileDocument(profile) {
  const errors = [];
  if (!isRecord(profile)) return ["character profile 必须是对象"];
  checkExactKeys(profile, ["$schema", "name", "description"], "character profile", errors);
  if (profile.$schema !== CHARACTER_PROFILE_SCHEMA_ID) errors.push("character profile.$schema 不匹配");
  checkNonemptyText(profile.name, "character profile.name", errors, 100);
  checkNonemptyText(profile.description, "character profile.description", errors, 1000);
  return errors;
}

export function validateCharacterVisualDocument(visual) {
  const errors = [];
  if (!isRecord(visual)) return ["character visual 必须是对象"];
  checkExactKeys(visual, ["$schema", "description", "base_description", "variants"], "character visual", errors);
  if (visual.$schema !== CHARACTER_VISUAL_SCHEMA_ID) errors.push("character visual.$schema 不匹配");
  if (visual.description !== undefined) checkNonemptyText(visual.description, "character visual.description", errors);
  if (visual.base_description !== undefined) checkNonemptyText(visual.base_description, "character visual.base_description", errors);
  if (!Array.isArray(visual.variants)) errors.push("character visual.variants 必须是数组");
  else {
    if (visual.variants.length === 0) errors.push("character visual.variants 至少需要一个子设定");
    visual.variants.forEach((variant, index) => {
      const valuePath = `character visual.variants[${index}]`;
      if (!isRecord(variant)) { errors.push(`${valuePath} 必须是对象`); return; }
      checkExactKeys(variant, ["id", "name", "description"], valuePath, errors);
      if (!characterVariantIdPattern.test(variant.id ?? "") || variant.id === "main") errors.push(`${valuePath}.id 不是有效 variant ID`);
      checkNonemptyText(variant.name, `${valuePath}.name`, errors, 100);
      if (variant.description !== undefined && typeof variant.description !== "string") errors.push(`${valuePath}.description 必须是字符串`);
    });
  }
  return [...errors, ...validateCharacterVisualSemantics(visual)];
}

export function validateCharacterPromptDocument(promptDocument) {
  const errors = [];
  if (!isRecord(promptDocument)) return ["character prompt 必须是对象"];
  checkExactKeys(promptDocument, ["$schema", "identity", "variants"], "character prompt", errors);
  if (promptDocument.$schema !== CHARACTER_PROMPT_SCHEMA_ID) errors.push("character prompt.$schema 不匹配");
  if (!isRecord(promptDocument.identity)) errors.push("character prompt.identity 必须是对象");
  else {
    checkExactKeys(promptDocument.identity, ["prompt", "lora"], "character prompt.identity", errors);
    validatePrompt(promptDocument.identity.prompt, "character prompt.identity.prompt", errors);
    validateLora(promptDocument.identity.lora, "character prompt.identity.lora", errors);
  }
  if (!isRecord(promptDocument.variants)) errors.push("character prompt.variants 必须是对象");
  else {
    const variantIdList = Object.keys(promptDocument.variants);
    if (variantIdList.length === 0) errors.push("character prompt.variants 至少需要一个造型");
    for (const variantId of variantIdList) {
      if (!characterVariantIdPattern.test(variantId) || variantId === "main") errors.push(`character prompt.variants 包含无效 variant ID：${variantId}`);
    }
    // identity_disabled 只允许关闭 identity 中存在的文本键；enabled:false 的自有片段是合法草稿，不做校验。
    const identityKeys = new Set(Object.values(isRecord(promptDocument.identity?.prompt) ? promptDocument.identity.prompt : {}).flat()
      .map(promptFragmentTextKey)
      .filter(Boolean));
    for (const [variantId, configuration] of Object.entries(promptDocument.variants)) {
      const valuePath = `character prompt.variants.${variantId}`;
      if (!isRecord(configuration)) { errors.push(`${valuePath} 必须是对象`); continue; }
      checkExactKeys(configuration, ["prompt", "loras", "identity_disabled", "identity_overrides"], valuePath, errors);
      validatePrompt(configuration.prompt, `${valuePath}.prompt`, errors);
      if (!Array.isArray(configuration.loras)) errors.push(`${valuePath}.loras 必须是数组`);
      else configuration.loras.forEach((lora, index) => {
        if (!isRecord(lora)) errors.push(`${valuePath}.loras[${index}] 必须是对象`);
        else validateLora(lora, `${valuePath}.loras[${index}]`, errors);
      });
      errors.push(...validateAdjustments(configuration.identity_overrides, `${valuePath}.identity_overrides`));
      const availableWords = new Set(Object.entries(promptDocument.identity?.prompt ?? {}).flatMap(([category, fragments]) => Array.isArray(fragments) ? fragments.map(fragment => adjustmentKey(fragment, category)) : []));
      for (const key of Object.keys(configuration.identity_overrides ?? {})) if (!availableWords.has(key)) errors.push(valuePath + ' 的继承词不存在：' + key);
      const disabledPath = valuePath + '.identity_disabled';
      if (!Array.isArray(configuration.identity_disabled)) errors.push(`${disabledPath} 必须是数组`);
      else {
        const seen = new Set();
        configuration.identity_disabled.forEach((key, index) => {
          const normalized = typeof key === "string" ? key.trim().toLowerCase() : "";
          if (!normalized) { errors.push(`${disabledPath}[${index}] 必须是非空字符串`); return; }
          if (seen.has(normalized)) errors.push(`${disabledPath}[${index}] 重复：${key}`);
          seen.add(normalized);
          if (!identityKeys.has(normalized)) errors.push(`${disabledPath}[${index}] 关闭了 identity.prompt 中不存在的片段：${key}`);
        });
      }
    }
  }
  return errors;
}

function promptFragmentTextKey(fragment) {
  const textKey = ["tag", "description"].find((key) => Object.hasOwn(fragment ?? {}, key));
  return textKey ? String(fragment[textKey]).trim().toLowerCase() : "";
}

function effectiveIdentityKeys(prompt) {
  return new Set(Object.values(isRecord(prompt) ? prompt : {}).flat()
    .filter((fragment) => fragment?.enabled !== false)
    .map(promptFragmentTextKey)
    .filter(Boolean));
}

// identity.prompt 变化对每个造型的实际影响：被删除且未被 identity_disabled 引用的键失去继承，新增键开始继承。
export function characterIdentityImpact(baselinePrompt, nextPrompt) {
  const baselineKeys = effectiveIdentityKeys(baselinePrompt?.identity?.prompt);
  const nextKeys = effectiveIdentityKeys(nextPrompt?.identity?.prompt);
  const removed = [...baselineKeys].filter((key) => !nextKeys.has(key)).sort((left, right) => left.localeCompare(right, "en"));
  const added = [...nextKeys].filter((key) => !baselineKeys.has(key)).sort((left, right) => left.localeCompare(right, "en"));
  if (!removed.length && !added.length) return null;
  const perVariant = {};
  for (const [variantId, configuration] of Object.entries(isRecord(nextPrompt?.variants) ? nextPrompt.variants : {})) {
    const overridden = new Set((Array.isArray(configuration?.identity_disabled) ? configuration.identity_disabled : [])
      .map((key) => String(key).trim().toLowerCase())
      .filter(Boolean));
    const lost = removed.filter((key) => !overridden.has(key));
    if (lost.length || added.length) perVariant[variantId] = { lost_inheritance: lost, new_inheritance: added };
  }
  return { per_variant: perVariant };
}

export function prepareCharacterPromptForPersistence(promptDocument, { baselinePrompt, createFragmentId } = {}) {
  const prepared = structuredClone(promptDocument);
  if (isRecord(prepared.identity)) {
    prepared.identity.prompt = preparePromptForPersistence(prepared.identity.prompt, {
      baselinePrompt: baselinePrompt?.identity?.prompt,
      createFragmentId,
    });
  }
  const settings = [];
  if (isRecord(prepared.variants)) {
    for (const [variantId, setting] of Object.entries(prepared.variants)) {
      settings.push([setting, baselinePrompt?.variants?.[variantId]]);
    }
  }
  for (const [setting, baselineSetting] of settings) {
    if (!isRecord(setting)) continue;
    setting.prompt = preparePromptForPersistence(setting.prompt, {
      baselinePrompt: baselineSetting?.prompt,
      createFragmentId,
    });
  }
  return prepared;
}

export function validateCharacterLoraDocument(loraDocument) {
  const errors = [];
  if (!isRecord(loraDocument)) return ["character LoRA 必须是对象"];
  checkExactKeys(loraDocument, ["$schema", "identity", "variants"], "character LoRA", errors);
  if (loraDocument.$schema !== CHARACTER_LORA_SCHEMA_ID) errors.push("character LoRA.$schema 不匹配");
  validateLora(loraDocument.identity, "character LoRA.identity", errors);
  const validateLoras = (loras, valuePath) => {
    if (!Array.isArray(loras)) { errors.push(`${valuePath} 必须是数组`); return; }
    loras.forEach((lora, index) => {
      if (!isRecord(lora)) { errors.push(`${valuePath}[${index}] 必须是对象`); return; }
      validateLora(lora, `${valuePath}[${index}]`, errors);
    });
  };
  if (!isRecord(loraDocument.variants)) errors.push("character LoRA.variants 必须是对象");
  else {
    if (Object.keys(loraDocument.variants).length === 0) errors.push("character LoRA.variants 至少需要一个造型");
    for (const [variantId, loras] of Object.entries(loraDocument.variants)) {
      if (!characterVariantIdPattern.test(variantId) || variantId === "main") errors.push(`character LoRA.variants 包含无效 variant ID：${variantId}`);
      validateLoras(loras, `character LoRA.variants.${variantId}`);
    }
  }
  return errors;
}

export function validateCharacterPagesIndexDocument(indexDocument) {
  const errors = [];
  if (!isRecord(indexDocument)) return ["character pages index 必须是对象"];
  checkExactKeys(indexDocument, ["$schema", "pages", "next_number"], "character pages index", errors);
  if (indexDocument.$schema !== CHARACTER_PAGES_INDEX_SCHEMA_ID) errors.push("character pages index.$schema 不匹配");
  if (indexDocument.next_number !== undefined && (!Number.isSafeInteger(indexDocument.next_number) || indexDocument.next_number < 1)) errors.push('next_number 必须是正整数');
  if (!Array.isArray(indexDocument.pages)) errors.push("character pages index.pages 必须是数组");
  else indexDocument.pages.forEach((page, index) => {
    const valuePath = `character pages index.pages[${index}]`;
    if (!isRecord(page)) { errors.push(`${valuePath} 必须是对象`); return; }
    checkExactKeys(page, ["page_id", "character_id", "variant_id"], valuePath, errors);
    if (!storyPageIdPattern.test(page.page_id ?? "")) errors.push(`${valuePath}.page_id 不是有效页面 ID`);
    if (!characterIdPattern.test(page.character_id ?? "") || page.character_id === "npc") errors.push(`${valuePath}.character_id 不是有效角色 ID`);
    if (!characterVariantIdPattern.test(page.variant_id ?? "") || page.variant_id === "main") {
      errors.push(`${valuePath}.variant_id 不是有效 variant ID`);
    }
  });
  return [...errors, ...validateCharacterPagesIndexSemantics(indexDocument)];
}

export function validateCharacterPageGoalDocument(goal) {
  const errors = [];
  if (!isRecord(goal)) return ["character page goal 必须是对象"];
  checkExactKeys(goal, ["$schema", "title", "visual_goal"], "character page goal", errors);
  if (goal.$schema !== CHARACTER_PAGE_GOAL_SCHEMA_ID) errors.push("character page goal.$schema 不匹配");
  checkNonemptyText(goal.title, "character page goal.title", errors);
  if (goal.visual_goal !== undefined) checkNonemptyText(goal.visual_goal, "character page goal.visual_goal", errors);
  return errors;
}

export function validateCharacterPagePromptDocument(prompt) {
  return validateStoryPagePromptDocument(prompt);
}

function characterIds(characterIndex) {
  return Array.isArray(characterIndex?.characters)
    ? characterIndex.characters.filter((id) => typeof id === "string")
    : [];
}

function visualVariantIds(visual) {
  return new Set((Array.isArray(visual?.variants) ? visual.variants : [])
    .map((variant) => variant?.id)
    .filter((id) => typeof id === "string"));
}

function promptVariantIds(prompt) {
  return new Set(isRecord(prompt?.variants) ? Object.keys(prompt.variants) : []);
}

export function validateCharacterIndexSemantics(characterIndex) {
  const errors = [];
  const seen = new Set();
  for (const [index, id] of characterIds(characterIndex).entries()) {
    if (seen.has(id)) errors.push(`characters[${index}] 重复：${id}`);
    seen.add(id);
  }
  return errors;
}

export function validateCharacterVisualSemantics(visual) {
  const errors = [];
  const seen = new Set();
  for (const [index, variant] of (Array.isArray(visual?.variants) ? visual.variants : []).entries()) {
    if (typeof variant?.id !== "string") continue;
    if (seen.has(variant.id)) errors.push(`variants[${index}].id 重复：${variant.id}`);
    seen.add(variant.id);
  }
  return errors;
}

export function validateCharacterPagesIndexSemantics(characterPagesIndex) {
  const errors = [];
  const seen = new Set();
  for (const [index, page] of (Array.isArray(characterPagesIndex?.pages) ? characterPagesIndex.pages : []).entries()) {
    if (typeof page?.page_id !== "string") continue;
    if (seen.has(page.page_id)) errors.push(`pages[${index}].page_id 重复：${page.page_id}`);
    seen.add(page.page_id);
  }
  return errors;
}

export function diagnoseCharacterFiles({
  characterIndex,
  profileCharacterIds = [],
  visualByCharacter = {},
  promptByCharacter = {},
  characterPagesIndex = { pages: [] },
  goalPageIds = [],
  promptPageIds = [],
  characterStyles = { characters: {} },
  storyNarrativesByPage = {},
}) {
  const diagnostics = [];
  const indexedCharacterIds = new Set(characterIds(characterIndex));
  const profileIds = new Set(profileCharacterIds);
  const visualIds = new Set(isRecord(visualByCharacter) ? Object.keys(visualByCharacter) : []);
  const promptIds = new Set(isRecord(promptByCharacter) ? Object.keys(promptByCharacter) : []);

  for (const characterId of indexedCharacterIds) {
    if (!profileIds.has(characterId)) diagnostics.push({ code: "missing_character_profile", character_id: characterId });
    if (!visualIds.has(characterId)) diagnostics.push({ code: "missing_character_visual", character_id: characterId });
    if (!promptIds.has(characterId)) diagnostics.push({ code: "missing_character_prompt", character_id: characterId });
  }
  for (const characterId of profileIds) {
    if (!indexedCharacterIds.has(characterId)) diagnostics.push({ code: "unindexed_character_profile", character_id: characterId });
  }
  for (const characterId of visualIds) {
    if (!indexedCharacterIds.has(characterId)) diagnostics.push({ code: "unindexed_character_visual", character_id: characterId });
  }
  for (const characterId of promptIds) {
    if (!indexedCharacterIds.has(characterId)) diagnostics.push({ code: "unindexed_character_prompt", character_id: characterId });
  }

  for (const characterId of [...visualIds].filter((id) => promptIds.has(id))) {
    const visualVariants = visualVariantIds(visualByCharacter[characterId]);
    const promptVariants = promptVariantIds(promptByCharacter[characterId]);
    for (const variantId of visualVariants) {
      if (!promptVariants.has(variantId)) diagnostics.push({ code: "missing_variant_prompt", character_id: characterId, variant_id: variantId });
    }
    for (const variantId of promptVariants) {
      if (!visualVariants.has(variantId)) diagnostics.push({ code: "dangling_prompt_variant_reference", character_id: characterId, variant_id: variantId });
    }
  }

  const indexedPageIds = new Set();
  for (const page of (Array.isArray(characterPagesIndex?.pages) ? characterPagesIndex.pages : [])) {
    if (!isRecord(page) || typeof page.page_id !== "string") continue;
    indexedPageIds.add(page.page_id);
    if (!indexedCharacterIds.has(page.character_id)) {
      diagnostics.push({ code: "dangling_character_page_owner", page_id: page.page_id, character_id: page.character_id });
      continue;
    }
    if (visualIds.has(page.character_id) && !visualVariantIds(visualByCharacter[page.character_id]).has(page.variant_id)) {
      diagnostics.push({ code: "dangling_character_page_variant", page_id: page.page_id, character_id: page.character_id, variant_id: page.variant_id });
    }
  }
  const goalIds = new Set(goalPageIds);
  const pagePromptIds = new Set(promptPageIds);
  const allPageIds = new Set([...indexedPageIds, ...goalIds, ...pagePromptIds]);
  for (const pageId of allPageIds) {
    if (!goalIds.has(pageId)) diagnostics.push({ code: "missing_character_page_goal", page_id: pageId });
    if (!pagePromptIds.has(pageId)) diagnostics.push({ code: "missing_character_page_prompt", page_id: pageId });
    if (!indexedPageIds.has(pageId)) diagnostics.push({ code: "unindexed_character_page_file", page_id: pageId });
  }

  for (const characterId of Object.keys(isRecord(characterStyles?.characters) ? characterStyles.characters : {})) {
    if (!indexedCharacterIds.has(characterId)) diagnostics.push({ code: "dangling_character_style_reference", character_id: characterId });
  }

  for (const [pageId, narrative] of Object.entries(isRecord(storyNarrativesByPage) ? storyNarrativesByPage : {})) {
    for (const reference of (Array.isArray(narrative?.characters) ? narrative.characters : [])) {
      if (!indexedCharacterIds.has(reference?.character_id)) {
        diagnostics.push({ code: "dangling_story_character_reference", page_id: pageId, character_id: reference?.character_id });
        continue;
      }
      if (visualIds.has(reference.character_id) && !visualVariantIds(visualByCharacter[reference.character_id]).has(reference.variant_id)) {
        diagnostics.push({ code: "dangling_story_variant_reference", page_id: pageId, character_id: reference.character_id, variant_id: reference.variant_id });
      }
    }
    for (const speaker of storyNarrativeSpeakerIds(narrative)) {
      if (!indexedCharacterIds.has(speaker)) diagnostics.push({ code: "dangling_story_dialogue_speaker", page_id: pageId, character_id: speaker });
    }
  }

  return diagnostics;
}

export function diagnoseCharacterCoreDependents({
  characterId,
  exists = true,
  visual = { variants: [] },
  prompt = { variants: {} },
  characterPages = [],
  characterStyles = { characters: {} },
  storyNarrativesByPage = {},
}) {
  const diagnostics = [];
  const visualVariants = visualVariantIds(visual);
  const promptVariants = promptVariantIds(prompt);
  if (exists) {
    for (const variantId of visualVariants) {
      if (!promptVariants.has(variantId)) diagnostics.push({ code: "missing_variant_prompt", character_id: characterId, variant_id: variantId });
    }
    for (const variantId of promptVariants) {
      if (!visualVariants.has(variantId)) diagnostics.push({ code: "dangling_prompt_variant_reference", character_id: characterId, variant_id: variantId });
    }
  }
  for (const page of characterPages) {
    if (page?.character_id !== characterId) continue;
    if (!exists) diagnostics.push({ code: "dangling_character_page_owner", page_id: page.page_id, character_id: characterId });
    else if (!visualVariants.has(page.variant_id)) {
      diagnostics.push({ code: "dangling_character_page_variant", page_id: page.page_id, character_id: characterId, variant_id: page.variant_id });
    }
  }
  if (!exists && Object.hasOwn(isRecord(characterStyles?.characters) ? characterStyles.characters : {}, characterId)) {
    diagnostics.push({ code: "dangling_character_style_reference", character_id: characterId });
  }
  for (const [pageId, narrative] of Object.entries(isRecord(storyNarrativesByPage) ? storyNarrativesByPage : {})) {
    for (const reference of (Array.isArray(narrative?.characters) ? narrative.characters : [])) {
      if (reference?.character_id !== characterId) continue;
      if (!exists) diagnostics.push({ code: "dangling_story_character_reference", page_id: pageId, character_id: characterId });
      else if (!visualVariants.has(reference.variant_id)) {
        diagnostics.push({ code: "dangling_story_variant_reference", page_id: pageId, character_id: characterId, variant_id: reference.variant_id });
      }
    }
    if (!exists && storyNarrativeSpeakerIds(narrative).includes(characterId)) {
      diagnostics.push({ code: "dangling_story_dialogue_speaker", page_id: pageId, character_id: characterId });
    }
  }
  return diagnostics;
}

export function isCharacterPageId(value) {
  return typeof value === "string" && storyPageIdPattern.test(value);
}
