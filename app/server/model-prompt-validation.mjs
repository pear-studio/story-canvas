import {validateLoraOverrides} from '../shared/lora-inheritance.mjs';
import {validateLoraDefinition} from './lora-config.mjs';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// 容器与预览共用单模型校验；显式接收适配器，避免通过注册表形成模块循环。
export function validateModelPromptInput(value,kind,adapter,{baselinePrompt}={}){
  const id=adapter.id;
  if(!record(value))return [`models.${id} 必须是对象`];
  const errors=[];
  const schema=kind==='page'?'https://storyvisualizer.local/schemas/story-page-prompt.schema.json':'https://storyvisualizer.local/schemas/character-prompt.schema.json';
  const {loras,lora_overrides,trigger_sources,...prompt}=value;
  if(kind!=='page'&&['loras','lora_overrides','trigger_sources'].some(key=>Object.hasOwn(value,key)))
    errors.push(`models.${id}: 设定顶层不接受页面 LoRA 字段；Anima 使用 identity.lora 和 variants 内的 loras/lora_overrides`);
  errors.push(...validateLoraOverrides(lora_overrides,`models.${id}.lora_overrides`));
  errors.push(...adapter[kind==='page'?'validatePagePrompt':'validateSettingPrompt']({$schema:schema,...prompt},
    baselinePrompt===undefined?{}:{baselinePrompt}).map(message=>`models.${id}: ${message}`));
  if(loras!==undefined){
    if(!Array.isArray(loras))errors.push(`models.${id}.loras 必须是数组`);
    else for(const [index,lora] of loras.entries()){
      const {enabled,...definition}=lora??{};
      if(enabled!==undefined&&typeof enabled!=='boolean')errors.push('LoRA enabled 必须为布尔值');
      errors.push(...validateLoraDefinition(definition,`models.${id}.loras[${index}]`));
    }
  }
  if(trigger_sources!==undefined&&!adapter.validTriggerSources?.(trigger_sources,kind))
    errors.push(`models.${id}.trigger_sources 必须包含 style 词条数组及 characters/scenes 来源词条表`);
  return errors;
}
