import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  runNavigationAction,
  saveStorySummary,
  startPageRender,
  type ProjectWorkbenchView,
  type StorySummaryResult,
  type StorySummaryTarget,
  type WorkbenchCharacter,
  type WorkbenchPage,
} from "./project-workbench-client";
import { TextPageArtwork } from "./TextPageArtwork";
import type { LetteringStyle } from "./lettering";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { StoryCandidateRefresh } from "./StoryCandidateRefresh";
import { useFeedback } from "./feedback";
import {StoryPagePreview} from "./StoryPagePreview";
import {pageNavigationInfo,pageTypeOf,pageTypeLabels,PageTypeIcon,type PageType} from "./PageNavigationSummary";
import {pageKeyId} from "./page-key";

export type StoryOverviewTarget = ({ kind: "overview" } | { kind: "chapter" | "sequence"; id: string }) & { requestId?: number };
export type StoryReadingPosition = {top:number;strips:Record<string,number>;directory:number};

type SummaryEditorProps = {
  projectId: string;
  target: StorySummaryTarget;
  label: string;
  text: string;
  sha256: string;
  busy: boolean;
  onSaved: (result: StorySummaryResult) => void;
  onReload: () => Promise<void>;
};

function SummaryEditor({ projectId, target, label, text, sha256, busy, onSaved, onReload }: SummaryEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(text); setError(""); }, [text, sha256]);
  const dirty = draft !== text;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await saveStorySummary(projectId, target, draft, sha256);
      if (!mounted.current) return;
      onSaved(result);
      setEditing(false);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "保存失败");
      try { await onReload(); } catch { /* 后台同步会继续重试，保留当前错误。 */ }
    } finally { if (mounted.current) setSaving(false); }
  }

  return <section className={editing ? "story-summary-editor" : "story-summary-reader"} data-project-fact-dirty={dirty || saving ? "true" : undefined}>
    <header>{editing ? <label htmlFor={id}>{target.kind === "synopsis" ? "故事梗概" : "摘要"}</label> : target.kind === "synopsis" ? <h4>故事梗概</h4> : null}
      <div className="story-summary-actions">{editing ? <>
        <button type="button" className="button button--quiet" disabled={saving} onClick={() => { setDraft(text); setError(""); setEditing(false); }}>取消</button>
        <button type="button" className="button button--quiet" aria-label={`保存${label}`} disabled={busy || saving || !dirty || !draft.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
      </> : <button type="button" className="button button--quiet" aria-label={`编辑${label}`} disabled={busy} onClick={() => setEditing(true)}>编辑</button>}</div>
    </header>
    {editing ? <textarea id={id} aria-label={label} rows={3} autoFocus value={draft} disabled={saving || busy} onChange={(event) => setDraft(event.target.value)} /> : <p>{text || "暂无摘要"}</p>}
    {error && <p className="prompt-save-error" role="alert">{error}</p>}
  </section>;
}

function StoryTitleEditor({ projectId, kind, targetId, title, busy, onReload }: {
  projectId: string;
  kind: "chapter" | "sequence";
  targetId: string;
  title: string;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(title); setError(""); }, [title]);
  const label = kind === "chapter" ? "章节名称" : "情节单元名称";
  const Heading = kind === "chapter" ? "h3" : "h4";

  async function save() {
    setSaving(true);
    setError("");
    try {
      await runNavigationAction(projectId, `rename-${kind}`, { [`${kind}_id`]: targetId, title: draft.trim() });
      await onReload();
      if (mounted.current) setEditing(false);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "重命名失败");
      try { await onReload(); } catch { /* 保留错误，等待后台同步。 */ }
    } finally { if (mounted.current) setSaving(false); }
  }

  function cancel() { setEditing(false); setDraft(title); setError(""); }

  return <div className="story-overview-title" data-project-fact-dirty={editing && (draft !== title || saving) ? "true" : undefined}>
    {editing ? <form onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" && !saving && !event.nativeEvent.isComposing) { event.preventDefault(); cancel(); }
    }} onSubmit={(event) => { event.preventDefault(); if (!busy && !saving && draft.trim() && draft.trim() !== title) void save(); }}>
      <input aria-label={label} value={draft} autoFocus disabled={busy || saving} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!busy && !saving && draft.trim() && draft.trim() !== title) void save();
        }
      }} />
      <button type="submit" className="button button--quiet" aria-label={`保存${label}`} disabled={busy || saving || !draft.trim() || draft.trim() === title}>{saving ? "保存中…" : "保存"}</button>
      <button type="button" className="button button--quiet" disabled={saving} onClick={cancel}>取消</button>
      {error && <p className="prompt-save-error" role="alert">{error}</p>}
    </form> : <>
      <Heading>{title}</Heading><button type="button" className="button button--quiet story-overview-rename" aria-label={`重命名${kind === "chapter" ? "章节" : "情节单元"}：${title}`} disabled={busy} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(true); }}>重命名</button>
    </>}
  </div>;
}

