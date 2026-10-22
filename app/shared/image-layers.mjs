// 图片图层的几何与契约由编辑器、Agent 和成品共同使用。
export const layerLimit = 12;
export const fullCrop = () => ({x:0,y:0,w:1,h:1});
export const emptyLayers = () => ({version:1,assets:{},items:[]});
export const exactObject = (v,keys) => Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)));
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,90}$/.test(v);
export function validRect(v){return exactObject(v,['x','y','w','h'])&&['x','y','w','h'].every(k=>Number.isFinite(v[k]))&&v.x>=0&&v.y>=0&&v.w>0&&v.h>0&&v.x+v.w<=1.000001&&v.y+v.h<=1.000001;}
const validFile=file=>typeof file==='string'&&/^[^<>:"/\\|?*\x00-\x1f]+\.(png|jpe?g|webp)$/i.test(file)&&!file.includes('..');
export function validImageSource(a,allowPage=true){
  if(allowPage&&exactObject(a,['page_id'])&&/^page-(?:\d{3}|[a-f0-9]{12})$/.test(a.page_id??''))return true;
  if(!exactObject(a,allowPage?['file']:['file','multilingual','localizations'])||!validFile(a.file))return false;
  if(a.multilingual!==undefined&&typeof a.multilingual!=='boolean')return false;
  return a.localizations===undefined||exactObject(a.localizations,['en','ja'])&&Object.values(a.localizations).every(v=>exactObject(v,['file'])&&validFile(v.file));
}
// 默认共用原图；显式开启后缺译返回 null，由预览和输出报告，绝不回退中文。
export function imageSourceForLocale(source,locale='zh'){
  if(source.page_id)return {page_id:source.page_id};
  return source.multilingual&&locale!=='zh'?source.localizations?.[locale]??null:{file:source.file};
}
export function imageSourceFiles(source){return source?.file?[source.file,...Object.values(source.localizations??{}).map(v=>v.file)]:[];}
export function validateImageItems(assets,items,allowPage=true){
  const errors=[];
  if(!exactObject(assets,Object.keys(assets??{})))return ['素材集合无效'];
  for(const [key,source] of Object.entries(assets))if(!id(key)||!validImageSource(source,allowPage))errors.push(`素材来源无效：${key}`);
  if(!Array.isArray(items)||items.length>layerLimit)return [...errors,`前景最多 ${layerLimit} 张`];
  const ids=new Set();
  for(const item of items){
    if(!exactObject(item,['id','asset_id','enabled','box','crop'])||!id(item?.id)||ids.has(item?.id)||typeof item?.enabled!=='boolean'||!Object.hasOwn(assets,item?.asset_id)||!validRect(item?.box)||!validRect(item?.crop))errors.push('图片身份、开关、位置或裁切无效');
    ids.add(item?.id);
  }
  return errors;
}
export function validateLayers(doc){return !exactObject(doc,['version','assets','items'])||doc.version!==1?['素材布局无效']:validateImageItems(doc.assets,doc.items,false);}
export function canvasSize(canvas){if(typeof canvas==='object')return canvas;const [width,height]=canvas.split(':').map(Number);return {width,height};}
export function imagePlacement(asset,box,crop,canvas,cover=false){
  const size=canvasSize(canvas),src={...crop},dest={...box};
  const aspect=asset.width*src.w/(asset.height*src.h),target=box.w*size.width/(box.h*size.height);
  if(cover){if(aspect>target){const w=src.h*asset.height*target/asset.width;src.x+=(src.w-w)/2;src.w=w;}else{const h=src.w*asset.width/target/asset.height;src.y+=(src.h-h)/2;src.h=h;}}
  else if(aspect>target){dest.h=box.w*size.width/aspect/size.height;dest.y+=(box.h-dest.h)/2;}
  else {dest.w=box.h*size.height*aspect/size.width;dest.x+=(box.w-dest.w)/2;}
  return {source:src,box:dest};
}
export function moveImageBox(box,dx,dy){return {...box,x:Math.max(0,Math.min(1-box.w,box.x+dx)),y:Math.max(0,Math.min(1-box.h,box.y+dy))};}
export function resizeImageBox(box,dx,dy,canvas){
  const {width,height}=canvasSize(canvas),w=box.w*width,h=box.h*height;
  const scale=1+(dx*width*w+dy*height*h)/(w*w+h*h);
  const minimum=.02*Math.min(width,height)/Math.max(w,h),maximum=Math.min((1-box.x)/box.w,(1-box.y)/box.h);
  const ratio=Math.min(maximum,Math.max(minimum,scale));return {...box,w:box.w*ratio,h:box.h*ratio};
}
export function cropImageItem(item,crop,asset,canvas){
  if(!asset||asset.error)return {...item,crop};
  const old=imagePlacement(asset,item.box,item.crop,canvas).box,size=canvasSize(canvas);
  let w=old.w,h=w*size.width/(asset.width*crop.w/(asset.height*crop.h))/size.height;
  const scale=Math.min(1,1/w,1/h);w*=scale;h*=scale;
  return {...item,crop,box:moveImageBox({x:old.x+(old.w-w)/2,y:old.y+(old.h-h)/2,w,h},0,0)};
}
export function layerGeometryErrors(doc,media,canvas){
  const size=canvasSize(canvas),errors=[];
  for(const item of doc.items){const asset=media[item.asset_id];if(!asset||asset.error)continue;
    const box=imagePlacement(asset,item.box,item.crop,canvas).box;
    if(Math.max(box.w*size.width,box.h*size.height)+1e-8<.02*Math.min(size.width,size.height))errors.push(`${item.id}：图片显示长边不能小于画布短边的 2%`);
    if(item.crop.w*asset.width<1-1e-6||item.crop.h*asset.height<1-1e-6)errors.push(`${item.id}：取景至少保留一个原图像素`);
  }
  return errors;
}
