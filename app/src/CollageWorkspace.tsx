import {CollageOpacityControl} from './CollageOpacityControl';
import {CollageLayerRow} from './CollageLayerRow';
import {useNavigationReorder,NavigationReorderHandle,navigationDropClass,navigationSourceClass,NavigationReorderPreviewOverlay} from './NavigationReorder';
import {useEffect,useRef,useState,type CSSProperties,type ReactNode,type PointerEvent} from 'react';
import {arrangeCollage,changeCollageCanvas,imagePlacement,visibleCollageItems,collageSourceIds,collageLimit,fullCrop,type CollageDocument,type CollageMedia,type Rect} from '../shared/collage-layout.mjs';
import {CanvasControl} from './CanvasControl';
import {CollageCanvas} from './CollageCanvas';
import {CollagePicker} from './CollagePicker';
import {CollageCrop} from './CollageCrop';
import {collageAction,collageAssetUrl,useCollageMedia,type CollageScope,type CollageChoice} from './collage-client';
import type {WorkbenchPage} from './project-workbench-client';
import {WorkspaceHeader,SectionHeader} from './WorkspaceHeader';
import {FinishedOutputButton} from './FinishedOutputButton';
import {startFinishedPage} from './finished-client';
import {usePageChanges} from './use-page-changes';
import {useSaveShortcut} from './use-save-shortcut';
import {useDraftHistory} from './use-draft-history';
import ZoomableImageLightbox from './ImageLightbox';
import {Modal} from './Modal';
import {readFacts,mutateTargetFacts} from './project-write-client';
import {responseJson} from './api-response';

