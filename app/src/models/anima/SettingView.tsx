import {LoraListEditor} from '../LoraListEditor';
import type {LoraOverrides} from '../../../shared/lora-inheritance.mjs';
import { type ReferenceEntry } from "../../ReferenceLibrary";
import { useEffect, useMemo, useRef } from 'react';
import { useSettingEditor } from '../../use-setting-editor';
import { InheritedPromptEditor } from '../../InheritedPromptEditor';
import { PromptFragmentEditor, type PromptFragment as DisplayPromptFragment } from '../../PromptFragmentEditor';
import { createPromptDraftFragment, displayPromptDraft, persistPromptDraft } from '../../prompt-fragment-draft';
import { InlineTitleEditor, SectionHeader, WorkspaceHeader } from '../../WorkspaceHeader';
import {type SettingKind, type EditableWorkbenchCharacter as SharedCharacter} from '../../project-workbench-client';
import {promptCategories, type CharacterLora, type CharacterPromptDocument, type CharacterPromptSetting, type InheritedAdjustments} from './types';
type WorkbenchCharacter = SharedCharacter<CharacterPromptDocument>;
const promptLabels = { population: '其他', person: '人物', setting: '场景', camera: '镜头', avoid: '避免' };

type EditableCharacterLora = { filename: string; sha256: string; weight: string; trigger: string };
type EditableCharacterSetting = { reference_images?: ReferenceEntry[]; prompt: Record<string, DisplayPromptFragment[]>; loras: EditableCharacterLora[]; loraOverrides: LoraOverrides; identityOverrides: InheritedAdjustments };
type EditableCharacterIdentity = { prompt: Record<string, DisplayPromptFragment[]>; lora: EditableCharacterLora | null };
type EditableCharacterPrompt = { identity: EditableCharacterIdentity; variants: Record<string, EditableCharacterSetting> };
type EditablePromptScope = EditableCharacterIdentity | EditableCharacterSetting;

function emptyDisplayPrompt() {
  return Object.fromEntries(promptCategories.map((category) => [category, []])) as Record<string, DisplayPromptFragment[]>;
}

function editableLora(lora: CharacterLora): EditableCharacterLora {
  return { filename: lora.filename, sha256: lora.sha256, weight: String(lora.weight), trigger: lora.trigger ?? "" };
}

function persistedLora(lora: EditableCharacterLora): CharacterLora {
  return {
    filename: lora.filename,
    sha256: lora.sha256,
    weight: Number(lora.weight),
    ...(lora.trigger.trim() ? { trigger: lora.trigger } : {}),
  };
}

function editableCharacterSetting(setting?: CharacterPromptSetting): EditableCharacterSetting {
  return {
    reference_images: setting?.reference_images,
    prompt: setting ? displayPromptDraft(setting.prompt) : emptyDisplayPrompt(),
    loras: (setting?.loras ?? []).map(editableLora),
    loraOverrides: setting?.lora_overrides ?? {},

    identityOverrides: structuredClone(setting?.identity_overrides ?? {}),
  };
}

function editableCharacterPrompt(prompt: CharacterPromptDocument): EditableCharacterPrompt {
  return {
    identity: {
      prompt: displayPromptDraft(prompt.identity.prompt),
      lora: prompt.identity?.lora ? editableLora(prompt.identity.lora) : null,
    },
    variants: Object.fromEntries(Object.entries(prompt.variants).map(([id, setting]) => [id, editableCharacterSetting(setting)])),
  };
}

function persistedCharacterSetting(setting: EditableCharacterSetting): CharacterPromptSetting {
  return {
    ...(setting.reference_images ? { reference_images: setting.reference_images } : {}),
    prompt: persistPromptDraft(setting.prompt, { shared: true }),
    loras: setting.loras.map(persistedLora),
    lora_overrides: setting.loraOverrides,

    ...(Object.keys(setting.identityOverrides).length ? { identity_overrides: setting.identityOverrides } : {}),
  };
}

function persistedCharacterIdentity(identity: EditableCharacterIdentity): CharacterPromptDocument['identity'] {
  return {
    prompt: persistPromptDraft(identity.prompt, { shared: true }),
    lora: identity.lora ? persistedLora(identity.lora) : null,
  };
}

