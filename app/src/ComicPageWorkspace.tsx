import {useDraftHistory} from './use-draft-history';
import {usePageChanges} from './use-page-changes';
import {Popover} from './Popover';
import ZoomableImageLightbox from './ImageLightbox';
import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import type {WorkbenchPageEditorProps} from './WorkbenchPageEditor';
import type {WorkbenchPage,EditableWorkbenchPage,PageMedia} from './project-workbench-client';
import {loadPageMedia,loadProjectWorkbench,isEditablePage} from './project-workbench-client';
import type {LetteringLocale} from './page-translations';
import {comicAction} from './comic-client';
import {comicGeometry,comicPanelDimensions,updateComicNode,type ComicDocument,type ComicBox} from '../shared/comic-layout.mjs';
import {useFeedback} from './feedback';
import {useSaveShortcut} from './use-save-shortcut';
import {startFinishedPage} from './finished-client';
import './comic.css';
import canvasChoices from '../shared/canvas-presets.json';

export type ComicPanelControls={active:boolean;busy:boolean;saveRef:{current:(()=>Promise<boolean>)|null};discardRef:{current:(()=>void)|null};layoutDirty:boolean;layoutVersion:string;saveLayout:()=>Promise<boolean>;onDirtyChange:(dirty:boolean)=>void;onPageChanged:(page:WorkbenchPage,patch:Partial<WorkbenchPage>)=>void;selectedCandidateId:string|null;onSelectCandidate:(id:string)=>void;comicPreview:NonNullable<WorkbenchPageEditorProps['comicPreview']>;onTrackedTasksChange:(projectId:string,ids:string[])=>void};
type Props={pageOrder:number;editorResizer:ReactNode;projectId:string;page:EditableWorkbenchPage;busy:boolean;letteringLocale:LetteringLocale;renderPanel:(page:EditableWorkbenchPage,controls:ComicPanelControls)=>ReactNode;onReload:()=>Promise<void>;onPageChanged:(target:WorkbenchPage,patch:Partial<WorkbenchPage>)=>void;onTrackedTasksChange:(projectId:string,ids:string[])=>void};
const position=(box:ComicBox):CSSProperties=>({left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

export function ComicPageWorkspace(props:Props) {
  const {projectId,page}=props,comic=page.comic!;
  const {notify,confirm}=useFeedback();
  const [fullscreen,setFullscreen]=useState(false);
  const [letteringEditorTarget,setLetteringEditorTarget]=useState<HTMLDivElement|null>(null);
  const [document,setDocument]=useState(comic.document),[baseline,setBaseline]=useState(JSON.stringify(comic.document));
  const version=useRef(comic.sha256),[pages,setPages]=useState(comic.panels);
  const pagesRef=useRef(pages);pagesRef.current=pages;
  const [view,setView]=useState('whole');
  const [active,setActive]=useState(comic.document.order[0]),[mode,setMode]=useState<'layout'|'lettering'>('layout');
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const [media,setMedia]=useState<Record<string,PageMedia>>({}),[mediaError,setMediaError]=useState('');
  const [dirty,setDirty]=useState<Record<string,boolean>>({});
  const [targets,setTargets]=useState<Record<string,HTMLSpanElement|null>>({});
  const targetRefs=useRef<Record<string,(node:HTMLSpanElement|null)=>void>>({});
  const saves=useRef<Record<string,{current:(()=>Promise<boolean>)|null}>>({});
  const discards=useRef<Record<string,{current:(()=>void)|null}>>({});
  const [historyEpoch,setHistoryEpoch]=useState(0);
  const layoutHistory=useDraftHistory(document,setDocument,`${projectId}:${page.page_id}:${[...document.order].sort().join(',')}:${historyEpoch}`,view==='whole'&&mode==='layout');
  const canvasRef=useRef<HTMLDivElement>(null),alive=useRef(true);
  const committed=useRef(comic.document);
  const panelTasks=useRef<Record<string,string[]>>({}),taskCallbacks=useRef<Record<string,(projectId:string,ids:string[])=>void>>({});
  const localDocument=useRef(document);localDocument.current=document;
  const layoutDirty=JSON.stringify(document)!==baseline;
  const dirtyRef=useRef(false);dirtyRef.current=layoutDirty;
  const geometry=comicGeometry(document);
  const disabled=props.busy||pending;
  const panelSignature=JSON.stringify(comic.panels.map(panel=>[panel.page_id,panel.content_sha256,panel.prompt_sha256,panel.render_sha256,panel.layout_sha256]));
  useEffect(()=>{
    setPages(comic.panels);
    if(!dirtyRef.current){setDocument(comic.document);setBaseline(JSON.stringify(comic.document));version.current=comic.sha256;committed.current=comic.document;}
  },[comic.sha256,panelSignature]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;props.onTrackedTasksChange(projectId,[]);};},[projectId]);
  const orderKey=document.order.join(',');
  useEffect(()=>{
    if(view!=='whole')return;
    let cancelled=false,timer:number;
    async function refresh(){
      try {
        const entries=await Promise.all(document.order.map(async id=>[id,(await loadPageMedia(projectId,{page_id:id}))?.media??{candidates:[]} ] as const));
        if(!cancelled){setMedia(Object.fromEntries(entries));setMediaError('');}
      }catch(cause){if(!cancelled)setMediaError(message(cause));}
      if(!cancelled)timer=window.setTimeout(refresh,2500);
    }
    void refresh();return()=>{cancelled=true;clearTimeout(timer);};
  },[projectId,orderKey,view]);
  function updatePanel(patch:Partial<ComicDocument['panels'][string]>) {
    setDocument(value=>({...value,panels:{...value.panels,[active]:{...value.panels[active],...patch}}}));
  }
  function publish(){props.onPageChanged(page,{...pagesRef.current.find(panel=>panel.page_id===page.page_id),comic:{document:committed.current,sha256:version.current,panels:pagesRef.current}});}
  function patchPage(id:string,patch:Partial<WorkbenchPage>){
    pagesRef.current=pagesRef.current.map(panel=>({...panel,...(panel.page_id===id?patch:{}),...(patch.layout_sha256?{layout_sha256:patch.layout_sha256}:{})}));setPages(pagesRef.current);publish();
  }
  const layoutSaving=useRef<Promise<boolean>|null>(null);
  function saveLayout():Promise<boolean>{
    if(layoutSaving.current)return layoutSaving.current;
    const snapshot=structuredClone(localDocument.current);
    if(JSON.stringify(snapshot)===JSON.stringify(committed.current))return Promise.resolve(true);
    setPending(true);setError('');
    const operation=(async()=>{try{const result=await comicAction(projectId,page.page_id,'save',{expected_sha256:version.current,document:snapshot});if(!alive.current)return false;version.current=result.sha256;committed.current=result.document;setBaseline(JSON.stringify(result.document));publish();return true;}catch(cause){if(alive.current)setError(`保存未完成，草稿已保留：${message(cause)}`);return false;}finally{layoutSaving.current=null;if(alive.current)setPending(false);}})();
    layoutSaving.current=operation;return operation;
  }
  const saving=useRef(false);
  async function saveAll() {
    if(saving.current)return false;
    saving.current=true;setPending(true);setError('');
    try {
      for(const id of localDocument.current.order)if(saves.current[id]?.current&&!await saves.current[id].current!()){if(alive.current){setActive(id);setView(id);setError(`分镜 ${localDocument.current.order.indexOf(id)+1} 未保存，请检查此格的提示。`);}return false;}
      if(!await saveLayout())return false;
      if(alive.current){publish();notify({kind:'success',message:'整页分镜已保存'});}
      return true;
    }catch(cause){if(alive.current)setError(`保存未完成，草稿已保留：${message(cause)}`);return false;}
    finally{saving.current=false;if(alive.current)setPending(false);}
  }
  function discardAll(){for(const target of Object.values(discards.current))target.current?.();setDocument(structuredClone(committed.current));setHistoryEpoch(value=>value+1);setError('');}
  usePageChanges(`${projectId}:${page.page_id}`,{dirty:layoutDirty||Object.values(dirty).some(Boolean),save:saveAll});
  useSaveShortcut(()=>{void saveAll();},`${projectId}:${page.page_id}:comic`,view==='whole');
  async function split(axis:'x'|'y'){
    if(!await saveAll())return;
    setPending(true);
    try{
      const result=await comicAction(projectId,page.page_id,'split',{expected_sha256:version.current,panel_id:active,axis});
      const loaded=await loadProjectWorkbench(projectId,undefined,{kind:'page',page_id:page.page_id});
      if(!alive.current)return;
      const root=loaded.view.outline.chapters.flatMap(chapter=>chapter.sequences.flatMap(sequence=>sequence.pages)).find(entry=>entry.page_id===page.page_id)!;
      props.onPageChanged(page,root);setDocument(root.comic!.document);setPages(root.comic!.panels);setBaseline(JSON.stringify(root.comic!.document));version.current=root.comic!.sha256;committed.current=root.comic!.document;setActive(result.panel_id!);setView(result.panel_id!);
    }catch(cause){if(alive.current)setError(message(cause));}finally{if(alive.current)setPending(false);}
  }
  async function output(){
    if(!await saveAll())return;
    setPending(true);
    try{await startFinishedPage(projectId,page.page_key,undefined,props.letteringLocale);if(alive.current)notify({kind:'success',message:'已提交整页成品，可在成品页查看进度与结果'});}
    catch(cause){if(alive.current)setError(message(cause));}finally{if(alive.current)setPending(false);}
  }
  function startDivider(event:React.PointerEvent<HTMLButtonElement>,divider:typeof geometry.dividers[number]){
    if(disabled)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    const rect=canvasRef.current!.getBoundingClientRect(),original=document.layout;
    const move=(next:PointerEvent)=>{
      const point=divider.axis==='x'?(next.clientX-rect.x)/rect.width:(next.clientY-rect.y)/rect.height;
      const origin=divider.axis==='x'?divider.box.x:divider.box.y,length=divider.axis==='x'?divider.box.w:divider.box.h;
      const gap=Math.min(document.gutter/(divider.axis==='x'?geometry.width:geometry.height),length*.08);
      const ratio=Math.max(.1,Math.min(.9,(point-origin-gap/2)/(length-gap)));
      setDocument(value=>({...value,layout:updateComicNode(original,divider.id,node=>'page_id'in node?node:{...node,ratio})}));
    };
    const target=event.currentTarget;
    const end=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',end,{once:true});target.addEventListener('pointercancel',end,{once:true});
  }
  function reorder(id:string,to:number){setDocument(value=>{const order=value.order.filter(item=>item!==id);order.splice(Math.max(0,Math.min(order.length,to)),0,id);const remap=(node:ComicDocument['layout']):ComicDocument['layout']=>'page_id'in node?{page_id:order[value.order.indexOf(node.page_id)]}:{...node,first:remap(node.first),second:remap(node.second)};return {...value,order,layout:remap(value.layout)};});}
  function startOrder(event:React.PointerEvent<HTMLButtonElement>,id:string){
    if(disabled)return;event.preventDefault();const target=event.currentTarget;target.setPointerCapture(event.pointerId);
    const move=(next:PointerEvent)=>{const tabs=Array.from(target.closest('.comic-tabs')!.querySelectorAll<HTMLElement>('[data-panel-tab]'));const hit=tabs.find(node=>{const rect=node.getBoundingClientRect();return next.clientX>=rect.left&&next.clientX<=rect.right;});if(hit)reorder(id,Number(hit.dataset.panelTab));};
    const end=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',end,{once:true});target.addEventListener('pointercancel',end,{once:true});
  }
  function startCrop(event:React.PointerEvent<HTMLButtonElement>,id:string){
    setActive(id);if(disabled||mode!=='layout'||fullscreen)return;
    event.preventDefault();const target=event.currentTarget,img=target.querySelector('img');if(!img?.naturalWidth||!img.naturalHeight)return;
    target.setPointerCapture(event.pointerId);const rect=target.getBoundingClientRect(),crop={...localDocument.current.panels[id].crop};
    const cover=Math.max(rect.width/img.naturalWidth,rect.height/img.naturalHeight),overflowX=img.naturalWidth*cover*crop.zoom-rect.width,overflowY=img.naturalHeight*cover*crop.zoom-rect.height;
    const move=(next:PointerEvent)=>setDocument(value=>({...value,panels:{...value.panels,[id]:{...value.panels[id],crop:{...crop,x:overflowX>1?Math.max(0,Math.min(1,crop.x-(next.clientX-event.clientX)/overflowX)):crop.x,y:overflowY>1?Math.max(0,Math.min(1,crop.y-(next.clientY-event.clientY)/overflowY)):crop.y}}}}));
    const end=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',end,{once:true});target.addEventListener('pointercancel',end,{once:true});
  }
  // 原生非 passive 监听只在画布内截获滚轮，不影响左侧编辑区滚动。
  useEffect(()=>{const canvas=canvasRef.current;if(!canvas||mode!=='layout'||fullscreen||disabled)return;
    const wheel=(event:WheelEvent)=>{const frame=(event.target as Element).closest<HTMLElement>('[data-crop-panel]');if(!frame)return;event.preventDefault();const id=frame.dataset.cropPanel!;setActive(id);setDocument(value=>{const panel=value.panels[id];return {...value,panels:{...value.panels,[id]:{...panel,crop:{...panel.crop,zoom:Math.max(1,Math.min(4,panel.crop.zoom*Math.exp(-event.deltaY*.0015)))}}}};});};
    canvas.addEventListener('wheel',wheel,{passive:false});return()=>canvas.removeEventListener('wheel',wheel);
  },[mode,fullscreen,disabled]);
  async function restore(){
    if(document.order.length>1&&!await confirm({kind:'warning',title:'拆回独立页',message:'按当前阅读顺序拆回独立页，保留每格的文案、Prompt 和所有图片。整页布局将移除。',confirmLabel:'拆回独立页'}))return;
    if(!await saveAll())return;setPending(true);
    try{await comicAction(projectId,page.page_id,'restore',{expected_sha256:version.current});await props.onReload();notify({kind:'success',message:'已恢复独立页面，内容与图片均保留'});}catch(cause){setError(message(cause));}finally{if(alive.current)setPending(false);}
  }
  const selected=document.panels[active],dimensions=comicPanelDimensions(document,active);
  const preview=<div ref={canvasRef} className={`comic-canvas is-${fullscreen?'preview':mode}`} style={{aspectRatio:`${geometry.width}/${geometry.height}`,'--comic-aspect':geometry.width/geometry.height} as CSSProperties}>
        {document.order.map((id,index)=>{
          targetRefs.current[id]??=node=>setTargets(value=>value[id]===node?value:{...value,[id]:node});
          const box=geometry.frames[id],settings=document.panels[id],candidate=media[id]?.candidates.find(item=>item.candidate_id===settings.candidate_id);
          return <div key={id} className={`comic-frame ${!fullscreen&&active===id?'is-active':''}`} style={position(box)}>
            <button className="comic-frame-image" data-crop-panel={id} onPointerDown={event=>startCrop(event,id)} aria-label={`选择分镜 ${index+1}`} onClick={()=>setActive(id)}>{candidate?<img src={candidate.url} alt={`分镜 ${index+1}`} draggable={false} style={{objectPosition:`${settings.crop.x*100}% ${settings.crop.y*100}%`,transform:`scale(${settings.crop.zoom})`,transformOrigin:`${settings.crop.x*100}% ${settings.crop.y*100}%`}}/>:<span>分镜 {index+1}<small>{settings.candidate_id?'选定图片暂不可用':'尚未选图'}</small></span>}</button>
            <span className="comic-frame-number">{index+1}</span>
          </div>;
        })}
        {document.order.map(id=><span key={`text-${id}`} className="comic-lettering-target" style={position(geometry.frames[id])} ref={targetRefs.current[id]}/>)}
        {!fullscreen&&mode==='layout'&&geometry.dividers.map(divider=><button key={divider.id} className={`comic-divider is-${divider.axis}`} aria-label={divider.axis==='x'?'调整左右分隔线':'调整上下分隔线'} disabled={disabled} style={{...position(divider.box),...(divider.axis==='x'?{left:`${(divider.box.x+divider.box.w*divider.position)*100}%`,width:12}:{top:`${(divider.box.y+divider.box.h*divider.position)*100}%`,height:12})}} title="拖动调整；双击恢复 50%" onDoubleClick={()=>setDocument(value=>({...value,layout:updateComicNode(value.layout,divider.id,node=>'page_id'in node?node:{...node,ratio:.5})}))} onPointerDown={event=>startDivider(event,divider)} onKeyDown={event=>{if(event.key==='Home'){event.preventDefault();setDocument(value=>({...value,layout:updateComicNode(value.layout,divider.id,node=>'page_id'in node?node:{...node,ratio:.5})}));return;}const delta=['ArrowRight','ArrowDown'].includes(event.key)?.02:['ArrowLeft','ArrowUp'].includes(event.key)?-.02:0;if(!delta)return;event.preventDefault();setDocument(value=>({...value,layout:updateComicNode(value.layout,divider.id,node=>'page_id'in node?node:{...node,ratio:Math.max(.1,Math.min(.9,node.ratio+delta))})}));}}/>) }
      </div>;
  return <div data-project-fact-dirty={layoutDirty||Object.values(dirty).some(Boolean)?'true':undefined} className="comic-page-shell">
    <div role="tablist" aria-label="页面与分镜" className="comic-tabs">
      <span className={view==='whole'?'is-active':''}><button role="tab" aria-label="整页" aria-selected={view==='whole'} onClick={()=>setView('whole')}>整页{layoutDirty&&<i aria-label="有未保存修改"/>}</button></span>
      {document.order.map((id,index)=><span key={id} data-panel-tab={index} className={view===id?'is-active':''}><button className="comic-order-handle page-reorder-handle" title="拖动排序；左右方向键也可调整" aria-label={`拖动排序分镜 ${index+1}`} disabled={disabled} onPointerDown={event=>startOrder(event,id)} onKeyDown={event=>{const delta=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;if(delta){event.preventDefault();reorder(id,index+delta);}}}><svg viewBox="0 0 12 18" aria-hidden="true">{[4,9,14].flatMap(y=>[3,8].map(x=><circle key={`${x}:${y}`} cx={x} cy={y} r="1.2"/>))}</svg></button><button role="tab" aria-label={`分镜 ${index+1}`} aria-selected={view===id} onClick={()=>{setActive(id);setView(id);}}>分镜 {index+1}{dirty[id]&&<i aria-label="有未保存修改"/>}</button></span>)}
    </div>
    {error&&<p role="alert" className="prompt-save-error">{error}</p>}
    <div className="comic-view" hidden={view!=='whole'}>
      <div className="story-layout current-workbench-page comic-workspace">
        <section className="document-editor comic-whole-settings">
          <h3>整页 · {page.title}</h3><p>{mode==='layout'?'调整分格和裁切；切换分镜标签可编辑 Prompt 和候选。':'编辑当前分镜文案，在预览中拖动文字；允许跨格排版。'}</p>
          <div className="comic-panel-list">{document.order.map((id,index)=><button key={id} className="button" aria-pressed={active===id} onClick={()=>setActive(id)}>分镜 {index+1} · {pages.find(panel=>panel.page_id===id)?.title}</button>)}</div>
          {mode==='layout'&&<fieldset disabled={disabled} className="comic-image-settings"><legend>分镜 {document.order.indexOf(active)+1}</legend><button className="button" onClick={()=>setView(active)}>编辑此分镜</button>
            <label>生成画幅<select value={selected.size_mode} onChange={event=>updatePanel({size_mode:event.target.value as 'panel'|'preset'})}><option value="panel">按格子比例 · {dimensions.width} × {dimensions.height}</option><option value="preset">使用分镜预设画幅</option></select></label>
            <small>拖动图片移动取景，滚轮缩放；双击分隔线恢复 50%。选图请在分镜候选区点击“用于整页”。</small>
            {mediaError&&<p role="alert">{mediaError}</p>}
          </fieldset>}
          <div className="comic-lettering-editor" ref={setLetteringEditorTarget} hidden={mode!=='lettering'}/>
        </section>
        {props.editorResizer}
    <aside className="comic-preview-column">
      <div className="comic-toolbar"><strong>整页预览</strong><select aria-label="整页画幅" disabled={disabled} value={document.canvas} onChange={event=>setDocument(value=>({...value,canvas:event.target.value}))}>{canvasChoices.map(choice=><option key={choice.value} value={choice.value}>{choice.label} {choice.value}</option>)}</select><button className="button" aria-pressed={mode==='layout'} onClick={()=>setMode('layout')}>版式 / 裁切</button><button className="button" aria-pressed={mode==='lettering'} onClick={()=>{setMode('lettering');}}>嵌字</button><button className="button" onClick={()=>setFullscreen(true)}>全屏预览</button></div>
      {fullscreen?<ZoomableImageLightbox fullResolutionOnly content={{width:geometry.width*2,height:geometry.height*2,children:preview}} alt="整页放大预览" footer={page.title} onClose={()=>setFullscreen(false)}/>:preview}
      <div className="page-output-toolbar"><div className="comic-page-actions mobile-generate-bar"><button className="button button--quiet" disabled={disabled||!layoutHistory.canUndo} onClick={layoutHistory.undo}>撤销布局</button><button className="button button--quiet" disabled={disabled||!layoutHistory.canRedo} onClick={layoutHistory.redo}>重做布局</button><button className="button button--quiet" disabled={disabled||!layoutDirty&&!Object.values(dirty).some(Boolean)} onClick={discardAll}>放弃修改</button><button className="button button--primary" disabled={disabled||!layoutDirty&&!Object.values(dirty).some(Boolean)} onClick={()=>void saveAll()}>保存整页</button></div><button className="button" disabled={disabled||document.order.some(id=>!document.panels[id].candidate_id)} onClick={()=>void output()}>输出整页成品</button></div>
      <div className="comic-panel-actions"><button className="button" disabled={disabled||document.order.length>=12||mode!=='layout'} onClick={()=>void split('y')}>上下切分</button><button className="button" disabled={disabled||document.order.length>=12||mode!=='layout'} onClick={()=>void split('x')}>左右切分</button><Popover className="comic-options"><summary className="button">裁切与版式设置</summary><div className="comic-options-panel">
        <label>横向取景<input aria-label="横向取景" type="range" min="0" max="1" step=".01" value={selected.crop.x} onChange={event=>updatePanel({crop:{...selected.crop,x:Number(event.target.value)}})}/></label>
        <label>纵向取景<input aria-label="纵向取景" type="range" min="0" max="1" step=".01" value={selected.crop.y} onChange={event=>updatePanel({crop:{...selected.crop,y:Number(event.target.value)}})}/></label>
        <label>放大裁切<input aria-label="放大裁切" type="range" min="1" max="4" step=".05" value={selected.crop.zoom} onChange={event=>updatePanel({crop:{...selected.crop,zoom:Number(event.target.value)}})}/></label>
        <button className="button" disabled={disabled} onClick={()=>updatePanel({crop:{x:.5,y:.5,zoom:1}})}>重置本格取景</button>
        <label>页边距<input aria-label="页边距" type="range" min="0" max="64" value={document.margin} onChange={event=>setDocument(value=>({...value,margin:Number(event.target.value)}))}/><output>{document.margin}</output></label>
        <label>格间距<input aria-label="格间距" type="range" min="0" max="64" value={document.gutter} onChange={event=>setDocument(value=>({...value,gutter:Number(event.target.value)}))}/><output>{document.gutter}</output></label>
        <button className="button" disabled={disabled} onClick={()=>void restore()}>{document.order.length===1?'恢复单页':'拆回独立页'}</button>
      </div></Popover></div>
    </aside>
      </div>
    </div>
    {document.order.map(id=>{
      const panel=pages.find(entry=>entry.page_id===id);if(!panel||!isEditablePage(panel))return null;
      const box=geometry.frames[id];saves.current[id]??={current:null};discards.current[id]??={current:null};
      taskCallbacks.current[id]??=(_projectId,ids)=>{panelTasks.current[id]=ids;props.onTrackedTasksChange(projectId,[...new Set(Object.values(panelTasks.current).flat())]);};
      return <div key={id} className="comic-view comic-panel-view" hidden={view!==id}>{props.renderPanel(panel,{active:view===id,busy:disabled,layoutVersion:version.current,saveRef:saves.current[id],discardRef:discards.current[id],layoutDirty,saveLayout,onDirtyChange:value=>setDirty(previous=>previous[id]===value?previous:{...previous,[id]:value}),onPageChanged:(_source,patch)=>patchPage(id,patch),selectedCandidateId:document.panels[id].candidate_id,onSelectCandidate:candidateId=>setDocument(value=>({...value,panels:{...value.panels,[id]:{...value.panels[id],candidate_id:candidateId}}})),comicPreview:{target:targets[id]??null,pageCanvas:document.canvas,canvas:`${box.w*geometry.width}:${box.h*geometry.height}`,frame:box,visible:view==='whole',editorTarget:view==='whole'&&mode==='lettering'&&active===id?letteringEditorTarget:null,interactive:!fullscreen&&mode==='lettering',onSelect:()=>setActive(id)},onTrackedTasksChange:taskCallbacks.current[id]})}</div>;
    })}
  </div>;
}
