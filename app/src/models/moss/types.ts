import type {MossCategory,MossEntry} from '../../../shared/moss-prompt.mjs';
import type {Lora,LoraOverrides} from '../../../shared/lora-inheritance.mjs';
import type {PageLoraFields} from '../prompt-common';

export type MossLayoutItem = {id:string;bbox:[number,number,number,number]} & (
  {character_id:string;label?:never;entries?:never;text?:never} |
  {character_id?:never;label:'object';entries:MossEntry[];text?:never} |
  {character_id?:never;label:'text';entries:MossEntry[];text:string}
);
export type MossLayout = {enabled:boolean;items:MossLayoutItem[]};
export type PagePromptDraft = PageLoraFields & Partial<Record<MossCategory,MossEntry[]>> & {
  scene_id?:string;scene_variant_id?:string;
  entry_overrides?:Record<string,MossEntry[]>;
  project_overrides?:{style?:MossEntry[];lighting?:MossEntry[]};
  layout?:MossLayout;
};
export type CharacterPromptVariant = {entries:MossEntry[];loras?:Lora[];lora_overrides?:LoraOverrides};
export type CharacterPromptDocument = {prompt_name:string;identity:{lora:Lora|null};variants:Record<string,CharacterPromptVariant>};
export type MossProjectPrompt = Record<import('../../../shared/moss-prompt.mjs').MossProjectField,MossEntry[]>;