export function AnimaSettingView({ kind = 'character', projectId, character, initialSettingId, busy, onSaved, onSettingChange, onDirtyChange }: { kind?: SettingKind; projectId: string; character: WorkbenchCharacter; initialSettingId: string; busy: boolean; onSaved: (replacement: Partial<WorkbenchCharacter>) => void; onSettingChange?: (settingId: string) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const label = kind === 'scene' ? '场景' : '角色';
  const characterViewRef = useRef<HTMLElement>(null);
  const categories = kind === 'scene' ? promptCategories.filter(c => c === 'setting' || c === 'avoid') : promptCategories.filter(c=>c!=='population');
  const normalize = (document:CharacterPromptDocument):Record<string,EditablePromptScope> => {const value=editableCharacterPrompt(document);return {base:value.identity,...Object.fromEntries(Object.entries(value.variants).map(([id,value])=>[`variant:${id}`,value]))};};
  const sourceScopes = useMemo(()=>normalize(character.prompt),[character.id,character.prompt_sha256]);
  const editor = useSettingEditor({kind,projectId,character,initialSettingId,busy,onSaved,onSettingChange,onDirtyChange},'anima',sourceScopes,(value,base)=>base ? {identity:persistedCharacterIdentity(value as EditableCharacterIdentity)} : persistedCharacterSetting(value as EditableCharacterSetting),normalize);
  const {settingId,isProfile,scopeKey:selectedScopeKey,selectedScope,selectedVariant,variantIdDraft,variantIdDirty,variantIdValid,variantIdConflict,
    profileDraft,setProfileDraft,updateSelectedVariant,setVariantIdDraft,promptState,dirty,saving,notice,valid,saveCurrent} = editor;
  const savingSection = saving ? 'all' : null;
  const selectedSettingId = settingId;
  const hasSelectedSetting = isProfile || Boolean(selectedScope);
  useEffect(() => {if(characterViewRef.current)characterViewRef.current.scrollTop=0;},[settingId]);
  const identityDraft = promptState.scopes.base.draft as EditableCharacterIdentity;
  const selectedSetting = (selectedScope?.draft ?? editableCharacterSetting()) as EditableCharacterSetting;
  function updateSelectedSetting(update:(value:EditableCharacterSetting)=>EditableCharacterSetting) {promptState.setDraft(selectedScopeKey,current=>update(current as EditableCharacterSetting));}
  function updateIdentity(update:(value:EditableCharacterIdentity)=>EditableCharacterIdentity) {promptState.setDraft('base',current=>update(current as EditableCharacterIdentity));}
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
            <SectionHeader title="基础设定" description="所有子设定共享的 Prompt" />
          <LoraListEditor projectId={projectId} profileId="anima-base-v1" title="基础 LoRA" single value={identityDraft.lora?[persistedLora(identityDraft.lora)]:[]} disabled={busy||savingSection!==null} onChange={value=>updateIdentity(identity=>({...identity,lora:value[0]?editableLora(value[0]):null}))}/>
          <PromptFragmentEditor categories={categories.map((category) => ({ id: category, label: promptLabels[category] }))} scope="character" fragments={identityDraft.prompt} createFragment={createPromptDraftFragment} onChange={(prompt) => updateIdentity((identity) => ({ ...identity, prompt }))} historyScopeKey={`${character.id}:identity:${promptState.scopes.base?.fingerprint}`} />

          </section>
        </>}
        {!isProfile && <>
        {selectedVariant && <section className="resource-form--wide character-fact-section"><SectionHeader title="子设定" description="名称与稳定 ID" /><div className="character-fact-fields"><label className="resource-form--wide"><span>子设定 ID</span><input className={variantIdDirty && (!variantIdValid || variantIdConflict) ? "is-missing mono-input" : "mono-input"} value={variantIdDraft} onChange={(event) => setVariantIdDraft(event.target.value)} />{variantIdDirty && (!variantIdValid || variantIdConflict) && <small className="character-color-hint">ID 由小写字母、数字与连字符组成，且不能与现有子设定重复。</small>}</label></div></section>}
        {!hasSelectedSetting ? <section className="resource-form--wide character-fact-section character-generation-section"><SectionHeader title="生成配置" description="尚未建立" /><div className="character-generation-empty character-generation-empty--action"><button type="button" className="button button--quiet" onClick={() => updateSelectedSetting(() => editableCharacterSetting())}>建立 Prompt</button></div></section> : <section className="resource-form--wide character-fact-section character-generation-section">
          <SectionHeader title="生成配置" description="子设定 Prompt" />
          {promptState.scopes.base?.dirty && <p role="status">基础设定有未保存修改；此处继承已保存的基础设定。</p>}
          <LoraListEditor projectId={projectId} profileId="anima-base-v1" title="子设定 LoRA" inherited={character.prompt.identity.lora?[character.prompt.identity.lora]:[]} value={selectedSetting.loras.map(persistedLora)} overrides={selectedSetting.loraOverrides} disabled={busy||savingSection!==null} onChange={(value,loraOverrides)=>updateSelectedSetting(setting=>({...setting,loras:value.map(editableLora),loraOverrides}))}/>
          <InheritedPromptEditor title="基础 Prompt" source={character.id + ':' + settingId + ':' + selectedScope?.fingerprint} prompt={character.prompt.identity.prompt} adjustments={selectedSetting.identityOverrides} defaultOpen onChange={value => updateSelectedSetting(setting => ({ ...setting, identityOverrides: value }))} />
          <PromptFragmentEditor categories={categories.map((category) => ({ id: category, label: promptLabels[category] }))} scope="character" fragments={selectedSetting.prompt} createFragment={createPromptDraftFragment} onChange={(prompt) => updateSelectedSetting((setting) => ({ ...setting, prompt }))} historyScopeKey={`${character.id}:${settingId}:${selectedScope?.fingerprint}`} />

        </section>}
        </>}
      </div>
    </div>
    </fieldset>
  </section>;
}
