import type {PagePromptDraft as AnimaPagePrompt,CharacterPromptDocument as AnimaSettingPrompt} from './anima/types';
import type {PagePromptDraft as QwenPagePrompt,CharacterPromptDocument as QwenSettingPrompt} from './qwen/types';
import type {PagePromptDraft as H3PagePrompt} from './h3/types';
import type {PagePromptDraft as MossPagePrompt,CharacterPromptDocument as MossSettingPrompt} from './moss/types';

/** 公共工作台持有原生草稿，不把不同模型字段合并成一种 Prompt。 */
export type PagePrompts = {anima:AnimaPagePrompt; qwen:QwenPagePrompt; h3:H3PagePrompt; moss:MossPagePrompt};
export type SettingPrompts = {anima:AnimaSettingPrompt; qwen:QwenSettingPrompt; moss:MossSettingPrompt};
export type GenerationModelId = keyof PagePrompts;
export type PromptModelId = keyof SettingPrompts;
export type PagePrompt = PagePrompts[GenerationModelId];
export type SettingPrompt = SettingPrompts[PromptModelId];
