import {validateReferenceEntries,validateReferenceOverrides} from '../../../shared/reference-images.mjs';
import {parseOverrideSource} from '../../prompt-contract.mjs';
const STORY_PAGE_PROMPT_SCHEMA_ID='https://storyvisualizer.local/schemas/story-page-prompt.schema.json';
const CHARACTER_PROMPT_SCHEMA_ID='https://storyvisualizer.local/schemas/character-prompt.schema.json';
const storyIdPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const characterVariantIdPattern=storyIdPattern;
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

export function validateTextOverrides(value) {
  if (value === undefined) return [];
  if (!isRecord(value)) return ["text_overrides 必须是对象"];
  const errors = [];
  for (const [source, text] of Object.entries(value)) {
    if (!parseOverrideSource(source)) errors.push(`text_overrides 的来源无效：${source}`);
    else if (typeof text !== "string") errors.push(`text_overrides.${source} 必须是字符串`);
  }
  return errors;
}

export function validateStoryPagePromptDocument(prompt) {
  const errors = [];
  if (!isRecord(prompt)) return ["prompt 必须是 JSON 对象"];
  checkExactKeys(prompt, ["$schema", "text", "composition", "scene_id", "scene_variant_id", "text_overrides", "reference_overrides", "reference_images"], "prompt", errors);
  if (prompt.composition !== undefined && !['settings','standalone'].includes(prompt.composition)) errors.push('Qwen composition 无效');
  if (prompt.$schema !== STORY_PAGE_PROMPT_SCHEMA_ID) errors.push("prompt.$schema 不匹配");
  if (typeof prompt.text !== "string") errors.push("prompt.text 必须是字符串");
  if (prompt.scene_id !== undefined && !storyIdPattern.test(prompt.scene_id)) errors.push('scene_id 无效');
  if (prompt.scene_variant_id !== undefined && (!storyIdPattern.test(prompt.scene_variant_id) || prompt.scene_variant_id === 'main')) errors.push('scene_variant_id 无效');
  if ((prompt.scene_id === undefined) !== (prompt.scene_variant_id === undefined)) errors.push('scene_id 和 scene_variant_id 必须同时提供');
  errors.push(...validateTextOverrides(prompt.text_overrides));
  errors.push(...validateReferenceEntries(prompt.reference_images, { allowPurpose: true }), ...validateReferenceOverrides(prompt.reference_overrides));
  return errors;
}

// 页面 override 的 key 必须对应当前实际引用；切换子设定或移除引用后旧 key 不允许残留。
export function checkPagePromptOverrideReferences(prompt, characterReferences) {
  const errors = [];
  const active = new Set((Array.isArray(characterReferences) ? characterReferences : [])
    .map((reference) => `character:${reference?.character_id}:${reference?.variant_id}`));
  if (prompt?.scene_id) active.add(`scene:${prompt.scene_id}:${prompt.scene_variant_id}`);
  for (const field of ["text_overrides", "reference_overrides"]) {
    for (const source of Object.keys(isRecord(prompt?.[field]) ? prompt[field] : {})) {
      if (!active.has(source)) errors.push(`${field} 引用了未出场的设定：${source}`);
    }
  }
  return errors;
}

export function promptOverrideCharacterIds(prompt) {
  const ids = new Set();
  for (const field of ["text_overrides", "reference_overrides"]) {
    for (const source of Object.keys(isRecord(prompt?.[field]) ? prompt[field] : {})) {
      const parsed = parseOverrideSource(source);
      if (parsed?.kind === "character") ids.add(parsed.id);
    }
  }
  return [...ids];
}

export function validateCharacterPromptDocument(promptDocument) {
  const errors = [];
  if (!isRecord(promptDocument)) return ["character prompt 必须是对象"];
  checkExactKeys(promptDocument, ["$schema", "prompt_name", "variants"], "character prompt", errors);
  if (promptDocument.$schema !== CHARACTER_PROMPT_SCHEMA_ID) errors.push("character prompt.$schema 不匹配");
  checkNonemptyText(promptDocument.prompt_name, "character prompt.prompt_name", errors, 200);
  if (!isRecord(promptDocument.variants)) errors.push("character prompt.variants 必须是对象");
  else {
    const variantIdList = Object.keys(promptDocument.variants);
    if (variantIdList.length === 0) errors.push("character prompt.variants 至少需要一个造型");
    for (const [variantId, configuration] of Object.entries(promptDocument.variants)) {
      const valuePath = `character prompt.variants.${variantId}`;
      if (!characterVariantIdPattern.test(variantId) || variantId === "main") errors.push(`character prompt.variants 包含无效 variant ID：${variantId}`);
      if (!isRecord(configuration)) { errors.push(`${valuePath} 必须是对象`); continue; }
      checkExactKeys(configuration, ["text", "reference_images"], valuePath, errors);
      if (typeof configuration.text !== "string") errors.push(`${valuePath}.text 必须是字符串`);
      errors.push(...validateReferenceEntries(configuration.reference_images));
    }
  }
  return errors;
}
