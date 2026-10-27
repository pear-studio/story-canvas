import {compileCurrentPagePrompt} from './prompt-compiler.mjs';
import * as contract from './prompt-contract.mjs';
import {promptPageDiagnostics} from '../../../shared/prompt-source-view.mjs';
import {validateModelPromptInput} from '../../model-prompt-validation.mjs';

const schema='https://storyvisualizer.local/schemas/story-page-prompt.schema.json';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const emptySettingVariant=()=>({text:'',reference_images:[]});

export const qwenAdapter=Object.freeze({
  id:'qwen',architecture:'qwen-image-2-1',label:'Qwen-Image-2.1',defaultProfile:'qwen-image-2-1',
  capabilities:Object.freeze({references:true,rewrite:true}),
  emptyPrompt:()=>({text:'',composition:'settings'}),emptySettingVariant,
  emptySettingPrompt(name,variantIds){return {prompt_name:name,variants:Object.fromEntries(variantIds.map(id=>[id,emptySettingVariant()]))};},
  settingBaseFields:Object.freeze(['prompt_name']),settingVariantDependencies:()=>({}),
  sourceOverrideFields:Object.freeze(['inheritance','text_overrides','reference_overrides']),
  sourceReadHint:target=>target.kind==='page'
    ?'页面文字覆盖写 changes.text_overrides[source]，参考图选择写 changes.reference_overrides[source]（图片 ID 数组）；null 删除覆盖以恢复继承，空串清空文字，[] 不选择参考图。'
    :'Qwen 子设定直接编辑 prompt.read 返回的 text 与 reference_images；不使用 identity_overrides。来源回执仅供查看，保存使用该子设定自己的 prompt.read 读据。',
  normalizePagePromptDraft(source){
    const prompt={$schema:schema,text:typeof source.text==='string'?source.text:'',
      ...(source.composition?{composition:source.composition}:{}),
      ...(source.loras?{loras:structuredClone(source.loras)}:{}),
      ...(source.lora_overrides?{lora_overrides:structuredClone(source.lora_overrides)}:{}),
      ...(source.scene_id?{scene_id:source.scene_id,scene_variant_id:source.scene_variant_id}:{}),
      ...(record(source.text_overrides)?{text_overrides:structuredClone(source.text_overrides)}:{}),
      ...(record(source.reference_overrides)?{reference_overrides:structuredClone(source.reference_overrides)}:{}),
      ...(Array.isArray(source.reference_images)?{reference_images:source.reference_images.filter(record).map(entry=>structuredClone(entry))}:{})};
    return {prompt,errors:validateModelPromptInput(source,'page',qwenAdapter)};
  },
  resolveSetting(configuration,promptDocument){return {prompt_name:promptDocument.prompt_name,text:configuration.text??'',reference_images:structuredClone(configuration.reference_images??[])};},
  consumesSettings:prompt=>prompt.composition!=='standalone',
  pageScopeDetails({document,narrative,inheritedSources}){
    return {diagnostics:promptPageDiagnostics(document,narrative.characters??[],inheritedSources,'qwen'),
      read_hint:'document 是本页文字与覆盖。references.characters 为画面引用；standalone 时不消费上游。inherited_sources 的 text 已应用覆盖，reference_images 为可用图库，selected_image_ids 才是选择结果（空数组表示不选）。解除引用用 references.edit，保留画外对白。'};
  },
  compilePrompt:compileCurrentPagePrompt,
  validatePagePrompt:contract.validateStoryPagePromptDocument,preparePagePrompt:prompt=>structuredClone(prompt),
  validateSettingPrompt:contract.validateCharacterPromptDocument,prepareSettingPrompt:prompt=>structuredClone(prompt),
  validateProfilePrompt(value){
    if(!record(value)||Object.keys(value).some(key=>key!=='text')||typeof value.text!=='string')throw new TypeError('Qwen prompt.text 必须是字符串，且不允许未知字段');
  },
  async resolveProfilePrompt(_root,profile){return {prompt:structuredClone(profile.prompt),identity:{}};},
  async resolveEffectivePrompt(_root,bundle){return structuredClone(bundle.source_identity);},
  sourceIdentityFields:[],validateSourceIdentity(){},
});
