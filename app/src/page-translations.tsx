import {useEffect,useRef,useState} from 'react';
import {readFacts,mutateTargetFacts} from './project-write-client';
import {responseJson} from './api-response';
export type LetteringLocale='zh'|'en'|'ja';
export const localeLabels={zh:'中文',en:'English',ja:'日本語'};
export function LetteringLocaleSelect({value,onChange}:{value:LetteringLocale;onChange:(locale:LetteringLocale)=>void}) {
  return <label className="lettering-locale">嵌字语言 <select aria-label="嵌字语言" value={value} onChange={event=>onChange(event.target.value as LetteringLocale)}>{Object.entries(localeLabels).map(([locale,label])=><option key={locale} value={locale}>{label}</option>)}</select></label>;
}
export type TranslationLine={id:string;text:string;translation:string;mode?:string;speaker?:string;status:'missing'|'stale'|'ready';source_sha256:string};
export type PageTranslation={locale:'en'|'ja';lines:TranslationLine[];expected_source_sha256:string;expected_translation_sha256:string;summary:{total:number;missing:number;stale:number}};
const endpoint=(project:string,operation:string)=>`/api/projects/${encodeURIComponent(project)}/workbench/translation/${operation}`;
export const loadTranslation=async(project:string,page:string,locale:'en'|'ja',signal?:AbortSignal)=>responseJson<PageTranslation>(await readFacts(endpoint(project,'read'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:{page_id:page},locale}),signal}));
type Branch={baseline:PageTranslation;draft:Record<string,string>;confirmed:string[]};
const changed=(branch:Branch)=>branch.confirmed.length>0||branch.baseline.lines.some(line=>(branch.draft[line.id]??'')!==line.translation);
export function usePageTranslations(project:string,page:string,sourceIdentity:string,enabled=true) {
  const identity=`${project}/${page}`,active=useRef(identity);active.current=identity;
  const generation=useRef(0),saving=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [store,setStore]=useState<{identity:string;branches:Partial<Record<'en'|'ja',Branch>>}>({identity,branches:{}});
  const current=useRef(store);current.current=store;
  useEffect(()=>{setError('');setBusy(false);},[identity]);
  useEffect(()=>{const controller=new AbortController();generation.current++;let timer:ReturnType<typeof setTimeout>;
    if(!enabled)return ()=>controller.abort();
    async function load(){const epoch=generation.current;try{const values=await Promise.all((['en','ja'] as const).map(locale=>loadTranslation(project,page,locale,controller.signal)));
      if(controller.signal.aborted||active.current!==identity||generation.current!==epoch||saving.current)return;
      setStore(previous=>{const branches=previous.identity===identity?{...previous.branches}:{};
        for(const value of values){const branch=branches[value.locale];if(!branch||!changed(branch))branches[value.locale]={baseline:value,draft:Object.fromEntries(value.lines.map(line=>[line.id,line.translation])),confirmed:[]};}
        return {identity,branches};});
    }catch(reason){if(!controller.signal.aborted&&active.current===identity)setError(String(reason));}
    finally{if(!controller.signal.aborted)timer=setTimeout(load,3000);}}
    void load();return ()=>{controller.abort();clearTimeout(timer);};
  },[identity,sourceIdentity,enabled]);
  const branches=store.identity===identity?store.branches:{};
  const dirty=Object.values(branches).some(branch=>branch&&changed(branch));
  function edit(locale:'en'|'ja',id:string,text:string,confirm=false){setStore(previous=>{if(previous.identity!==identity||!previous.branches[locale])return previous;const branch=previous.branches[locale]!;return {...previous,branches:{...previous.branches,[locale]:{...branch,draft:{...branch.draft,[id]:text},confirmed:confirm?[...new Set([...branch.confirmed,id])]:branch.confirmed}}};});}
  async function save(locale?:'en'|'ja') {
    if(saving.current||current.current.identity!==identity)return false;
    const targets=(locale?[locale]:['en','ja']) as ('en'|'ja')[];
    if(targets.some(language=>!current.current.branches[language])){setError('译文尚未载入，请稍后保存。');return false;}
    saving.current=true;setBusy(true);setError('');generation.current++;
    let success=true;
    for(const language of targets){const branch=current.current.branches[language]!;if(!changed(branch))continue;
      const entries=Object.fromEntries(branch.baseline.lines.filter(line=>branch.confirmed.includes(line.id)||(branch.draft[line.id]??'')!==line.translation).map(line=>[line.id,branch.draft[line.id]??'']));
      try{const value=await responseJson<PageTranslation>(await mutateTargetFacts(endpoint(project,'save'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:{page_id:page},locale:language,entries,expected_source_sha256:branch.baseline.expected_source_sha256,expected_translation_sha256:branch.baseline.expected_translation_sha256})}));
        if(active.current!==identity){success=false;continue;}
        setStore(previous=>({...previous,branches:{...previous.branches,[language]:{baseline:value,draft:Object.fromEntries(value.lines.map(line=>[line.id,line.translation])),confirmed:[]}}}));
      }catch(reason){success=false;if(active.current===identity)setError(previous=>[previous,`${localeLabels[language]} 保存失败，草稿已保留：${reason instanceof Error?reason.message:String(reason)}`].filter(Boolean).join('\n'));}
    }
    saving.current=false;if(active.current===identity)setBusy(false);
    return success;
  }
  function discard(){generation.current++;setError('');setStore(previous=>({identity,branches:Object.fromEntries(Object.entries(previous.identity===identity?previous.branches:{}).map(([locale,branch])=>[locale,{...branch,draft:Object.fromEntries(branch.baseline.lines.map(line=>[line.id,line.translation])),confirmed:[]}]))}));}
  return {branches,dirty,busy,error,edit,save,discard};
}
export function TranslationEditor({locale,branch,busy,error,onEdit,onSelect,selectedId,characterNames={}}:{locale:'en'|'ja';branch?:Branch;busy:boolean;error:string;onEdit:(id:string,text:string,confirm?:boolean)=>void;onSelect:(id:string)=>void;selectedId:string;characterNames?:Record<string,string>}) {
  if(!branch)return <p role="status">{error||'正在读取译文…'}</p>;
  return <section className="translation-editor">
    <p className="translation-guide">中文原文供参考。译文可手写，也可由 Agent 写入。预览使用已保存的中文布局。</p>
    {error&&<p className="prompt-save-error" role="alert">{error}</p>}
    {branch.baseline.lines.map(line=>{const text=branch.draft[line.id]??'',stale=line.status==='stale'&&!branch.confirmed.includes(line.id)&&text===line.translation;return <article className={`translation-row ${selectedId===line.id?'is-selected':''}`} key={line.id} onClick={()=>onSelect(line.id)}>
      <label>中文 · {line.mode?({speech:'对白',thought:'心声',heart:'爱心',narration:'旁白'}[line.mode]??line.mode):(line.id==='body'?'正文':'展示标题')}{line.speaker&&` · ${characterNames[line.speaker]??(line.speaker==='npc'?'NPC':line.speaker)}`}<div className="translation-source">{line.text}</div></label>
      <label>{localeLabels[locale]}{!text.trim()&&<small> · 缺译</small>}{stale&&<small> · 中文已变化</small>}<textarea aria-label={`${localeLabels[locale]}译文 ${line.id}`} lang={locale} rows={Math.min(8,Math.max(2,Math.ceil(text.length/40)))} value={text} disabled={busy} onFocus={()=>onSelect(line.id)} onChange={event=>onEdit(line.id,event.target.value)}/></label>
      {stale&&<button className="button button--quiet" type="button" disabled={busy} onClick={()=>onEdit(line.id,text,true)}>沿用此译文</button>}
    </article>;})}
    {!branch.baseline.lines.length&&<p>本页没有需要翻译的文字。</p>}
  </section>;
}