type Layout=Pick<CollageDocument,'canvas'|'items'|'background'>;
const layoutOf=(doc:CollageDocument):Layout=>({canvas:doc.canvas,items:doc.items,background:doc.background});
export function CollageWorkspace({projectId,page,breadcrumb,editorResizer,onReload}:{projectId:string;page:WorkbenchPage;breadcrumb:string[];editorResizer:ReactNode;onReload:()=>Promise<unknown>}){
  const [scope,setScope]=useState<CollageScope>(page.collage!),[assets,setAssets]=useState(page.collage!.document.assets),[layout,setLayout]=useState(()=>layoutOf(page.collage!.document));
  const [rename,setRename]=useState<{title:string;args:Record<string,unknown>}|null>(null);
  const [transient,setTransient]=useState<Layout|null>(null),[selected,setSelected]=useState(''),[picker,setPicker]=useState<'foreground'|'background'|null>(null),[cropTarget,setCropTarget]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState('');
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width: 1160px)').matches),[previewOpen,setPreviewOpen]=useState(false);
  useEffect(()=>{const media=window.matchMedia('(max-width: 1160px)');const update=()=>{setCompact(media.matches);setPreviewOpen(false);gesture.current=null;setTransient(null);};media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const [pickedMedia,setPickedMedia]=useState<Record<string,CollageMedia>>({});
  const [externalVersion,setExternalVersion]=useState(0);
  const canvas=useRef<HTMLDivElement>(null),gesture=useRef<{id:string;mode:string;x:number;y:number;box:Rect;layout:Layout;width:number;height:number}|null>(null),saving=useRef(false);
  const activeAssets=(value:Layout)=>Object.fromEntries(Object.entries(assets).filter(([id])=>value.background?.asset_id===id||value.items.some(i=>i.asset_id===id)));
  const doc:CollageDocument={version:1,assets:activeAssets(transient??layout),...(transient??layout)},savedDoc:CollageDocument={version:1,assets:activeAssets(layout),...layout};
  const refreshedMedia=useCollageMedia(projectId,savedDoc),media={...pickedMedia,...refreshedMedia};
  // 交互框与渲染共用裁剪后的实际边界，避免空白区域拦截点击、缩放时跳位。
  const itemBox=(item:CollageDocument['items'][number])=>{const asset=media[item.asset_id];return asset&&!asset.error?imagePlacement(asset,item.box,item.crop,doc.canvas).box:item.box;};
  const displayedItems=visibleCollageItems(doc).map(item=>({...item,box:itemBox(item)}));
  const mediaReady=collageSourceIds(savedDoc).every(id=>media[id]&&!media[id].error);
  const dirty=JSON.stringify(layout)!==JSON.stringify(layoutOf(scope.document))||Object.entries(savedDoc.assets).some(([id,asset])=>JSON.stringify(asset)!==JSON.stringify(scope.document.assets[id]))||Boolean(transient);
  const modal=Boolean(picker||cropTarget||preview||rename||previewOpen);
  const history=useDraftHistory(layout,setLayout,`${projectId}:${page.page_id}:${externalVersion}`,!busy&&!transient&&!modal);
  const change=(next:Layout)=>{history.checkpoint();setLayout(layoutOf({...doc,...next}));};
  // 项目轮询可带回 Agent 的新保存；本地有草稿时保留并由服务端哈希拒绝覆盖。
  useEffect(()=>{if(!dirty&&page.collage&&page.collage.sha256!==scope.sha256){setScope(page.collage);setAssets(page.collage.document.assets);setExternalVersion(v=>v+1);setLayout(layoutOf(page.collage.document));}},[page.collage?.sha256]);
  async function save(){
    if(saving.current||transient||cropTarget)throw Error('请先完成当前调整');
    saving.current=true;setBusy(true);setError('');
    try{const result=await collageAction<CollageScope>(projectId,page.page_id,'save',{expected_sha256:scope.sha256,document:savedDoc});setScope(result);setAssets(current=>({...current,...result.document.assets}));await onReload();}
    finally{saving.current=false;setBusy(false);}
  }
  async function run(action:()=>Promise<unknown>){setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  usePageChanges(`${projectId}:${page.page_id}`,{dirty:dirty||Boolean(cropTarget),save:async()=>{try{await save();return true;}catch(e){setError(String(e));return false;}}});
  useSaveShortcut(()=>{if(!busy&&!modal&&!transient&&dirty)void run(save);},`${projectId}:${page.page_id}`);
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&(gesture.current)){gesture.current=null;setTransient(null);e.preventDefault();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[]);
  function begin(e:PointerEvent<HTMLElement>,id:string,mode:string){if(busy||e.button!==0)return;e.preventDefault();e.stopPropagation();const item=layout.items.find(i=>i.id===id)!,r=canvas.current!.getBoundingClientRect();setSelected(id);gesture.current={id,mode,x:e.clientX,y:e.clientY,box:itemBox(item),layout,width:r.width,height:r.height};e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.focus();}
  function move(e:PointerEvent<HTMLDivElement>){const g=gesture.current;if(!g)return;const dx=(e.clientX-g.x)/g.width,dy=(e.clientY-g.y)/g.height,b={...g.box};
    if(g.mode==='move'){b.x=Math.max(0,Math.min(1-b.w,b.x+dx));b.y=Math.max(0,Math.min(1-b.h,b.y+dy));}
    else {const w=b.w*g.width,h=b.h*g.height,scale=1+(dx*g.width*w+dy*g.height*h)/(w*w+h*h);const ratio=Math.min((1-b.x)/b.w,(1-b.y)/b.h,Math.max(.02/Math.min(b.w,b.h),scale));b.w*=ratio;b.h*=ratio;}
    setTransient({...g.layout,items:g.layout.items.map(i=>i.id===g.id?{...i,box:b}:i)});
  }
  function end(cancel=false){if(!gesture.current)return;if(!cancel&&transient)change(transient);gesture.current=null;setTransient(null);}
  function add(choices:CollageChoice[]){let next=structuredClone(savedDoc);const nextMedia={...media};const ids:string[]=[];for(const c of choices){const assetId=crypto.randomUUID();next.assets[assetId]=c.asset;nextMedia[assetId]=c.media;if(picker==='background'){next.background={asset_id:assetId,enabled:true,crop:fullCrop(),opacity:.45};break;}const id=crypto.randomUUID();ids.push(id);next.items.push({id,asset_id:assetId,enabled:true,box:fullCrop(),crop:fullCrop()});}if(ids.length)next=arrangeCollage(next,ids,nextMedia);setPickedMedia(nextMedia);setAssets(current=>({...current,...next.assets}));change(next);setSelected(ids.at(-1)??'');setPicker(null);}
  function remove(id=selected){change({...layout,items:layout.items.filter(i=>i.id!==id)});if(selected===id)setSelected('');}
  const layerLabel=(assetId:string)=>media[assetId]?.label??assets[assetId]?.page_id??'来源已移除';
  const reorder=useNavigationReorder(drop=>{
    if(busy||!drop.targetId||drop.kind!=='collage-layer'||drop.id===drop.targetId)return;
    const displayed=layout.items,item=displayed.find(i=>i.id===drop.id);if(!item)return;
    const next=displayed.filter(i=>i.id!==drop.id),index=next.findIndex(i=>i.id===drop.targetId);if(index<0)return;
    next.splice(index+(drop.placement==='after'?1:0),0,item);change({...layout,items:next});
  });
  const cropItem=cropTarget==='background'?doc.background:doc.items.find(i=>i.id===cropTarget);
  const editingActions=<><button className="button" disabled={busy||!history.canUndo||Boolean(transient)} onClick={history.undo}>撤销</button><button className="button" disabled={busy||!history.canRedo||Boolean(transient)} onClick={history.redo}>重做</button><button className="button button--primary" disabled={busy||!dirty||Boolean(transient)} onClick={()=>void run(save)}>{busy?'处理中…':'保存'}</button></>;
  const outputAction=<FinishedOutputButton projectId={projectId} pageId={page.page_id} dirty={dirty} dirtyLabel="保存并输出成品" disabled={busy||Boolean(transient)||!mediaReady||(!visibleCollageItems(doc).length&&!doc.background?.enabled)} onOutput={async()=>{if(dirty)await save();return (await startFinishedPage(projectId,page.page_key)).job;}}/>;
  const results=<>
    {compact?<p className="collage-preview-hint">拖动图片，右下角等比缩放。</p>:<SectionHeader title="组图预览" description="拖动图片，右下角等比缩放；方向键微调，Shift 加速。"/>}
    <div className="collage-preview-surface" style={{'--preview-aspect':doc.canvas.replace(':',' / ')} as CSSProperties}>
      <div className="collage-stage" ref={canvas}>
      <CollageCanvas projectId={projectId} document={doc} media={media}>
        {displayedItems.map(item=><div key={item.id} className={`collage-handle ${selected===item.id?'is-selected':''}`} role="button" aria-label={layerLabel(item.asset_id)} aria-pressed={selected===item.id} tabIndex={busy?-1:0} style={{left:`${item.box.x*100}%`,top:`${item.box.y*100}%`,width:`${item.box.w*100}%`,height:`${item.box.h*100}%`}} onPointerDown={e=>begin(e,item.id,'move')} onPointerMove={move} onPointerUp={()=>end()} onPointerCancel={()=>end(true)} onKeyDown={e=>{if(busy)return;if(e.key==='Escape'){end(true);return;}if((e.key==='Delete'||e.key==='Backspace')&&selected===item.id){e.preventDefault();remove();return;}const delta=e.shiftKey?.02:.005,offset:Record<string,number[]>={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]};if(offset[e.key]){e.preventDefault();setSelected(item.id);const [dx,dy]=offset[e.key];change({...layout,items:layout.items.map(i=>i.id===item.id?{...i,box:{...item.box,x:Math.max(0,Math.min(1-item.box.w,item.box.x+dx)),y:Math.max(0,Math.min(1-item.box.h,item.box.y+dy))}}:i)});}}} onFocus={()=>setSelected(item.id)}><span className="collage-resize" aria-hidden="true" onPointerDown={e=>begin(e,item.id,'resize')}/></div>)}
        {!visibleCollageItems(doc).length&&!doc.background?.enabled&&<span className="collage-empty">添加或启用图片，开始排列组图</span>}
      </CollageCanvas>
    </div>
    </div>
    <div className="page-output-toolbar collage-output-toolbar">{!compact&&editingActions}<button className="button" disabled={busy||!mediaReady||Boolean(transient)} onClick={()=>void run(async()=>{const p=await collageAction<{url:string}>(projectId,page.page_id,'preview',{document:savedDoc});setPreview(p.url);})}>查看合成图</button>{outputAction}</div>
  </>;
  return <section className="collage-workspace" data-page-content-dirty={dirty||Boolean(cropTarget)}>
    <div className="story-layout current-workbench-page">
      <div className="document-editor collage-editor" aria-label="组图参数">
    <WorkspaceHeader breadcrumb={breadcrumb} title={<button className="inline-title-trigger" aria-label="修改组图标题" disabled={busy} onClick={()=>void run(async()=>{const value=await responseJson<{document:{title:string};save:{args:Record<string,unknown>}}>(await readFacts('/api/agent/page-editor',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,page_key:page.page_key,section:'content'})}));setRename({title:value.document.title,args:value.save.args});})}>{page.title}</button>} meta="组图页"/>
        {error&&<p role="alert">{error}</p>}
        <section className="collage-editor-section"><SectionHeader title="画布" actions={<div className="page-generation-settings page-generation-settings--compact"><CanvasControl value={doc.canvas} disabled={busy} onChange={canvas=>change(changeCollageCanvas(savedDoc,canvas))}/></div>}/></section>
        <div className="collage-inspector">
          <section className="collage-editor-section"><SectionHeader title="背景" description="黑底上的背景图，固定在所有图片下方。"/>
            <fieldset disabled={busy}>{doc.background?<>
              <div className={`collage-layer-row collage-layer-row--background ${doc.background.enabled?'':'is-disabled'}`}><CollageLayerRow projectId={projectId} media={media[doc.background.asset_id]} label={layerLabel(doc.background.asset_id)} background disabled={busy} enabled={doc.background.enabled} onEnabledChange={enabled=>change({...layout,background:{...doc.background!,enabled}})} onSelect={()=>setPicker('background')} onCrop={()=>setCropTarget('background')} onRemove={()=>change({...layout,background:null})}/></div>
              <CollageOpacityControl value={doc.background.opacity} disabled={busy||!doc.background.enabled} onChange={opacity=>change({...layout,background:{...doc.background!,opacity}})}/>
            </>:<button className="button" onClick={()=>setPicker('background')}>选择背景图</button>}</fieldset>
          </section>
          <section className="collage-editor-section"><SectionHeader title="图片" description="按住手柄拖动排序；列表按选择顺序排列，后面的图片叠在上层。"/>
            <fieldset disabled={busy}><div className="collage-toolbar"><button className="button" disabled={busy||doc.items.length>=collageLimit} onClick={()=>setPicker('foreground')}>添加图片 · {doc.items.length}/{collageLimit}</button><button className="button" disabled={busy||!visibleCollageItems(doc).length||!mediaReady} onClick={()=>change(arrangeCollage(savedDoc,undefined,media))}>重新平铺</button></div>
              <div className="collage-layer-list">{doc.items.map(item=><div key={item.id} data-nav-kind="collage-layer" data-nav-id={item.id} data-nav-group={page.page_id} className={['collage-layer-row',item.enabled?'':'is-disabled',selected===item.id?'is-selected':'',navigationDropClass(reorder,'collage-layer',item.id),navigationSourceClass(reorder,'collage-layer',item.id)].filter(Boolean).join(' ')}>
                <CollageLayerRow projectId={projectId} media={media[item.asset_id]} label={layerLabel(item.asset_id)} selected={selected===item.id} disabled={busy} enabled={item.enabled} onEnabledChange={enabled=>change({...layout,items:layout.items.map(i=>i.id===item.id?{...i,enabled}:i)})} handle={<NavigationReorderHandle label={layerLabel(item.asset_id)} source={{kind:'collage-layer',id:item.id,group:page.page_id,title:layerLabel(item.asset_id)}} reorder={reorder}/>} onSelect={()=>setSelected(item.id)} onCrop={()=>setCropTarget(item.id)} onRemove={()=>remove(item.id)}/>
              </div>)}</div>
            </fieldset>
          </section>
        </div>
        <NavigationReorderPreviewOverlay reorder={reorder}/>
      </div>
      {editorResizer}
      {!compact&&<aside className="page-images collage-preview" aria-label="组图预览">{results}</aside>}
    </div>
    {compact&&<div className="mobile-generate-bar collage-mobile-actions" aria-label="页面操作">{editingActions}<button className="button" aria-haspopup="dialog" aria-expanded={previewOpen} onClick={()=>setPreviewOpen(true)}>预览组图</button></div>}
    {compact&&previewOpen&&<Modal size="workspace" title="组图预览" subtitle={page.title} className="collage-preview-modal" onClose={()=>{end(true);setPreviewOpen(false);}}>{results}</Modal>}
    {rename&&<Modal title="组图标题" busy={busy} onClose={()=>setRename(null)} footer={<button className="button button--primary" disabled={busy||!rename.title.trim()} onClick={()=>void run(async()=>{await responseJson(await mutateTargetFacts('/api/agent/page-editor/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...rename.args,changes:{title:rename.title}})},projectId));setRename(null);await onReload();})}>保存标题</button>}><input aria-label="组图标题" autoFocus value={rename.title} onChange={e=>setRename({...rename,title:e.target.value})}/></Modal>}
    {picker&&<CollagePicker excluded={picker==='foreground'?doc.items.map(i=>assets[i.asset_id].page_id):[]} projectId={projectId} pageId={page.page_id} limit={picker==='background'?1:collageLimit-doc.items.length} onAdd={add} onClose={()=>setPicker(null)}/>}
    {cropTarget&&cropItem&&<CollageCrop canvas={cropTarget==='background'?doc.canvas:undefined} imageSize={media[cropItem.asset_id]} url={collageAssetUrl(projectId,media[cropItem.asset_id])} initial={cropItem.crop} onClose={()=>setCropTarget(null)} onDone={crop=>{change(cropTarget==='background'?{...layout,background:{...doc.background!,crop}}:{...layout,items:layout.items.map(i=>i.id===cropTarget?{...i,crop}:i)});setCropTarget(null);}}/>}
    {preview&&<ZoomableImageLightbox src={preview} alt="组图合成预览" footer={<a className="button" href={preview} download="collage-preview.png">下载预览</a>} fullResolutionOnly onClose={()=>setPreview('')}/>}
  </section>;
}
