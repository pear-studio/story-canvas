import {PromptPopulationEditor} from '../PromptPopulationEditor';
import {useEffect,useRef,useState} from 'react';
import {PromptTextArea} from '../SourcePromptEditor';
import {PromptFragmentEditor} from '../PromptFragmentEditor';
import {displayPromptDraft,persistPromptDraft,createPromptDraftFragment} from '../prompt-fragment-draft';
import type {PagePrompt,WorkbenchPage} from '../project-workbench-client';
import type {PagePrompt as AnimaPrompt} from './anima/types';
type Props={page:WorkbenchPage;prompt:PagePrompt;onChange:(value:PagePrompt)=>void;disabled:boolean};
export function QwenOverviewEditor({page,prompt,onChange,disabled}:Props) {
  return <PromptTextArea ariaLabel={`${page.title} 本页 Prompt`} rows={4} value={prompt.text??''} disabled={disabled} placeholder="本页画面描述，可留空" onChange={text=>onChange({...prompt,text})}/>;
}
export function AnimaOverviewEditor({page,prompt,onChange,disabled}:Props) {
  const [draft,setDraft]=useState(()=>displayPromptDraft(prompt as AnimaPrompt));
  const emitted=useRef(JSON.stringify(prompt));
  useEffect(()=>{if(JSON.stringify(prompt)!==emitted.current){setDraft(displayPromptDraft(prompt as AnimaPrompt));emitted.current=JSON.stringify(prompt);}},[prompt]);
  const change=(value:typeof draft)=>{setDraft(value);const next={...prompt,...persistPromptDraft(value)};emitted.current=JSON.stringify(next);onChange(next);};
  return <><PromptPopulationEditor fragments={draft.population??[]} disabled={disabled} onChange={population=>change({...draft,population})}/><PromptFragmentEditor categories={[{id:'person',label:'人物'},{id:'setting',label:'场景'},{id:'camera',label:'镜头'},{id:'avoid',label:'避免'}]} scope="page" fragments={draft} createFragment={createPromptDraftFragment} onChange={value=>change({...value,population:draft.population})} historyScopeKey={`${page.page_id}:${page.prompt_sha256}`}/></>;
}
