// Anima 词条编辑契约；恢复自 64db906，公共工作台不解释词条结构。
import type { ReferenceEntry } from '../../ReferenceLibrary';
export const promptCategories = ["population","person","setting","camera","avoid"] as const;

export type PromptCategory = typeof promptCategories[number];
export type PromptFragment = {
  id?: string;
  /** 仅继承解析结果携带，不写入本地 Prompt。 */
  inheritance_key?: string;
  inheritance_source?: string;
  tag?: string;
  description?: string;
  character_id?: string;
  weight?: number;
  enabled?: boolean;
};
export type InheritedAdjustments = Record<string, { weight?: number; enabled?: boolean }>;
export type SettingKind = 'character' | 'scene';
export type PageOwner = { page_id: string; owner_kind: 'story' | 'character' | 'scene'; sequence_id?: string; character_id?: string; scene_id?: string; variant_id?: string };
export type PagePrompt = Record<PromptCategory, PromptFragment[]> & { camera_settings?: import("../../../shared/camera-prompt.mjs").CameraSettings; reference_images?: ReferenceEntry[]; reference_overrides?: Record<string, string[]>; scene_id?: string; scene_variant_id?: string; inheritance?: Record<string, InheritedAdjustments> };
export type CharacterLora = { filename: string; sha256: string; weight: number; trigger?: string };
export type CharacterPromptSetting = {
  reference_images?: ReferenceEntry[];
  prompt: PagePrompt;
  loras: CharacterLora[];
  lora_overrides?: import("../../../shared/lora-inheritance.mjs").LoraOverrides;
  identity_overrides?: InheritedAdjustments;
};
export type CharacterPromptIdentity = {
  prompt: PagePrompt;
  lora: CharacterLora | null;
};
export type CharacterPromptDocument = {
  identity: CharacterPromptIdentity;
  /** 键为子设定 ID，与 visual.variants 一一对应；无保留 id。 */
  variants: Record<string, CharacterPromptSetting>;
};
export type CharacterPromptIdentityImpact = {
  per_variant: Record<string, { lost_inheritance: string[]; new_inheritance: string[] }>;
};
