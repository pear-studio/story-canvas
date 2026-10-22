import {ImageLayerList} from './ImageLayerList';
import {ImageLayerCanvas} from './ImageLayerCanvas';
import {MaterialPicker} from './MaterialPicker';
import {cropImageItem} from '../shared/image-layers.mjs';
import {CollageOpacityControl} from './CollageOpacityControl';
import {CollageLayerRow} from './CollageLayerRow';
import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {arrangeCollage,changeCollageCanvas,visibleCollageItems,collageSourceIds,collageLimit,fullCrop,type CollageDocument,type CollageMedia} from '../shared/collage-layout.mjs';
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
  const [materialPicker,setMaterialPicker]=useState(false),[layerEditing,setLayerEditing]=useState(false);
  const [rename,setRename]=useState<{title:string;args:Record<string,unknown>}|null>(null);
  const [selected,setSelected]=useState(''),[picker,setPicker]=useState<'foreground'|'background'|null>(null),[cropTarget,setCropTarget]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState('');
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width: 1160px)').matches),[previewOpen,setPreviewOpen]=useState(false);
  useEffect(()=>{const media=window.matchMedia('(max-width: 1160px)');const update=()=>{setCompact(media.matches);setPreviewOpen(false);setLayerEditing(false);};media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const [pickedMedia,setPickedMedia]=useState<Record<string,CollageMedia>>({});
  const [externalVersion,setExternalVersion]=useState(0);
  const saving=useRef(false);
  const activeAssets=(value:Layout)=>Object.fromEntries(Object.entries(assets).filter(([id])=>value.background?.asset_id===id||value.items.some(i=>i.asset_id===id)));
  const doc:CollageDocument={version:1,assets:activeAssets(layout),...layout},savedDoc:CollageDocument={version:1,assets:activeAssets(layout),...layout};
  const refreshedMedia=useCollageMedia(projectId,savedDoc),media={...pickedMedia,...refreshedMedia};
  const mediaReady=collageSourceIds(savedDoc).every(id=>media[id]&&!media[id].error);
  const dirty=JSON.stringify(layout)!==JSON.stringify(layoutOf(scope.document))||Object.entries(savedDoc.assets).some(([id,asset])=>JSON.stringify(asset)!==JSON.stringify(scope.document.assets[id]))||layerEditing;
  const modal=Boolean(picker||materialPicker||cropTarget||preview||rename||previewOpen);
  const history=useDraftHistory(layout,setLayout,`${projectId}:${page.page_id}:${externalVersion}`,!busy&&!layerEditing&&!modal);
  const change=(next:Layout)=>{history.checkpoint();setLayout(layoutOf({...doc,...next}));};
  // 项目轮询可带回 Agent 的新保存；本地有草稿时保留并由服务端哈希拒绝覆盖。
  useEffect(()=>{if(!dirty&&page.collage&&page.collage.sha256!==scope.sha256){setScope(page.collage);setAssets(page.collage.document.assets);setExternalVersion(v=>v+1);setLayout(layoutOf(page.collage.document));}},[page.collage?.sha256]);
  async function save(){
    if(saving.current||cropTarget||layerEditing||materialPicker)throw Error('请先完成当前调整');
    saving.current=true;setBusy(true);setError('');
    try{const result=await collageAction<CollageScope>(projectId,page.page_id,'save',{expected_sha256:scope.sha256,document:savedDoc});setScope(result);setAssets(current=>({...current,...result.document.assets}));await onReload();}
    finally{saving.current=false;setBusy(false);}
  }
  async function run(action:()=>Promise<unknown>){setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  usePageChanges(`${projectId}:${page.page_id}`,{dirty:dirty||Boolean(cropTarget),save:async()=>{try{await save();return true;}catch(e){setError(String(e));return false;}}});
  useSaveShortcut(()=>{if(!busy&&!modal&&!layerEditing&&dirty)void run(save);},`${projectId}:${page.page_id}`);
  function add(choices:Array<Pick<CollageChoice,'asset'|'media'>>){let next=structuredClone(savedDoc);const nextMedia={...media};const ids:string[]=[];for(const c of choices){const assetId=crypto.randomUUID();next.assets[assetId]=c.asset;nextMedia[assetId]=c.media;if(picker==='background'){next.background={asset_id:assetId,enabled:true,crop:fullCrop(),opacity:.45};break;}const id=crypto.randomUUID();ids.push(id);next.items.push({id,asset_id:assetId,enabled:true,box:fullCrop(),crop:fullCrop()});}if(ids.length)next=arrangeCollage(next,ids,nextMedia);setPickedMedia(nextMedia);setAssets(current=>({...current,...next.assets}));change(next);setSelected(ids.at(-1)??'');setPicker(null);}
  const layerLabel=(assetId:string)=>media[assetId]?.label??assets[assetId]?.page_id??'来源已移除';
  const cropItem=cropTarget==='background'?doc.background:doc.items.find(i=>i.id===cropTarget);
  const editingActions=<><button className="button" disabled={busy||layerEditing||!history.canUndo} onClick={history.undo}>撤销</button><button className="button" disabled={busy||layerEditing||!history.canRedo} onClick={history.redo}>重做</button><button className="button button--primary" disabled={busy||layerEditing||!dirty} onClick={()=>void run(save)}>{busy?'处理中…':'保存'}</button></>;
  const outputAction=<FinishedOutputButton projectId={projectId} pageId={page.page_id} dirty={dirty} dirtyLabel="保存并输出成品" disabled={busy||layerEditing||!mediaReady||(!visibleCollageItems(doc).length&&!doc.background?.enabled)} onOutput={async()=>{if(dirty)await save();return (await startFinishedPage(projectId,page.page_key)).job;}}/>;
  const results=<>
    {compact?<p className="collage-preview-hint">拖动图片，右下角等比缩放。</p>:<SectionHeader title="组图预览" description="拖动图片，右下角等比缩放；方向键微调，Shift 加速。"/>}
    <div className="collage-preview-surface" style={{'--preview-aspect':doc.canvas.replace(':',' / ')} as CSSProperties}>
      <div className="collage-stage" >
      <CollageCanvas projectId={projectId} document={doc} media={media} foreground={false}>
        <ImageLayerCanvas projectId={projectId} document={doc} media={media} canvas={doc.canvas} interactive={!busy&&!picker&&!materialPicker&&!cropTarget&&!preview&&!rename} selected={selected} onSelect={setSelected} onChange={items=>change({...layout,items})} onEditing={setLayerEditing}/>
        {!visibleCollageItems(doc).length&&!doc.background?.enabled&&<span className="collage-empty">添加或启用图片，开始排列组图</span>}
      </CollageCanvas>
    </div>
    </div>
    <div className="page-output-toolbar collage-output-toolbar">{!compact&&editingActions}<button className="button" disabled={busy||layerEditing||!mediaReady} onClick={()=>void run(async()=>{const p=await collageAction<{url:string}>(projectId,page.page_id,'preview',{document:savedDoc});setPreview(p.url);})}>查看合成图</button>{outputAction}</div>
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
            <fieldset disabled={busy}><div className="collage-toolbar"><button className="button" disabled={busy||doc.items.length>=collageLimit} onClick={()=>setPicker('foreground')}>添加图片 · {doc.items.length}/{collageLimit}</button><button className="button" disabled={busy||doc.items.length>=collageLimit} onClick={()=>setMaterialPicker(true)}>添加项目素材</button><button className="button" disabled={busy||!visibleCollageItems(doc).length||!mediaReady} onClick={()=>change(arrangeCollage(savedDoc,undefined,media))}>重新平铺</button></div>
              <ImageLayerList projectId={projectId} group={page.page_id} items={doc.items} media={media} selected={selected} disabled={busy||layerEditing} onSelect={setSelected} onChange={items=>change({...layout,items})} onCrop={setCropTarget}/>
            </fieldset>
          </section>
        </div>

      </div>
      {editorResizer}
      {!compact&&<aside className="page-images collage-preview" aria-label="组图预览">{results}</aside>}
    </div>
    {compact&&<div className="mobile-generate-bar collage-mobile-actions" aria-label="页面操作">{editingActions}<button className="button" aria-haspopup="dialog" aria-expanded={previewOpen} onClick={()=>setPreviewOpen(true)}>预览组图</button></div>}
    {compact&&previewOpen&&<Modal size="workspace" title="组图预览" subtitle={page.title} className="collage-preview-modal" onClose={()=>{setPreviewOpen(false);setLayerEditing(false);}}>{results}</Modal>}
    {rename&&<Modal title="组图标题" busy={busy} onClose={()=>setRename(null)} footer={<button className="button button--primary" disabled={busy||!rename.title.trim()} onClick={()=>void run(async()=>{await responseJson(await mutateTargetFacts('/api/agent/page-editor/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...rename.args,changes:{title:rename.title}})},projectId));setRename(null);await onReload();})}>保存标题</button>}><input aria-label="组图标题" autoFocus value={rename.title} onChange={e=>setRename({...rename,title:e.target.value})}/></Modal>}
    {materialPicker&&<MaterialPicker projectId={projectId} limit={collageLimit-doc.items.length} onClose={()=>setMaterialPicker(false)} onAdd={choices=>{add(choices);setMaterialPicker(false);}}/>}
    {picker&&<CollagePicker excluded={picker==='foreground'?doc.items.flatMap(i=>assets[i.asset_id].page_id?[assets[i.asset_id].page_id!]:[]):[]} projectId={projectId} pageId={page.page_id} limit={picker==='background'?1:collageLimit-doc.items.length} onAdd={add} onClose={()=>setPicker(null)}/>}
    {cropTarget&&cropItem&&<CollageCrop canvas={cropTarget==='background'?doc.canvas:undefined} imageSize={media[cropItem.asset_id]} url={collageAssetUrl(projectId,media[cropItem.asset_id])} initial={cropItem.crop} onClose={()=>setCropTarget(null)} onDone={crop=>{change(cropTarget==='background'?{...layout,background:{...doc.background!,crop}}:{...layout,items:layout.items.map(i=>i.id===cropTarget?cropImageItem(i,crop,media[i.asset_id],doc.canvas):i)});setCropTarget(null);}}/>}
    {preview&&<ZoomableImageLightbox src={preview} alt="组图合成预览" footer={<a className="button" href={preview} download="collage-preview.png">下载预览</a>} fullResolutionOnly onClose={()=>setPreview('')}/>}
  </section>;
}
