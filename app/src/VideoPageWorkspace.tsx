import {useEffect,useRef,useState} from 'react';
import {loadPageMedia,startPageRender,deleteCandidate,loadCandidateDetail,type WorkbenchPage,type Candidate,type PagePrompt,type CandidateDetail} from './project-workbench-client';
import {readFacts,mutateTargetFacts} from './project-write-client';
import {responseJson} from './api-response';
import {referenceUrl} from './ReferenceLibrary';
import {startFinishedPage} from './finished-client';
import {useFeedback} from './feedback';
import {Modal} from './Modal';
import {WorkspaceHeader,SectionHeader} from './WorkspaceHeader';
import {GenerationDetailsPanel} from './GenerationDetailsPanel';
import ZoomableImageLightbox from './ImageLightbox';
import {mediaVariantUrl} from './media-variant';
import {PageLoraEditor} from './models/PageLoraEditor';
import {FinishedOutputButton} from './FinishedOutputButton';
import {usePageChanges} from './use-page-changes';
import {useSaveShortcut} from './use-save-shortcut';
import {useDraftHistory} from './use-draft-history';
import {defaultVideoPostprocess,normalizeVideoPostprocess,videoPostprocessTiming,type VideoPostprocess} from '../shared/video-postprocess.mjs';
import {videoPreviewUrl} from './video-preview';
import {useVideoPreview} from './use-video-preview';
import './VideoPageWorkspace.css';

