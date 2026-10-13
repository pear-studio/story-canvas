import { randomBytes } from 'node:crypto';
import { modelAdapter } from './model-adapters.mjs';
import { mapModelPrompts, promptModelEntries } from './model-prompts.mjs';
import { validateCharacterProfileDocument, validateCharacterVisualDocument, validateCharacterPromptDocument } from './character-files.mjs';
import { validateSceneProfileDocument, validateSceneVisualDocument, validateScenePromptDocument } from './scene-files.mjs';
import { ApiError } from './http-support.mjs';

// 整页设定保存与局部事实写入共用原生 Prompt 归一化和契约校验。
export function prepareSettingFact(kind, section, baseline, edited, visual) {
  const validators = kind === 'character'
    ? {profile:validateCharacterProfileDocument, visual:validateCharacterVisualDocument, prompt:validateCharacterPromptDocument}
    : {profile:validateSceneProfileDocument, visual:validateSceneVisualDocument, prompt:validateScenePromptDocument};
  let value = structuredClone(edited);
  if (section === 'visual' && kind === 'character') {
    delete value.description; delete value.base_description;
    for (const variant of value.variants ?? []) delete variant.description;
  }
  if (section === 'prompt') {
    const previous = new Map(promptModelEntries(baseline));
    value = mapModelPrompts(value, (input, modelId) => modelAdapter(modelId).prepareSettingPrompt(input, {
      baselinePrompt:previous.get(modelId), createFragmentId:()=>`token-${randomBytes(6).toString('hex')}`,
    }));
    const ids = new Set(visual.variants.map(v => v.id));
    if (promptModelEntries(value).some(([,input]) => Object.keys(input.variants).some(id => !ids.has(id))
      || (kind === 'scene' && Object.keys(input.variants).length !== ids.size))) throw new ApiError(422, `${kind}_prompt_visual_mismatch`);
  }
  const errors = validators[section](value, {baselinePrompt:baseline});
  if (errors.length) throw new ApiError(422, kind === 'character' ? 'invalid_character_edit_document' : 'invalid_scene_document', errors);
  return value;
}
