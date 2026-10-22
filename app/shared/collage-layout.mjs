import canvasPresets from './canvas-presets.json' with {type:'json'};
// 组图预览、Agent 平铺和成品合成共用几何；坐标相对各自画布／原图。
export const collageLimit = 12;
export const fullCrop = () => ({x:0,y:0,w:1,h:1});
export const emptyCollage = (canvas='3:4') => ({version:1,canvas,assets:{},background:null,items:[]});
export const visibleCollageItems = document => document.items.filter(item=>item.enabled);
export const collageSourceIds = document => [...new Set([...visibleCollageItems(document).map(item=>item.asset_id),...(document.background?.enabled?[document.background.asset_id]:[])])];
// 成品采用生图画幅预设的两倍尺寸；显式宽度用于预览，旧画幅保留原尺寸。
export function collageSize(canvas,width=(canvasPresets.find(p=>p.value===canvas)?.width??1024)*2){const [w,h]=canvas.split(':').map(Number);return {width,height:Math.round(width*h/w)};}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,90}$/.test(v);
export function validRect(v){return exact(v,['x','y','w','h'])&&['x','y','w','h'].every(k=>Number.isFinite(v[k]))&&v.x>=0&&v.y>=0&&v.w>0&&v.h>0&&v.x+v.w<=1.000001&&v.y+v.h<=1.000001;}
export function validateCollage(doc){
  const errors=[];
  if(!exact(doc,['version','canvas','assets','background','items'])||doc.version!==1)return ['组图文档无效'];
  if(!['3:4','1:1','4:3','2:3','9:16'].includes(doc.canvas))errors.push('组图画幅无效');
  if(!exact(doc.assets,Object.keys(doc.assets??{})))return [...errors,'素材集合无效'];
  for(const [key,a] of Object.entries(doc.assets)){
    if(!a||typeof a!=='object'){errors.push(`素材无效：${key}`);continue;}
    if(!id(key)||!exact(a,['page_id'])||!/^page-(?:\d{3}|[a-f0-9]{12})$/.test(a.page_id??''))errors.push(`来源页面无效：${key}`);
  }
  if(!Array.isArray(doc.items)||doc.items.length>collageLimit)return [...errors,`前景最多 ${collageLimit} 张`];
  const ids=new Set();
  for(const item of doc.items){
    if(!item||typeof item!=='object'){errors.push('图片无效');continue;}
    if(!exact(item,['id','asset_id','enabled','box','crop'])||typeof item.enabled!=='boolean'||!id(item.id)||ids.has(item.id)||!Object.hasOwn(doc.assets,item.asset_id)||!validRect(item.box)||!validRect(item.crop))errors.push('图片身份、开关、位置或裁切无效');
    ids.add(item.id);
  }
  const b=doc.background;
  if(b!==null&&(!exact(b,['asset_id','enabled','crop','opacity'])||typeof b.enabled!=='boolean'||!Object.hasOwn(doc.assets,b.asset_id)||!validRect(b.crop)||!Number.isFinite(b.opacity)||b.opacity<0||b.opacity>1))errors.push('背景设置无效');
  return errors;
}
export function imagePlacement(asset,box,crop,canvas,cover=false){
  const size=collageSize(canvas,1e6),src={...crop},dest={...box};
  const aspect=asset.width*src.w/(asset.height*src.h),target=box.w*size.width/(box.h*size.height);
  if(cover){if(aspect>target){const w=src.h*asset.height*target/asset.width;src.x+=(src.w-w)/2;src.w=w;}else{const h=src.w*asset.width/target/asset.height;src.y+=(src.h-h)/2;src.h=h;}}
  else if(aspect>target){dest.h=box.w*size.width/aspect/size.height;dest.y+=(box.h-dest.h)/2;}
  else {dest.w=box.h*size.height*aspect/size.width;dest.x+=(box.w-dest.w)/2;}
  return {source:src,box:dest};
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
