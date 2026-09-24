import {ReferenceLibrary,ReferenceSelection,type ReferenceEntry} from '../../ReferenceLibrary';
import {PromptTextArea} from '../../SourcePromptEditor';
import {SceneReferenceEditor} from '../../SceneReferenceEditor';
import {ReferenceRow,ReferenceLabel,ParticipantEditor} from '../../PromptReferences';
import {characterSource,sceneSource,type PagePrompt} from '../../project-workbench-client';
import type {ModelPageEditorProps} from '../types';
function selectedReferenceImages(entries: ReferenceEntry[], selection?: string[]) {
  return (selection ?? entries.slice(0, 1).map(e => e.id)).flatMap(id => entries.filter(e => e.id === id));
}

/** 引用文字框：显示生效文字（本页覆盖 ?? 当前子设定文字），编辑即成为本页 override，可一键恢复继承。 */
function ReferenceTextField({ label, currentText, override, disabled, onChange, onRestore }: {
  label: string;
  currentText: string;
  override: string | undefined;
  disabled: boolean;
  onChange: (text: string) => void;
  onRestore: () => void;
}) {
  return <div className="page-reference-text">
    <PromptTextArea ariaLabel={label} rows={2} value={override ?? currentText} disabled={disabled} onChange={onChange} />
    {override !== undefined && <div className="page-reference-override-status"><span>已覆盖</span><button type="button" className="button button--quiet" disabled={disabled} onClick={onRestore}>恢复继承</button></div>}
  </div>;
}


