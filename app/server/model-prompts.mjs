import { modelAdapter } from './model-adapters.mjs';
import {validateModelPromptInput} from './model-prompt-validation.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function promptModelEntries(document) {
  return Object.entries(document.models);
}
export function mapModelPrompts(document, transform) {
  return {...structuredClone(document),models:Object.fromEntries(promptModelEntries(document).map(([id,value])=>[id,transform(structuredClone(value),id)]))};
}
export function emptySettingVariant(modelId) {
  return modelAdapter(modelId).emptySettingVariant();
}
export function emptySettingPrompt(modelId, name, variantIds) {
  return modelAdapter(modelId).emptySettingPrompt(name,variantIds);
}
export function renamePromptSource(document, oldSource, newSource) {
  return mapModelPrompts(document,(input,id)=>{
    for(const field of modelAdapter(id).sourceOverrideFields)if(Object.hasOwn(input[field]??{},oldSource)){input[field][newSource]=input[field][oldSource];delete input[field][oldSource];}
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
    errors.push(...validateModelPromptInput(value,kind,adapter,{
      ...(baselinePrompt === undefined ? {} : { baselinePrompt: modelPrompt(baselinePrompt, id) ?? {} }),
    }));
  }
  return errors;
}
