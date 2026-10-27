import {mossCategories,validateMossEntries} from '../../../shared/moss-prompt.mjs';
import {validateLoraDefinition} from '../../lora-config.mjs';
import {validateLoraOverrides} from '../../../shared/lora-inheritance.mjs';
import {parseOverrideSource} from '../../prompt-contract.mjs';
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
const exact=(v,keys,label)=>Object.keys(v).filter(k=>!keys.includes(k)).map(k=>`${label} 包含未知字段：${k}`);
export function validateProfilePrompt(value){
  const errors=record(value)?[...exact(value,['style','lighting','avoid'],'MOSS 项目描述'),...validateMossEntries(value.style,'style'),...validateMossEntries(value.lighting,'lighting'),...(value.avoid===undefined?[]:validateMossEntries(value.avoid,'avoid'))]:['MOSS 项目描述必须是对象'];
  if(errors.length)throw new TypeError(errors.join('；'));
}
export function validatePagePrompt(value){
  if(!record(value))return ['MOSS Prompt 必须是对象'];
  const errors=exact(value,['$schema',...mossCategories,'scene_id','scene_variant_id','entry_overrides','project_overrides','layout'],'MOSS Prompt');
  for(const category of mossCategories)if(category!=='avoid'||value.avoid!==undefined)errors.push(...validateMossEntries(value[category],category,{person:category==='person'}));
  if(value.$schema!=='https://storyvisualizer.local/schemas/story-page-prompt.schema.json')errors.push('MOSS Prompt $schema 不匹配');
  if((value.scene_id===undefined)!==(value.scene_variant_id===undefined)||value.scene_id!==undefined&&(!id(value.scene_id)||!id(value.scene_variant_id)||value.scene_variant_id==='main'))errors.push('场景引用无效');
  if(value.entry_overrides!==undefined){
    if(!record(value.entry_overrides))errors.push('entry_overrides 必须是对象');
    else for(const [source,entries] of Object.entries(value.entry_overrides)){if(!parseOverrideSource(source))errors.push(`entry_overrides 来源无效：${source}`);errors.push(...validateMossEntries(entries,source));}
  }
  if(value.project_overrides!==undefined){
    if(!record(value.project_overrides))errors.push('project_overrides 必须是对象');
    else {errors.push(...exact(value.project_overrides,['style','lighting'],'project_overrides'));for(const [k,v] of Object.entries(value.project_overrides))errors.push(...validateMossEntries(v,k));}
  }
  if(value.layout!==undefined){
    const layout=value.layout;
    if(!record(layout)||!Array.isArray(layout.items)||typeof layout.enabled!=='boolean')errors.push('layout 必须包含 enabled 和 items');
    else {
      errors.push(...exact(layout,['enabled','items'],'layout'));const seen=new Set(),characters=new Set();
      for(const item of layout.items){
        if(!record(item)){errors.push('Layout 元素必须是对象');continue;}
        errors.push(...exact(item,['id','character_id','label','entries','text','bbox'],'Layout 元素'));
        if(!id(item.id)||seen.has(item.id))errors.push('Layout 元素 ID 无效或重复');seen.add(item.id);
        if(!Array.isArray(item.bbox)||item.bbox.length!==4||item.bbox.some(n=>typeof n!=='number'||!Number.isFinite(n))||item.bbox[0]<0||item.bbox[1]<0||item.bbox[2]<=0||item.bbox[3]<=0||item.bbox[0]+item.bbox[2]>1.000001||item.bbox[1]+item.bbox[3]>1.000001)errors.push('Layout bbox 必须为画幅内归一化 [x,y,width,height]');
        if(item.character_id!==undefined){if(!id(item.character_id)||characters.has(item.character_id))errors.push('Layout 角色无效或重复');characters.add(item.character_id);if(item.entries!==undefined||item.text!==undefined||item.label!==undefined)errors.push('角色 Layout 元素复用人物条目，不另存描述');}
        else {if(!['object','text'].includes(item.label))errors.push('Layout 元素类别无效');errors.push(...validateMossEntries(item.entries,'Layout entries'));if(item.label==='text'&&typeof item.text!=='string')errors.push('文字元素必须提供 text');if(item.label!=='text'&&item.text!==undefined)errors.push('非文字元素不接受 text');}
      }
    }
  }
  return errors;
}
export function validateSettingPrompt(value){
  if(!record(value))return ['MOSS 设定必须是对象'];
  const errors=exact(value,['$schema','prompt_name','identity','variants'],'MOSS 设定');
  if(value.$schema!=='https://storyvisualizer.local/schemas/character-prompt.schema.json')errors.push('MOSS 设定 $schema 不匹配');
  if(typeof value.prompt_name!=='string'||!value.prompt_name.trim())errors.push('prompt_name 不能为空');
  if(!record(value.identity))errors.push('identity 必须包含 lora');
  else {errors.push(...exact(value.identity,['lora'],'identity'));if(value.identity.lora!==null)errors.push(...validateLoraDefinition(value.identity.lora,'identity.lora'));}
  if(!record(value.variants)||!Object.keys(value.variants).length)errors.push('variants 至少需要一个子设定');
  else for(const [key,variant] of Object.entries(value.variants)){
    if(!id(key)||key==='main')errors.push('子设定 ID 无效');
    if(!record(variant)){errors.push('子设定必须是对象');continue;}
    errors.push(...exact(variant,['entries','loras','lora_overrides'],key),...validateMossEntries(variant.entries,key),...validateLoraOverrides(variant.lora_overrides));
    if(variant.loras!==undefined){if(!Array.isArray(variant.loras))errors.push('loras 必须是数组');else for(const lora of variant.loras)errors.push(...validateLoraDefinition(lora,'loras'));}
  }return errors;
}
