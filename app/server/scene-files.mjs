import {
  CHARACTER_PROFILE_SCHEMA_ID, CHARACTER_VISUAL_SCHEMA_ID, CHARACTER_PROMPT_SCHEMA_ID,
  validateCharacterProfileDocument, validateCharacterVisualDocument, validateCharacterPromptDocument,
} from './character-files.mjs';
import { modelPrompt } from './model-prompts.mjs';

export const SCENE_INDEX_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-index.schema.json';
export const SCENE_PROFILE_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-profile.schema.json';
export const SCENE_VISUAL_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-visual.schema.json';
export const SCENE_PROMPT_SCHEMA_ID = 'https://storyvisualizer.local/schemas/scene-prompt.schema.json';
export const sceneIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// 场景复用角色设定契约，不维护第二套 Prompt 校验器。
function validateSetting(document, schema, sharedSchema, validate) {
  const errors = document?.$schema === schema ? [] : ['scene.$schema 不匹配'];
  return [...errors, ...validate({ ...document, $schema: sharedSchema }).map(error => error.replaceAll('character', 'scene'))];
}
export const validateSceneProfileDocument = document => validateSetting(document, SCENE_PROFILE_SCHEMA_ID, CHARACTER_PROFILE_SCHEMA_ID, validateCharacterProfileDocument);
export const validateSceneVisualDocument = document => validateSetting(document, SCENE_VISUAL_SCHEMA_ID, CHARACTER_VISUAL_SCHEMA_ID, validateCharacterVisualDocument);
export function validateSceneIndexDocument(document) {
  if (!document || document.$schema !== SCENE_INDEX_SCHEMA_ID || !Array.isArray(document.scenes)
    || Object.keys(document).some(key => !['$schema', 'scenes'].includes(key))) return ['场景索引格式无效'];
  return document.scenes.every(id => typeof id === 'string' && sceneIdPattern.test(id)) && new Set(document.scenes).size === document.scenes.length ? [] : ['场景 ID 无效或重复'];
}
export function validateScenePromptDocument(document) {
  return validateSetting(document, SCENE_PROMPT_SCHEMA_ID, CHARACTER_PROMPT_SCHEMA_ID, validateCharacterPromptDocument);
}
export function defaultSceneFacts(id, name) {
  const displayName = name?.trim() || id;
  return {
    profile: { $schema: SCENE_PROFILE_SCHEMA_ID, name: displayName, description: '待补充场景设定。' },
    visual: { $schema: SCENE_VISUAL_SCHEMA_ID, variants: [{ id: 'default', name: '默认' }] },
    prompt: { $schema: SCENE_PROMPT_SCHEMA_ID, prompt_name: displayName, variants: { default: { text: '', reference_images: [] } } },
  };
}

export function resolveSceneConfiguration(scene, variantId, modelId = 'qwen') {
  const prompt = modelPrompt(scene?.prompt, modelId);
  const variant = prompt?.variants?.[variantId];
  if (!variant || !scene.visual?.variants?.some(item => item.id === variantId)) throw new TypeError(`场景子设定不存在：${scene?.id} · ${variantId}`);
  return { ...(modelId === 'anima' ? { ...structuredClone(variant), identity: structuredClone(prompt.identity), loras: [] } : {}), id: scene.id, name: scene.name, prompt_name: prompt.prompt_name, configuration_id: variantId,
    configuration_path: `variants.${variantId}`, text: variant.text ?? '', reference_images: structuredClone(variant.reference_images ?? []) };
}
