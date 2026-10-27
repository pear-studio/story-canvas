import {useState} from 'react';
import {SceneReferenceEditor} from '../../SceneReferenceEditor';
import {ReferenceRow,ReferenceLabel,ParticipantEditor} from '../../PromptReferences';
import {characterSource,sceneSource} from '../../project-workbench-client';
import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import {cleanPageCharacterInput} from '../../../shared/page-character-cleanup.mjs';
import {emptyMossPrompt,mossPageCategories,mossLabels,mossText,type MossEntry} from '../../../shared/moss-prompt.mjs';
import {LoraListEditor} from '../LoraListEditor';
import type {ModelPageEditorProps} from '../types';
import {MossCategoriesEditor,MossEntriesEditor} from './EntriesEditor';
import {MossProjectDescriptions} from './ProjectDescriptions';
import {MossLayoutModal} from './LayoutModal';
import type {PagePromptDraft,CharacterPromptDocument,CharacterPromptVariant} from './types';

export function MossPageEditor({projectId,page,prompt,onChange,characters,scenes,references,onReferencesChange,disabled,header}:ModelPageEditorProps<PagePromptDraft,CharacterPromptDocument>) {
  const native={...emptyMossPrompt(),...prompt};
  const [layoutOpen,setLayoutOpen]=useState(false);
  const roles=references.flatMap(ref=>{const character=characters.find(c=>c.id===ref.character_id);return character?[{id:character.id,label:character.name,color:character.style?.display_color}]:[];});
  const values=Object.fromEntries(mossPageCategories.map(category=>[category,native[category]]));
  const sourceEntries=(source:string,variant:CharacterPromptVariant)=>native.entry_overrides?.[source]??variant.entries;
  function setSource(source:string,entries?:MossEntry[]){const entry_overrides={...native.entry_overrides};if(entries===undefined)delete entry_overrides[source];else entry_overrides[source]=entries;onChange({...native,entry_overrides});}
  function inheritedLoras(input:CharacterPromptDocument,variant:CharacterPromptVariant){const inherited=settingLoras(input.identity,variant);if(!inherited.length)return null;const names=new Set(inherited.map(lora=>lora.filename)),local=native.loras??[];return <LoraListEditor projectId={projectId} profileId={page.render?.profile_id??'moss-image'} title="继承 LoRA" inherited={inherited} value={local.filter(lora=>names.has(lora.filename))} overrides={native.lora_overrides} allowAdd={false} collapsed disabled={disabled} onChange={(value,lora_overrides)=>onChange({...native,loras:[...local.filter(lora=>!names.has(lora.filename)),...value],lora_overrides})}/>;}
  function inheritedEntries(source:string,variant:CharacterPromptVariant){return <><MossEntriesEditor label="描述" value={sourceEntries(source,variant)} scopeKey={`${page.page_id}:${page.prompt_sha256}:${source}`} disabled={disabled} onChange={entries=>setSource(source,entries)}/>{native.entry_overrides?.[source]!==undefined&&<div className="moss-reference-actions"><span>本页已覆盖</span><button type="button" className="button button--quiet" disabled={disabled} onClick={()=>setSource(source)}>恢复继承</button></div>}</>;}
  function settingSources(sceneId?:string,variantId?:string){
    const selected=[...references.map(ref=>({source:characterSource(ref.character_id,ref.variant_id),input:characters.find(character=>character.id===ref.character_id)?.prompt,variantId:ref.variant_id})),...(sceneId&&variantId?[{source:sceneSource(sceneId,variantId),input:scenes.find(scene=>scene.id===sceneId)?.prompt,variantId}]:[])];
    return Object.fromEntries(selected.map(({source,input,variantId})=>[source,{identity:input?.identity,variant:input?.variants[variantId],...(!input?.variants[variantId]?{missing:source}:{})}]));
  }
  function changeScene(scene_id?:string,scene_variant_id?:string){
    const next={...native,scene_id,scene_variant_id,entry_overrides:Object.fromEntries(Object.entries(native.entry_overrides??{}).filter(([key])=>!key.startsWith('scene:')))};
    onChange(cleanPageCharacterInput(next,references,references,{beforeSources:settingSources(native.scene_id,native.scene_variant_id),afterSources:settingSources(scene_id,scene_variant_id),styleLoras:page.project_loras}));
  }
  const layoutCharacters=references.flatMap(ref=>{const character=characters.find(c=>c.id===ref.character_id),variant=character?.prompt?.variants[ref.variant_id];if(!character||!variant)return [];return [{id:character.id,name:character.name,color:character.style?.display_color,description:mossText([...sourceEntries(characterSource(character.id,ref.variant_id),variant),...native.person.filter(entry=>entry.character_id===character.id)])}];});
  const enabledCounts=Object.fromEntries(references.flatMap(ref=>{const character=characters.find(c=>c.id===ref.character_id),variant=character?.prompt?.variants[ref.variant_id];if(!character||!variant)return [];const entries=sourceEntries(characterSource(character.id,ref.variant_id),variant);return [[character.id,{enabled:entries.filter(entry=>entry.enabled!==false).length,total:entries.length}]];}));
  return <fieldset className="moss-entry-fieldset" disabled={disabled} inert={disabled}>
    {header&&<div className="prompt-heading-row">{header}</div>}
    <div className="page-reference-rows"><ReferenceRow title="角色" editor={<ParticipantEditor characters={characters} value={references} onChange={onReferencesChange} enabledCounts={enabledCounts}/>}>{references.map(ref=>{
      const character=characters.find(c=>c.id===ref.character_id),input=character?.prompt,variant=input?.variants[ref.variant_id];
      if(!character||!input||!variant)return <div className="page-reference-setting" key={ref.character_id}><p role="alert">设定缺失：{character?.name??ref.character_id} · {ref.variant_id}</p><button type="button" className="button" disabled={disabled} onClick={()=>onReferencesChange(references.filter(item=>item.character_id!==ref.character_id))}>移除缺失引用</button></div>;
      const source=characterSource(character.id,ref.variant_id);
      return <div className="page-reference-setting" key={source} data-reference-source={source}><ReferenceLabel name={character.name} variant={character.visual.variants.find(v=>v.id===ref.variant_id)?.name??ref.variant_id} color={character.style?.display_color}/>{inheritedEntries(source,variant)}{inheritedLoras(input,variant)}</div>;
    })}</ReferenceRow>
    <ReferenceRow title="场景" editor={<SceneReferenceEditor scenes={scenes} value={native.scene_id} variantId={native.scene_variant_id} onChange={changeScene}/>}>
      {scenes.filter(scene=>scene.id===native.scene_id).map(scene=>{const input=scene.prompt,variant=input?.variants[native.scene_variant_id??''];if(!input||!variant)return <p role="alert" key={scene.id}>场景设定缺失：{scene.name}</p>;const source=sceneSource(scene.id,native.scene_variant_id!);return <div className="page-reference-setting" key={source} data-reference-source={source}><ReferenceLabel name={scene.name} variant={scene.visual.variants.find(v=>v.id===native.scene_variant_id)?.name??native.scene_variant_id}/>{inheritedEntries(source,variant)}{inheritedLoras(input,variant)}</div>;})}
    </ReferenceRow></div>
    <MossCategoriesEditor categories={mossPageCategories.map(id=>({id,label:mossLabels[id]}))} value={values} roles={roles} scopeKey={`${page.page_id}:${page.prompt_sha256}`} disabled={disabled} onChange={next=>onChange({...native,...next})}/>
    <MossProjectDescriptions prompt={native} projectPrompt={page.model_project_prompt} scopeKey={page.page_id} disabled={disabled} onChange={onChange}/>
    <button type="button" className="prompt-camera-row" aria-label="编辑 Layout" aria-haspopup="dialog" disabled={disabled||!page.generation_dimensions} title={page.generation_dimensions?'编辑画面布局':'请先配置可用的生成尺寸'} onClick={()=>setLayoutOpen(true)}><span className="prompt-camera-label">Layout</span><span className="prompt-camera-summary" aria-label="当前布局">{native.layout?.items.length?<span className="prompt-camera-chip">{native.layout.enabled?'':'未启用 · '}{native.layout.items.length} 项</span>:<span className="prompt-camera-empty">未设置</span>}</span><span className="prompt-camera-edit">调整 <span aria-hidden="true">›</span></span></button>
    {layoutOpen&&page.generation_dimensions&&<MossLayoutModal value={native.layout} characters={layoutCharacters} dimensions={page.generation_dimensions} onClose={()=>setLayoutOpen(false)} onApply={layout=>{onChange({...native,layout});setLayoutOpen(false);}}/>}
  </fieldset>;
}
