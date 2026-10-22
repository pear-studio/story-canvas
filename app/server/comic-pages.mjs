import {readPageLayers} from './page-layers.mjs';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {readPageIndex,readPageContent,pageRelativePath} from './pages-store.mjs';
import {readPageRenderSettings} from './page-render-settings.mjs';
import {resolveProjectLocation} from './project-operations.mjs';
import {commitFactChanges} from './fact-commit.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {factConflict} from './fact-conflict.mjs';
import {ApiError} from './http-support.mjs';
import {createPage} from './page-facts.mjs';
import {comicLeaves,validateComicDocument,comicPanelDimensions,updateComicNode} from '../shared/comic-layout.mjs';
import {candidateFileRelativePath,readGenerationCandidateRecords} from './candidate-storage.mjs';
import {resolveExistingProjectMedia} from './render-media.mjs';
import {assertNoActivePageRender} from './render-task-storage.mjs';
import {listFinishedJobs,finishedBusyStatuses} from './finished-jobs.mjs';

export const comicPath = id => pageRelativePath(id,'comic');
export async function readComicDocument(directory,id) {
  let value;
  try { value=JSON.parse(await readFile(path.join(directory,comicPath(id)),'utf8')); }
  catch(error) { if(error.code==='ENOENT')return null;throw error; }
  const errors=validateComicDocument(value,id);
  if(errors.length)throw new ApiError(422,'invalid_comic_document',errors);
  return value;
}
export async function comicGenerationDimensions(directory,id) {
  const entry=(await readPageIndex(directory)).pages.find(page=>page.page_id===id);
  const document=await readComicDocument(directory,entry?.parent_page_id??id);
  return document?.panels[id]?.size_mode==='panel'?comicPanelDimensions(document,id):null;
}
async function context(root,projectId,id) {
  const {projectDirectory:directory}=await resolveProjectLocation(root,projectId);
  const index=await readPageIndex(directory),entry=index.pages.find(page=>page.page_id===id);
  if(!entry||entry.parent_page_id||entry.owner_kind!=='story')throw new ApiError(422,'comic_story_page_required');
  if((await readPageLayers(directory,id)).document.items.length)throw new ApiError(422,'comic_layers_unsupported',['请先移除素材图层，再转换为分镜']);
  if((await readPageContent(directory,id)).page_kind)throw new ApiError(422,'comic_image_page_required');
  return {directory,index,entry};
}
export async function convertComicPage(root,projectId,id) {
  const {directory}=await context(root,projectId,id);
  if(await readComicDocument(directory,id))throw new ApiError(409,'page_already_comic');
  const render=await readPageRenderSettings(directory,id);
  const candidates=await readGenerationCandidateRecords(directory,{pageKey:{page_id:id}});
  const document={version:1,canvas:render.canvas,margin:0,gutter:0,layout:{page_id:id},order:[id],panels:{[id]:{candidate_id:candidates.length===1?candidates[0].candidate_id:null,crop:{x:.5,y:.5,zoom:1},size_mode:'panel'}}};
  await commitFactChanges(directory,[{relative:comicPath(id),before:null,after:document}]);
  return {document,sha256:hashCanonicalJson(document)};
}

