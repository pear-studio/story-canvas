import {fullCrop,validRect,imagePlacement,validateImageItems} from './image-layers.mjs';
export {fullCrop,validRect,imagePlacement} from './image-layers.mjs';
import canvasPresets from './canvas-presets.json' with {type:'json'};
// 组图预览、Agent 平铺和成品合成共用几何；坐标相对各自画布／原图。
export const collageLimit = 12;

export const emptyCollage = (canvas='3:4') => ({version:1,canvas,assets:{},background:null,items:[]});
export const visibleCollageItems = document => document.items.filter(item=>item.enabled);
export const collageSourceIds = document => [...new Set([...visibleCollageItems(document).map(item=>item.asset_id),...(document.background?.enabled?[document.background.asset_id]:[])])];
// 无字成品只保留页面原画引用，去掉导入素材及其背景／排版。
export function collageWithoutMaterials(document){
  const assets=Object.fromEntries(Object.entries(document.assets).filter(([,asset])=>asset.page_id));
  return {...document,assets,items:document.items.filter(item=>assets[item.asset_id]),background:document.background&&assets[document.background.asset_id]?document.background:null};
}
// 成品采用生图画幅预设的两倍尺寸；显式宽度用于预览，旧画幅保留原尺寸。
export function collageSize(canvas,width=(canvasPresets.find(p=>p.value===canvas)?.width??1024)*2){const [w,h]=canvas.split(':').map(Number);return {width,height:Math.round(width*h/w)};}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,90}$/.test(v);
export function validateCollage(doc){
  const errors=[];
  if(!exact(doc,['version','canvas','assets','background','items'])||doc.version!==1)return ['组图文档无效'];
  if(!['3:4','1:1','4:3','2:3','9:16'].includes(doc.canvas))errors.push('组图画幅无效');
  if(!exact(doc.assets,Object.keys(doc.assets??{})))return [...errors,'素材集合无效'];
  errors.push(...validateImageItems(doc.assets,doc.items));
  const b=doc.background;
  if(b!==null&&(!exact(b,['asset_id','enabled','crop','opacity'])||typeof b.enabled!=='boolean'||!Object.hasOwn(doc.assets,b.asset_id)||!validRect(b.crop)||!Number.isFinite(b.opacity)||b.opacity<0||b.opacity>1))errors.push('背景设置无效');
  return errors;
}
export function arrangeCollage(document,ids=document.items.map(i=>i.id),media={}){
  const doc=structuredClone(document),items=visibleCollageItems(doc).filter(i=>ids.includes(i.id));
  if(!items.length)return doc;
  const {width,height}=collageSize(doc.canvas),columns=Math.max(1,Math.ceil(Math.sqrt(items.length*width/height))),rows=Math.ceil(items.length/columns),margin=.035,gap=.018;
  const w=(1-2*margin-gap*(columns-1))/columns,h=(1-2*margin-gap*(rows-1))/rows;
  items.forEach((item,n)=>{const cell={x:margin+(n%columns)*(w+gap),y:margin+Math.floor(n/columns)*(h+gap),w,h},asset=media[item.asset_id];item.box=asset&&!asset.error?imagePlacement(asset,cell,item.crop,doc.canvas).box:cell;});
  return doc;
}
export function changeCollageCanvas(document,canvas){
  const doc=structuredClone(document),old=collageSize(doc.canvas,1e6),next=collageSize(canvas,1e6);
  for(const item of doc.items){item.box.h*=old.height/next.height;const scale=Math.min(1,1/item.box.w,1/item.box.h);item.box.w*=scale;item.box.h*=scale;item.box.x=Math.min(item.box.x,1-item.box.w);item.box.y=Math.min(item.box.y,1-item.box.h);}
  doc.canvas=canvas;return doc;
}
