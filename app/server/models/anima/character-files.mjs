import { validatePopulation } from '../../../shared/prompt-population.mjs';
import {validateLoraOverrides} from '../../../shared/lora-inheritance.mjs';
import { validateReferenceEntries } from "../../../shared/reference-images.mjs";
import { adjustmentKey, validateAdjustments } from '../../../shared/prompt-inheritance.mjs';
import {
  STORY_PAGE_PROMPT_SCHEMA_ID,
  prepareSharedPromptForPersistence,
  storyPromptFragmentIdPattern,
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
  checkExactKeys(fragment, ["id", "tag", "description", "weight", "enabled"], valuePath, errors);
  if (!storyPromptFragmentIdPattern.test(fragment.id ?? '')) errors.push(`${valuePath}.id 必须是有效共享 Prompt 片段 ID`);
  const textKeys = ["tag", "description"].filter((key) => Object.hasOwn(fragment, key));
  if (textKeys.length !== 1) errors.push(`${valuePath} 必须且只能包含 tag、description 之一`);
  else checkNonemptyText(fragment[textKeys[0]], `${valuePath}.${textKeys[0]}`, errors);
  if (fragment.weight !== undefined && (typeof fragment.weight !== "number" || !Number.isFinite(fragment.weight))) errors.push(`${valuePath}.weight 必须是有限数字`);
  if (fragment.enabled !== undefined && typeof fragment.enabled !== "boolean") errors.push(`${valuePath}.enabled 必须是布尔值`);
}

const promptCategories = ["population","person","setting","camera","avoid"];

function validatePrompt(value, valuePath, errors) {
  if (!isRecord(value)) { errors.push(`${valuePath} 必须是对象`); return; }
  checkExactKeys(value, promptCategories, valuePath, errors);
  errors.push(...validatePopulation(value,{setting:true}).map(error=>valuePath+"."+error));
  const ids = new Set();
  for (const category of promptCategories) {
    if (!Array.isArray(value[category])) errors.push(`${valuePath}.${category} 必须是数组`);
    else value[category].forEach((fragment, index) => {
      validatePromptFragment(fragment, `${valuePath}.${category}[${index}]`, errors);
      if (typeof fragment?.id === 'string') {
        if (ids.has(fragment.id)) errors.push(`${valuePath}.${category}[${index}].id 在同一来源中重复`);
        ids.add(fragment.id);
      }
    });
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

export function validateCharacterPromptDocument(promptDocument, { baselinePrompt } = {}) {
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
    for (const [variantId, configuration] of Object.entries(promptDocument.variants)) {
      const valuePath = `character prompt.variants.${variantId}`;
      if (!isRecord(configuration)) { errors.push(`${valuePath} 必须是对象`); continue; }
      checkExactKeys(configuration, ["prompt", "loras", "lora_overrides", "identity_overrides", "reference_images"], valuePath, errors);
      errors.push(...validateReferenceEntries(configuration.reference_images));
      validatePrompt(configuration.prompt, `${valuePath}.prompt`, errors);
      if (!Array.isArray(configuration.loras)) errors.push(`${valuePath}.loras 必须是数组`);
      else configuration.loras.forEach((lora, index) => {
        if (!isRecord(lora)) errors.push(`${valuePath}.loras[${index}] 必须是对象`);
        else validateLora(lora, `${valuePath}.loras[${index}]`, errors);
      });
      errors.push(...validateLoraOverrides(configuration.lora_overrides, `${valuePath}.lora_overrides`));
      errors.push(...validateAdjustments(configuration.identity_overrides, `${valuePath}.identity_overrides`, {
        layers: ['identity'],
        ...(baselinePrompt === undefined ? {} : {
          availableKeys: sharedKeys(promptDocument.identity?.prompt),
          baselineAdjustments: baselinePrompt?.variants?.[variantId]?.identity_overrides,
        }),
      }));
    }
  }
  return errors;
}

function sharedKeys(prompt) {
  return promptCategories.flatMap(category => Array.isArray(prompt?.[category]) ? prompt[category].filter(isRecord).map(adjustmentKey) : []);
}

export function prepareCharacterPromptForPersistence(promptDocument, { baselinePrompt, createFragmentId } = {}) {
  const prepared = structuredClone(promptDocument);
  if (isRecord(prepared.identity)) {
    prepared.identity.prompt = prepareSharedPromptForPersistence(prepared.identity.prompt, {
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
    setting.prompt = prepareSharedPromptForPersistence(setting.prompt, {
      baselinePrompt: baselineSetting?.prompt,
      createFragmentId,
    });
  }
  // 读/编译允许保留失效覆盖；写入仅允许沿持久基线原样保留，不能新增或修改失效定位。
  const errors = validateCharacterPromptDocument({ $schema: CHARACTER_PROMPT_SCHEMA_ID, ...prepared }, { baselinePrompt: baselinePrompt ?? {} });
  if (errors.length) throw Object.assign(new TypeError(errors.join('；')), {
    status: 400, code: 'invalid_prompt_fragment', details: errors,
  });
  return prepared;
}

