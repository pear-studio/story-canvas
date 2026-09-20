import {
  CHARACTER_PROFILE_SCHEMA_ID, CHARACTER_VISUAL_SCHEMA_ID, CHARACTER_PROMPT_SCHEMA_ID, CHARACTER_LORA_SCHEMA_ID,
  validateCharacterProfileDocument, validateCharacterVisualDocument, validateCharacterPromptDocument, validateCharacterLoraDocument,
  prepareCharacterPromptForPersistence,
} from './character-files.mjs';
import { emptyCategories } from '../shared/prompt-inheritance.mjs';

export const SCENE_INDEX_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-index.schema.json';
export const SCENE_PROFILE_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-profile.schema.json';
export const SCENE_VISUAL_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-visual.schema.json';
export const SCENE_PROMPT_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-prompt.schema.json';
export const SCENE_LORA_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-lora.schema.json';
export const sceneIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// 场景复用角色设定契约，额外限制环境词分类；不维护第二套 Prompt/LoRA 校验器。
function validateSetting(document, schema, sharedSchema, validate) {
  const errors = document?.$schema === schema ? [] : ['scene.$schema 不匹配'];
  return [...errors, ...validate({ ...document, $schema: sharedSchema }).map(error => error.replaceAll('character', 'scene'))];
}
export const validateSceneLoraDocument = document => validateSetting(document, SCENE_LORA_SCHEMA_ID, CHARACTER_LORA_SCHEMA_ID, validateCharacterLoraDocument);
export const validateSceneProfileDocument = document => validateSetting(document, SCENE_PROFILE_SCHEMA_ID, CHARACTER_PROFILE_SCHEMA_ID, validateCharacterProfileDocument);
export const validateSceneVisualDocument = document => validateSetting(document, SCENE_VISUAL_SCHEMA_ID, CHARACTER_VISUAL_SCHEMA_ID, validateCharacterVisualDocument);
export function validateSceneIndexDocument(document) {
  if (!document || document.$schema !== SCENE_INDEX_SCHEMA_ID || !Array.isArray(document.scenes)
    || Object.keys(document).some(key => !['$schema', 'scenes'].includes(key))) return ['场景索引格式无效'];
  return document.scenes.every(id => typeof id === 'string' && sceneIdPattern.test(id)) && new Set(document.scenes).size === document.scenes.length ? [] : ['场景 ID 无效或重复'];
}
export function validateScenePromptDocument(document) {
  const errors = validateSetting(document, SCENE_PROMPT_SCHEMA_ID, CHARACTER_PROMPT_SCHEMA_ID, validateCharacterPromptDocument);
  for (const config of [document?.identity, ...Object.values(document?.variants ?? {})]) {
    for (const category of ['subject', 'person', 'camera']) if (config?.prompt?.[category]?.length) errors.push('场景设定仅使用场景和避免分类');
  }
  return errors;
}
export function prepareScenePromptForPersistence(document, options = {}) {
  const prepared = prepareCharacterPromptForPersistence({ ...document, $schema: CHARACTER_PROMPT_SCHEMA_ID }, options);
  prepared.$schema = SCENE_PROMPT_SCHEMA_ID;
  return prepared;
}
export function defaultSceneFacts(id, name) {
  return {
    profile: { $schema: SCENE_PROFILE_SCHEMA_ID, name: name?.trim() || id, description: '待补充场景设定。' },
    visual: { $schema: SCENE_VISUAL_SCHEMA_ID, variants: [{ id: 'default', name: '默认' }] },
    prompt: { $schema: SCENE_PROMPT_SCHEMA_ID, identity: { prompt: emptyCategories(), lora: null }, variants: { default: { prompt: emptyCategories(), loras: [], identity_disabled: [] } } },
  };
}

export function resolveSceneConfiguration(scene, variantId) {
  const variant = scene?.prompt?.variants?.[variantId];
  if (!variant || !scene.visual?.variants?.some(item => item.id === variantId)) throw new TypeError(`场景子设定不存在：${scene?.id} · ${variantId}`);
  return { id: scene.id, name: scene.name, configuration_id: variantId, identity: scene.prompt.identity,
    ...variant, loras: [...(scene.prompt.identity.lora ? [scene.prompt.identity.lora] : []), ...variant.loras] };
}
