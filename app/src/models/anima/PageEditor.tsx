import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import {LoraListEditor} from '../LoraListEditor';
import {useEffect,useRef,useState} from 'react';
import {PromptFragmentEditor} from '../../PromptFragmentEditor';
import {PromptPopulationEditor} from '../../PromptPopulationEditor';
import {InheritedPromptEditor} from '../../InheritedPromptEditor';
import {CameraControlDialog} from '../../CameraControlDialog';
import {SceneReferenceEditor} from '../../SceneReferenceEditor';
import {ReferenceRow,ReferenceLabel,ParticipantEditor} from '../../PromptReferences';
import {displayPromptDraft,persistPromptDraft,createPromptDraftFragment,matchesLocalPromptDraft} from '../../prompt-fragment-draft';
import {applyCameraDraft} from '../../camera-prompt-draft';
import {cameraFragmentIndex} from '../../../shared/camera-prompt.mjs';
import {variantPrompt,applyInheritedPrompt} from '../../../shared/prompt-inheritance.mjs';
import {characterSource,sceneSource} from '../../project-workbench-client';
import {promptCategories,type PagePrompt,type CharacterPromptDocument} from './types';
import type {ModelPageEditorProps} from '../types';

const labels={population:'画面人数',person:'人物',setting:'场景',camera:'镜头',avoid:'避免'};
// 沿用 64db906 的编辑器和引用行。仅把宿主草稿转换与模型编辑区域收进适配器。
export function AnimaPageEditor({projectId,page,prompt,onChange,characters,scenes,references,onReferencesChange,disabled,onOpenOverview,header}:ModelPageEditorProps) {
  const native={population:[],person:[],setting:[],camera:[],avoid:[],...prompt} as PagePrompt;
  const [draft,setDraft]=useState(()=>displayPromptDraft(native));
  const [cameraOpen,setCameraOpen]=useState(false);
  const emitted=useRef(JSON.stringify(prompt));
  useEffect(()=>{const incoming=JSON.stringify(prompt);if(incoming!==emitted.current){if(!matchesLocalPromptDraft(draft,native))setDraft(displayPromptDraft(native));emitted.current=incoming;}},[prompt]);
  function changeDraft(next:ReturnType<typeof displayPromptDraft>){setDraft(next);const value={...prompt,...persistPromptDraft(next)};emitted.current=JSON.stringify(value);onChange(value);}
  const roles=references.flatMap(ref=>{const c=characters.find(c=>c.id===ref.character_id);return c?[{id:c.id,label:c.name,color:c.style?.display_color}]:[];});
  const setting=(c:typeof characters[number])=>c.model_prompts?.models?.anima??(c.model_id==='anima'?c.prompt as unknown as CharacterPromptDocument:undefined);
  const enabledCounts=Object.fromEntries(references.flatMap(ref=>{
    const c=characters.find(c=>c.id===ref.character_id),input=c&&setting(c),variant=input?.variants[ref.variant_id];
    if(!input||!variant)return [];
    const fragments=Object.values(applyInheritedPrompt(variantPrompt(input.identity,variant),prompt.inheritance?.[characterSource(ref.character_id,ref.variant_id)])).flat();
    return [[ref.character_id,{enabled:fragments.filter(fragment=>fragment.enabled!==false).length,total:fragments.length}]];
  }));
  function inherited(source:string,value:PagePrompt,sha:string) {return <InheritedPromptEditor title="继承词" collapsible={false} source={`${source}:${sha}`} prompt={value} adjustments={prompt.inheritance?.[source]} onChange={adjustments=>onChange({...prompt,inheritance:{...prompt.inheritance,[source]:adjustments}})}/>;}
  function inheritedLoras(input:CharacterPromptDocument,variant:CharacterPromptDocument['variants'][string]) {
    const inherited=settingLoras(input.identity,variant);if(!inherited.length)return null;
    const names=new Set(inherited.map(lora=>lora.filename)),local=prompt.loras??[];
    return <LoraListEditor projectId={projectId} profileId={page.render?.profile_id} title="继承 LoRA" inherited={inherited} value={local.filter(lora=>names.has(lora.filename))} overrides={prompt.lora_overrides} allowAdd={false} collapsed disabled={disabled} onChange={(value,lora_overrides)=>onChange({...prompt,loras:[...local.filter(lora=>!names.has(lora.filename)),...value],lora_overrides})}/>;
  }
  return <>
    <div className="prompt-heading-row">{header??<h3>Prompt</h3>}<PromptPopulationEditor fragments={draft.population??[]} disabled={disabled} onChange={population=>changeDraft({...draft,population})}/></div>
    <div className="page-reference-rows">
      <ReferenceRow title="角色" editor={<ParticipantEditor characters={characters} value={references} onChange={onReferencesChange} enabledCounts={enabledCounts}/>}>
        {references.map(ref=>{const c=characters.find(c=>c.id===ref.character_id),input=c&&setting(c),variant=input?.variants[ref.variant_id];
          if(!c||!input||!variant)return <p role="alert" key={ref.character_id}>设定缺失：{c?.name??ref.character_id} · {ref.variant_id}</p>;
          const source=characterSource(c.id,ref.variant_id);
          return <div className="page-reference-setting" key={source} data-reference-source={source}><ReferenceLabel name={c.name} variant={c.visual.variants.find(v=>v.id===ref.variant_id)?.name??ref.variant_id} color={c.style?.display_color}/>{inherited(source,variantPrompt(input.identity,variant) as PagePrompt,c.prompt_sha256)}{inheritedLoras(input,variant)}</div>;
        })}
      </ReferenceRow>
      <ReferenceRow title="场景" editor={<SceneReferenceEditor enabledCount={(()=>{const c=scenes.find(c=>c.id===prompt.scene_id),input=c&&setting(c),variant=input?.variants[prompt.scene_variant_id??''];if(!input||!variant)return undefined;const fragments=Object.values(applyInheritedPrompt(variantPrompt(input.identity,variant),prompt.inheritance?.[sceneSource(c!.id,prompt.scene_variant_id!)])).flat();return {enabled:fragments.filter(f=>f.enabled!==false).length,total:fragments.length};})()} scenes={scenes} value={prompt.scene_id} variantId={prompt.scene_variant_id} onChange={(scene_id,scene_variant_id)=>onChange({...prompt,scene_id,scene_variant_id,inheritance:Object.fromEntries(Object.entries(prompt.inheritance??{}).filter(([key])=>!key.startsWith('scene:')))})}/> }>
        {scenes.filter(c=>c.id===prompt.scene_id).map(c=>{const input=setting(c),variant=input?.variants[prompt.scene_variant_id??''];if(!input||!variant)return <p role="alert" key={c.id}>场景设定缺失</p>;const source=sceneSource(c.id,prompt.scene_variant_id!);return <div className="page-reference-setting" key={source} data-reference-source={source}><ReferenceLabel name={c.name} variant={c.visual.variants.find(v=>v.id===prompt.scene_variant_id)?.name}/>{inherited(source,variantPrompt(input.identity,variant) as PagePrompt,c.prompt_sha256)}{inheritedLoras(input,variant)}</div>;})}
      </ReferenceRow>
    </div>
    <PromptFragmentEditor categories={promptCategories.filter(c=>c!=='population').map(id=>({id,label:labels[id]}))} scope="page" fragments={draft} roles={roles} createFragment={createPromptDraftFragment} onChange={next=>changeDraft({...next,population:draft.population})} historyScopeKey={`${page.page_id}:${page.prompt_sha256}`}/>
    <div className="prompt-camera-actions"><button type="button" className="button" disabled={disabled} onClick={()=>setCameraOpen(true)}>机位控制</button>{onOpenOverview&&<button type="button" className="button" disabled={disabled} onClick={onOpenOverview}>Prompt 总览</button>}</div>
    {cameraOpen&&<CameraControlDialog cameraSettings={draft.camera[cameraFragmentIndex(draft.camera)]?.camera_settings} onClose={()=>setCameraOpen(false)} onApply={settings=>{changeDraft(applyCameraDraft(draft,settings,createPromptDraftFragment));setCameraOpen(false);}}/>}
  </>;
}
