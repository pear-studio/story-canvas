import type {CSSProperties,ReactNode} from 'react';
import {imagePlacement,fullCrop,visibleCollageItems,type CollageDocument,type CollageMedia,type Rect} from '../shared/collage-layout.mjs';
import {collageAssetUrl} from './collage-client';
import './CollageWorkspace.css';
const rectStyle=(box:Rect):CSSProperties=>({left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`});
export function CollageImage({projectId,asset,box,crop,canvas,cover=false,opacity=1,width=1024}:{projectId:string;asset?:CollageMedia;box:Rect;crop:Rect;canvas:string;cover?:boolean;opacity?:number;width?:number}){
  if(!asset||asset.error)return <span className="collage-image collage-source-error" style={rectStyle(box)}>{asset?.error??'加载中…'}</span>;
  const g=imagePlacement(asset,box,crop,canvas,cover),s=g.source;
  return <span className="collage-image" style={{...rectStyle(g.box),opacity}}><img draggable={false} src={collageAssetUrl(projectId,asset,width)} alt="" decoding="async" style={{position:'absolute',maxWidth:'none',width:`${100/s.w}%`,height:`${100/s.h}%`,left:`${-s.x/s.w*100}%`,top:`${-s.y/s.h*100}%`}}/></span>;
}
export function CollageCanvas({projectId,document:doc,media,width=1024,children}:{projectId:string;document:CollageDocument;media:Record<string,CollageMedia>;width?:number;children?:ReactNode}){
  const b=doc.background;
  return <div className="collage-canvas" style={{aspectRatio:doc.canvas.replace(':','/')}}>
    {b?.enabled&&<CollageImage projectId={projectId} asset={media[b.asset_id]} box={fullCrop()} crop={b.crop} canvas={doc.canvas} cover opacity={b.opacity} width={width}/>}
    {visibleCollageItems(doc).map(item=><CollageImage key={item.id} projectId={projectId} asset={media[item.asset_id]} box={item.box} crop={item.crop} canvas={doc.canvas} width={width}/>)}
    {children}
  </div>;
}
