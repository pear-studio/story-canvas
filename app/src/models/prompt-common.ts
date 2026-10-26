import type {Lora, LoraOverrides} from '../../shared/lora-inheritance.mjs';

/** 已有公共 LoRA 契约；模型专属 Prompt 字段由各模型声明。 */
export type PageLoraFields = {loras?:Lora[]; lora_overrides?:LoraOverrides};