export function QwenPageEditor({projectId,page,prompt:promptDraft,onChange,characters,scenes:allScenes,references:allReferences,onReferencesChange,disabled,rewrite,onOpenOverview:onOpenPromptOverview}:ModelPageEditorProps) {
 const standalone=promptDraft.composition==='standalone';
 const references=standalone?[]:allReferences,scenes=standalone?[]:allScenes;
 const pageIdentity=page.page_id;
 const setPromptDraft=(update:PagePrompt|((value:PagePrompt)=>PagePrompt))=>onChange(typeof update==='function'?update(promptDraft):update);
  const selectedScene = scenes.find(scene => scene.id === promptDraft.scene_id);
  const sceneEntries = selectedScene?.prompt.variants[promptDraft.scene_variant_id ?? '']?.reference_images ?? [];
  const sceneSelection = promptDraft.reference_overrides?.[sceneSource(promptDraft.scene_id ?? '', promptDraft.scene_variant_id ?? '')] ?? sceneEntries.slice(0, 1).map(e => e.id);
  const referenceCount = (promptDraft.reference_images?.length ?? 0) + sceneSelection.length + references.reduce((count, ref) => {
    const entries = characters.find(c => c.id === ref.character_id)?.prompt.variants[ref.variant_id]?.reference_images ?? [];
    return count + (promptDraft.reference_overrides?.[characterSource(ref.character_id, ref.variant_id)] ?? entries.slice(0, 1)).length;
  }, 0);
  const enabledReferenceImages = [
    ...references.flatMap(ref => selectedReferenceImages(characters.find(c => c.id === ref.character_id)?.prompt.variants[ref.variant_id]?.reference_images ?? [], promptDraft.reference_overrides?.[characterSource(ref.character_id, ref.variant_id)])),
    ...selectedReferenceImages(sceneEntries, promptDraft.reference_overrides?.[sceneSource(promptDraft.scene_id ?? '', promptDraft.scene_variant_id ?? '')]),
    ...(promptDraft.reference_images ?? []),
  ];
  /** 切换子设定或移除引用时清理对应的整段文字与图片 override，不保留隐藏草稿。 */

  function changeScene(scene_id?: string, scene_variant_id?: string) {
    setPromptDraft(current => ({ ...current, scene_id, scene_variant_id,
      text_overrides:Object.fromEntries(Object.entries(current.text_overrides??{}).filter(([key])=>!key.startsWith('scene:'))),
      reference_overrides:Object.fromEntries(Object.entries(current.reference_overrides??{}).filter(([key])=>!key.startsWith('scene:'))),
    }));
  }
  function setTextOverride(source: string, text: string | undefined) {
    setPromptDraft(current => {
      const next = { ...(current.text_overrides ?? {}) };
      if (text === undefined) delete next[source];
      else next[source] = text;
      return { ...current, text_overrides: next };
    });
  }
  function setReferenceOverride(source: string, ids: string[] | undefined) {
    setPromptDraft(current => {
      const next = { ...(current.reference_overrides ?? {}) };
      if (ids === undefined) delete next[source];
      else next[source] = ids;
      return { ...current, reference_overrides: next };
    });
  }
 return <>      {!standalone&&<div className="page-reference-rows">
      <ReferenceRow title="角色" editor={<ParticipantEditor characters={characters} value={references} onChange={onReferencesChange} />}>
      {references.map(reference => {
        const character = characters.find(c => c.id === reference.character_id), variant = character?.prompt.variants[reference.variant_id];
        if (!character || !variant) return <div className="page-reference-setting" key={reference.character_id}><p role="alert">设定缺失：{character?.name ?? reference.character_id} · {reference.variant_id}</p><button type="button" className="button" onClick={() => onReferencesChange(references.filter(r => r.character_id !== reference.character_id))}>移除缺失引用</button></div>;
        const source = characterSource(character.id, reference.variant_id);
        const entries = variant.reference_images ?? [];
        const variantName = character.visual.variants.find(v => v.id === reference.variant_id)?.name ?? reference.variant_id;
        return <div className="page-reference-setting" key={source} data-reference-source={source}><ReferenceLabel name={character.name} variant={variantName} color={character.style?.display_color} />
          <ReferenceSelection projectId={projectId} entries={entries} selection={promptDraft.reference_overrides?.[source]} onChange={ids => setReferenceOverride(source, ids)} />
          <ReferenceTextField label={`${character.name} · ${variantName} 引用文字`} currentText={variant.text ?? ""} override={promptDraft.text_overrides?.[source]} disabled={disabled} onChange={text => setTextOverride(source, text)} onRestore={() => setTextOverride(source, undefined)} />
        </div>;
      })}
      </ReferenceRow>
      <ReferenceRow title="场景" editor={
        <SceneReferenceEditor scenes={scenes} value={promptDraft.scene_id} variantId={promptDraft.scene_variant_id} onChange={changeScene} />
      }>
        {scenes.filter(scene => scene.id === promptDraft.scene_id && scene.prompt.variants[promptDraft.scene_variant_id ?? '']).map(scene => {
          const variantId = promptDraft.scene_variant_id!, variant = scene.prompt.variants[variantId], source = sceneSource(scene.id, variantId);
          const variantName = scene.visual.variants.find(v => v.id === variantId)?.name ?? variantId;
          return <div className="page-reference-setting" key={source} data-reference-source={source}><ReferenceLabel name={scene.name} variant={variantName} /><ReferenceSelection projectId={projectId} entries={variant.reference_images ?? []} selection={promptDraft.reference_overrides?.[source]} onChange={ids => setReferenceOverride(source, ids)} />
            <ReferenceTextField label={`${scene.name} · ${variantName} 引用文字`} currentText={variant.text ?? ""} override={promptDraft.text_overrides?.[source]} disabled={disabled} onChange={text => setTextOverride(source, text)} onRestore={() => setTextOverride(source, undefined)} />
          </div>;
        })}
      </ReferenceRow></div>}
      {referenceCount > 10 && <p role="alert">本页引用了 {referenceCount} 张参考图，最多支持 10 张，请展开设定取消部分图片。</p>}
      <label className="page-prompt-field"><span>本页 Prompt</span><PromptTextArea ariaLabel="本页 Prompt" rows={3} value={promptDraft.text ?? ""} disabled={disabled} placeholder="本页画面描述，可留空" onChange={text => setPromptDraft(current => ({ ...current, text }))} /></label>
      {rewrite}

      {onOpenPromptOverview && <div className="prompt-camera-actions"><button type="button" className="button" disabled={disabled} onClick={onOpenPromptOverview}>Prompt 总览</button></div>}
      <ReferenceLibrary key={pageIdentity} projectId={projectId} target={{ kind: 'page', id: page.page_id }} pages={[]} inheritedEntries={enabledReferenceImages.slice(0, enabledReferenceImages.length - (promptDraft.reference_images?.length ?? 0))} initialEntries={promptDraft.reference_images ?? []} capacity={10 - referenceCount} disabled={disabled} onChanged={() => {}} onDraftChange={entries => setPromptDraft(current => ({ ...current, reference_images: entries }))} /></>;
}
