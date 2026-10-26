import {PromptPopulationEditor} from '../../PromptPopulationEditor';
import {useEffect,useRef,useState} from 'react';
import {PromptFragmentEditor} from '../../PromptFragmentEditor';
import {displayPromptDraft,persistPromptDraft,createPromptDraftFragment,matchesLocalPromptDraft} from '../../prompt-fragment-draft';
import type {ModelOverviewEditorProps} from '../types';
import type {PagePrompt,PagePromptDraft} from './types';

export function AnimaOverviewEditor({page,prompt,onChange,disabled}:ModelOverviewEditorProps<PagePromptDraft>) {
  const [draft,setDraft]=useState(()=>displayPromptDraft(prompt as PagePrompt));
  const emitted=useRef(JSON.stringify(prompt));
  useEffect(()=>{if(JSON.stringify(prompt)!==emitted.current){if(!matchesLocalPromptDraft(draft,prompt as PagePrompt))setDraft(displayPromptDraft(prompt as PagePrompt));emitted.current=JSON.stringify(prompt);}},[prompt]);
  const change=(value:typeof draft)=>{setDraft(value);const next={...prompt,...persistPromptDraft(value)};emitted.current=JSON.stringify(next);onChange(next);};
  return <><PromptPopulationEditor fragments={draft.population??[]} disabled={disabled} onChange={population=>change({...draft,population})}/><PromptFragmentEditor categories={[{id:'person',label:'人物'},{id:'setting',label:'场景'},{id:'camera',label:'镜头'},{id:'avoid',label:'避免'}]} scope="page" fragments={draft} createFragment={createPromptDraftFragment} onChange={value=>change({...value,population:draft.population})} historyScopeKey={`${page.page_id}:${page.prompt_sha256}`}/></>;
}
