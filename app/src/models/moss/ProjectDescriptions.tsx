import {mossProjectFields,mossProjectLabels,mossText,type MossEntry,type MossProjectField} from '../../../shared/moss-prompt.mjs';
import {MossEntriesEditor} from './EntriesEditor';
import type {PagePromptDraft,MossProjectPrompt} from './types';
import '../../PromptDisclosure.css';

export function MossProjectDescriptions({prompt,projectPrompt,scopeKey,disabled=false,onChange}:{
  prompt:PagePromptDraft;projectPrompt?:Partial<MossProjectPrompt>;scopeKey:string;disabled?:boolean;onChange:(prompt:PagePromptDraft)=>void;
}) {
  function setOverride(key:MossProjectField,entries?:MossEntry[]) {
    if(key==='avoid') {
      const next={...prompt};
      if(entries===undefined)delete next.avoid;else next.avoid=entries;
      onChange(next);
    } else {
      const project_overrides={...prompt.project_overrides};
      if(entries===undefined)delete project_overrides[key];else project_overrides[key]=entries;
      onChange({...prompt,project_overrides});
    }
  }
  return <>{mossProjectFields.map(key=>{
    const label=mossProjectLabels[key],base=projectPrompt?.[key]??[],override=key==='avoid'?prompt.avoid:prompt.project_overrides?.[key],effective=override??base;
    return <details className="moss-project-description" key={key}>
      <summary className="prompt-disclosure"><span>{label} · {override===undefined?'继承项目':'本页覆盖'}</span><span className="moss-project-description__preview">{mossText(effective)||'未设置'}</span></summary>
      <div className="moss-reference-actions">{override===undefined
        ?<button type="button" className="button button--quiet" disabled={disabled} onClick={()=>setOverride(key,structuredClone(base))}>本页覆盖{label}</button>
        :<button type="button" className="button button--quiet" disabled={disabled} onClick={()=>setOverride(key)}>恢复项目{label}</button>}</div>
      <MossEntriesEditor label={label} value={effective} scopeKey={`${scopeKey}:project:${key}`} disabled={disabled||override===undefined} onChange={entries=>setOverride(key,entries)}/>
    </details>;
  })}</>;
}
