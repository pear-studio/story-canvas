import { ReferenceLibrary } from "../../ReferenceLibrary";
import { useEffect, useMemo, useRef } from 'react';
import { useSettingEditor } from '../../use-setting-editor';
import { PromptTextArea } from '../../SourcePromptEditor';
import { InlineTitleEditor, SectionHeader, WorkspaceHeader } from '../../WorkspaceHeader';
import { type CharacterPromptVariant, type CharacterPromptDocument } from '../../project-workbench-client';

type PromptScope = { prompt_name: string } | CharacterPromptVariant;

export function QwenSettingView({ kind = 'character', projectId, character, initialSettingId, busy, onSaved, onSettingChange, onDirtyChange }: import('../types').ModelSettingEditorProps) {
  const label = kind === 'scene' ? '场景' : '角色';
  const characterViewRef = useRef<HTMLElement>(null);
  const normalize = (document:CharacterPromptDocument):Record<string,PromptScope> => ({base:{prompt_name:document.prompt_name},...Object.fromEntries(Object.entries(document.variants).map(([id,value])=>[`variant:${id}`,structuredClone(value)]))});
  const sourceScopes = useMemo(()=>normalize(character.prompt),[character.id,character.prompt_sha256]);
  const editor = useSettingEditor({kind,projectId,character,initialSettingId,busy,onSaved,onSettingChange,onDirtyChange},'qwen',sourceScopes,value=>value,normalize);
  const {settingId,isProfile,scopeKey:selectedScopeKey,selectedScope,selectedVariant,variantIdDraft,variantIdDirty,variantIdValid,variantIdConflict,
    profileDraft,setProfileDraft,updateSelectedVariant,setVariantIdDraft,promptState,dirty,saving,notice,valid,saveCurrent} = editor;
  const savingSection = saving ? 'all' : null;
  const selectedSettingId = settingId;
  const hasSelectedSetting = isProfile || Boolean(selectedScope);
  useEffect(() => {if(characterViewRef.current)characterViewRef.current.scrollTop=0;},[settingId]);
  const basePrompt = promptState.scopes.base.draft as {prompt_name:string};
  const selectedSetting = (selectedScope?.draft ?? {text:''}) as CharacterPromptVariant;
  function updateSelectedSetting(update:(value:CharacterPromptVariant)=>CharacterPromptVariant) {promptState.setDraft(selectedScopeKey,current=>update(current as CharacterPromptVariant));}
  return <section className="resource-editor current-workbench-character" data-project-fact-dirty={dirty ? "true" : undefined} ref={characterViewRef}>
    <WorkspaceHeader actions={<button type="button" aria-label="保存当前设定" title="保存当前设定 (Ctrl+S / ⌘S)" className="button button--primary" disabled={busy || saving || !valid} onClick={() => void saveCurrent()}>{saving ? '保存中…' : '保存'}</button>} breadcrumb={[label, profileDraft.name]} className="character-workspace-header" title={<span className="character-title-editor">{isProfile ? <InlineTitleEditor label={`重命名${label}`} value={profileDraft.name} disabled={busy || savingSection !== null} onChange={(name) => setProfileDraft((current) => ({ ...current, name }))} /> : <><span>{profileDraft.name}</span><i>·</i>{selectedVariant && <InlineTitleEditor key={selectedVariant.id} label="重命名子设定" value={selectedVariant.name} disabled={busy || savingSection !== null} onChange={(name) => updateSelectedVariant((variant) => ({ ...variant, name }))} />}</>}</span>} />
    {notice && <p role="status">{notice}</p>}
    <fieldset inert={busy || savingSection !== null} disabled={busy || savingSection !== null} style={{border:0,padding:0,margin:0,minWidth:0}}><div className="character-settings-layout">
      <div className="resource-form">
        {isProfile && <>
          <div className="resource-form--wide character-summary-stack">
            <section className="character-fact-section character-summary-card"><SectionHeader title={`${label}档案`} /><div className="character-fact-fields character-fact-fields--stacked"><label><span>{label}设定</span><textarea aria-label={`${label}设定`} rows={2} value={profileDraft.description} onChange={(event) => setProfileDraft((current) => ({ ...current, description: event.target.value }))} /></label></div></section>
          </div>
          <section className="resource-form--wide character-fact-section character-generation-section">
            <SectionHeader title="Prompt 名称" description="生成时引用此设定的名称，所有子设定共用；创建时复制显示名称，之后独立修改" />
            <div className="character-fact-fields"><label className="resource-form--wide"><span>Prompt 名称</span><input value={basePrompt.prompt_name} disabled={busy || savingSection !== null} onChange={(event) => promptState.setDraft('base', { prompt_name: event.target.value })} />{!basePrompt.prompt_name.trim() && <small className="character-color-hint">Prompt 名称不能为空。</small>}</label></div>
          </section>
        </>}
        {!isProfile && <>
        {selectedVariant && <section className="resource-form--wide character-fact-section"><SectionHeader title="子设定" description="名称与稳定 ID" /><div className="character-fact-fields"><label className="resource-form--wide"><span>子设定 ID</span><input className={variantIdDirty && (!variantIdValid || variantIdConflict) ? "is-missing mono-input" : "mono-input"} value={variantIdDraft} onChange={(event) => setVariantIdDraft(event.target.value)} />{variantIdDirty && (!variantIdValid || variantIdConflict) && <small className="character-color-hint">ID 由小写字母、数字与连字符组成，且不能与现有子设定重复。</small>}</label></div></section>}
        {!hasSelectedSetting ? <section className="resource-form--wide character-fact-section character-generation-section"><SectionHeader title="生成配置" description="尚未建立" /><div className="character-generation-empty character-generation-empty--action"><button type="button" className="button button--quiet" onClick={() => updateSelectedSetting(() => ({ text: "" }))}>建立 Prompt</button></div></section> : <section className="resource-form--wide character-fact-section character-generation-section">
          <SectionHeader title="生成配置" description="子设定完整 Prompt 与参考图" />
          <ReferenceLibrary initialEntries={selectedSetting.reference_images ?? []} onDraftChange={reference_images=>updateSelectedSetting(setting=>({...setting,reference_images}))} key={`${projectId}:${character.id}:${settingId}:${selectedScope?.fingerprint}`} projectId={projectId} target={{kind,id:character.id,variant_id:settingId,model_id:'qwen'}} pages={character.pages.filter(p=>p.variant_id===settingId)} disabled={busy || saving} onChanged={()=>{}} />
          <label className="variant-prompt-field"><span>子设定 Prompt</span><PromptTextArea ariaLabel={`${selectedVariant?.name ?? selectedSettingId} 子设定 Prompt`} rows={4} value={selectedSetting.text} disabled={busy || savingSection !== null} placeholder="此子设定的完整文字描述" onChange={(text) => updateSelectedSetting((setting) => ({ ...setting, text }))} /></label>

        </section>}
        </>}
      </div>
    </div>
    </fieldset>
  </section>;
}
