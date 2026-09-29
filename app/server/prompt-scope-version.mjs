import { hashCanonicalJson } from './workflow-definition.mjs';
import { ApiError } from './http-support.mjs';
import { emptySettingPrompt, emptySettingVariant, modelPrompt, promptModelEntries } from './model-prompts.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PROMPT_EDIT_PROTOCOL = 1;

export function normalizePromptTarget(value, activeModel) {
  if (!record(value) || Object.keys(value).some(key => !['kind','id','model_id','scope','variant_id'].includes(key))) throw new ApiError(400,'invalid_prompt_target');
  const { kind,id,scope,variant_id } = value;
  if (!['page','character','scene'].includes(kind) || typeof id !== 'string' || !id.trim()) throw new ApiError(400,'invalid_prompt_target');
  const model_id = value.model_id ?? (kind === 'page' ? activeModel : undefined);
  if (!['anima','qwen'].includes(model_id)) throw new ApiError(400,'invalid_prompt_model',['设定必须明确 model_id；页面可省略以使用当前模型']);
  if (kind === 'page') {
    if (scope !== undefined || variant_id !== undefined) throw new ApiError(400,'invalid_prompt_target',['页面不接受 scope 或 variant_id']);
    return {kind,id,model_id};
  }
  if (!['base','variant'].includes(scope) || (scope === 'variant' ? typeof variant_id !== 'string' || !variant_id.trim() : variant_id !== undefined)) throw new ApiError(400,'invalid_prompt_target',['设定使用 scope:base 或 scope:variant + variant_id']);
  return {kind,id,model_id,scope,...(scope === 'variant' ? {variant_id} : {})};
}

function settingModel(document, target, visual) {
  return promptModelEntries(document).some(([id]) => id === target.model_id) ? structuredClone(modelPrompt(document,target.model_id))
    : emptySettingPrompt(target.model_id,target.id,(visual?.variants ?? []).map(v => v.id));
}

export function settingPromptScopeDocument({target,document,visual}) {
  const input = settingModel(document,target,visual);
  if (target.scope === 'base') return structuredClone(target.model_id === 'anima' ? {identity:input.identity} : {prompt_name:input.prompt_name});
  if (!(visual?.variants ?? []).some(variant => variant.id === target.variant_id)) throw new ApiError(404,'prompt_variant_not_found',[target.variant_id]);
  return structuredClone(input.variants?.[target.variant_id] ?? emptySettingVariant(target.model_id));
}

export function promptScopeVersion({projectId,target,document,dependencies}) {
  return hashCanonicalJson({protocol:PROMPT_EDIT_PROTOCOL,project_id:projectId,target,document,dependencies});
}

// 同一文件内其他模型／子设定的变化不使本 scope 失效；Anima 子设定明确依赖基础。
export function settingPromptScopeVersion({projectId,target:rawTarget,document,visual}) {
  const target = normalizePromptTarget(rawTarget);
  const input = settingModel(document,target,visual);
  return promptScopeVersion({projectId,target,document:settingPromptScopeDocument({target,document,visual}),dependencies:{
    ...(target.scope === 'variant' ? {variant_id:target.variant_id,...(target.model_id === 'anima' ? {identity:input.identity} : {})} : {}),
  }});
}

export function settingPromptScopeVersions({projectId,kind,id,document,visual}) {
  return Object.fromEntries(['anima','qwen'].map(model_id => [model_id,{
    base:settingPromptScopeVersion({projectId,target:{kind,id,model_id,scope:'base'},document,visual}),
    variants:Object.fromEntries((visual?.variants ?? []).map(({id:variant_id}) => [variant_id,settingPromptScopeVersion({projectId,target:{kind,id,model_id,scope:'variant',variant_id},document,visual})])),
  }]));
}

export function replaceSettingPromptScope({target,document,visual,value}) {
  if (!record(value)) throw new ApiError(400,'invalid_prompt_changes');
  const input = settingModel(document,target,visual);
  delete input.$schema;
  if (target.scope === 'base') {
    const field = target.model_id === 'anima' ? 'identity' : 'prompt_name';
    if (Object.keys(value).some(key => key !== field) || !Object.hasOwn(value,field)) throw new ApiError(400,'invalid_prompt_scope_fields',[field]);
    input[field] = structuredClone(value[field]);
    // identity.lora 是必需的 nullable 字段；删除表示无 LoRA，仍以 null 持久化。
    if (field === 'identity' && record(input.identity) && !Object.hasOwn(input.identity,'lora')) input.identity.lora = null;
  } else input.variants[target.variant_id] = structuredClone(value);
  return input;
}
