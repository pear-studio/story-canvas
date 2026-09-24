import { type ReferenceEntry } from "../../ReferenceLibrary";
import { PromptPopulationEditor } from "../../PromptPopulationEditor";
import { useFactDraft } from '../../use-fact-draft';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InheritedPromptEditor } from '../../InheritedPromptEditor';
import { PromptFragmentEditor, type PromptFragment as DisplayPromptFragment } from '../../PromptFragmentEditor';
import { createPromptDraftFragment, displayPromptDraft, persistPromptDraft } from '../../prompt-fragment-draft';
import { InlineTitleEditor, SectionHeader, WorkspaceHeader } from '../../WorkspaceHeader';
import { useFeedback } from '../../feedback';
import {saveSettingProfile, saveSettingVisual, saveSettingPrompt, renameSettingVariant, type SettingKind, type CharacterProfileDraft, type CharacterVisualDraft, type WorkbenchCharacter as SharedCharacter} from '../../project-workbench-client';
import {promptCategories, type CharacterLora, type CharacterPromptDocument, type CharacterPromptSetting, type InheritedAdjustments} from './types';
type WorkbenchCharacter = SharedCharacter<CharacterPromptDocument>;
const promptLabels = { subject: '人数', person: '人物', setting: '场景', camera: '镜头', avoid: '避免' };
const characterVariantIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type EditableCharacterLora = { filename: string; sha256: string; weight: string; trigger: string };
type EditableCharacterSetting = { reference_images?: ReferenceEntry[]; prompt: Record<string, DisplayPromptFragment[]>; loras: EditableCharacterLora[]; identityDisabled: string[]; identityOverrides: InheritedAdjustments };
type EditableCharacterIdentity = { prompt: Record<string, DisplayPromptFragment[]>; lora: EditableCharacterLora | null };
type EditableCharacterPrompt = { identity: EditableCharacterIdentity; variants: Record<string, EditableCharacterSetting> };

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
    identityDisabled: [...(setting?.identity_disabled ?? [])],
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
    prompt: persistPromptDraft(setting.prompt),
    loras: setting.loras.map(persistedLora),
    identity_disabled: [...setting.identityDisabled],
    ...(Object.keys(setting.identityOverrides).length ? { identity_overrides: setting.identityOverrides } : {}),
  };
}

function persistedCharacterPrompt(prompt: EditableCharacterPrompt): CharacterPromptDocument {
  return {
    identity: {
      prompt: persistPromptDraft(prompt.identity.prompt),
      lora: prompt.identity.lora ? persistedLora(prompt.identity.lora) : null,
    },
    variants: Object.fromEntries(Object.entries(prompt.variants).map(([id, setting]) => [id, persistedCharacterSetting(setting)])),
  };
}

