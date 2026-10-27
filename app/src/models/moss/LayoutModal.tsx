import {useRef,useState,type CSSProperties,type PointerEvent as ReactPointerEvent} from 'react';
import {Modal} from '../../Modal';
import {PromptTextArea} from '../../SourcePromptEditor';
import {clampMossBox,mossText} from '../../../shared/moss-prompt.mjs';
import {MossEntriesEditor} from './EntriesEditor';
import type {MossLayout,MossLayoutItem} from './types';
import './moss.css';

export type LayoutCharacter={id:string;name:string;color?:string;description:string};
export function MossLayoutModal({value,characters,dimensions,onClose,onApply}:{value?:MossLayout;characters:LayoutCharacter[];dimensions:{width:number;height:number};onClose:()=>void;onApply:(value:MossLayout)=>void}) {
  const [draft,setDraft]=useState<MossLayout>(()=>structuredClone(value??{enabled:false,items:[]}));
  const [selectedId,setSelectedId]=useState(value?.items[0]?.id??'');
  const stage=useRef<HTMLDivElement>(null);
  const drag=useRef<{id:string;pointerId:number;x:number;y:number;bbox:MossLayoutItem['bbox'];resize:boolean;width:number;height:number}|null>(null);
  const ratio=dimensions.width/dimensions.height;
  const selected=draft.items.find(item=>item.id===selectedId);
  const title=(item:MossLayoutItem)=>item.character_id?characters.find(c=>c.id===item.character_id)?.name??item.character_id:item.label==='text'?item.text||'文字':mossText(item.entries)||'物体';
  function updateItem(id:string,change:(item:MossLayoutItem)=>MossLayoutItem){setDraft(current=>({...current,items:current.items.map(item=>item.id===id?change(item):item)}));}
  function startDrag(event:ReactPointerEvent<HTMLElement>,item:MossLayoutItem,resize=false){if(event.button!==0)return;event.preventDefault();event.stopPropagation();setSelectedId(item.id);const rect=stage.current!.getBoundingClientRect();drag.current={id:item.id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,bbox:[...item.bbox],resize,width:rect.width,height:rect.height};stage.current!.setPointerCapture(event.pointerId);}
  function moveDrag(event:ReactPointerEvent<HTMLDivElement>){const active=drag.current;if(!active||active.pointerId!==event.pointerId)return;const dx=(event.clientX-active.x)/active.width,dy=(event.clientY-active.y)/active.height;const [x,y,w,h]=active.bbox;const bbox=active.resize?clampMossBox([x,y,Math.min(1-x,w+dx),Math.min(1-y,h+dy)]):clampMossBox([x+dx,y+dy,w,h]);updateItem(active.id,item=>({...item,bbox}));}
  function finishDrag(event:ReactPointerEvent<HTMLDivElement>,cancel=false){const active=drag.current;if(!active||active.pointerId!==event.pointerId)return;if(cancel)updateItem(active.id,item=>({...item,bbox:active.bbox}));drag.current=null;if(stage.current?.hasPointerCapture(event.pointerId))stage.current.releasePointerCapture(event.pointerId);}
  function addItem(character_id?:string,label:'object'|'text'='object'){const item:MossLayoutItem=character_id?{id:`box-${crypto.randomUUID()}`,character_id,bbox:[.2,.15,.35,.7]}:label==='text'?{id:`box-${crypto.randomUUID()}`,label,entries:[],text:'',bbox:[.2,.2,.4,.2]}:{id:`box-${crypto.randomUUID()}`,label,entries:[],bbox:[.2,.2,.4,.4]};setDraft(current=>({enabled:true,items:[...current.items,item]}));setSelectedId(item.id);}
  function changeCoordinate(index:number,value:number){if(!selected||!Number.isFinite(value))return;const box=[...selected.bbox];box[index]=value/100;if(index===2)box[2]=Math.min(1-box[0],box[2]);if(index===3)box[3]=Math.min(1-box[1],box[3]);updateItem(selected.id,item=>({...item,bbox:clampMossBox(box)}));}
  return <Modal size="workspace" className="moss-layout-modal" title="Layout" subtitle={`${dimensions.width} × ${dimensions.height} · 拖动定位，右下角调整大小`} ariaLabel="MOSS Layout" onClose={onClose} footer={<div className="moss-layout-actions"><button type="button" className="button" onClick={onClose}>取消</button><button type="button" className="button button--primary" onClick={()=>onApply(draft)}>应用</button></div>}>
    <div className="moss-layout-toolbar"><label><input type="checkbox" checked={draft.enabled} onChange={event=>setDraft(current=>({...current,enabled:event.target.checked}))}/> 启用 Layout</label></div>
    <div className="moss-layout-editor">
      <div className="moss-layout-stage-wrap"><div ref={stage} className="moss-layout-stage" aria-label="Layout 画布" style={{'--layout-ratio':ratio} as CSSProperties} onPointerMove={moveDrag} onPointerUp={event=>finishDrag(event)} onPointerCancel={event=>finishDrag(event,true)}>
        {draft.items.map(item=><div key={item.id} role="button" tabIndex={0} aria-label={`定位 ${title(item)}`} aria-pressed={selectedId===item.id} className={`moss-layout-box${selectedId===item.id?' is-selected':''}`} style={{left:`${item.bbox[0]*100}%`,top:`${item.bbox[1]*100}%`,width:`${item.bbox[2]*100}%`,height:`${item.bbox[3]*100}%`,'--box-color':characters.find(c=>c.id===item.character_id)?.color??'#528a95'} as CSSProperties} onFocus={()=>setSelectedId(item.id)} onPointerDown={event=>startDrag(event,item)} onKeyDown={event=>{const directions:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const delta=directions[event.key];if(!delta)return;event.preventDefault();const step=event.shiftKey?.05:.01;updateItem(item.id,current=>({...current,bbox:clampMossBox([current.bbox[0]+delta[0]*step,current.bbox[1]+delta[1]*step,current.bbox[2],current.bbox[3]])}));}}><span className="moss-layout-box-label">{title(item)}</span><button type="button" className="moss-layout-resize" aria-label={`调整 ${title(item)} 大小`} onPointerDown={event=>startDrag(event,item,true)} onKeyDown={event=>event.stopPropagation()}/></div>)}
      </div></div>
      <div className="moss-layout-sidebar"><div className="moss-layout-toolbar"><select aria-label="添加角色布局" value="" onChange={event=>{if(event.target.value)addItem(event.target.value);}}><option value="">添加角色…</option>{characters.filter(character=>!draft.items.some(item=>item.character_id===character.id)).map(character=><option key={character.id} value={character.id}>{character.name}</option>)}</select><button type="button" className="button button--quiet" onClick={()=>addItem()}>添加物体</button><button type="button" className="button button--quiet" onClick={()=>addItem(undefined,'text')}>添加文字</button></div>
        <div className="moss-layout-items">{draft.items.map((item,index)=><button type="button" key={item.id} className={`button ${item.id===selectedId?'button--primary':'button--quiet'}`} aria-pressed={item.id===selectedId} onClick={()=>setSelectedId(item.id)}>{index+1} · {title(item).slice(0,24)}</button>)}</div>
        {!selected?<p className="field-hint">添加角色、物体或文字后，在画布中安排位置。</p>:<><div className="moss-layout-coordinates">{['左 %','上 %','宽 %','高 %'].map((label,index)=><label key={label}><span>{label}</span><input type="number" aria-label={label} min={index>1?2:0} max="100" step="1" value={Math.round(selected.bbox[index]*1000)/10} onChange={event=>changeCoordinate(index,event.target.valueAsNumber)}/></label>)}</div>
          {selected.character_id!==undefined?<><strong>{title(selected)}</strong><p className="moss-layout-caption">{characters.find(c=>c.id===selected.character_id)?.description||'尚无启用的人物描述，请在页面 Prompt 中编辑。'}</p><small className="field-hint">复用当前人物描述。</small></>:<>
            {selected.label==='text'&&<label>文字内容<PromptTextArea ariaLabel="布局文字内容" value={selected.text} rows={2} onChange={text=>updateItem(selected.id,item=>item.label==='text'?{...item,text}:item)}/></label>}
            <MossEntriesEditor label={selected.label==='text'?'文字样式':'描述'} value={selected.entries} scopeKey={`layout:${selected.id}`} onChange={entries=>updateItem(selected.id,item=>item.character_id!==undefined?item:{...item,entries})}/>
          </>}
          <div className="moss-reference-actions"><button type="button" className="button button--quiet" onClick={()=>{setDraft(current=>({...current,items:current.items.filter(item=>item.id!==selected.id)}));setSelectedId('');}}>移除元素</button></div>
        </>}
      </div>
    </div>
  </Modal>;
}
