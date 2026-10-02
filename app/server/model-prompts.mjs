import {validateLoraOverrides} from '../shared/lora-inheritance.mjs';
import { modelAdapter } from './model-adapters.mjs';
import { validateLoraDefinition } from './lora-config.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function promptModelEntries(document) {
  return Object.entries(document.models);
}
export function mapModelPrompts(document, transform) {
  return {...structuredClone(document),models:Object.fromEntries(promptModelEntries(document).map(([id,value])=>[id,transform(structuredClone(value),id)]))};
}
export function emptySettingVariant(modelId) {
  modelAdapter(modelId);
  return modelId==='anima'?{prompt:modelAdapter('anima').emptyPrompt(),loras:[]}:{text:'',reference_images:[]};
}
export function emptySettingPrompt(modelId, name, variantIds) {
  return {
    ...(modelId === 'anima' ? {identity:{prompt:modelAdapter(modelId).emptyPrompt(),lora:null}} : {prompt_name:name}),
    variants:Object.fromEntries(variantIds.map(id => [id,emptySettingVariant(modelId)])),
  };
}
export function renamePromptSource(document, oldSource, newSource) {
  return mapModelPrompts(document,input=>{
    for(const field of ['inheritance','text_overrides','reference_overrides'])if(Object.hasOwn(input[field]??{},oldSource)){input[field][newSource]=input[field][oldSource];delete input[field][oldSource];}
    return input;
  });
}
export function modelPrompt(document, id) {
  const value = document.models[id];
  return value ? { $schema: document.$schema, ...structuredClone(value) } : null;
}
export function replaceModelPrompt(document, id, prompt) {
  const { $schema: _schema, ...value } = structuredClone(prompt);
  return { ...structuredClone(document), models: { ...structuredClone(document.models), [id]: value } };
}
export function makeModelPromptDocument(schema, id, prompt) {
  const { $schema: _schema, ...value } = structuredClone(prompt);
  return { $schema: schema, models: { [id]: value } };
}
export function validateModelPromptDocument(document, kind, { baselinePrompt } = {}) {
  const schema=kind==='page'?'https://storyvisualizer.local/schemas/story-page-prompt.schema.json':'https://storyvisualizer.local/schemas/character-prompt.schema.json';
  if (document?.$schema !== schema) return ['模型 Prompt 文档 $schema 不匹配'];
  if (!isRecord(document.models) || !Object.keys(document.models).length) return ['models 必须包含至少一个模型输入'];
  if (Object.keys(document).some(key => !['$schema','models'].includes(key))) return ['模型 Prompt 文档包含未知字段'];
  const errors=[];
  for (const [id, value] of Object.entries(document.models)) {
    let adapter;
    try { adapter=modelAdapter(id); } catch(error) { errors.push(error.message); continue; }
    if (!isRecord(value)) { errors.push(`models.${id} 必须是对象`); continue; }
    const { loras, lora_overrides, trigger_sources, ...prompt }=value;
    if (kind !== 'page' && ['loras','lora_overrides','trigger_sources'].some(key => Object.hasOwn(value,key))) {
      errors.push(`models.${id}: 设定顶层不接受页面 LoRA 字段；Anima 使用 identity.lora 和 variants 内的 loras/lora_overrides`);
    }
    errors.push(...validateLoraOverrides(lora_overrides, `models.${id}.lora_overrides`));
    errors.push(...adapter[kind==='page'?'validatePagePrompt':'validateSettingPrompt']({$schema:schema,...prompt}, {
      ...(baselinePrompt === undefined ? {} : { baselinePrompt: modelPrompt(baselinePrompt, id) ?? {} }),
    }).map(message=>`models.${id}: ${message}`));
    if (loras!==undefined) {
      if (!Array.isArray(loras)) errors.push(`models.${id}.loras 必须是数组`);
      else for(const [index,lora] of loras.entries()) {
        const {enabled,...definition}=lora??{};
        if(enabled!==undefined&&typeof enabled!=='boolean')errors.push('LoRA enabled 必须为布尔值');
        errors.push(...validateLoraDefinition(definition,`models.${id}.loras[${index}]`));
      }
    }
    if (trigger_sources !== undefined) {
      const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
      if (kind !== 'page' || id !== 'anima' || !isRecord(trigger_sources)
        || Object.keys(trigger_sources).some(key => !['style','characters','scenes'].includes(key))
        || !stringList(trigger_sources.style)
        || ['characters','scenes'].some(key => !isRecord(trigger_sources[key]) || Object.values(trigger_sources[key]).some(value => !stringList(value)))) {
        errors.push(`models.${id}.trigger_sources 必须包含 style 词条数组及 characters/scenes 来源词条表`);
      }
    }
  }
  return errors;
}
