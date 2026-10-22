import {useRef,useState,useEffect,type PointerEvent,type CSSProperties} from 'react';
import {imagePlacement,moveImageBox,resizeImageBox,type ImageItem,type ImageLayers,type ImageMedia,type Rect} from '../shared/image-layers.mjs';
import {imageSourceUrl} from './image-layer-client';
import './CollageWorkspace.css';
import './image-layers.css';
export function ImageLayer({url,asset,box,crop,canvas,cover=false,opacity=1}:{url:string;asset?:ImageMedia;box:Rect;crop:Rect;canvas:string;cover?:boolean;opacity?:number}){
  const style=(r:Rect):CSSProperties=>({left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.w*100}%`,height:`${r.h*100}%`});
  if(!asset||asset.error)return <span className="collage-image collage-source-error" style={style(box)}>{asset?.error??'加载中…'}</span>;
  const g=imagePlacement(asset,box,crop,canvas,cover),s=g.source;
  return <span className="collage-image" style={{...style(g.box),opacity}}><img draggable={false} src={url} alt="" decoding="async" style={{position:'absolute',maxWidth:'none',width:`${100/s.w}%`,height:`${100/s.h}%`,left:`${-s.x/s.w*100}%`,top:`${-s.y/s.h*100}%`}}/></span>;
}
export function ImageLayerCanvas({projectId,document,media,canvas,interactive=false,selected='',onSelect=()=>{},onChange=()=>{},onEditing=()=>{}}:{projectId:string;document:ImageLayers;media:Record<string,ImageMedia>;canvas:string;interactive?:boolean;selected?:string;onSelect?:(id:string)=>void;onChange?:(items:ImageItem[])=>void;onEditing?:(value:boolean)=>void}){
  const host=useRef<HTMLDivElement>(null),gesture=useRef<{pointerId:number;id:string;mode:string;x:number;y:number;box:Rect;items:ImageItem[];width:number;height:number}|null>(null),pending=useRef<ImageItem[]|null>(null),[transient,setTransient]=useState<ImageItem[]|null>(null);
  function end(cancel=false){if(!gesture.current)return;if(!cancel&&pending.current)onChange(pending.current);gesture.current=null;pending.current=null;setTransient(null);onEditing(false);}
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&gesture.current){e.preventDefault();end(true);}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);});
  useEffect(()=>{end(true);},[interactive,canvas]);
  const items=transient??document.items;
  const boxFor=(item:ImageItem)=>media[item.asset_id]&&!media[item.asset_id].error?imagePlacement(media[item.asset_id],item.box,item.crop,canvas).box:item.box;
  function begin(e:PointerEvent<HTMLElement>,item:ImageItem,mode:string){if(!interactive||e.button!==0)return;e.preventDefault();e.stopPropagation();const r=host.current!.getBoundingClientRect();onSelect(item.id);gesture.current={pointerId:e.pointerId,id:item.id,mode,x:e.clientX,y:e.clientY,box:boxFor(item),items:document.items,width:r.width,height:r.height};e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.focus();onEditing(true);}
  function move(e:PointerEvent<HTMLElement>){const g=gesture.current;if(!g||e.pointerId!==g.pointerId)return;const dx=(e.clientX-g.x)/g.width,dy=(e.clientY-g.y)/g.height,box=g.mode==='move'?moveImageBox(g.box,dx,dy):resizeImageBox(g.box,dx,dy,{width:g.width,height:g.height});pending.current=g.items.map(i=>i.id===g.id?{...i,box}:i);setTransient(pending.current);}
  return <div className="image-layer-surface" ref={host}>
    {items.filter(i=>i.enabled).map(item=><ImageLayer key={item.id} url={imageSourceUrl(projectId,media[item.asset_id],1024)} asset={media[item.asset_id]} box={item.box} crop={item.crop} canvas={canvas}/>)}
    {interactive&&items.filter(i=>i.enabled).map(item=>{const box=boxFor(item);return <div key={item.id} role="button" aria-label={media[item.asset_id]?.label??'图片素材'} aria-pressed={selected===item.id} tabIndex={0} className={`collage-handle ${selected===item.id?'is-selected':''}`} style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`}} onPointerDown={e=>begin(e,item,'move')} onPointerMove={move} onPointerUp={()=>end()} onPointerCancel={()=>end(true)} onFocus={()=>onSelect(item.id)} onKeyDown={e=>{
      if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();onChange(document.items.filter(i=>i.id!==item.id));return;}
      const delta=e.shiftKey?.02:.005,offset:Record<string,number[]>={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]};if(offset[e.key]){e.preventDefault();const [dx,dy]=offset[e.key];onChange(document.items.map(i=>i.id===item.id?{...i,box:moveImageBox(box,dx,dy)}:i));}
    }}><span className="collage-resize" aria-hidden="true" onPointerDown={e=>begin(e,item,'resize')}/></div>;})}
  </div>;
}