export function AnimaSettingView({ kind = 'character', projectId, character, initialSettingId, busy, onSaved, onSettingChange }: { kind?: SettingKind; projectId: string; character: WorkbenchCharacter; initialSettingId: string; busy: boolean; onSaved: (replacement: Partial<WorkbenchCharacter>) => void; onSettingChange?: (settingId: string) => void }) {
  const { notify } = useFeedback();
  const label = kind === 'scene' ? '场景' : '角色';
  const categories = kind === 'scene' ? promptCategories.filter(c => c === 'setting' || c === 'avoid') : promptCategories.filter(c => c !== 'subject');
  const characterViewRef = useRef<HTMLElement>(null);
  const [settingId, setSettingId] = useState(initialSettingId);
  const sourceProfile = useMemo<CharacterProfileDraft>(() => ({ name: character.name, description: character.description }), [character.id, character.profile_sha256]);
  const sourceVisual = useMemo<CharacterVisualDraft>(() => structuredClone(character.visual), [character.id, character.visual_sha256]);
  const sourcePrompt = useMemo(() => editableCharacterPrompt(character.prompt), [character.id, character.prompt_sha256]);
  const profileState = useFactDraft(sourceProfile, character.profile_sha256);
  const { draft: profileDraft, setDraft: setProfileDraft } = profileState;
  const visualState = useFactDraft(sourceVisual, character.visual_sha256);
  const { draft: visualDraft, setDraft: setVisualDraft } = visualState;
  const promptState = useFactDraft(sourcePrompt, `${character.prompt_sha256}:${character.visual_sha256}`);
  const { draft: promptDraft, setDraft: setPromptDraft } = promptState;
  const editTarget = { ...character, profile_sha256: profileState.fingerprint, visual_sha256: visualState.fingerprint, prompt_sha256: promptState.fingerprint.split(":")[0] };
  const [savingSection, setSavingSection] = useState<"profile" | "visual" | "prompt" | null>(null);
  useEffect(() => { setSettingId(initialSettingId !== "identity" && character.visual.variants.some((variant) => variant.id === initialSettingId) ? initialSettingId : "profile"); }, [character.id, character.visual.variants, initialSettingId]);
  useEffect(() => { if (characterViewRef.current) characterViewRef.current.scrollTop = 0; }, [settingId]);
  const profileDirty = profileState.dirty;
  const visualDirty = visualState.dirty;
  const promptDirty = promptState.dirty;
  const isProfile = settingId === "profile";
  const selectedVariant = isProfile ? null : visualDraft.variants.find((variant) => variant.id === settingId) ?? null;
  const selectedSettingId = selectedVariant?.id ?? settingId;
  const [variantIdDrafts, setVariantIdDrafts] = useState<Record<string,string>>({});
  const variantIdDraft = selectedVariant ? variantIdDrafts[selectedVariant.id] ?? selectedVariant.id : '';
  function setVariantIdDraft(value: string) { if (selectedVariant) setVariantIdDrafts(current => ({...current,[selectedVariant.id]:value})); }

  const variantIdDirty = Boolean(selectedVariant) && variantIdDraft !== selectedVariant?.id;
  const dirty = profileDirty || visualDirty || promptDirty || visualDraft.variants.some(v => variantIdDrafts[v.id] !== undefined && variantIdDrafts[v.id] !== v.id);
  const variantIdValid = characterVariantIdPattern.test(variantIdDraft);
  const variantIdConflict = Boolean(selectedVariant) && visualDraft.variants.some((variant) => variant.id !== selectedVariant?.id && variant.id === variantIdDraft);
  const hasSelectedSetting = isProfile || Object.hasOwn(promptDraft.variants, selectedSettingId);
  const selectedSetting = promptDraft.variants[selectedSettingId] ?? editableCharacterSetting();
  function updateSelectedSetting(update: (setting: EditableCharacterSetting) => EditableCharacterSetting) {
    setPromptDraft((current) => ({ ...current, variants: { ...current.variants, [selectedSettingId]: update(current.variants[selectedSettingId] ?? editableCharacterSetting()) } }));
  }
  function updateIdentity(update: (identity: EditableCharacterIdentity) => EditableCharacterIdentity) {
    setPromptDraft((current) => ({ ...current, identity: update(current.identity) }));
  }
  function updateSelectedVariant(update: (variant: CharacterVisualDraft["variants"][number]) => CharacterVisualDraft["variants"][number]) {
    if (!selectedVariant) return;
    setVisualDraft((current) => ({ ...current, variants: current.variants.map((variant) => variant.id === selectedVariant.id ? update(variant) : variant) }));
  }
  async function saveProfile() {
    setSavingSection("profile");

    try {
      const result = await saveSettingProfile(kind, projectId, editTarget, profileDraft);
      profileState.accept(result.profile, result.profile_sha256);
      onSaved({ ...result.profile, profile_sha256: result.profile_sha256 });
      notify({ kind: "success", message: `${label}档案已保存` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      notify({ kind: "error", message });
    } finally { setSavingSection(null); }
  }
  async function saveVisual() {
    if (selectedVariant && variantIdDirty) {
      if (!variantIdValid || variantIdConflict) return;
      if (promptDirty) {
        const message = "角色 Prompt 有未保存修改，请先保存或复原后再修改子设定 ID";

        notify({ kind: "error", message });
        return;
      }
    }
    setSavingSection("visual");

    try {
      let visualSha = visualState.fingerprint;
      if (selectedVariant && variantIdDirty) {
        const renamed = await renameSettingVariant(kind, projectId, editTarget, selectedVariant.id, variantIdDraft);
        visualSha = renamed.visual_sha256;
        promptState.accept(editableCharacterPrompt(renamed.prompt), `${renamed.prompt_sha256}:${renamed.visual_sha256}`);
        onSaved({ visual: renamed.visual, visual_sha256: renamed.visual_sha256, prompt: renamed.prompt, model_prompts: renamed.model_prompts, prompt_sha256: renamed.prompt_sha256 });
      }
      const payload = structuredClone(visualDraft);
      if (selectedVariant && variantIdDirty) payload.variants = payload.variants.map((variant) => variant.id === selectedVariant.id ? { ...variant, id: variantIdDraft } : variant);
      const result = await saveSettingVisual(kind, projectId, { ...editTarget, visual_sha256: visualSha }, payload);
      visualState.accept(result.visual, result.visual_sha256);
      onSaved({ visual: result.visual, visual_sha256: result.visual_sha256 });
      if (selectedVariant && variantIdDirty) {
        setSettingId(variantIdDraft);
        onSettingChange?.(variantIdDraft);
      }
      notify({ kind: "success", message: isProfile ? "角色视觉说明已保存" : variantIdDirty ? "子设定 ID 与说明已保存" : "子设定已保存" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      notify({ kind: "error", message });
    } finally { setSavingSection(null); }
  }
  async function savePrompt() {
    setSavingSection("prompt");

    try {
      const document = persistedCharacterPrompt(promptDraft);
      const result = await saveSettingPrompt(kind, projectId, {...editTarget, visual_sha256: promptState.fingerprint.split(':')[1]}, document);
      const normalized = editableCharacterPrompt(result.prompt);
      promptState.accept(normalized, `${result.prompt_sha256}:${promptState.fingerprint.split(":")[1]}`);
      onSaved({ prompt: result.prompt, model_prompts: result.model_prompts, prompt_sha256: result.prompt_sha256 });
      notify({ kind: "success", message: `${label} Prompt 已保存` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      notify({ kind: "error", message });
    } finally { setSavingSection(null); }
  }
  return <section className="resource-editor current-workbench-character" data-project-fact-dirty={dirty ? "true" : undefined} ref={characterViewRef}>
    <WorkspaceHeader breadcrumb={[label, profileDraft.name]} className="character-workspace-header" title={<span className="character-title-editor">{isProfile ? <InlineTitleEditor label={`重命名${label}`} value={profileDraft.name} disabled={busy || savingSection !== null} onChange={(name) => setProfileDraft((current) => ({ ...current, name }))} /> : <><span>{profileDraft.name}</span><i>·</i>{selectedVariant && <InlineTitleEditor key={selectedVariant.id} label="重命名子设定" value={selectedVariant.name} disabled={busy || savingSection !== null} onChange={(name) => updateSelectedVariant((variant) => ({ ...variant, name }))} />}</>}</span>} />
    {(profileState.conflict || visualState.conflict || promptState.conflict) && <p role="alert">设定已被其他操作修改，当前草稿保留。<button type="button" className="button button--quiet" onClick={() => { profileState.reset(); visualState.reset(); promptState.reset(); setVariantIdDrafts({}); }}>放弃草稿并载入最新</button></p>}
    <fieldset inert={busy || savingSection !== null} disabled={busy || savingSection !== null} style={{border:0,padding:0,margin:0,minWidth:0}}><div className="character-settings-layout">
      <div className="resource-form">
        {isProfile && <>
          <div className="resource-form--wide character-summary-stack">
            <section className="character-fact-section character-summary-card"><SectionHeader title={`${label}档案`} actions={<button type="button" className="button button--quiet character-section-save" disabled={busy || savingSection !== null || !profileDirty || !profileDraft.name.trim()} onClick={() => void saveProfile()}>{savingSection === "profile" ? "保存中…" : "保存"}</button>} /><div className="character-fact-fields character-fact-fields--stacked"><label><span>{label}设定</span><textarea rows={2} value={profileDraft.description} onChange={(event) => setProfileDraft((current) => ({ ...current, description: event.target.value }))} /></label></div></section>
          </div>
          <section className="resource-form--wide character-fact-section character-generation-section">
            <SectionHeader title="基础设定" description="所有子设定共享的 Prompt" actions={<button type="button" aria-label="保存基础设定" className="button button--quiet character-section-save" disabled={busy || savingSection !== null || !promptDirty} onClick={() => void savePrompt()}>{savingSection === "prompt" ? "保存中…" : "保存"}</button>} />
            {kind === "character" && <PromptPopulationEditor fragments={promptDraft.identity.prompt.subject} disabled={busy || savingSection !== null} onChange={subject => updateIdentity(identity => ({ ...identity, prompt: { ...identity.prompt, subject } }))} />}
          <PromptFragmentEditor categories={categories.map((category) => ({ id: category, label: promptLabels[category] }))} scope="character" fragments={promptDraft.identity.prompt} createFragment={createPromptDraftFragment} onChange={(prompt) => updateIdentity((identity) => ({ ...identity, prompt }))} historyScopeKey={`${character.id}:identity:${character.prompt_sha256}`} />

          </section>
        </>}
        {!isProfile && <>
        {selectedVariant && <section className="resource-form--wide character-fact-section"><SectionHeader title="子设定" description="名称与稳定 ID" actions={<button type="button" aria-label="保存子设定" className="button button--quiet character-section-save" disabled={busy || savingSection !== null || (!visualDirty && !variantIdDirty) || !selectedVariant.name.trim() || (variantIdDirty && (!variantIdValid || variantIdConflict))} onClick={() => void saveVisual()}>{savingSection === "visual" ? "保存中…" : "保存"}</button>} /><div className="character-fact-fields"><label className="resource-form--wide"><span>子设定 ID</span><input className={variantIdDirty && (!variantIdValid || variantIdConflict) ? "is-missing mono-input" : "mono-input"} value={variantIdDraft} onChange={(event) => setVariantIdDraft(event.target.value)} />{variantIdDirty && (!variantIdValid || variantIdConflict) && <small className="character-color-hint">ID 由小写字母、数字与连字符组成，且不能与现有子设定重复。</small>}</label></div></section>}
        {!hasSelectedSetting ? <section className="resource-form--wide character-fact-section character-generation-section"><SectionHeader title="生成配置" description="尚未建立" /><div className="character-generation-empty character-generation-empty--action"><button type="button" className="button button--quiet" onClick={() => updateSelectedSetting(() => editableCharacterSetting())}>建立 Prompt</button></div></section> : <section className="resource-form--wide character-fact-section character-generation-section">
          <SectionHeader title="生成配置" description="子设定 Prompt" actions={<button type="button" aria-label="保存 Prompt" className="button button--quiet character-section-save" disabled={busy || savingSection !== null || !promptDirty} onClick={() => void savePrompt()}>{savingSection === "prompt" ? "保存中…" : "保存"}</button>} />
          <InheritedPromptEditor title="基础 Prompt" source={character.id + ':' + settingId + ':' + character.prompt_sha256} prompt={persistPromptDraft(promptDraft.identity.prompt)} adjustments={selectedSetting.identityOverrides} disabled={selectedSetting.identityDisabled} defaultOpen onChange={value => updateSelectedSetting(setting => ({ ...setting, identityDisabled: [], identityOverrides: value }))} />
          {kind === "character" && <PromptPopulationEditor fragments={selectedSetting.prompt.subject} disabled={busy || savingSection !== null} onChange={subject => updateSelectedSetting(setting => ({ ...setting, prompt: { ...setting.prompt, subject } }))} />}
          <PromptFragmentEditor categories={categories.map((category) => ({ id: category, label: promptLabels[category] }))} scope="character" fragments={selectedSetting.prompt} createFragment={createPromptDraftFragment} onChange={(prompt) => updateSelectedSetting((setting) => ({ ...setting, prompt }))} historyScopeKey={`${character.id}:${settingId}:${character.prompt_sha256}`} />

        </section>}
        </>}
      </div>
    </div>
    </fieldset>
  </section>;
}

