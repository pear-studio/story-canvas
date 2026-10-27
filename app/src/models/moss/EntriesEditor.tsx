import {useEffect,useRef,useState} from 'react';
import {PromptFragmentEditor,type PromptFragment,type PromptDictionaryScope} from '../../PromptFragmentEditor';
import type {MossEntry} from '../../../shared/moss-prompt.mjs';
import './moss.css';

type Role={id:string;label:string;color?:string};
const createFragment=():PromptFragment=>({id:`entry-${crypto.randomUUID()}`,prompt_type:'custom_description',prompt_text:''});
function display(value:Record<string,MossEntry[]>):Record<string,PromptFragment[]> {
  return Object.fromEntries(Object.entries(value).map(([category,entries])=>[category,entries.map((entry,index)=>({id:entry.id??`entry-${crypto.randomUUID()}`,source_index:index,prompt_type:'custom_description',prompt_text:entry.description,...(entry.character_id?{role:entry.character_id}:{}),...(entry.enabled===undefined?{}:{enabled:entry.enabled})}))]));
}
function persist(value:Record<string,PromptFragment[]>):Record<string,MossEntry[]> {
  return Object.fromEntries(Object.entries(value).map(([category,entries])=>[category,entries.map(entry=>({id:entry.id,description:entry.prompt_text,...(entry.role?{character_id:entry.role}:{}),...(entry.enabled===undefined?{}:{enabled:entry.enabled})}))]));
}
export function MossCategoriesEditor({categories,value,onChange,scopeKey,disabled=false,roles,scope='page'}:{
  categories:Array<{id:string;label:string}>;value:Record<string,MossEntry[]>;onChange:(value:Record<string,MossEntry[]>)=>void;scopeKey:string;disabled?:boolean;roles?:Role[];scope?:PromptDictionaryScope;
}) {
  const [draft,setDraft]=useState(()=>display(value));
  const emitted=useRef(JSON.stringify(value)),currentScope=useRef(scopeKey);
  useEffect(()=>{const incoming=JSON.stringify(value);if(incoming!==emitted.current||scopeKey!==currentScope.current){setDraft(display(value));emitted.current=incoming;currentScope.current=scopeKey;}},[value,scopeKey]);
  return <fieldset className="moss-entry-fieldset" disabled={disabled} inert={disabled}><PromptFragmentEditor naturalLanguage categories={categories} scope={scope} roles={roles} fragments={draft} createFragment={createFragment} showEmptyCategories={categories.length===1} historyScopeKey={scopeKey} onChange={next=>{setDraft(next);const result=persist(next);emitted.current=JSON.stringify(result);onChange(result);}}/></fieldset>;
}
export function MossEntriesEditor({label,value,onChange,scopeKey,disabled=false,scope='page'}:{
  label:string;value:MossEntry[];onChange:(value:MossEntry[])=>void;scopeKey:string;disabled?:boolean;scope?:PromptDictionaryScope|'scene';
}) {
  return <MossCategoriesEditor categories={[{id:'description',label}]} value={{description:value}} onChange={next=>onChange(next.description??[])} scopeKey={scopeKey} disabled={disabled} scope={scope==='scene'?'character':scope}/>;
}