async function assertIdle(directory,ids){
  for(const id of ids)await assertNoActivePageRender(directory,{page_id:id});
  if((await listFinishedJobs(directory)).some(job=>ids.includes(job.page_id)&&finishedBusyStatuses.has(job.status)))throw new ApiError(409,'page_finished_output_busy');
}
export async function restoreComicPage(root,projectId,id,value){
  const {directory,index}=await context(root,projectId,id),before=await readComicDocument(directory,id);
  if(!before||value.expected_sha256!==hashCanonicalJson(before))throw factConflict('comic_layout_conflict');
  await assertIdle(directory,before.order);
  const entries=before.order.map(panelId=>{const entry=index.pages.find(page=>page.page_id===panelId);if(!entry)throw new ApiError(422,'comic_panel_missing');const {parent_page_id,...rest}=entry;return rest;});
  // 在根页位置按阅读顺序拆回，保留每格身份和全部原文件。
  const next=structuredClone(index);next.pages=[];
  for(const entry of index.pages){if(entry.page_id===id)next.pages.push(...entries);else if(!before.order.includes(entry.page_id))next.pages.push(entry);}
  await commitFactChanges(directory,[{relative:'pages/index.json',before:index,after:next},{relative:comicPath(id),before,after:null,remove:true}]);
  return {page_keys:entries.map(entry=>({page_id:entry.page_id})),restored:true};
}
export async function planComicMerge(root,projectId,id,value){
  const {directory,index,entry}=await context(root,projectId,id);
  const ids=value.page_keys?.map(key=>key.page_id);
  if(!Array.isArray(ids)||ids.length<2||ids.length>12||ids[0]!==id||new Set(ids).size!==ids.length||!['x','y'].includes(value.axis))throw new ApiError(422,'invalid_comic_merge');
  const sources=[];
  for(const pageId of ids){
    const source=index.pages.find(page=>page.page_id===pageId),content=source&&await readPageContent(directory,pageId),comic=source&&await readComicDocument(directory,pageId);
    if(!source||source.parent_page_id||source.owner_kind!=='story'||source.sequence_id!==entry.sequence_id||content.page_kind||comic&&comic.order.length!==1)throw new ApiError(422,'comic_merge_single_pages_required');
    const candidates=await readGenerationCandidateRecords(directory,{pageKey:{page_id:pageId}});
    if((await readPageLayers(directory,pageId)).document.items.length)throw new ApiError(422,'comic_layers_unsupported',['请先移除素材图层，再合并为分镜']);
    sources.push({page_id:pageId,title:content.title,entry:source,comic,candidate_ids:candidates.map(item=>item.candidate_id)});
  }
  const fingerprint=hashCanonicalJson({sources,axis:value.axis});
  return {sources,axis:value.axis,sha256:fingerprint};
}
export async function mergeComicPages(root,projectId,id,value){
  const plan=await planComicMerge(root,projectId,id,value);
  if(value.expected_sha256!==plan.sha256)throw factConflict('comic_merge_conflict');
  const {directory,index}=await context(root,projectId,id),ids=plan.sources.map(source=>source.page_id);
  await assertIdle(directory,ids);
  const tree=items=>items.length===1?{page_id:items[0]}:{id:`split-${randomBytes(6).toString('hex')}`,axis:value.axis,ratio:Math.floor(items.length/2)/items.length,first:tree(items.slice(0,Math.floor(items.length/2))),second:tree(items.slice(Math.floor(items.length/2)))};
  const render=await readPageRenderSettings(directory,id);
  const document={version:1,canvas:plan.sources[0].comic?.canvas??render.canvas,margin:0,gutter:0,layout:tree(ids),order:ids,panels:Object.fromEntries(plan.sources.map(source=>[source.page_id,source.comic?.panels[source.page_id]??{candidate_id:source.candidate_ids.length===1?source.candidate_ids[0]:null,crop:{x:.5,y:.5,zoom:1},size_mode:'panel'}]))};
  const next=structuredClone(index);next.pages=next.pages.map(entry=>ids.includes(entry.page_id)&&entry.page_id!==id?{...entry,parent_page_id:id}:entry);
  const writes=[{relative:'pages/index.json',before:index,after:next},{relative:comicPath(id),before:plan.sources[0].comic,after:document}];
  for(const source of plan.sources.slice(1))if(source.comic)writes.push({relative:comicPath(source.page_id),before:source.comic,after:null,remove:true});
  await commitFactChanges(directory,writes);
  return {document,sha256:hashCanonicalJson(document),page_key:{page_id:id},undo:{operation:'page.comic.restore',page_key:{page_id:id},expected_sha256:hashCanonicalJson(document)}};
}
export async function saveComicPage(root,projectId,id,value) {
  const {directory,index}=await context(root,projectId,id),before=await readComicDocument(directory,id);
  if(!before||value.expected_sha256!==hashCanonicalJson(before))throw factConflict('comic_layout_conflict');
  const document=structuredClone(value.document),errors=validateComicDocument(document,id);
  const allowed=index.pages.filter(page=>page.page_id===id||page.parent_page_id===id).map(page=>page.page_id);
  if(!errors.length && (comicLeaves(document.layout).some(page=>!allowed.includes(page))||allowed.some(page=>!document.order.includes(page))))errors.push('布局必须包含本页全部分镜');
  if(errors.length)throw new ApiError(422,'invalid_comic_document',errors);
  for(const [pageId,panel] of Object.entries(document.panels))if(panel.candidate_id&&!await resolveExistingProjectMedia(directory,candidateFileRelativePath({page_id:pageId},panel.candidate_id)))throw new ApiError(422,'comic_candidate_missing',[pageId]);
  await commitFactChanges(directory,[{relative:comicPath(id),before,after:document}]);
  return {document,sha256:hashCanonicalJson(document)};
}
export async function splitComicPanel(root,projectId,id,value) {
  const {directory,entry}=await context(root,projectId,id),before=await readComicDocument(directory,id);
  if(!before||value.expected_sha256!==hashCanonicalJson(before))throw factConflict('comic_layout_conflict');
  if(!before.order.includes(value.panel_id)||!['x','y'].includes(value.axis)||before.order.length>=12)throw new ApiError(422,'invalid_comic_split');
  // 在一次项目写锁和事实提交中同时建立空分镜与布局。
  const render=await readPageRenderSettings(directory,value.panel_id);
  let receipt;
  receipt=await createPage(root,projectId,{owner_kind:'story',sequence_id:entry.sequence_id,parent_page_id:id},{content:{title:`分镜 ${before.order.length+1}`},extraWrites:async(newId)=>{
    const document=structuredClone(before);
    document.layout=updateComicNode(document.layout,value.panel_id,()=>({id:`split-${randomBytes(6).toString('hex')}`,axis:value.axis,ratio:.5,first:{page_id:value.panel_id},second:{page_id:newId}}));
    document.order.splice(document.order.indexOf(value.panel_id)+1,0,newId);
    document.panels[newId]={candidate_id:null,crop:{x:.5,y:.5,zoom:1},size_mode:'panel'};
    const errors=validateComicDocument(document,id);if(errors.length)throw new ApiError(422,'invalid_comic_split',errors);
    return [{relative:comicPath(id),before,after:document}];
  },renderSettings:render});
  return {panel_id:receipt.page_id,document:await readComicDocument(directory,id)};
}
