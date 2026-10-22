import sharp from 'sharp';
import {imagePlacement} from '../shared/image-layers.mjs';
// 只消费已冻结字节；不读取项目或重新选择候选。
export async function imageComposite(asset,bytes,box,crop,size,cover=false,opacity=1){
  const {source:s,box:b}=imagePlacement(asset,box,crop,size,cover);
  const left=Math.min(size.width-1,Math.round(b.x*size.width)),top=Math.min(size.height-1,Math.round(b.y*size.height));
  const w=Math.max(1,Math.min(size.width-left,Math.round((b.x+b.w)*size.width)-left)),h=Math.max(1,Math.min(size.height-top,Math.round((b.y+b.h)*size.height)-top));
  const sx=Math.min(asset.width-1,Math.round(s.x*asset.width)),sy=Math.min(asset.height-1,Math.round(s.y*asset.height));
  let image=sharp(bytes).extract({left:sx,top:sy,width:Math.max(1,Math.min(asset.width-sx,Math.round(s.w*asset.width))),height:Math.max(1,Math.min(asset.height-sy,Math.round(s.h*asset.height)))}).resize(w,h).ensureAlpha();
  if(opacity!==1){const {data,info}=await image.raw().toBuffer({resolveWithObject:true});for(let i=3;i<data.length;i+=4)data[i]=Math.round(data[i]*opacity);image=sharp(data,{raw:info});}
  return {input:await image.png().toBuffer(),left,top};
}
export async function composeImageLayers(clean,document,capture){
  const items=document.items.filter(i=>i.enabled);if(!items.length)return clean;
  const size=await sharp(clean).metadata(),layers=[];
  for(const item of items)layers.push(await imageComposite(capture.media[item.asset_id],capture.buffers[item.asset_id],item.box,item.crop,size));
  return sharp(clean).composite(layers).png().toBuffer();
}
