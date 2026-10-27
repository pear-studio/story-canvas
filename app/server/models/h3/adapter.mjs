import * as prompt from './prompt.mjs';
import {qwenAdapter} from '../qwen/adapter.mjs';

export const h3Adapter=Object.freeze({
  id:'h3',architecture:'minimax-h3',label:'MiniMax H3',defaultProfile:'minimax-h3',
  capabilities:Object.freeze({references:true,rewrite:false,video:true}),
  emptyPrompt:prompt.emptyPrompt,compilePrompt:prompt.compilePrompt,
  validatePagePrompt:prompt.validatePrompt,preparePagePrompt:value=>structuredClone(value),
  validateSettingPrompt:()=>['H3 不使用角色设定输入'],prepareSettingPrompt:value=>value,
  // 保留既有 inspection 草稿的文字投影与校验行为；视频草稿支持不在本次重构中变更。
  normalizePagePromptDraft:source=>qwenAdapter.normalizePagePromptDraft(source),
  consumesSettings:value=>value.composition!=='standalone',
  pageScopeDetails:context=>qwenAdapter.pageScopeDetails(context),
  sourceReadHint:target=>qwenAdapter.sourceReadHint(target),
  sourceOverrideFields:Object.freeze(['inheritance','text_overrides','reference_overrides']),
  validateProfilePrompt(value){if(typeof value?.text!=='string')throw Error('H3 prompt.text 必须是字符串');},
  async resolveProfilePrompt(_root,profile){return {prompt:profile.prompt,identity:{}};},
  async resolveEffectivePrompt(_root,bundle){return structuredClone(bundle.source_identity);},
  sourceIdentityFields:[],validateSourceIdentity(){},
});