type Scope={document:PagePrompt;save:{args:Record<string,unknown>}};
type ContentScope={document:{video_postprocess?:VideoPostprocess};save:{args:Record<string,unknown>}};
export function VideoPageWorkspace({projectId,page,pages,breadcrumb,onReload}:{projectId:string;page:WorkbenchPage;pages:WorkbenchPage[];breadcrumb:string[];onReload:()=>Promise<unknown>}) {
  const [scope,setScope]=useState<Scope|null>(null),[draft,setDraft]=useState<PagePrompt>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [candidates,setCandidates]=useState<Candidate[]>([]),[sourceCandidates,setSourceCandidates]=useState<Candidate[]>([]),[sourceId,setSourceId]=useState(''),[selected,setSelected]=useState(''),[count,setCount]=useState(1),[seed,setSeed]=useState('');
  const [detail,setDetail]=useState<CandidateDetail|null>(null),[sourceOpen,setSourceOpen]=useState(false),[previewOpen,setPreviewOpen]=useState(false);
  const [largeOpen,setLargeOpen]=useState(false);
  const [contentScope,setContentScope]=useState<ContentScope|null>(null),[postprocess,setPostprocess]=useState<VideoPostprocess>(()=>normalizeVideoPostprocess(page.video_postprocess));
  const [appliedPostprocess,setAppliedPostprocess]=useState<VideoPostprocess>(()=>normalizeVideoPostprocess(page.video_postprocess));
  const [previewAttempt,setPreviewAttempt]=useState(0);
  const [mediaLoaded,setMediaLoaded]=useState(false),[mediaError,setMediaError]=useState('');
  const [tab,setTab]=useState<'generation'|'postprocess'>('generation');
  const saving=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width: 1160px)').matches);
  const {confirm}=useFeedback();
  const [renameTitle,setRenameTitle]=useState<string|null>(null);
  const [sources,setSources]=useState<{page_id:string;title:string}[]>([]);
  const eligible=sources;
  const pageOrder=pages.findIndex(p=>p.page_id===page.page_id)+1;
  const promptDirty=scope!==null&&JSON.stringify(draft)!==JSON.stringify(scope.document);
  const postprocessDirty=contentScope!==null&&JSON.stringify(postprocess)!==JSON.stringify(normalizeVideoPostprocess(contentScope.document.video_postprocess));
  const dirty=promptDirty||postprocessDirty;
  const base=`/api/projects/${encodeURIComponent(projectId)}/workbench`;
  async function readScope() {const s=await responseJson<Scope>(await readFacts('/api/agent/prompt/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,target:{kind:'page',id:page.page_id}})}));if(mounted.current){setScope(s);setDraft(s.document);}}
  async function readContent() {const s=await responseJson<ContentScope>(await readFacts('/api/agent/page-editor',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,page_key:page.page_key,section:'content'})}));if(mounted.current){setContentScope(s);setPostprocess(normalizeVideoPostprocess(s.document.video_postprocess));setAppliedPostprocess(normalizeVideoPostprocess(s.document.video_postprocess));}}
  useEffect(()=>{void readContent().catch(e=>mounted.current&&setError(String(e)));},[projectId,page.page_id]);
  async function refresh(){const x=await loadPageMedia(projectId,page.page_key,undefined,undefined,true);if(x)setCandidates(x.media.candidates);setMediaLoaded(true);setMediaError('');}
  async function run(work:()=>Promise<unknown>){setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  useEffect(()=>{const query=window.matchMedia('(max-width: 1160px)');const update=()=>{setCompact(query.matches);setPreviewOpen(false);};query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  useEffect(()=>{let active=true;void readScope().catch(e=>active&&setError(String(e)));void (async()=>responseJson<{sources:{page_key:{page_id:string};title:string}[];source_page_key:{page_id:string}|null}>(await readFacts(`${base}/video-source`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:page.page_key})})))().then(result=>{if(active){setSources(result.sources.map(s=>({page_id:s.page_key.page_id,title:s.title})));setSourceId(result.source_page_key?.page_id??'');}}).catch(e=>active&&setError(String(e)));return()=>{active=false;};},[projectId,page.page_id]);
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;setMediaLoaded(false);setMediaError('');const poll=async()=>{try{const x=await loadPageMedia(projectId,page.page_key,controller.signal);if(!controller.signal.aborted){if(x)setCandidates(x.media.candidates);setMediaLoaded(true);setMediaError('');}}catch(e){if(!controller.signal.aborted)setMediaError(String(e));}if(!controller.signal.aborted)timer=setTimeout(poll,3000);};void poll();return()=>{controller.abort();clearTimeout(timer);};},[projectId,page.page_id]);
  useEffect(()=>{const controller=new AbortController();setSourceCandidates([]);if(sourceId)void loadPageMedia(projectId,{page_id:sourceId},controller.signal).then(x=>{if(x&&!controller.signal.aborted)setSourceCandidates(x.media.candidates.filter(c=>c.media_kind!=='video'));}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});return()=>controller.abort();},[projectId,sourceId]);
  async function save(){
    if(saving.current)throw Error('正在保存，请稍后再试');
    if(!scope||!contentScope)throw Error('页面设置尚未载入');
    normalizeVideoPostprocess(postprocess);
    saving.current=true;
    try {
      if(promptDirty){
        await responseJson(await mutateTargetFacts('/api/agent/prompt/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...scope.save.args,changes:draft})},projectId));
        await readScope();
      }
      if(postprocessDirty){
        const s=await responseJson<ContentScope>(await mutateTargetFacts('/api/agent/page-editor/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...contentScope.save.args,changes:{video_postprocess:postprocess}})},projectId));
        if(mounted.current)setContentScope(s);
      }
      if(mounted.current){setAppliedPostprocess(normalizeVideoPostprocess(postprocess));history.checkpoint();await onReload();setNotice('页面设置已保存，后处理已应用');}
    } finally {saving.current=false;}
  }
  const history=useDraftHistory({draft,postprocess},value=>{setDraft(value.draft);setPostprocess(value.postprocess);},`${projectId}:${page.page_id}:${Boolean(scope)}:${Boolean(contentScope)}`,!busy);
  usePageChanges(`${projectId}:${page.page_id}`,{dirty,save:async()=>{setBusy(true);setError('');try{await save();return true;}catch(e){setError(String(e));return false;}finally{setBusy(false);}}});
  useSaveShortcut(()=>{if(!busy&&(dirty||unapplied))void run(save);},`${projectId}:${page.page_id}`);
  async function importImage(c:Candidate){
    if(dirty)await save();
    const target={kind:'page',id:page.page_id};
    const library=await responseJson<{sha256:string}>(await readFacts(`${base}/reference-library`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'read',target})}));
    await responseJson(await mutateTargetFacts(`${base}/reference-library`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'save',target,expected_sha256:library.sha256,candidate_id:c.candidate_id,page_key:{page_id:sourceId},title:eligible.find(p=>p.page_id===sourceId)?.title??'输入图'})}));
    await readScope();setSourceOpen(false);setNotice('候选图已导入，后续页面重排不会改变输入');
  }
  const current=candidates.find(c=>c.candidate_id===selected)??candidates[0];
  function candidateDuration(candidate:Candidate) {
    if(!candidate.video)return '时长未知';
    try{return `处理后 ${videoPostprocessTiming(candidate.video,appliedPostprocess).duration_seconds.toFixed(2)} 秒`;}
    catch{return '裁剪范围无效';}
  }
  const unapplied=JSON.stringify(postprocess)!==JSON.stringify(appliedPostprocess);
  let postprocessError='',appliedError='',processedDuration:number|undefined,previewDuration:number|undefined,requestedPreview='',smallPreview='';
  try {
    const edit=normalizeVideoPostprocess(postprocess);
    if(current?.video)processedDuration=videoPostprocessTiming(current.video,edit).duration_seconds;
  } catch(e){postprocessError=e instanceof Error?e.message:String(e);}
  try {
    if(current?.video)previewDuration=videoPostprocessTiming(current.video,appliedPostprocess).duration_seconds;
    if(current?.video_url){requestedPreview=videoPreviewUrl(current.video_url,1024,appliedPostprocess);smallPreview=videoPreviewUrl(current.video_url,320,appliedPostprocess);}
  } catch(e){appliedError=e instanceof Error?e.message:String(e);}
  const preview=useVideoPreview(smallPreview,requestedPreview,previewAttempt),previewUrl=preview.url;
  useEffect(()=>setLargeOpen(false),[requestedPreview]);
  const frames=17*Math.round(((draft.duration??5)*24-5)/17)+5;
  const input=draft.reference_images?.[0];
  const generateDisabled=busy||!scope||!contentScope||!input||!draft.text?.trim();
  const generate=()=>run(async()=>{if(dirty)await save();const result=await startPageRender(projectId,page.page_key,{operation:'candidates',count,...(seed?{seed:Number(seed)}:{})});setNotice(`已排队：${result.task.task_id}`);});
  const editingActions=<><button type="button" className="button button--quiet" disabled={busy||!history.canUndo} onClick={history.undo}>撤销</button><button type="button" className="button button--quiet" disabled={busy||!dirty} onClick={()=>{if(scope)setDraft(structuredClone(scope.document));if(contentScope){const saved=normalizeVideoPostprocess(contentScope.document.video_postprocess);setPostprocess(saved);setAppliedPostprocess(saved);}setError('');setNotice('');}}>放弃修改</button><button type="button" className="button button--quiet" disabled={busy||(!dirty&&!unapplied)||!scope||!contentScope} onClick={()=>void run(save)}>保存</button><button type="button" className="button button--primary" disabled={generateDisabled} onClick={()=>void generate()}>{dirty?'保存并生成':'生成'} ×{count}</button></>;
  const outputAction=<FinishedOutputButton projectId={projectId} pageId={page.page_id} candidateId={current?.candidate_id} dirty={dirty} dirtyLabel="保存并输出成品" disabled={busy||!scope||!contentScope||!current||Boolean(postprocessError)} onOutput={async candidateId=>{
    setBusy(true);setError('');
    try {if(dirty||unapplied)await save();if(!mounted.current)return null;return (await startFinishedPage(projectId,page.page_key,candidateId)).job;}
    finally{if(mounted.current)setBusy(false);}
  }}/>;
  const results=<div className="video-page-results">
    <div className="video-result-main">
    {current?.video_url?<div className="video-preview-stage">
      {appliedError?<p role="alert">{appliedError}</p>:<>
      <button type="button" className="video-candidate-preview" disabled={!previewUrl} aria-label="查看动态候选大图" onClick={()=>setLargeOpen(true)}>{previewUrl&&<img className="video-candidate-player" src={previewUrl} data-preview-source={requestedPreview} data-preview-width={preview.width} alt="动态后处理预览"/>}</button>
      {preview.error?<p role="alert">{previewUrl?'高清预览加载失败，当前显示小预览。':'动图预览加载失败，候选原视频仍保留。'}<span className="video-field-hint">{preview.error}</span><button type="button" className="button" onClick={()=>setPreviewAttempt(value=>value+1)}>重试预览</button></p>:preview.pending&&<p role="status">{previewUrl?'正在加载高清预览…':'正在加载动图预览…'}</p>}
      </>}
    </div>:<div className="video-empty-state">{mediaError?<p role="alert">候选列表读取失败，正在重试。</p>:!mediaLoaded?<p role="status">正在读取候选列表…</p>:<><b>尚无视频候选</b><p>生成中的候选会在完成后自动出现。</p></>}</div>}
    {current&&<><p className="video-result-meta">{current.video?.width} × {current.video?.height} · 处理后 {previewDuration?.toFixed(2)??'—'} 秒 · Seed {current.seed}</p>
      <div className="video-result-actions">
        {!appliedError&&preview.width===1024&&<a className="button button--quiet" href={previewUrl} download="animation.webp">下载 WebP</a>}
        <button type="button" className="button button--quiet" disabled={Boolean(appliedError)||!previewUrl} onClick={()=>setLargeOpen(true)}>查看大图</button>
        <button type="button" className="button button--quiet" onClick={()=>void run(async()=>{setDetail((await loadCandidateDetail(projectId,page.page_key,current.candidate_id)).detail);})}>生成详情</button>
        <button type="button" className="button button--danger" disabled={busy} onClick={()=>void run(async()=>{if(!await confirm({title:'删除视频候选',message:'删除此候选的视频与审阅文件，输入图和页面设置会保留。',danger:true,confirmLabel:'删除'}))return;await deleteCandidate(projectId,page.page_key,current.candidate_id);await refresh();})}>删除</button>
      </div></>}
    {current?.review_url&&<details className="video-disclosure"><summary>原片抽帧审阅</summary><img className="video-review-image" src={current.review_url} alt="含首尾帧和时间标记的原片动作拼图"/></details>}
    <div className="page-output-toolbar video-output-toolbar">{!compact&&editingActions}{outputAction}</div>
    </div>
    <div className="video-candidate-rail">
    <SectionHeader title={`候选 · ${candidates.length}`} actions={<button type="button" className="button button--quiet" disabled={busy} onClick={()=>void run(refresh)}>刷新</button>}/>
    <div className="video-candidate-list" aria-label="选择视频候选">{candidates.map(c=><button type="button" key={c.candidate_id} className={c===current?'is-selected':''} aria-pressed={c===current} onClick={()=>setSelected(c.candidate_id)}><img src={mediaVariantUrl(c.url,320)} alt={`视频 Seed ${c.seed}`}/><small>{candidateDuration(c)} · Seed {c.seed}</small></button>)}</div>
    </div>
  </div>;
  return <section className="video-page-workspace" data-project-fact-dirty={dirty?'true':undefined} data-page-prompt-dirty={promptDirty?'true':'false'}>
    <div className="video-page-columns">
    <div className="document-editor video-page-editor">
    <WorkspaceHeader breadcrumb={breadcrumb} title={<span className="page-title-editor"><span className="page-order" aria-label={`第 ${pageOrder} 页`}>{String(pageOrder).padStart(2,'0')}</span><button type="button" className="inline-title-trigger" aria-label="重命名页面" disabled={busy||dirty} onClick={()=>setRenameTitle(page.title)}>{page.title}</button></span>} meta="动态页 · H3"/>
    {renameTitle!==null&&<Modal title="页面标题" busy={busy} onClose={()=>setRenameTitle(null)} footer={<button className="button" disabled={busy||!renameTitle.trim()} onClick={()=>void run(async()=>{const scope=await responseJson<{save:{args:Record<string,unknown>}}>(await readFacts('/api/agent/page-editor',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,page_key:page.page_key,section:'content'})}));await responseJson(await mutateTargetFacts('/api/agent/page-editor/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...scope.save.args,changes:{title:renameTitle}})},projectId));setRenameTitle(null);await readScope();await readContent();await onReload();})}>保存标题</button>}><input aria-label="动态页标题" value={renameTitle} onChange={e=>setRenameTitle(e.target.value)} autoFocus/></Modal>}
    {error&&<p role="alert" className="video-message video-message--error">{error}</p>}{notice&&<p role="status" className="video-message">{notice}</p>}
    <div className="editor-mode-tabs" role="tablist" aria-label="动态页编辑内容">
      <button type="button" role="tab" aria-selected={tab==='generation'} className={tab==='generation'?'is-active':''} onClick={()=>setTab('generation')}>动作 / Prompt{promptDirty&&<i/>}</button>
      <button type="button" role="tab" aria-selected={tab==='postprocess'} className={tab==='postprocess'?'is-active':''} onClick={()=>setTab('postprocess')}>后处理{postprocessDirty&&<i/>}</button>
    </div>
    <div hidden={tab!=='generation'}>
    <section className="video-editor-section">
      <SectionHeader title="输入图" actions={<button type="button" className="button button--quiet" disabled={busy||!scope} onClick={()=>setSourceOpen(true)}>{input?'更换输入图':'导入候选图'}</button>}/>
      {input?<div className="video-input-summary"><img src={referenceUrl(projectId,input.file)} alt="动态页输入图"/><div><b>{input.title||'已导入图片'}</b><small>独立保存的输入图</small><p>更换后用于下次生成，已有候选会保留。</p></div></div>:<p className="video-field-hint">默认从前一张插画页选择候选图。</p>}
    </section>
    <section className="video-editor-section">
      <SectionHeader title="动作描述" description="描述动作和镜头，支持中文。"/>
      <textarea className="video-action-input" aria-label="动作描述" rows={4} value={draft.text??''} disabled={busy||!scope} onChange={e=>setDraft({...draft,text:e.target.value})} placeholder="例如：女子向前走过门口，镜头固定。"/>
    </section>
    <section className="video-editor-section">
      <SectionHeader title="生成设置" description="24 fps · 无音频 · 原尺寸输出"/>
      <div className="video-settings">
        <label className="video-field">时长（秒）<input aria-label="时长（秒）" type="number" min={3} max={15} step="any" value={draft.duration??5} disabled={busy} onChange={e=>setDraft({...draft,duration:Number(e.target.value)})}/><small>实际 {(frames/24).toFixed(2)} 秒 · {frames} 帧</small></label>
        <label className="video-field">尺寸<select aria-label="视频尺寸" value={draft.quality??'standard'} disabled={busy} onChange={e=>setDraft({...draft,quality:e.target.value as 'preview'|'standard'})}><option value="preview">低分辨率</option><option value="standard">标准尺寸</option></select><small>短边约 {draft.quality==='preview'?576:768}px，跟随输入图比例</small></label>
      </div>
      <label className="video-loop"><input type="checkbox" checked={draft.loop??false} disabled={busy} onChange={e=>setDraft({...draft,loop:e.target.checked})}/><span>循环生成<small>约束首尾回到同一画面；接缝需播放验收</small></span></label>
      <details className="video-disclosure video-advanced"><summary>更多参数<span>{draft.steps??20} 步 · {count} 段 · {seed?'固定 Seed':'随机 Seed'}</span></summary><div className="video-settings">
        <label className="video-field">采样步数<input aria-label="采样步数" type="number" min={8} max={50} value={draft.steps??20} disabled={busy} onChange={e=>setDraft({...draft,steps:Number(e.target.value)})}/></label>
        <label className="video-field">数量<input aria-label="视频数量" type="number" min={1} max={3} value={count} disabled={busy} onChange={e=>setCount(Number(e.target.value))}/></label>
        <label className="video-field video-seed">Seed<input aria-label="视频 Seed" type="number" min={0} placeholder="留空随机" value={seed} disabled={busy} onChange={e=>setSeed(e.target.value)}/></label>
      </div></details>
    </section>
    <section className="video-editor-section">
      <PageLoraEditor projectId={projectId} page={page} prompt={draft} onChange={setDraft} disabled={busy||!scope}/>
    </section>
    </div>
    <section className="video-editor-section" hidden={tab!=='postprocess'}>
      <SectionHeader title="后处理" description="拖动滑条或输入数值，点击应用更新预览；保存会同时应用并记住参数。"/>
      <div className="video-settings">
        <label className="video-field">裁掉开头（秒）<input aria-label="裁掉开头（秒）" type="number" min={0} max={3600} step={0.1} value={Number.isFinite(postprocess.trim_start_seconds)?postprocess.trim_start_seconds:''} disabled={busy||!contentScope} onChange={e=>setPostprocess({...postprocess,trim_start_seconds:e.target.valueAsNumber})}/><input type="range" aria-label="裁掉开头滑条" min={0} max={Math.max(0,Math.floor(((current?.video?.duration_seconds??15)-1/(current?.video?.fps??24))*10)/10)} step={0.1} value={Number.isFinite(postprocess.trim_start_seconds)?postprocess.trim_start_seconds:0} disabled={busy||!contentScope} onChange={e=>setPostprocess({...postprocess,trim_start_seconds:e.target.valueAsNumber})}/></label>
        <label className="video-field">裁掉结尾（秒）<input aria-label="裁掉结尾（秒）" type="number" min={0} max={3600} step={0.1} value={Number.isFinite(postprocess.trim_end_seconds)?postprocess.trim_end_seconds:''} disabled={busy||!contentScope} onChange={e=>setPostprocess({...postprocess,trim_end_seconds:e.target.valueAsNumber})}/><input type="range" aria-label="裁掉结尾滑条" min={0} max={Math.max(0,Math.floor(((current?.video?.duration_seconds??15)-1/(current?.video?.fps??24))*10)/10)} step={0.1} value={Number.isFinite(postprocess.trim_end_seconds)?postprocess.trim_end_seconds:0} disabled={busy||!contentScope} onChange={e=>setPostprocess({...postprocess,trim_end_seconds:e.target.valueAsNumber})}/></label>
        <label className="video-field">播放倍率<input aria-label="播放倍率" type="number" min={0.1} max={4} step={0.1} value={Number.isFinite(postprocess.speed)?postprocess.speed:''} disabled={busy||!contentScope} onChange={e=>setPostprocess({...postprocess,speed:e.target.valueAsNumber})}/><input type="range" aria-label="播放倍率滑条" min={0.1} max={4} step={0.1} value={Number.isFinite(postprocess.speed)?postprocess.speed:0.1} disabled={busy||!contentScope} onChange={e=>setPostprocess({...postprocess,speed:e.target.valueAsNumber})}/><small>0.1–4.0 ×，每步 0.1</small></label>
      </div>
      {postprocessError?<p role="alert" className="video-message video-message--error">{postprocessError}</p>:<p className="video-field-hint">{current?.video?`原始 ${current.video.duration_seconds.toFixed(2)} 秒 → 处理后 ${processedDuration?.toFixed(2)} 秒`:'生成候选后即可预览'} · 首尾裁剪对齐视频帧</p>}
      <div className="video-postprocess-actions"><button type="button" className="button button--primary" disabled={busy||!contentScope||Boolean(postprocessError)||!unapplied} onClick={()=>{setAppliedPostprocess(normalizeVideoPostprocess(postprocess));history.checkpoint();}}>应用</button>
      <button type="button" className="button button--quiet" disabled={busy||!contentScope} onClick={()=>{history.checkpoint();setPostprocess({...defaultVideoPostprocess});}}>重置后处理</button></div>
      {unapplied&&<p className="video-field-hint" role="status">参数尚未应用，右侧保留上次应用的预览；点击应用或保存即可更新。</p>}
    </section>
    <p className="video-field-hint">{dirty?'有未保存修改':'已保存'}</p>
    </div>
    {!compact&&<aside className="page-images video-page-preview" aria-label="动态页预览">{results}</aside>}
    </div>
    {compact&&<div className="mobile-generate-bar video-mobile-actions" aria-label="页面操作">{editingActions}<button type="button" className="button button--quiet" aria-haspopup="dialog" aria-expanded={previewOpen} onClick={()=>setPreviewOpen(true)}>候选 {candidates.length}</button></div>}
    {previewOpen&&compact&&<Modal size="workspace" title="视频候选" subtitle={page.title} className="video-preview-modal" onClose={()=>setPreviewOpen(false)}>{results}</Modal>}
    {largeOpen&&previewUrl&&!appliedError&&<ZoomableImageLightbox src={previewUrl} fullResolutionOnly alt="动态后处理预览" footer={<span>{page.title} · Seed {current?.seed}</span>} onClose={()=>setLargeOpen(false)}/>}
    {sourceOpen&&<Modal title="导入候选图" subtitle="选择后复制为本页输入图" className="video-source-modal" onClose={()=>setSourceOpen(false)} busy={busy}>
      {error&&<p role="alert" className="video-message video-message--error">{error}</p>}
      <label className="video-field">来源页面<select aria-label="来源页面" disabled={busy} value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">选择插画页</option>{eligible.map(p=><option key={p.page_id} value={p.page_id}>{p.title}</option>)}</select></label>
      <div className="video-source-candidates">{sourceCandidates.map(c=><button type="button" key={c.candidate_id} disabled={busy} onClick={()=>void run(()=>importImage(c))} aria-label={`导入候选 Seed ${c.seed}`}><img src={c.url} alt={`候选 Seed ${c.seed}`}/><small>Seed {c.seed}</small></button>)}</div>
      {sourceId&&!sourceCandidates.length&&<p className="video-field-hint">此页暂无候选，可选择其他页面。</p>}
    </Modal>}
    {detail&&<Modal title="候选生成详情" subtitle={`Seed ${detail.seed??'—'}`} className="candidate-detail-dialog" onClose={()=>setDetail(null)}><GenerationDetailsPanel details={detail.generation}/></Modal>}
  </section>;
}
