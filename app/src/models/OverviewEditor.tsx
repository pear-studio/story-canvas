import {PromptPopulationEditor} from '../PromptPopulationEditor';
import {useEffect,useRef,useState} from 'react';
import {PromptTextArea} from '../SourcePromptEditor';
import {PromptFragmentEditor} from '../PromptFragmentEditor';
import {displayPromptDraft,persistPromptDraft,createPromptDraftFragment,matchesLocalPromptDraft} from '../prompt-fragment-draft';
import type {PagePrompt,WorkbenchPage} from '../project-workbench-client';
import type {PagePrompt as AnimaPrompt} from './anima/types';
type Props={page:WorkbenchPage;prompt:PagePrompt;onChange:(value:PagePrompt)=>void;disabled:boolean};
export function QwenOverviewEditor({page,prompt,onChange,disabled}:Props) {
  return <PromptTextArea ariaLabel={`${page.title} 本页 Prompt`} rows={4} value={prompt.text??''} disabled={disabled} placeholder="本页画面描述，可留空" onChange={text=>onChange({...prompt,text})}/>;
}
export function H3OverviewEditor({page,prompt,onChange,disabled}:Props) {
  return <><PromptTextArea ariaLabel={`${page.title} 本页 Prompt`} rows={4} value={prompt.text??''} disabled={disabled} placeholder="动作描述，可使用中文" onChange={text=>onChange({...prompt,text})}/>
    <label>时长（秒）<input type="number" min={3} max={15} step="any" disabled={disabled} value={prompt.duration??5} onChange={e=>onChange({...prompt,duration:Number(e.target.value)})}/></label>
    <label>尺寸<select disabled={disabled} value={prompt.quality??'standard'} onChange={e=>onChange({...prompt,quality:e.target.value as 'preview'|'standard'})}><option value="preview">低分辨率</option><option value="standard">标准尺寸</option></select></label>
    <label>采样步数<input type="number" min={8} max={50} disabled={disabled} value={prompt.steps??20} onChange={e=>onChange({...prompt,steps:Number(e.target.value)})}/></label>
    <label><input type="checkbox" disabled={disabled} checked={prompt.loop??false} onChange={e=>onChange({...prompt,loop:e.target.checked})}/>循环生成</label><small>24 fps · 无音频 · 无超分；输入图在单页导入</small></>;
}
export function AnimaOverviewEditor({page,prompt,onChange,disabled}:Props) {
  const [draft,setDraft]=useState(()=>displayPromptDraft(prompt as AnimaPrompt));
  const emitted=useRef(JSON.stringify(prompt));
  useEffect(()=>{if(JSON.stringify(prompt)!==emitted.current){if(!matchesLocalPromptDraft(draft,prompt as AnimaPrompt))setDraft(displayPromptDraft(prompt as AnimaPrompt));emitted.current=JSON.stringify(prompt);}},[prompt]);
  const change=(value:typeof draft)=>{setDraft(value);const next={...prompt,...persistPromptDraft(value)};emitted.current=JSON.stringify(next);onChange(next);};
  return <><PromptPopulationEditor fragments={draft.population??[]} disabled={disabled} onChange={population=>change({...draft,population})}/><PromptFragmentEditor categories={[{id:'person',label:'人物'},{id:'setting',label:'场景'},{id:'camera',label:'镜头'},{id:'avoid',label:'避免'}]} scope="page" fragments={draft} createFragment={createPromptDraftFragment} onChange={value=>change({...value,population:draft.population})} historyScopeKey={`${page.page_id}:${page.prompt_sha256}`}/></>;
}
