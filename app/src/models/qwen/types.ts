import type {ReferenceEntry} from '../../ReferenceLibrary';
import type {PageLoraFields} from '../prompt-common';

export type PageReferenceEntry = ReferenceEntry & {purpose?:string};
export type PagePrompt = PageLoraFields & {
  text:string;
  composition?:'settings'|'standalone';
  scene_id?:string;
  scene_variant_id?:string;
  text_overrides?:Record<string,string>;
  reference_overrides?:Record<string,string[]>;
  reference_images?:PageReferenceEntry[];
};
export type PagePromptDraft = Partial<PagePrompt>;
export type CharacterPromptVariant = {text:string; reference_images?:ReferenceEntry[]};
export type CharacterPromptDocument = {
  prompt_name:string;
  /** 键与 visual.variants 一一对应，每个子设定保存完整文字。 */
  variants:Record<string,CharacterPromptVariant>;
};
