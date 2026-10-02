import { ReferenceLibrary } from "../../ReferenceLibrary";
import { useFactDraft } from '../../use-fact-draft';
import { useScopedFactDrafts } from '../../use-scoped-fact-drafts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PromptTextArea } from '../../SourcePromptEditor';
import { InlineTitleEditor, SectionHeader, WorkspaceHeader } from '../../WorkspaceHeader';
import { useFeedback } from '../../feedback';
import { saveSettingProfile, saveSettingVisual, saveSettingPromptScope, renameSettingVariant, type CharacterPromptVariant, type CharacterProfileDraft, type CharacterVisualDraft } from '../../project-workbench-client';
const characterVariantIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type PromptScope = { prompt_name: string } | CharacterPromptVariant;

export function QwenSettingView({ kind = 'character', projectId, character, initialSettingId, busy, onSaved, onSettingChange, onDirtyChange }: import('../types').ModelSettingEditorProps) {
  const { notify } = useFeedback();
  const label = kind === 'scene' ? '场景' : '角色';
  const characterViewRef = useRef<HTMLElement>(null);
  const [settingId, setSettingId] = useState(initialSettingId);
  const sourceProfile = useMemo<CharacterProfileDraft>(() => ({ name: character.name, description: character.description }), [character.id, character.profile_sha256]);
  const sourceVisual = useMemo<CharacterVisualDraft>(() => structuredClone(character.visual), [character.id, character.visual_sha256]);
  const sourcePrompt = useMemo<Record<string, PromptScope>>(() => ({
    base: { prompt_name: character.prompt.prompt_name },
    ...Object.fromEntries(Object.entries(character.prompt.variants).map(([id, variant]) => [`variant:${id}`, structuredClone(variant)])),
  }), [character.id, character.prompt_sha256]);
  const scopeVersions = character.prompt_scope_versions?.qwen;
  const promptFingerprints = {
    base: scopeVersions?.base ?? '',
    ...Object.fromEntries(Object.entries(scopeVersions?.variants ?? {}).map(([id, version]) => [`variant:${id}`, version])),
  };
  const profileState = useFactDraft(sourceProfile, character.profile_sha256);
  const { draft: profileDraft, setDraft: setProfileDraft } = profileState;
  const visualState = useFactDraft(sourceVisual, character.visual_sha256);
  const { draft: visualDraft, setDraft: setVisualDraft } = visualState;
  const promptState = useScopedFactDrafts(sourcePrompt, promptFingerprints);
  const editTarget = { ...character, profile_sha256: profileState.fingerprint, visual_sha256: visualState.fingerprint };
  const [savingSection, setSavingSection] = useState<"profile" | "visual" | "prompt" | null>(null);
  useEffect(() => { setSettingId(initialSettingId !== "identity" && character.visual.variants.some((variant) => variant.id === initialSettingId) ? initialSettingId : "profile"); }, [character.id, character.visual.variants, initialSettingId]);
  useEffect(() => { if (characterViewRef.current) characterViewRef.current.scrollTop = 0; }, [settingId]);
  const profileDirty = profileState.dirty;
  const visualDirty = visualState.dirty;
  const promptDirty = promptState.dirty;
  const isProfile = settingId === "profile";
  const selectedVariant = isProfile ? null : visualDraft.variants.find((variant) => variant.id === settingId) ?? null;
  const selectedSettingId = selectedVariant?.id ?? settingId;
  const selectedScopeKey = isProfile ? 'base' : `variant:${selectedSettingId}`;
  const selectedScope = promptState.scopes[selectedScopeKey];
  const basePrompt = promptState.scopes.base?.draft as { prompt_name: string };
  const [variantIdDrafts, setVariantIdDrafts] = useState<Record<string,string>>({});
  const variantIdDraft = selectedVariant ? variantIdDrafts[selectedVariant.id] ?? selectedVariant.id : '';
  function setVariantIdDraft(value: string) { if (selectedVariant) setVariantIdDrafts(current => ({...current,[selectedVariant.id]:value})); }

  const variantIdDirty = Boolean(selectedVariant) && variantIdDraft !== selectedVariant?.id;
  const dirty = profileDirty || visualDirty || promptDirty || visualDraft.variants.some(v => variantIdDrafts[v.id] !== undefined && variantIdDrafts[v.id] !== v.id);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const variantIdValid = characterVariantIdPattern.test(variantIdDraft);
  const variantIdConflict = Boolean(selectedVariant) && visualDraft.variants.some((variant) => variant.id !== selectedVariant?.id && variant.id === variantIdDraft);
  const hasSelectedSetting = isProfile || Boolean(selectedScope);
  const selectedSetting = (selectedScope?.draft as CharacterPromptVariant | undefined) ?? { text: "" };
  function updateSelectedSetting(update: (setting: CharacterPromptVariant) => CharacterPromptVariant) {
    promptState.setDraft(selectedScopeKey, (current) => update((current as CharacterPromptVariant | undefined) ?? { text: "" }));
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
        const message = "Prompt 有未保存修改，请先保存或复原后再修改子设定 ID";

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
    if (!selectedScope?.fingerprint) return;
    setSavingSection("prompt");

    try {
      const result = await saveSettingPromptScope(kind, projectId, character, {
        model_id: 'qwen', scope: isProfile ? 'base' : 'variant', ...(!isProfile ? { variant_id: selectedSettingId } : {}),
      }, selectedScope.draft, selectedScope.fingerprint);
      promptState.accept(selectedScopeKey, result.document, result.save.args.expected_sha256);
      onSaved({});
      notify({ kind: "success", message: `${label} Prompt 已保存` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      notify({ kind: "error", message });
    } finally { setSavingSection(null); }
  }
  const promptSaveButton = <button type="button" aria-label="保存 Prompt" className="button button--quiet character-section-save" disabled={busy || savingSection !== null || !selectedScope?.dirty || !selectedScope.fingerprint || (isProfile && !basePrompt.prompt_name.trim())} onClick={() => void savePrompt()}>{savingSection === "prompt" ? "保存中…" : "保存"}</button>;
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
            <SectionHeader title="Prompt 名称" description="生成时引用此设定的名称，所有子设定共用；创建时复制显示名称，之后独立修改" actions={promptSaveButton} />
            <div className="character-fact-fields"><label className="resource-form--wide"><span>Prompt 名称</span><input value={basePrompt.prompt_name} disabled={busy || savingSection !== null} onChange={(event) => promptState.setDraft('base', { prompt_name: event.target.value })} />{!basePrompt.prompt_name.trim() && <small className="character-color-hint">Prompt 名称不能为空。</small>}</label></div>
          </section>
        </>}
        {!isProfile && <>
        {selectedVariant && <section className="resource-form--wide character-fact-section"><SectionHeader title="子设定" description="名称与稳定 ID" actions={<button type="button" aria-label="保存子设定" className="button button--quiet character-section-save" disabled={busy || savingSection !== null || (!visualDirty && !variantIdDirty) || !selectedVariant.name.trim() || (variantIdDirty && (!variantIdValid || variantIdConflict))} onClick={() => void saveVisual()}>{savingSection === "visual" ? "保存中…" : "保存"}</button>} /><div className="character-fact-fields"><label className="resource-form--wide"><span>子设定 ID</span><input className={variantIdDirty && (!variantIdValid || variantIdConflict) ? "is-missing mono-input" : "mono-input"} value={variantIdDraft} onChange={(event) => setVariantIdDraft(event.target.value)} />{variantIdDirty && (!variantIdValid || variantIdConflict) && <small className="character-color-hint">ID 由小写字母、数字与连字符组成，且不能与现有子设定重复。</small>}</label></div></section>}
        {!hasSelectedSetting ? <section className="resource-form--wide character-fact-section character-generation-section"><SectionHeader title="生成配置" description="尚未建立" /><div className="character-generation-empty character-generation-empty--action"><button type="button" className="button button--quiet" onClick={() => updateSelectedSetting(() => ({ text: "" }))}>建立 Prompt</button></div></section> : <section className="resource-form--wide character-fact-section character-generation-section">
          <SectionHeader title="生成配置" description="子设定完整 Prompt 与参考图" actions={promptSaveButton} />
          <ReferenceLibrary sourceVersion={JSON.stringify(character.prompt.variants[settingId]?.reference_images ?? [])} key={`${projectId}:${character.id}:${settingId}`} projectId={projectId} target={{ kind, id: character.id, variant_id: settingId, model_id: 'qwen' }} pages={character.pages.filter(p => p.variant_id === settingId)} disabled={busy || selectedScope?.dirty || savingSection !== null} onChanged={() => onSaved({})} />
          <label className="variant-prompt-field"><span>子设定 Prompt</span><PromptTextArea ariaLabel={`${selectedVariant?.name ?? selectedSettingId} 子设定 Prompt`} rows={4} value={selectedSetting.text} disabled={busy || savingSection !== null} placeholder="此子设定的完整文字描述" onChange={(text) => updateSelectedSetting((setting) => ({ ...setting, text }))} /></label>

        </section>}
        </>}
      </div>
    </div>
    </fieldset>
  </section>;
}
