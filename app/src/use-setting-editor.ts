import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedFactDrafts } from './use-scoped-fact-drafts';
import { useSaveShortcut } from './use-save-shortcut';
import { useFeedback } from './feedback';
import { ProjectRefreshRequiredError } from './api-response';
import { loadWorkbenchSetting, saveSettingScope, type CharacterProfileDraft, type EditableWorkbenchCharacter, type PromptModelId, type SettingKind } from './project-workbench-client';

type Metadata = {name:string; description?:string; id?:string};
type Props<D> = {kind?:SettingKind; projectId:string; character:EditableWorkbenchCharacter<D>; initialSettingId:string; busy:boolean;
  onSaved:(value:Partial<EditableWorkbenchCharacter<D>>) => void; onSettingChange?:(id:string)=>void; onDirtyChange?:(dirty:boolean)=>void};

export function useSettingEditor<P extends object, D extends object>(props: Props<D>, modelId: PromptModelId,
  sourceScopes: Record<string,P>, persist: (value:P, base:boolean)=>object, normalize: (document:D)=>Record<string,P>, validateScope:(value:P|undefined,base:boolean)=>boolean=()=>true) {
  const {kind='character',projectId,character,busy,onSaved,onSettingChange,onDirtyChange} = props;
  const {notify} = useFeedback();
  const identity = `${projectId}:${kind}:${character.id}:${modelId}`;
  const alive = useRef(true), currentIdentity = useRef(identity), inFlight = useRef(false);
  currentIdentity.current = identity;
  useEffect(() => {alive.current=true; return () => {alive.current=false;};},[]);
  const [settingId,setSettingId] = useState(props.initialSettingId);
  useEffect(() => {setSettingId(character.visual.variants.some(v=>v.id===props.initialSettingId) ? props.initialSettingId : 'profile');},[props.initialSettingId,character.visual]);
  const selection = useRef(settingId); selection.current=settingId;
  const isProfile = settingId === 'profile' || settingId === 'identity';
  const scopeKey = isProfile ? 'base' : `variant:${settingId}`;
  const [saving,setSaving] = useState(false);
  const [notice,setNotice] = useState('');
  function discarded() {setNotice('内容已更新，过时的修改已丢弃，请在最新内容上重新编辑。');}
  const sourceMetadata = useMemo<Record<string,Metadata>>(() => ({base:{name:character.name,description:character.description},
    ...Object.fromEntries(character.visual.variants.map(v=>[`variant:${v.id}`,{id:v.id,name:v.name}]))}),[character.profile_sha256,character.visual_sha256]);
  const metadata = useScopedFactDrafts(sourceMetadata,Object.fromEntries(Object.entries(sourceMetadata).map(([key,value])=>[key,JSON.stringify(value)])),
    {discardConflicts:true,independentFields:['id','name','description'],onDiscard:discarded});
  const versions = character.prompt_scope_versions?.[modelId];
  const promptState = useScopedFactDrafts(sourceScopes,{base:versions?.base ?? '',...Object.fromEntries(Object.entries(versions?.variants ?? {}).map(([id,fp])=>[`variant:${id}`,fp]))},
    {discardConflicts:true,onDiscard:discarded});
  const selectedScope = promptState.scopes[scopeKey], selectedMeta = metadata.scopes[scopeKey];
  const selectedVariant = !isProfile && selectedMeta ? {...selectedMeta.draft,id:settingId} as {id:string;name:string} : null;
  const variantIdDraft = selectedMeta?.draft.id ?? settingId;
  const variantIdDirty = !isProfile && variantIdDraft !== settingId;
  const variantIdValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(variantIdDraft) && (kind !== 'character' || variantIdDraft !== 'main');
  const variantIdConflict = character.visual.variants.some(v=>v.id!==settingId && v.id===variantIdDraft);
  const dirty = metadata.dirty || promptState.dirty;
  const currentDirty = Boolean(selectedMeta?.dirty || selectedScope?.dirty);
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  const valid = Boolean(selectedMeta?.draft.name.trim()) && (isProfile || (variantIdValid && !variantIdConflict))
    && validateScope(selectedScope?.draft,isProfile);
  const profileDraft = metadata.scopes.base.draft as CharacterProfileDraft;
  function setProfileDraft(update: (draft:CharacterProfileDraft)=>CharacterProfileDraft) {metadata.setDraft('base',current=>update(current as CharacterProfileDraft));}
  function updateSelectedVariant(update:(variant:{id:string;name:string})=>{id:string;name:string}) {
    metadata.setDraft(scopeKey,current=>update(current as {id:string;name:string}));
  }
  function accept(saved:EditableWorkbenchCharacter<D>, savedId:string, oldKey:string) {
    const key = savedId === 'profile' ? 'base' : `variant:${savedId}`;
    const value:Metadata = key === 'base' ? {name:saved.name,description:saved.description} : saved.visual.variants.find(v=>v.id===savedId)!;
    metadata.accept(key,value,JSON.stringify(value));
    const scopes = normalize(saved.prompt), fps=saved.prompt_scope_versions?.[modelId];
    promptState.accept(key,scopes[key],key==='base' ? fps?.base ?? '' : fps?.variants[savedId] ?? '');
    // 已提交的改名只替换自身范围，不接纳或清除其他范围的草稿。
    if (oldKey !== key) {
      metadata.remove(oldKey);
      promptState.remove(oldKey);
    }
  }
  async function saveCurrent() {
    if (busy || inFlight.current || !currentDirty || !valid) return;
    inFlight.current=true; setSaving(true); setNotice('');
    const capturedId=settingId, capturedKey=scopeKey;
    try {
      const result = await saveSettingScope<D>(projectId,{kind,id:character.id,model_id:modelId,scope:isProfile?'base':'variant',...(isProfile?{}:{variant_id:settingId})},{
        ...(selectedMeta?.dirty ? isProfile ? {profile:{baseline:selectedMeta.baseline as CharacterProfileDraft,value:profileDraft}}
          : {variant:{baseline:selectedMeta.baseline as {id:string;name:string},value:selectedMeta.draft as {id:string;name:string}}} : {}),
        ...(selectedScope?.dirty ? {prompt:persist(selectedScope.draft,isProfile),expected_prompt_sha256:selectedScope.fingerprint} : {}),
      });
      if (!alive.current || currentIdentity.current!==identity) return;
      accept(result.setting,result.setting_id,capturedKey);
      onSaved(result.setting);
      if (selection.current===capturedId && result.setting_id!==capturedId) {setSettingId(result.setting_id);onSettingChange?.(result.setting_id);}
      notify({kind:'success',message:'当前设定已保存'});
    } catch (error) {
      if (!alive.current || currentIdentity.current!==identity) return;
      if (error instanceof ProjectRefreshRequiredError) {
        setNotice(error.saved ? '修改已保存，正在载入最新内容…' : '内容已更新，正在载入最新内容…');
        try {
          const latest = await loadWorkbenchSetting(projectId,kind,character.id);
          if (!alive.current || currentIdentity.current!==identity) return;
          // 当前未成功提交的范围整体作废，其他子设定仍由各自读据判断。
          const replacement = {...character,...latest,prompt:(latest.model_prompts?.models?.[modelId] ?? latest.prompt) as D};
          if (capturedKey === 'base' || replacement.visual.variants.some(v=>v.id===capturedId)) accept(replacement,capturedKey==='base'?'profile':capturedId,capturedKey);
          else {metadata.remove(capturedKey);promptState.remove(capturedKey);}
          onSaved(replacement);
          if (error.saved) setNotice('修改已保存，已载入最新内容。'); else discarded();
        } catch {setNotice(error.saved ? '修改已保存，但最新内容暂时读取失败；请刷新后继续。' : '本次未保存，最新内容暂时读取失败；请刷新后重新编辑。');}
      } else notify({kind:'error',message:error instanceof Error ? error.message : String(error)});
    } finally {inFlight.current=false;if(alive.current && currentIdentity.current===identity)setSaving(false);}
  }
  useSaveShortcut(()=>void saveCurrent(),`${identity}:${settingId}`);
  return {settingId,isProfile,scopeKey,selectedScope,selectedVariant,variantIdDraft,variantIdDirty,variantIdValid,variantIdConflict,
    profileDraft,setProfileDraft,updateSelectedVariant,setVariantIdDraft:(id:string)=>metadata.setDraft(scopeKey,current=>({...current,id})),
    promptState,dirty,currentDirty,saving,notice,valid,saveCurrent};
}