function characterName(characters: WorkbenchCharacter[], id: string, variantId?: string) {
  const character = characters.find((entry) => entry.id === id);
  const variant = character?.visual.variants.find((entry) => entry.id === variantId);
  return `${character?.name ?? id}${variant ? ` · ${variant.name}` : ""}`;
}

function StoryPageCard({ projectId, page, number, busy, letteringStyle, canvasAspect, onOpen, source }: {
  projectId: string; page: WorkbenchPage; number?: number; busy: boolean; source?:string;
  letteringStyle: LetteringStyle | null; canvasAspect?: string; onOpen: (page: WorkbenchPage) => void;
}) {
  const { notify } = useFeedback();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function generate() {
    if (pending.current || busy) return;
    pending.current = true;
    setSubmitting(true);
    try {
      await startPageRender(projectId, page.page_key, { operation: "candidates", count: 1 });
      if (mounted.current) notify({ kind: "success", message: `已提交“${page.title}”的单张生成任务` });
    } catch (error) {
      if (mounted.current) notify({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  const [media,setMedia]=useState<import('./project-workbench-client').PageMedia|null>(null);
  const info=pageNavigationInfo(page,media===null?null:{[pageKeyId(page.page_key)]:media.candidates.length},media?.candidates[0]?.video);
  return <article className="story-overview-page" data-page-id={page.page_id} data-page-type={info.type}>
    {page.page_kind === "text"
      ? <span className="story-page-thumbnail story-page-thumbnail--text" style={canvasAspect ? { aspectRatio: canvasAspect } : undefined} aria-label={`文字页：${page.title}`}>{letteringStyle ? <TextPageArtwork title={page.display_title ?? ""} body={page.body ?? ""} layout={page.text_layout} style={letteringStyle} /> : <span>{page.title}</span>}</span>
      : <StoryPagePreview projectId={projectId} page={page} onMediaChange={setMedia}/>}
    <div className="story-page-card-title">
      <button type="button" className="story-page-open" aria-label={`打开页面：${page.title}`} onClick={() => onOpen(page)}>
        <span className="story-overview-page-number">{String(number).padStart(2, "0")}</span><span data-tooltip={info.description}><PageTypeIcon type={info.type}/></span><strong>{page.title}</strong>
      </button>
      {!page.comic&&!['text','collage'].includes(page.page_kind??'') && <button type="button" className="story-page-generate" aria-label={`为“${page.title}”生成一张候选`} title="生成一张候选" disabled={busy || submitting} aria-busy={submitting} onClick={() => void generate()}>{submitting ? "…" : "+"}</button>}
    </div>
    {info.label&&<small className="story-page-card-meta" data-tooltip={info.description}>{info.label}</small>}
    {source&&<small className="story-page-source" data-tooltip={source}>{source}</small>}
    <p className="story-page-excerpt">{page.page_kind === "text" ? (page.body?.trim().split("\n")[0] || "无正文") : page.scene_description?.trim() || "尚未填写画面内容"}</p>
  </article>;
}

function StoryPageStrip({ projectId, title, pages, pageOrder, busy, letteringStyle, canvasAspect, onOpen }: {
  projectId: string;
  title: string;
  pages: WorkbenchPage[];
  pageOrder: Map<string, number>;
  busy: boolean;
  letteringStyle: LetteringStyle | null;
  canvasAspect?: string;
  onOpen: (page: WorkbenchPage) => void;
}) {
  return <div className="story-page-strip">
    <div className="story-overview-pages" role="region" aria-label={`${title}的分页`} tabIndex={0}>
      {pages.map((page) => <StoryPageCard key={`${projectId}:${page.page_id}`} projectId={projectId} page={page} number={pageOrder.get(page.page_id)} busy={busy} letteringStyle={letteringStyle} canvasAspect={canvasAspect} onOpen={onOpen} />)}
    </div>
  </div>;
}

function StorySequenceDialogue({ pages, pageOrder, characters, onOpen }: {
  pages: WorkbenchPage[];
  pageOrder: Map<string, number>;
  characters: WorkbenchCharacter[];
  onOpen: (page: WorkbenchPage) => void;
}) {
  const withDialogue = pages.filter((page) => page.dialogue?.length);
  if (!withDialogue.length) return null;
  return <section className="story-sequence-dialogue" aria-label="分页文案">
    {withDialogue.map((page) => {
      const hearts = page.dialogue!.filter((line) => line.mode === "heart");
      return <div className="story-dialogue-row" key={page.page_id}>
        <button type="button" className="story-dialogue-page" aria-label={`查看第 ${pageOrder.get(page.page_id)} 页文案：${page.title}`} onClick={() => onOpen(page)}>{String(pageOrder.get(page.page_id)).padStart(2, "0")} · {page.title}</button>
        <ul>
          {page.dialogue!.filter((line) => line.mode !== "heart").map((line) => <li key={line.id}>
            <span>{line.mode === "narration" ? "旁白" : `${line.speaker === "npc" ? "NPC" : characterName(characters, line.speaker ?? "")}${line.mode === "thought" ? " · 心声" : ""}`}</span>
            <p>{line.text}</p>
          </li>)}
          {hearts.length > 0 && <li className="story-dialogue-hearts">
            <span>爱心 ×{hearts.length}</span>
            <p>{hearts.map((line) => <span className="story-heart-chip" key={line.id}>{line.text}</span>)}</p>
          </li>}
        </ul>
      </div>;
    })}
  </section>;
}

export default function StoryOverview({projectId,view,focusTarget,busy,onSaved,onReload,onOpenPage,onSelectTarget,pageType='all',onPageTypeChange,readingPositions}: {
  projectId:string;view:ProjectWorkbenchView;focusTarget?:StoryOverviewTarget|null;busy:boolean;
  onSaved:(result:StorySummaryResult)=>void;onReload:()=>Promise<void>;onOpenPage:(page:WorkbenchPage)=>void;
  onSelectTarget:(target:StoryOverviewTarget)=>void;pageType?:PageType|'all';onPageTypeChange:(type:PageType|'all')=>void;
  readingPositions:Map<string,StoryReadingPosition>;
}){
  const root=useRef<HTMLDivElement>(null);
  const chapters=view.outline.chapters,sequences=chapters.flatMap(chapter=>chapter.sequences),pages=sequences.flatMap(sequence=>sequence.pages);
  const pageOrder=new Map(pages.map((page,index)=>[page.page_id,index+1]));
  const sources=new Map(chapters.flatMap(chapter=>chapter.sequences.flatMap(sequence=>sequence.pages.map(page=>[page.page_id,`${chapter.title} / ${sequence.title}`] as const))));
  const letteringStyle=view.project.lettering_settings;
  const canvasAspect=view.project.canvas?.includes(':')?view.project.canvas.replace(':',' / '):undefined;
  const editorProps={projectId,busy,onSaved,onReload};
  const kind=focusTarget?.kind??'overview',targetId=focusTarget&&focusTarget.kind!=='overview'?focusTarget.id:'',requestId=focusTarget?.requestId;
  const selectedChapter=chapters.find(item=>kind==='chapter'?item.id===targetId:item.sequences.some(seq=>seq.id===targetId));
  const selectedSequence=kind==='sequence'?selectedChapter?.sequences.find(item=>item.id===targetId):undefined;
  const scope=selectedChapter?kind:'overview';
  const scopePages=scope==='overview'?pages:selectedSequence?selectedSequence.pages:selectedChapter!.sequences.flatMap(item=>item.pages);
  const scopeLabel=scope==='overview'?'全文':selectedSequence?`${selectedChapter!.title} / ${selectedSequence.title}`:selectedChapter!.title;
  const filteredPages=scopePages.filter(page=>pageType==='all'||pageTypeOf(page)===pageType);
  const actionLabel=pageType==='all'?scopeLabel:`${scopeLabel} · ${pageTypeLabels[pageType]}`;
  const peers=scope==='chapter'?chapters:scope==='sequence'?sequences:[],peerIndex=peers.findIndex(item=>item.id===targetId);
  const scopeKey=`${scope}:${targetId}`;
  const readingKey=JSON.stringify([projectId,scopeKey,pageType]);
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const previous=useRef<{key:string;requestId:number|undefined}|null>(null);
  const savePosition=useRef(()=>{});
  function changeType(type:PageType|'all'){
    savePosition.current();
    onPageTypeChange(type);
  }
  function selectScope(value:string){
    savePosition.current();
    if(value==='overview')onSelectTarget({kind:'overview'});
    else{const colon=value.indexOf(':');onSelectTarget({kind:value.slice(0,colon) as 'chapter'|'sequence',id:value.slice(colon+1)});}
  }
  useEffect(()=>{
    if(!selectedChapter)return;
    setCollapsed(current=>{if(!current.has(selectedChapter.id))return current;const next=new Set(current);next.delete(selectedChapter.id);return next;});
  },[selectedChapter?.id]);
  useEffect(()=>{
    const element=root.current,main=element?.closest<HTMLElement>('.project-main'),topbar=document.querySelector<HTMLElement>('.topbar');
    if(!element||!main||!topbar)return;
    const update=()=>element.style.setProperty('--story-sticky-offset',getComputedStyle(main).overflowY==='visible'?`${topbar.getBoundingClientRect().height}px`:'0px');
    const observer=new ResizeObserver(update);observer.observe(topbar);observer.observe(main);update();return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    const element=root.current,main=element?.closest<HTMLElement>('.project-main');
    if(!element||!main)return;
    // 跨页返回或切回筛选范围恢复位置；再次主动点击当前范围仍定位到开头。
    const repeatScope=previous.current?.key===readingKey&&previous.current.requestId!==requestId;
    const restore=repeatScope?undefined:readingPositions.get(readingKey);
    previous.current={key:readingKey,requestId};
    let ready=false;
    const save=()=>{
      if(!ready)return;
      readingPositions.set(readingKey,{
        // 手机按正文起点记偏移，展开顶部工具造成的页面位移不计入阅读进度。
        top:getComputedStyle(main).overflowY==='visible'?-element.getBoundingClientRect().top:main.scrollTop,
        strips:Object.fromEntries(Array.from(element.querySelectorAll<HTMLElement>('.story-overview-sequence')).map(node=>[node.dataset.storyOverviewId!,node.querySelector('.story-overview-pages')?.scrollLeft??0])),
        directory:element.querySelector('.story-overview-directory')?.scrollTop??0,
      });
    };
    savePosition.current=save;
    main.addEventListener('scroll',save,{passive:true});
    window.addEventListener('scroll',save,{passive:true});
    element.addEventListener('scroll',save,true);
    const frame=requestAnimationFrame(()=>{
      if(restore){
        for(const node of element.querySelectorAll<HTMLElement>('.story-overview-sequence')){const strip=node.querySelector('.story-overview-pages');if(strip)strip.scrollLeft=restore.strips[node.dataset.storyOverviewId!]??0;}
        if(getComputedStyle(main).overflowY==='visible')window.scrollTo({top:restore.top+element.getBoundingClientRect().top+window.scrollY,behavior:'instant'});else main.scrollTo({top:restore.top,behavior:'instant'});
      }else element.querySelector('.story-overview-layout')?.scrollIntoView({block:'start',behavior:'instant'});
      const directory=element.querySelector<HTMLElement>('.story-overview-directory'),active=directory?.querySelector<HTMLElement>('[aria-current="location"]');
      if(directory&&restore)directory.scrollTop=restore.directory;
      else if(directory&&active){const bounds=directory.getBoundingClientRect(),target=active.getBoundingClientRect();if(target.top<bounds.top||target.bottom>bounds.bottom)directory.scrollTop+=target.top-bounds.top-8;}
      ready=true;save();
    });
    // 卸载后父容器会因内容变短归零；必须先解除监听，不能把归零覆盖到旧位置。
    return()=>{ready=false;cancelAnimationFrame(frame);main.removeEventListener('scroll',save);window.removeEventListener('scroll',save);element.removeEventListener('scroll',save,true);savePosition.current=()=>{};};
  },[readingKey,requestId,readingPositions]);
  return <div className="story-overview" ref={root} onClickCapture={()=>savePosition.current()}>
    <WorkspaceHeader title="剧情总览" meta={`${chapters.length} 章 · ${sequences.length} 情节单元 · ${pages.length} 页`}/>
    <div className="story-overview-layout">
      <nav className="story-overview-directory" aria-label="剧情阅读目录">
        <strong>阅读目录</strong>
        <button type="button" className="story-directory-scope" aria-label="全文" aria-current={scope==='overview'?'location':undefined} onClick={()=>onSelectTarget({kind:'overview'})}><span>全文</span><small>{pages.length} 页</small></button>
        <ol>{chapters.map((chapter,index)=><li key={chapter.id}>
          <div className={`story-directory-heading ${selectedChapter?.id===chapter.id?'is-current':''}`}>
            <button type="button" className="story-directory-fold" aria-label={`${collapsed.has(chapter.id)?'展开':'折叠'}章节：${chapter.title}`} aria-expanded={!collapsed.has(chapter.id)} onClick={()=>setCollapsed(current=>{const next=new Set(current);if(next.has(chapter.id))next.delete(chapter.id);else next.add(chapter.id);return next;})}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={collapsed.has(chapter.id)?'m6 4 4 4-4 4':'m4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.5"/></svg></button>
            <button type="button" className="story-directory-scope" aria-label={`${index+1}. ${chapter.title}`} data-tooltip={chapter.title} aria-current={scope==='chapter'&&targetId===chapter.id?'location':undefined} onClick={()=>onSelectTarget({kind:'chapter',id:chapter.id})}><span>{index+1}. {chapter.title}</span><small>{chapter.sequences.reduce((sum,sequence)=>sum+sequence.pages.length,0)} 页</small></button>
          </div>
          {!collapsed.has(chapter.id)&&<ol>{chapter.sequences.map((sequence,seqIndex)=><li key={sequence.id}><button type="button" className="story-directory-scope" data-tooltip={sequence.title} aria-current={scope==='sequence'&&targetId===sequence.id?'location':undefined} onClick={()=>onSelectTarget({kind:'sequence',id:sequence.id})}><span>{index+1}.{seqIndex+1} {sequence.title}</span><small>{sequence.pages.length} 页</small></button></li>)}</ol>}
        </li>)}</ol>
      </nav>
      <div className="story-overview-reader">
        <div className="story-reading-toolbar">
          <div className="story-reading-filters">
            <label>范围<select aria-label="阅读范围" value={scope==='overview'?'overview':`${scope}:${targetId}`} onChange={event=>selectScope(event.target.value)}><option value="overview">全项目</option>{chapters.map(chapter=><optgroup key={chapter.id} label={chapter.title}><option value={`chapter:${chapter.id}`}>{chapter.title} · 全章</option>{chapter.sequences.map(sequence=><option key={sequence.id} value={`sequence:${sequence.id}`}>{sequence.title}</option>)}</optgroup>)}</select></label>
            <label>类型<select aria-label="页面类型" value={pageType} onChange={event=>changeType(event.target.value as PageType|'all')}><option value="all">全部类型（{scopePages.length}）</option>{(Object.entries(pageTypeLabels) as Array<[PageType,string]>).map(([type,label])=><option value={type} key={type}>{label}（{scopePages.filter(page=>pageTypeOf(page)===type).length}）</option>)}</select></label>
          </div>
          <span className="story-reading-location" data-tooltip={actionLabel}>{scopeLabel}<small aria-live="polite">{pageType==='all'?`${scopePages.length} 页`:`${filteredPages.length} / ${scopePages.length} 页`}</small></span>
          <div className="story-reading-controls">{scope!=='overview'&&<><button type="button" className="button button--quiet" aria-label={scope==='chapter'?'上一章':'上一个情节单元'} disabled={peerIndex<=0} onClick={()=>onSelectTarget({kind:scope,id:peers[peerIndex-1].id})}>←</button><button type="button" className="button button--quiet" aria-label={scope==='chapter'?'下一章':'下一个情节单元'} disabled={peerIndex<0||peerIndex>=peers.length-1} onClick={()=>onSelectTarget({kind:scope,id:peers[peerIndex+1].id})}>→</button></>}</div>
          <div className="story-reading-actions" aria-label="当前结果的批量操作"><StoryCandidateRefresh key={`${projectId}:${scopeKey}:${pageType}`} projectId={projectId} pages={filteredPages} busy={busy} scopeLabel={actionLabel} pageOrder={pageOrder}/></div>
        </div>
        {pageType!=='all'?<>
          {filteredPages.length?<div className="story-filtered-pages" role="region" aria-label="筛选页面">{filteredPages.map(page=><StoryPageCard key={`${projectId}:${page.page_id}`} projectId={projectId} page={page} number={pageOrder.get(page.page_id)} busy={busy} letteringStyle={letteringStyle} canvasAspect={canvasAspect} source={sources.get(page.page_id)} onOpen={onOpenPage}/>)}</div>:<div className="story-overview-filter-empty"><p>当前范围没有{pageTypeLabels[pageType]}。</p>{scope!=='overview'&&<button type="button" className="button" onClick={()=>onSelectTarget({kind:'overview'})}>查看全项目{pageTypeLabels[pageType]}</button>}<button type="button" className="button button--quiet" onClick={()=>changeType('all')}>显示全部类型</button></div>}
        </>:<>
          {scope==='overview'&&<div id="story-overview-synopsis" className="story-overview-synopsis"><SummaryEditor {...editorProps} target={{kind:'synopsis'}} label="故事梗概" text={view.outline.synopsis} sha256={view.outline.synopsis_sha256}/></div>}
          {chapters.length===0&&<p className="story-overview-empty">还没有章节。</p>}
          {chapters.map((chapter,chapterIndex)=>(scope==='overview'||chapter.id===selectedChapter?.id)&&<section id={`story-chapter-${chapter.id}`} className="story-overview-chapter" data-story-overview-kind="chapter" data-story-overview-id={chapter.id} key={chapter.id}>
            <header className="story-section-heading"><span className="story-section-number">Chapter {chapterIndex+1}</span><StoryTitleEditor projectId={projectId} kind="chapter" targetId={chapter.id} title={chapter.title} busy={busy} onReload={onReload}/></header>
            <SummaryEditor {...editorProps} target={{kind:'chapter',id:chapter.id}} label={`章节摘要：${chapter.title}`} text={chapter.summary} sha256={chapter.summary_sha256}/>
            <div className="story-overview-sequences">{chapter.sequences.map((sequence,sequenceIndex)=>(scope!=='sequence'||sequence.id===targetId)&&<section id={`story-sequence-${sequence.id}`} className="story-overview-sequence" data-story-overview-kind="sequence" data-story-overview-id={sequence.id} key={sequence.id}>
              <header className="story-section-heading"><span className="story-section-number">Sequence {sequenceIndex+1}</span><StoryTitleEditor projectId={projectId} kind="sequence" targetId={sequence.id} title={sequence.title} busy={busy} onReload={onReload}/></header>
              <SummaryEditor {...editorProps} target={{kind:'sequence',id:sequence.id}} label={`情节单元摘要：${sequence.title}`} text={sequence.summary} sha256={sequence.summary_sha256}/>
              {sequence.pages.length===0?<p className="story-overview-empty">尚未分页。</p>:<><StoryPageStrip projectId={projectId} title={sequence.title} pages={sequence.pages} pageOrder={pageOrder} busy={busy} letteringStyle={letteringStyle} canvasAspect={canvasAspect} onOpen={onOpenPage}/><StorySequenceDialogue pages={sequence.pages} pageOrder={pageOrder} characters={view.characters} onOpen={onOpenPage}/></>}
            </section>)}</div>
          </section>)}
        </>}
      </div>
    </div>
  </div>;
}
