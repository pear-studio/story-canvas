import {emptyMossPrompt,mossText} from '../../../shared/moss-prompt.mjs';
import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import {promptPageDiagnostics} from '../../../shared/prompt-source-view.mjs';
import {validateModelPromptInput} from '../../model-prompt-validation.mjs';
import {compilePrompt} from './prompt-compiler.mjs';
import {validatePagePrompt,validateSettingPrompt,validateProfilePrompt} from './prompt-contract.mjs';
const emptySettingVariant=()=>({entries:[],loras:[]});
export const mossAdapter=Object.freeze({
  id:'moss',architecture:'moss-image',label:'MOSS',defaultProfile:'moss-image',
  capabilities:Object.freeze({references:false,rewrite:false,layout:true}),
  emptyPrompt:emptyMossPrompt,emptySettingVariant,
  emptySettingPrompt(name,ids){return {prompt_name:name,identity:{lora:null},variants:Object.fromEntries(ids.map(id=>[id,emptySettingVariant()]))};},
  settingBaseFields:Object.freeze(['prompt_name','identity']),settingVariantDependencies:input=>({identity:input.identity}),
  prepareSettingBase(input){if(input.identity&&!Object.hasOwn(input.identity,'lora'))input.identity.lora=null;},
  sourceOverrideFields:Object.freeze(['entry_overrides']),
  sourceReadHint:target=>target.kind==='page'
    ?'页面描述覆盖写 changes.entry_overrides[source]，完整替换为 description/enabled 条目数组；[] 清空，null 删除覆盖以恢复继承。不使用逐词 inheritance。'
    :'MOSS 子设定直接编辑 prompt.read 返回的 entries、loras 与 lora_overrides；没有继承的基础描述词，不使用 identity_overrides。基础身份 LoRA 在 scope:base 的 identity.lora 中维护。',
  normalizePagePromptDraft(source){return {prompt:{$schema:'https://storyvisualizer.local/schemas/story-page-prompt.schema.json',...structuredClone(source)},errors:validateModelPromptInput(source,'page',mossAdapter)};},
  resolveSetting(configuration,document){return {...structuredClone(configuration),prompt_name:document.prompt_name,text:mossText(configuration.entries),identity:structuredClone(document.identity),loras:settingLoras(document.identity,configuration)};},
  consumesSettings:()=>true,
  pageScopeDetails({document,narrative,inheritedSources}){
    const references=narrative.characters??[],ids=new Set(references.map(ref=>ref.character_id));
    const diagnostics=promptPageDiagnostics(document,references,inheritedSources,'moss');
    for(const [index,entry] of (document.person??[]).entries())if(entry.character_id&&!ids.has(entry.character_id))
      diagnostics.push({code:'unreferenced_character_binding',severity:'error',category:'person',index,character_id:entry.character_id});
    for(const [index,item] of (document.layout?.items??[]).entries())if(item.character_id&&!ids.has(item.character_id))
      diagnostics.push({code:'unreferenced_layout_character',severity:'error',index,item_id:item.id,character_id:item.character_id});
    return {diagnostics,read_hint:'MOSS 各分类保存自然语言条目 description/enabled；person 可绑定 character_id。entry_overrides 按来源替换设定描述；project_overrides 单独覆盖 style/lighting；avoid 缺省继承项目避免，数组替换，[] 清空。layout.items 的 bbox 为归一化 [x,y,width,height]，角色元素只引用 character_id，复用同一份人物描述。'};
  },
  async readProjectPrompt(context){const {readMossProjectPrompt}=await import('./project-prompt.mjs');return readMossProjectPrompt(context);},
  compilePrompt,validatePagePrompt,validateSettingPrompt,validateProfilePrompt,
  preparePagePrompt:value=>structuredClone(value),prepareSettingPrompt:value=>structuredClone(value),
  async resolveProfilePrompt(_root,profile){return {prompt:structuredClone(profile.prompt),identity:{}};},
  async resolveEffectivePrompt(_root,bundle){return structuredClone(bundle.source_identity);},
  sourceIdentityFields:[],validateSourceIdentity(){},
});
