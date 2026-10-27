import {useState} from 'react';
import {emptyMossPrompt,mossPageCategories,mossLabels,mossProjectFields,mossProjectLabels,mossText,type MossEntry} from '../../../shared/moss-prompt.mjs';
import {MossCategoriesEditor,MossEntriesEditor} from './EntriesEditor';
import {MossLayoutModal} from './LayoutModal';
import type {PagePromptDraft,MossProjectPrompt} from './types';

type FrozenSetting={id:string;configuration_id:string;prompt_name:string;entries:MossEntry[]};
export type MossComparisonInput={
  version:1;model_id:'moss';prompt:Omit<PagePromptDraft,'loras'|'lora_overrides'>;
  characters:FrozenSetting[];scenes:FrozenSetting[];participant_ids:string[];
  trigger_sources:Array<{lora_sha256:string;kind:'style'|'character'|'scene'|'page';owner:string;words:string[]}>;
};

/** 只编辑实验持有的原生快照；不调用项目设定或页面写入接口。 */
export function MossComparisonEditor({value,onChange,projectPrompt,dimensions,inputId,disabled}:{
  value:MossComparisonInput;onChange:(value:MossComparisonInput)=>void;projectPrompt?:Partial<MossProjectPrompt>;
  dimensions:{width:number;height:number}|null;inputId:string;disabled:boolean;
}) {
  const [layoutOpen,setLayoutOpen]=useState(false);
  const prompt={...emptyMossPrompt(),...value.prompt};
  const roles=value.characters.filter(character=>value.participant_ids.includes(character.id)).map(character=>({id:character.id,label:character.prompt_name}));
  const sourceKey=(kind:'character'|'scene',setting:FrozenSetting)=>`${kind}:${setting.id}:${setting.configuration_id}`;
  const effectiveEntries=(kind:'character'|'scene',setting:FrozenSetting)=>prompt.entry_overrides?.[sourceKey(kind,setting)]??setting.entries;
  function changeSetting(kind:'character'|'scene',index:number,changes:Partial<FrozenSetting>) {
    const field=kind==='character'?'characters':'scenes',original=value[field][index];
    const entry_overrides={...prompt.entry_overrides};
    if(changes.entries)delete entry_overrides[sourceKey(kind,original)];
    onChange({...value,prompt:{...value.prompt,entry_overrides},[field]:value[field].map((setting,i)=>i===index?{...setting,...changes}:setting)});
  }
  function addCharacter() {
    const id=`local-${crypto.randomUUID()}`;
    onChange({...value,characters:[...value.characters,{id,configuration_id:'default',prompt_name:`人物 ${value.characters.length+1}`,entries:[]}],participant_ids:[...value.participant_ids,id]});
  }
  const layoutCharacters=value.characters.filter(character=>value.participant_ids.includes(character.id)).map(character=>({id:character.id,name:character.prompt_name,description:mossText([...effectiveEntries('character',character),...prompt.person.filter(entry=>entry.character_id===character.id)])}));
  return <div className="comparison-moss-editor">
    <p className="field-hint">编辑本实验的描述与布局，不会修改来源页面或项目设定。</p>
    <MossCategoriesEditor categories={mossPageCategories.map(id=>({id,label:mossLabels[id]}))} value={Object.fromEntries(mossPageCategories.map(key=>[key,prompt[key]]))} roles={roles} scopeKey={`comparison:${inputId}:page`} disabled={disabled} onChange={changes=>onChange({...value,prompt:{...value.prompt,...changes}})}/>
    {(['character','scene'] as const).map(kind=><section key={kind} className="comparison-moss-settings"><h4>{kind==='character'?'人物描述':'场景描述'}</h4>{value[kind==='character'?'characters':'scenes'].map((setting,index)=><div className="comparison-moss-setting" key={setting.id} data-setting-id={setting.id}>
      <label>{kind==='character'?'人物名称':'场景名称'}<input aria-label={`${kind==='character'?'人物':'场景'}名称 ${index+1}`} value={setting.prompt_name} disabled={disabled} onChange={event=>changeSetting(kind,index,{prompt_name:event.target.value})}/></label>
      <small>ID：{setting.id} · {setting.configuration_id}</small>
      <MossEntriesEditor label={`${setting.prompt_name} 描述`} value={effectiveEntries(kind,setting)} scopeKey={`comparison:${inputId}:${kind}:${setting.id}`} disabled={disabled} onChange={entries=>changeSetting(kind,index,{entries})}/>
    </div>)}{kind==='character'&&<button type="button" className="button" disabled={disabled} onClick={addCharacter}>添加本地人物</button>}</section>)}
    <details className="comparison-moss-project"><summary>画风、光照与避免描述</summary>{mossProjectFields.map(key=>{
      const entries=(key==='avoid'?prompt.avoid:prompt.project_overrides?.[key])??projectPrompt?.[key]??[];
      return <MossEntriesEditor key={key} label={mossProjectLabels[key]} value={entries} scopeKey={`comparison:${inputId}:project:${key}`} disabled={disabled} onChange={entries=>onChange({...value,prompt:key==='avoid'?{...value.prompt,avoid:entries}:{...value.prompt,project_overrides:{...prompt.project_overrides,[key]:entries}}})}/>;
    })}</details>
    <button type="button" className="button" disabled={disabled||!dimensions} onClick={()=>setLayoutOpen(true)}>编辑 MOSS Layout</button><small>{prompt.layout?.enabled?'已启用':'未启用'} · {prompt.layout?.items.length??0} 个元素</small>
    {layoutOpen&&dimensions&&<MossLayoutModal value={prompt.layout} characters={layoutCharacters} dimensions={dimensions} onClose={()=>setLayoutOpen(false)} onApply={layout=>{onChange({...value,prompt:{...value.prompt,layout}});setLayoutOpen(false);}}/>}
  </div>;
}
