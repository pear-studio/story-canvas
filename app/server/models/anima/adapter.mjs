import {compileCurrentPagePrompt} from './current-page-prompt.mjs';
import * as profile from './profile.mjs';
import * as page from './story-files.mjs';
import * as setting from './character-files.mjs';
import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import {normalizeCameraSettings,cameraPromptPreview} from '../../../shared/camera-prompt.mjs';
import {promptPageDiagnostics} from '../../../shared/prompt-source-view.mjs';
import {applyPersonGroups} from '../../prompt-person-edit.mjs';
import {validateModelPromptInput} from '../../model-prompt-validation.mjs';
import {ApiError} from '../../http-support.mjs';

const emptyPrompt=()=>({population:[],person:[],setting:[],camera:[],avoid:[]});
const emptySettingVariant=()=>({prompt:emptyPrompt(),loras:[]});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export const animaAdapter=Object.freeze({
  id:'anima',architecture:'anima',label:'Anima Basic',defaultProfile:'anima-base-v1',
  capabilities:Object.freeze({references:false,rewrite:false}),
  emptyPrompt,emptySettingVariant,
  emptySettingPrompt(name,variantIds){
    return {identity:{prompt:emptyPrompt(),lora:null},variants:Object.fromEntries(variantIds.map(id=>[id,emptySettingVariant()]))};
  },
  settingBaseFields:Object.freeze(['identity']),
  settingVariantDependencies:input=>({identity:input.identity}),
  prepareSettingBase(input){
    // 删除必需的 nullable 字段表示停用，落盘仍保留 null。
    if(record(input.identity)&&!Object.hasOwn(input.identity,'lora'))input.identity.lora=null;
  },
  inheritedSettingReadHint:'document 是子设定自身词；inherited_sources 是基础继承词，调整 identity_overrides，不重复添加。',
  sourceReadHint:target=>target.kind==='page'
    ?'页面调整写 changes.inheritance[source][key]，使用来源返回的稳定 key；null 删除该调整以恢复继承。'
    :'本子设定只显示可覆盖的基础词，调整写 changes.identity_overrides[key]；自身词在 prompt.read 的 prompt 分类数组中编辑。',
  sourceOverrideFields:Object.freeze(['inheritance','text_overrides','reference_overrides']),
  normalizePagePromptDraft(source){
    return {prompt:{$schema:page.STORY_PAGE_PROMPT_SCHEMA_ID,...structuredClone(source)},
      errors:validateModelPromptInput(source,'page',animaAdapter)};
  },
  resolveSetting(configuration,promptDocument){
    return {prompt_name:promptDocument.prompt_name,text:configuration.text??'',reference_images:structuredClone(configuration.reference_images??[]),
      ...structuredClone(configuration),identity:structuredClone(promptDocument.identity),
      local_loras:structuredClone(configuration.loras??[]),loras:settingLoras(promptDocument.identity,configuration)};
  },
  consumesSettings:()=>true,
  pageScopeDetails({document,narrative,inheritedSources,referenceEdit}){
    const person=document.person??[];
    const diagnostics=promptPageDiagnostics(document,narrative.characters??[],inheritedSources,'anima');
    for(const issue of diagnostics)if(issue.code==='source_has_no_consumed_words'&&issue.source.startsWith('character:')){
      issue.message='该画面引用没有继承词参与输出；核查是否仍需入镜，不自动删除。解除画面引用保留对白。';
      issue.next=referenceEdit;
    }
    return {camera_preview:cameraPromptPreview(document.camera_settings),camera_help:{operation:'help',target:'prompt.save',topic:'camera'},
      bindings:{characters:(narrative.characters??[]).map(ref=>({character_id:ref.character_id,person_indices:person.flatMap((entry,index)=>entry.character_id===ref.character_id?[index]:[])})),unbound_person_indices:person.flatMap((entry,index)=>!entry.character_id?[index]:[])},
      diagnostics,read_hint:'document 仅本页词；references.characters 是画面引用，独立于人数和对白。inherited_sources 已应用覆盖，enabled 为启用，consumed 表示该分类会送入编译；去重后的实际输出按需查 prompt.context，不要复制继承。按角色改本页词用 changes.person_groups:[{character_id,entries}]，null 为未绑定，条目不填 character_id。解除角色用 references.edit，保留对白并清理角色绑定词及继承调整；只删词或 LoRA 不会解除引用。diagnostics 是带来源、位置和权重的核查线索，不代表可自动删除。'};
  },
  applyPersonGroups,
  normalizePageScope(document){
    if(document.camera_settings!==undefined){
      try{document.camera_settings=normalizeCameraSettings(document.camera_settings);}catch(error){throw new ApiError(400,'invalid_camera_settings',[error.message]);}
      if(!Object.keys(document.camera_settings).length)delete document.camera_settings;
    }
  },
  validTriggerSources(value,kind){
    const stringList=value=>Array.isArray(value)&&value.every(item=>typeof item==='string');
    return kind==='page'&&record(value)&&!Object.keys(value).some(key=>!['style','characters','scenes'].includes(key))
      &&stringList(value.style)&&!['characters','scenes'].some(key=>!record(value[key])||Object.values(value[key]).some(item=>!stringList(item)));
  },
  compilePrompt:compileCurrentPagePrompt,
  validatePagePrompt:page.validateStoryPagePromptDocument,preparePagePrompt:page.preparePromptForPersistence,
  validateSettingPrompt:setting.validateCharacterPromptDocument,prepareSettingPrompt:setting.prepareCharacterPromptForPersistence,
  validateProfilePrompt:profile.validateProfilePrompt,resolveProfilePrompt:profile.resolveProfilePrompt,
  resolveEffectivePrompt:profile.resolveEffectivePrompt,sourceIdentityFields:['prompt_policy','prompt_fragments'],
  validateSourceIdentity:profile.validateSourceIdentity,
});
