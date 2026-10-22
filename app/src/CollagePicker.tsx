import {useEffect,useState} from 'react';
import {Modal} from './Modal';
import ZoomableImageLightbox from './ImageLightbox';
import {NavigationContextMenu,type NavigationMenuRequest} from './NavigationContextMenu';
import {collageAction,collageAssetUrl,type CollageChoice,type CollageSources} from './collage-client';
export function CollagePicker({projectId,pageId,limit,excluded=[],onAdd,onClose}:{projectId:string;pageId:string;limit:number;excluded?:string[];onAdd:(choices:CollageChoice[])=>void;onClose:()=>void}){
  const [data,setData]=useState<CollageSources|null>(null),[selected,setSelected]=useState<CollageChoice[]>([]),[chapter,setChapter]=useState(''),[sequence,setSequence]=useState(''),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<CollageChoice|null>(null),[menu,setMenu]=useState<NavigationMenuRequest|null>(null);
  useEffect(()=>{
    const controller=new AbortController();setBusy(true);setError('');setMenu(null);
    const timer=setTimeout(()=>void collageAction<CollageSources>(projectId,pageId,'sources',{chapter_id:chapter,sequence_id:sequence,query,offset},controller.signal).then(result=>{if(!controller.signal.aborted)setData(result);}).catch(e=>{if(!controller.signal.aborted)setError(String(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);}),150);
    return()=>{clearTimeout(timer);controller.abort();};
  },[projectId,pageId,chapter,sequence,query,offset]);
  return <Modal className="reference-picker-modal collage-picker-modal" title="选择组图页面" subtitle={`已选 ${selected.length} / ${limit} · 自动使用页面的唯一候选，右键可放大`} onClose={onClose} footer={<><button className="button" onClick={onClose}>取消</button><button className="button button--primary" disabled={!selected.length} onClick={()=>onAdd(selected)}>添加 {selected.length} 页</button></>}>
    <div className="collage-toolbar"><select aria-label="来源章节" value={chapter} onChange={e=>{setChapter(e.target.value);setSequence('');setOffset(0);}}><option value="">全部章节</option>{data?.chapters.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select><select aria-label="来源单元" value={sequence} onChange={e=>{setSequence(e.target.value);setOffset(0);}}><option value="">全部单元</option>{data?.chapters.filter(c=>!chapter||c.id===chapter).flatMap(c=>c.sequences.map(s=><option key={s.id} value={s.id}>{s.title}</option>))}</select><input aria-label="查找图片页面" placeholder="搜索页面标题" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);}}/></div>
    {error&&<p role="alert">{error}</p>}{busy?<p>正在读取页面…</p>:<div className="reference-candidate-grid collage-picker-grid">{data?.pages.map(choice=>{
      const selectionIndex=selected.findIndex(s=>s.page_id===choice.page_id),checked=selectionIndex>=0,added=excluded.includes(choice.page_id),unavailable=Boolean(choice.media.error),disabled=added||unavailable||!checked&&selected.length>=limit;
      const openMenu=(x:number,y:number)=>setMenu({x,y,label:choice.title,items:[{id:'zoom',label:'放大',disabled:unavailable,onSelect:()=>setPreview(choice)}]});
      return <button key={choice.page_id} className="reference-candidate-choice" aria-label={choice.title} title={`${choice.path} / ${choice.title}${choice.media.error?' · '+choice.media.error:''}`} aria-pressed={checked||added} aria-disabled={disabled} onClick={()=>{if(!disabled)setSelected(current=>checked?current.filter(s=>s.page_id!==choice.page_id):[...current,choice]);}} onContextMenu={e=>{e.preventDefault();openMenu(e.clientX,e.clientY);}} onKeyDown={e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){e.preventDefault();const r=e.currentTarget.getBoundingClientRect();openMenu(r.left,r.top+r.height);}}}>
        {unavailable?<span className="collage-source-error">{choice.media.error}</span>:<img src={collageAssetUrl(projectId,choice.media,320)} alt="" loading="lazy" decoding="async"/>}{(checked||added)&&<i>{added?'已选':selectionIndex+1}</i>}
      </button>;
    })}</div>}
    {!busy&&!data?.pages.length&&<p>没有符合条件的页面。</p>}
    <div className="collage-toolbar"><button className="button" disabled={busy||!offset} onClick={()=>setOffset(Math.max(0,offset-48))}>上一批</button><button className="button" disabled={busy||data?.next==null} onClick={()=>setOffset(data!.next!)}>下一批</button></div>
    <NavigationContextMenu request={menu} onClose={()=>setMenu(null)}/>
    {preview&&<ZoomableImageLightbox src={collageAssetUrl(projectId,preview.media)} alt={preview.title} footer={null} onClose={()=>setPreview(null)}/>}
  </Modal>;
}
