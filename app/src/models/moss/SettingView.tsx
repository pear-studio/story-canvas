import {useEffect,useMemo,useRef} from 'react';
import {useSettingEditor} from '../../use-setting-editor';
import {InlineTitleEditor,SectionHeader,WorkspaceHeader} from '../../WorkspaceHeader';
import {LoraListEditor} from '../LoraListEditor';
import {MossEntriesEditor} from './EntriesEditor';
import type {CharacterPromptDocument,CharacterPromptVariant} from './types';
import type {ModelSettingEditorProps} from '../types';

type BasePrompt=Pick<CharacterPromptDocument,'prompt_name'|'identity'>;
type PromptScope=BasePrompt|CharacterPromptVariant;
function normalize(document:CharacterPromptDocument):Record<string,PromptScope>{return {base:{prompt_name:document.prompt_name,identity:structuredClone(document.identity)},...Object.fromEntries(Object.entries(document.variants).map(([id,value])=>[`variant:${id}`,structuredClone(value)]))};}

export function MossSettingView({kind='character',projectId,character,initialSettingId,busy,onSaved,onSettingChange,onDirtyChange}:ModelSettingEditorProps<CharacterPromptDocument>){
  const label=kind==='scene'?'场景':'角色',view=useRef<HTMLElement>(null);
  const sourceScopes=useMemo(()=>normalize(character.prompt),[character.id,character.prompt_sha256]);
  const editor=useSettingEditor({kind,projectId,character,initialSettingId,busy,onSaved,onSettingChange,onDirtyChange},'moss',sourceScopes,value=>value,normalize,(value,base)=>!base||Boolean((value as BasePrompt|undefined)?.prompt_name?.trim()));
  const {settingId,isProfile,scopeKey,selectedScope,selectedVariant,variantIdDraft,variantIdDirty,variantIdValid,variantIdConflict,profileDraft,setProfileDraft,updateSelectedVariant,setVariantIdDraft,promptState,dirty,saving,notice,valid,saveCurrent}=editor;
  useEffect(()=>{if(view.current)view.current.scrollTop=0;},[settingId]);
  const base=promptState.scopes.base.draft as BasePrompt,variant=(selectedScope?.draft??{entries:[],loras:[]}) as CharacterPromptVariant;
  const disabled=busy||saving;
  const updateVariant=(value:CharacterPromptVariant)=>promptState.setDraft(scopeKey,value);
  return <section className="resource-editor current-workbench-character" data-project-fact-dirty={dirty?'true':undefined} ref={view}>
    <WorkspaceHeader className="character-workspace-header" breadcrumb={[label,profileDraft.name]} actions={<button type="button" className="button button--primary" aria-label="保存当前设定" title="保存当前设定 (Ctrl+S / ⌘S)" disabled={disabled||!valid} onClick={()=>void saveCurrent()}>{saving?'保存中…':'保存'}</button>} title={<span className="character-title-editor">{isProfile?<InlineTitleEditor label={`重命名${label}`} value={profileDraft.name} disabled={disabled} onChange={name=>setProfileDraft(current=>({...current,name}))}/>:<><span>{profileDraft.name}</span><i>·</i>{selectedVariant&&<InlineTitleEditor key={selectedVariant.id} label="重命名子设定" value={selectedVariant.name} disabled={disabled} onChange={name=>updateSelectedVariant(current=>({...current,name}))}/>}</>}</span>}/>
    {notice&&<p role="status">{notice}</p>}
    <fieldset className="moss-entry-fieldset" disabled={disabled} inert={disabled}><div className="character-settings-layout"><div className="resource-form">
      {isProfile?<>
        <div className="resource-form--wide character-summary-stack"><section className="character-fact-section character-summary-card"><SectionHeader title={`${label}档案`}/><div className="character-fact-fields character-fact-fields--stacked"><label><span>{label}设定</span><textarea aria-label={`${label}设定`} rows={2} value={profileDraft.description} onChange={event=>setProfileDraft(current=>({...current,description:event.target.value}))}/></label></div></section></div>
        <section className="resource-form--wide character-fact-section character-generation-section"><SectionHeader title="Prompt 名称" description="生成时使用，所有子设定共用"/><div className="character-fact-fields"><label className="resource-form--wide"><span>Prompt 名称</span><input value={base.prompt_name} onChange={event=>promptState.setDraft('base',{...base,prompt_name:event.target.value})}/>{!base.prompt_name.trim()&&<small className="character-color-hint">Prompt 名称不能为空。</small>}</label></div><LoraListEditor projectId={projectId} profileId="moss-image" title="基础 LoRA" single value={base.identity.lora?[base.identity.lora]:[]} disabled={disabled} onChange={value=>promptState.setDraft('base',{...base,identity:{lora:value[0]??null}})}/></section>
      </>:<>
        {selectedVariant&&<section className="resource-form--wide character-fact-section"><SectionHeader title="子设定" description="名称与稳定 ID"/><div className="character-fact-fields"><label className="resource-form--wide"><span>子设定 ID</span><input className={variantIdDirty&&(!variantIdValid||variantIdConflict)?'is-missing mono-input':'mono-input'} value={variantIdDraft} onChange={event=>setVariantIdDraft(event.target.value)}/>{variantIdDirty&&(!variantIdValid||variantIdConflict)&&<small className="character-color-hint">ID 由小写字母、数字与连字符组成，且不能与现有子设定重复。</small>}</label></div></section>}
        <section className="resource-form--wide character-fact-section character-generation-section"><SectionHeader title="生成配置" description="子设定的完整描述"/><MossEntriesEditor label="描述" value={variant.entries??[]} scopeKey={`${projectId}:${kind}:${character.id}:${settingId}:${selectedScope?.fingerprint}`} scope="character" disabled={disabled} onChange={entries=>updateVariant({...variant,entries})}/><LoraListEditor projectId={projectId} profileId="moss-image" title="LoRA" inherited={base.identity.lora?[base.identity.lora]:[]} value={variant.loras??[]} overrides={variant.lora_overrides} disabled={disabled} onChange={(loras,lora_overrides)=>updateVariant({...variant,loras,lora_overrides})}/></section>
      </>}
    </div></div></fieldset>
  </section>;
}
