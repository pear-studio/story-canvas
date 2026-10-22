import {candidateFileRelativePath,requireCandidateId} from './candidate-storage.mjs';
import path from 'node:path';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {emptyLayers,validateLayers,layerGeometryErrors,imagePlacement,imageSourceForLocale,imageSourceFiles} from '../shared/image-layers.mjs';
import {requireLetteringLocale} from './page-translation-document.mjs';
import {resolveImageMaterial,imageMaterialBytes,imageMaterialLabels} from './image-materials.mjs';
import {composeImageLayers} from './image-layer-render.mjs';
import {readPageIndex,readPageContent,pageRelativePath} from './pages-store.mjs';
import {readPageRenderSettings} from './page-render-settings.mjs';
import {resolveExistingProjectMedia,resolveProjectMediaTarget} from './render-media.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {factConflict} from './fact-conflict.mjs';
import {commitFactChanges} from './fact-commit.mjs';
import {ApiError} from './http-support.mjs';
const fail=errors=>{throw new ApiError(422,'invalid_page_layers',errors);};
export async function readPageLayers(directory,id){
  const file=pageRelativePath(id,'layers');
  const document=await readFile(path.join(directory,file),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return emptyLayers();throw e;});
  const errors=validateLayers(document);if(errors.length)fail(errors);
  return {document,sha256:hashCanonicalJson(document)};
}
export async function requireLayersPage(directory,id){
  const entry=(await readPageIndex(directory)).pages.find(p=>p.page_id===id),content=entry&&await readPageContent(directory,id);
  if(!entry||entry.parent_page_id||content.page_kind||await stat(path.join(directory,pageRelativePath(id,'comic'))).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;}))fail(['素材图层仅支持普通静态图片页']);
}
export async function resolveLayerMedia(directory,document,locale='zh'){
  requireLetteringLocale(locale);
  const errors=validateLayers(document);if(errors.length)fail(errors);
  if(!Object.keys(document.assets).length)return {};
  const labels=await imageMaterialLabels(directory);
  return Object.fromEntries(await Promise.all(Object.entries(document.assets).map(async([id,a])=>{
    const source=imageSourceForLocale(a,locale),label=labels.get(a.file)??a.file;
    return [id,source?await resolveImageMaterial(directory,source.file,label):{label,width:1,height:1,error:`${label}：缺少${locale==='en'?'英文':'日文'}素材`}];
  })));
}
export function layerFingerprint(document,media,locale='zh'){
  const localized={...document,assets:Object.fromEntries(Object.entries(document.assets).map(([id,a])=>[id,imageSourceForLocale(a,locale)]))};
  return hashCanonicalJson({document:localized,sources:Object.fromEntries([...new Set(document.items.filter(i=>i.enabled).map(i=>i.asset_id))].sort().map(id=>[id,media[id]?.error??media[id]?.sha256??'missing']))});
}
export async function captureLayers(directory,document,locale='zh'){
  const media=await resolveLayerMedia(directory,document,locale),buffers={};
  for(const id of new Set(document.items.filter(i=>i.enabled).map(i=>i.asset_id)))buffers[id]=await imageMaterialBytes(directory,media[id]);
  return {media,buffers,sha256:layerFingerprint(document,media,locale)};
}
export async function prepareLayersWrite(directory,id,value){
  await requireLayersPage(directory,id);
  const before=await readPageLayers(directory,id);
  if(value.expected_sha256!==before.sha256)throw factConflict('page_layers_conflict');
  const document=structuredClone(value.document),errors=validateLayers(document);if(errors.length)fail(errors);
  const used=new Set(document.items.map(i=>i.asset_id));document.assets=Object.fromEntries(Object.entries(document.assets).filter(([id])=>used.has(id)));
  for(const [key,a] of Object.entries(document.assets))for(const file of imageSourceFiles(a)){
    if(imageSourceFiles(before.document.assets[key]).includes(file))continue;
    const media=await resolveImageMaterial(directory,file);if(media.error)fail([media.error]);
  }
  const canvas=(await readPageRenderSettings(directory,id)).canvas;
  for(const locale of ['zh','en','ja']){
    const geometryErrors=layerGeometryErrors(document,await resolveLayerMedia(directory,document,locale),canvas);if(geometryErrors.length)fail(geometryErrors);
  }
  const relative=pageRelativePath(id,'layers'),exists=await stat(path.join(directory,relative)).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;});
  return {write:{relative,before:exists?before.document:null,after:document},scope:{document,sha256:hashCanonicalJson(document)}};
}
export async function savePageLayers(directory,id,value){const prepared=await prepareLayersWrite(directory,id,value);await commitFactChanges(directory,[prepared.write]);return prepared.scope;}
export async function inspectPageLayers(directory,projectId,value){
  const id=value.page_key?.page_id;await requireLayersPage(directory,id);
  const scope=value.document?{document:value.document}:await readPageLayers(directory,id);
  requireCandidateId(value.candidate_id);
  const source=await resolveExistingProjectMedia(directory,candidateFileRelativePath({page_id:id},value.candidate_id));if(!source)fail(['指定候选不存在']);
  const locale=requireLetteringLocale(value.locale??'zh');
  const clean=await readFile(source.target),size=await sharp(clean).metadata(),capture=await captureLayers(directory,scope.document,locale);
  const errors=layerGeometryErrors(scope.document,capture.media,size);if(errors.length)fail(errors);
  const output=await composeImageLayers(clean,scope.document,capture),relative=`Saved/layer-previews/${randomUUID()}.png`,target=await resolveProjectMediaTarget(directory,relative,{createParent:true});await writeFile(target.target,output);
  return {...scope,locale,canvas:{width:size.width,height:size.height},layers:scope.document.items.map(item=>({...item,visible_box:imagePlacement(capture.media[item.asset_id],item.box,item.crop,size).box})),preview:{absolute_file:target.target,url:`/api/projects/${encodeURIComponent(projectId)}/media/${relative}`}};
}
