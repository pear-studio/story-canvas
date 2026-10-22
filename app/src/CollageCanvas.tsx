import {ImageLayer} from './ImageLayerCanvas';
import type {CSSProperties,ReactNode} from 'react';
import {imagePlacement,fullCrop,visibleCollageItems,type CollageDocument,type CollageMedia,type Rect} from '../shared/collage-layout.mjs';
import {collageAssetUrl} from './collage-client';
import './CollageWorkspace.css';
const rectStyle=(box:Rect):CSSProperties=>({left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`});
export function CollageImage({projectId,asset,box,crop,canvas,cover=false,opacity=1,width=1024}:{projectId:string;asset?:CollageMedia;box:Rect;crop:Rect;canvas:string;cover?:boolean;opacity?:number;width?:number}){
  return <ImageLayer url={collageAssetUrl(projectId,asset,width)} asset={asset} box={box} crop={crop} canvas={canvas} cover={cover} opacity={opacity}/>;
}
export function CollageCanvas({projectId,document:doc,media,width=1024,children,foreground=true}:{projectId:string;document:CollageDocument;media:Record<string,CollageMedia>;width?:number;children?:ReactNode;foreground?:boolean}){
  const b=doc.background;
  return <div className="collage-canvas" style={{aspectRatio:doc.canvas.replace(':','/')}}>
    {b?.enabled&&<CollageImage projectId={projectId} asset={media[b.asset_id]} box={fullCrop()} crop={b.crop} canvas={doc.canvas} cover opacity={b.opacity} width={width}/>}
    {foreground&&visibleCollageItems(doc).map(item=><CollageImage key={item.id} projectId={projectId} asset={media[item.asset_id]} box={item.box} crop={item.crop} canvas={doc.canvas} width={width}/>)}
    {children}
  </div>;
}
