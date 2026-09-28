import { validatePopulation } from '../../../shared/prompt-population.mjs';
import { validateReferenceEntries, validateReferenceOverrides } from "../../../shared/reference-images.mjs";
import { validateCameraSettings } from "../../../shared/camera-prompt.mjs";
import { validateAdjustments } from '../../../shared/prompt-inheritance.mjs';
import { NARRATION_CHARACTER_LIMIT } from "../../../shared/story-content-guidance.mjs";
export const STORY_PAGE_PROMPT_SCHEMA_ID = "https://storyvisualizer.local/schemas/story-page-prompt.schema.json";
export const storyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const storyPromptCategories = Object.freeze(["population","person","setting","camera","avoid"]);
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

export const storyPromptFragmentIdPattern = /^token-[a-f0-9]{12}$/;

function invalidFragmentId(field, message) {
  return Object.assign(new TypeError(message), {
    status: 400, code: 'invalid_prompt_fragment', details: [{ field, message }],
  });
}

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
        const field = `${category}[${index}].id`;
        if (!baselineIds.has(fragment.id)) throw invalidFragmentId(field, `${field}：新增 Prompt 片段请省略 id，由服务端生成；已有片段保留读取时的 id`);
        if (submittedIds.has(fragment.id)) throw invalidFragmentId(field, `${field}：片段 id 重复；已有片段只能提交一次，新副本请省略 id`);
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
  errors.push(...validatePopulation(prompt));
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
