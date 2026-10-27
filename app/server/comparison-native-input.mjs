import {ApiError} from './http-support.mjs';
import {emptyMossPrompt,validateMossEntries} from '../shared/moss-prompt.mjs';
import {validatePagePrompt,validateProfilePrompt} from './models/moss/prompt-contract.mjs';
import {compilePrompt as compileMossPrompt} from './models/moss/prompt-compiler.mjs';
import {resolvePageLoras} from './lora-config.mjs';
import {resolveRenderRecipe} from './render-task-contract.mjs';

const clone=structuredClone;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stableId=value=>typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const unique=values=>[...new Set(values)];
function fail(message,code='invalid_comparison_input'){throw new ApiError(422,code,[message]);}
function fields(value,allowed,label){if(!record(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(`${label} 含有未知字段或不是对象`);}
function words(value,label){if(!Array.isArray(value)||value.some(word=>typeof word!=='string'||!word.trim()))fail(`${label} 必须是明确的触发词数组；空数组表示没有触发词`);return unique(value.map(word=>word.trim()));}

export function comparisonInputRoute(input){
  const source=input.render?.route?.input_source??(input.reference_images?.length?'reference_image':'empty_latent');
  const route=input.render?.profile?.operations?.candidates?.routes?.[source];
  if(!route?.recipe||!input.render?.workflows?.[route.workflow])fail('测试输入缺少冻结的候选路线');
  if(input.render.route){
    const frozen=input.render.route;
    if(frozen.operation!=='candidates'||frozen.workflow_id!==route.workflow||frozen.recipe_source_id!==route.recipe_source_id||source!==(input.reference_images?.length?'reference_image':'empty_latent'))fail('冻结路线与输入或生成配置不一致');
  }
  return route;
}

export function emptyMossComparisonNative(){return {version:1,model_id:'moss',prompt:emptyMossPrompt(),characters:[],scenes:[],participant_ids:[],trigger_sources:[]};}

// 描述与触发词归属分别冻结；实验改变挂载时不再从唯一 owner 猜测共享 LoRA 的所有人物。
export function captureMossComparisonNative(target){
  const {loras:_local,lora_overrides:_overrides,trigger_sources:_triggers,$schema:_schema,...prompt}=clone(target.page_prompt);
  const setting=value=>({id:value.id,configuration_id:value.configuration_id,prompt_name:value.prompt_name,entries:clone(value.entries)});
  const resolved=resolvePageLoras(target.page_prompt,target.page_id,target.compiled_profile.effective_profile,target.characters,target.scenes);
  const trigger_sources=[];
  for(const lora of resolved.loras){
    const trigger=lora.trigger?.trim();let attributed=false;
    for(const [kind,settings,map] of [['character',target.characters,resolved.triggers.characters],['scene',target.scenes,resolved.triggers.scenes]]){
      for(const value of settings){
        if(!(value.loras??[]).some(source=>source.filename===lora.filename))continue;
        if(trigger&&!(map.get(value.id)??[]).includes(trigger))continue;
        trigger_sources.push({lora_sha256:lora.sha256,kind,owner:value.id,words:trigger?[trigger]:[]});attributed=true;
      }
    }
    if(trigger&&resolved.triggers.style.includes(trigger)||!attributed)trigger_sources.push({lora_sha256:lora.sha256,kind:lora.kind==='style'?'style':'page',owner:lora.owner??target.page_id,words:trigger&&resolved.triggers.style.includes(trigger)?[trigger]:[]});
  }
  return {version:1,model_id:'moss',prompt,characters:target.characters.map(setting),scenes:target.scenes.map(setting),participant_ids:[...target.participant_ids],trigger_sources};
}

export function assertMossComparisonNative(value,{loras=[]}={}){
  fields(value,['version','model_id','prompt','characters','scenes','participant_ids','trigger_sources'],'MOSS 原生输入');
  if(value.version!==1||value.model_id!=='moss')fail('MOSS 原生输入版本无效');
  const errors=validatePagePrompt({$schema:'https://storyvisualizer.local/schemas/story-page-prompt.schema.json',...value.prompt});
  if(errors.length)fail(errors.join('；'));
  const ids={};
  for(const key of ['characters','scenes']){
    if(!Array.isArray(value[key]))fail(`${key} 必须是数组`);ids[key]=new Set();
    for(const setting of value[key]){
      fields(setting,['id','configuration_id','prompt_name','entries'],key);
      if(!stableId(setting.id)||ids[key].has(setting.id)||!stableId(setting.configuration_id)||setting.configuration_id==='main'||typeof setting.prompt_name!=='string'||!setting.prompt_name.trim())fail(`${key} 的稳定 ID、子设定或生成名称无效`);
      ids[key].add(setting.id);const problems=validateMossEntries(setting.entries,`${key}.${setting.id}.entries`);if(problems.length)fail(problems.join('；'));
    }
  }
  if(!Array.isArray(value.participant_ids)||new Set(value.participant_ids).size!==value.participant_ids.length||value.participant_ids.some(id=>!ids.characters.has(id))||value.participant_ids.length!==value.characters.length)fail('participant_ids 必须按顺序恰好包含所有实验人物');
  if(value.scenes.length>1||value.scenes.some(scene=>scene.id!==value.prompt.scene_id||scene.configuration_id!==value.prompt.scene_variant_id)||Boolean(value.prompt.scene_id)!==Boolean(value.scenes.length))fail('实验场景必须与原生 Prompt 的场景引用一致');
  if(!Array.isArray(value.trigger_sources))fail('MOSS trigger_sources 必须是数组');
  const loraShas=new Set(loras.map(lora=>lora.sha256));const sources=new Set();
  for(const source of value.trigger_sources){
    fields(source,['lora_sha256','kind','owner','words'],'触发词归属');
    if(!sha(source.lora_sha256)||!loraShas.has(source.lora_sha256)||!['style','character','scene','page'].includes(source.kind)||typeof source.owner!=='string'||!source.owner.trim())fail('触发词归属缺少有效 LoRA 身份或来源');
    if(source.kind==='character'&&!ids.characters.has(source.owner)||source.kind==='scene'&&!ids.scenes.has(source.owner))fail('触发词指向不存在的实验人物或场景');
    const key=`${source.lora_sha256}:${source.kind}:${source.owner}`;if(sources.has(key))fail('触发词归属重复');sources.add(key);words(source.words,'触发词');
  }
  return clone(value);
}

function replacement(input,policy,change){
  if(!['preserve','replace'].includes(policy))fail('触发词策略无效');
  if(policy==='preserve'||change===undefined)return null;
  fields(change,['target_sha256','words'],'触发词替换');
  const next=words(change.words,'替换触发词');
  if(change.target_sha256!==undefined){
    if(!sha(change.target_sha256))fail('替换 LoRA SHA 无效');
    if(input.loras.filter(lora=>lora.sha256===change.target_sha256).length!==1)fail('替换触发词需要唯一匹配原输入 LoRA','comparison_trigger_target_ambiguous');
  }
  return {...change,words:next};
}

function nativeTriggers(native,change){
  let sources=clone(native.trigger_sources);
  if(change?.target_sha256){
    const targets=sources.filter(source=>source.lora_sha256===change.target_sha256);
    if(!targets.length)fail('原生输入缺少目标 LoRA 的触发词归属，请重新导入','comparison_trigger_target_ambiguous');
    sources=sources.map(source=>source.lora_sha256===change.target_sha256?{...source,words:change.words}:source);
  }else if(change)sources.push({kind:'page',owner:'comparison',words:change.words});
  const triggers={style:[],characters:new Map(native.characters.map(value=>[value.id,[]])),scenes:new Map(native.scenes.map(value=>[value.id,[]]))};
  for(const source of sources){
    const bucket=source.kind==='character'?triggers.characters.get(source.owner):source.kind==='scene'?triggers.scenes.get(source.owner):triggers.style;
    for(const word of source.words)if(!bucket.includes(word))bucket.push(word);
  }
  return triggers;
}

function textPrompt(input,change){
  let positive=input.prompt.positive;
  if(change?.target_sha256){
    const target=input.loras.find(lora=>lora.sha256===change.target_sha256);
    const original=words(target.trigger_words,'原输入 LoRA trigger_words');
    const others=input.loras.filter(lora=>lora.sha256!==target.sha256).flatMap(lora=>lora.trigger_words??[]);
    const edits=[];
    for(const word of original){
      if(others.some(other=>other.trim().toLowerCase()===word.toLowerCase()))fail('多个 LoRA 使用同名触发词，普通文本无法确定归属；请保持原 Prompt','comparison_trigger_target_ambiguous');
      const pattern=new RegExp(`(^|[,\\n][ \\t]*)(${word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})(?=[ \\t]*(?:[,\\n]|$))`,'gim');
      const matches=[...positive.matchAll(pattern)];
      if(matches.length!==1)fail(`无法唯一定位触发词“${word}”；请保持原 Prompt 或显式编辑输入`,'comparison_trigger_target_ambiguous');
      const match=matches[0];edits.push({start:match.index+match[1].length,end:match.index+match[0].length});
    }
    for(const edit of edits.sort((a,b)=>b.start-a.start))positive=positive.slice(0,edit.start)+positive.slice(edit.end);
  }
  if(change?.words.length)positive=[positive,...change.words].filter(Boolean).join('\n');
  return positive;
}

// recipe 参数由执行侧完成扫描覆盖；尺寸确定之后才编译归一化 Layout。
export function compileComparisonInput(input,{loras=input.loras,recipe,trigger_policy='preserve',trigger_change,allow_empty=false}={}){
  if(input.version!==1)fail('旧输入不能按新版编译语义执行，请重新导入','comparison_input_reimport_required');
  const resolvedRecipe=resolveRenderRecipe(recipe??comparisonInputRoute(input).recipe,input.render.canvas);
  const dimensions={width:resolvedRecipe.dimensions.width,height:resolvedRecipe.dimensions.height};
  const change=replacement(input,trigger_policy,trigger_change);
  if(input.render.profile.architecture_family==='moss-image'){
    const native=assertMossComparisonNative(input.native_input,{loras:input.loras});
    validateProfilePrompt(input.render.profile.prompt);
    const compiled=compileMossPrompt({pageId:'page-001',pageKey:{page_id:'page-001'},pagePrompt:native.prompt,profile:input.render.profile,characters:native.characters,scenes:native.scenes,participantIds:native.participant_ids,dimensions,loraResolution:{loras:clone(loras),errors:[],triggers:nativeTriggers(native,change)}});
    if(compiled.errors.length||!allow_empty&&compiled.missing.length)fail([...compiled.missing,...compiled.errors].join('；'));
    return {positive:compiled.positive_prompt,negative:compiled.negative_prompt,parts:{sections:compiled.sections},recipe:resolvedRecipe,dimensions};
  }
  if(input.native_input!==undefined)fail('原生 MOSS 输入不能用于其他模型家族');
  if(typeof input.prompt?.positive!=='string'||typeof input.prompt?.negative!=='string')fail('普通文本输入缺少正向与负向文本');
  const positive=textPrompt(input,change);if(!allow_empty&&!positive.trim())fail('测试输入正向文本为空');
  return {positive,negative:input.prompt.negative,parts:{positive:[{text:positive}],negative:[{text:input.prompt.negative}]},recipe:resolvedRecipe,dimensions};
}
