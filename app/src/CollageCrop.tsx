import {useRef,useState,type PointerEvent} from 'react';
import {Modal} from './Modal';
import {fullCrop,imagePlacement,type Rect} from '../shared/collage-layout.mjs';
export function CollageCrop({url,initial,canvas,imageSize,onDone,onClose}:{url:string;initial:Rect;canvas?:string;imageSize?:{width:number;height:number};onDone:(crop:Rect)=>void;onClose:()=>void}){
  const fit=(crop:Rect)=>canvas&&imageSize?imagePlacement(imageSize,fullCrop(),crop,canvas,true).source:crop;
  const [crop,setCrop]=useState(()=>fit(initial)),start=useRef<{x:number;y:number}|null>(null);
  function point(e:PointerEvent<HTMLDivElement>){const r=e.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
  return <Modal title="调整取景" subtitle={canvas?`按页面比例 ${canvas} 取景；取消不会改变组图。`:'在原图上拖出保留范围；取消不会改变组图。'} onClose={onClose} footer={<><button className="button" onClick={()=>setCrop(fit(fullCrop()))}>{canvas?'最大取景范围':'显示完整图片'}</button><button className="button" onClick={onClose}>取消</button><button className="button button--primary" onClick={()=>onDone(crop)}>完成裁切</button></>}>
    <div className="collage-crop" onPointerDown={e=>{if(e.button!==0)return;start.current=point(e);e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(!start.current)return;const p=point(e),s=start.current;let w=Math.abs(p.x-s.x),h=Math.abs(p.y-s.y);if(canvas&&imageSize){const [cw,ch]=canvas.split(':').map(Number),ratio=cw/ch*imageSize.height/imageSize.width;w=Math.min(Math.max(w,h*ratio),p.x<s.x?s.x:1-s.x,(p.y<s.y?s.y:1-s.y)*ratio);h=w/ratio;}if(w>.01&&h>.01)setCrop({x:p.x<s.x?s.x-w:s.x,y:p.y<s.y?s.y-h:s.y,w,h});}} onPointerUp={()=>{start.current=null;}} onPointerCancel={()=>{start.current=null;}}><img src={url} alt="裁切原图" draggable={false}/><span style={{left:`${crop.x*100}%`,top:`${crop.y*100}%`,width:`${crop.w*100}%`,height:`${crop.h*100}%`}}/></div>
  </Modal>;
}
