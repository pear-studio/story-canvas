import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {openMaterialFile,readProjectMaterials,saveMaterial} from './project-materials.mjs';
import {ApiError} from './http-support.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(message){throw new ApiError(422,'invalid_image_material',[message]);}
async function imageMeta(bytes){const meta=await sharp(bytes).metadata().catch(()=>null);if(!meta||!['png','jpeg','webp'].includes(meta.format)||(meta.pages??1)!==1)fail('素材必须是静态 PNG、JPEG 或 WebP');return meta;}
export async function imageMaterialLabels(directory){
  const metadata=await readFile(path.join(directory,'materials/index.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {items:[]};throw e;});
  return new Map((metadata.items??[]).map(item=>[item.file,item.title]));
}
export async function resolveImageMaterial(directory,file,label=file){
  try{
    const {target}=await openMaterialFile(directory,file),bytes=await readFile(target),meta=await imageMeta(bytes),rotated=(meta.orientation??1)>=5;
    return {material_file:file,label,width:rotated?meta.height:meta.width,height:rotated?meta.width:meta.height,sha256:sha(bytes)};
  }catch(error){return {material_file:file,label,width:1,height:1,error:error.details?.join('；')??'素材不存在或不是有效静态图片'};}
}
export async function imageMaterialBytes(directory,source){
  if(source.error)fail(source.error);
  const bytes=await readFile((await openMaterialFile(directory,source.material_file)).target);
  if(sha(bytes)!==source.sha256)fail('素材已变化，请重新读取');
  const meta=await imageMeta(bytes);return meta.orientation>1?sharp(bytes).rotate().png().toBuffer():bytes;
}
export async function listImageMaterials(directory,projectId){
  const {materials}=await readProjectMaterials(directory,projectId);
  return {materials:await Promise.all(materials.filter(m=>/\.(png|jpe?g|webp)$/i.test(m.file)).map(async m=>({asset:{file:m.file},title:m.title,media:await resolveImageMaterial(directory,m.file,m.title)})))};
}
export async function importImageMaterial(directory,projectId,value){
  if(typeof value.content!=='string'||value.content.length>Math.ceil(32*1024*1024/3)*4||!value.content.length||value.content.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.content))fail('图片内容无效或超过 32 MB');
  const bytes=Buffer.from(value.content,'base64');await imageMeta(bytes);
  const normalized=await sharp(bytes).rotate().png().toBuffer(),file=`image-${randomUUID()}.png`;
  await saveMaterial(directory,projectId,{file,title:value.title,encoding:'base64',content:normalized.toString('base64')});
  return {asset:{file},title:value.title,media:await resolveImageMaterial(directory,file,value.title)};
}
