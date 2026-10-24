import path from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
import {ApiError} from './http-support.mjs';
import {readFinishedPages,readFinishedRecord} from './finished-pages.mjs';
import {requireLetteringLocale} from './page-translation-document.mjs';
import {exportWorkTitle,filenamePart} from './work-title.mjs';
import {prepareExportMedia} from './finished-export-plan.mjs';
import {writeFinishedExport} from './finished-export-download.mjs';
import policy from '../shared/finished-export-policy.json' with {type:'json'};
import {mediaCache} from './media-cache.mjs';

export const exportModeLabels={standard:'高清',eh:'EH',pixiv:'Pixiv',preview:'网页'};
const editionLabels={zh:'中文',en:'英文',ja:'日文',clean:'无字'};
export function requireExportMode(mode){if(!Object.hasOwn(exportModeLabels,mode))throw new ApiError(400,'invalid_finished_export');return mode;}
export async function collectFinishedExport(projectRoot,projectId,directory,value) {
  if(!['lettered','clean'].includes(value?.variant))throw new ApiError(400,'invalid_finished_export');
  let mode=requireExportMode(value.mode??'standard');
  if(value.preview){if(!['standard','preview'].includes(mode))throw new ApiError(400,'invalid_finished_export');mode='preview';}
  const locale=requireLetteringLocale(value.locale),variant=value.variant,edition=variant==='clean'?'clean':locale;
  const listing=await readFinishedPages(projectRoot,projectId,directory,{locale,variant,mode});
  if(value.chapter_id!==undefined)throw new ApiError(400,'invalid_finished_export',['请使用 chapter_ids 选择章节']);
  const chapterIds=value.chapter_ids===undefined?null:choices(value.chapter_ids,listing.chapters.map(c=>c.id));
  const scope=chapterIds?listing.chapters.filter(c=>chapterIds.includes(c.id)).map(c=>c.title).join('_'):'全文';
  const scopeName=filenamePart(scope.replace(/[\s+]+/g,'_'),64);
  const pages=listing.pages.filter(p=>!chapterIds||chapterIds.includes(p.chapter_id));
  if(!pages.length)throw new ApiError(409,'finished_export_empty');
  const blocked=pages.filter(p=>p.status!=='ready');
  if(blocked.length)throw new ApiError(409,'finished_export_not_ready',blocked.map(p=>`${exportModeLabels[mode]} · ${editionLabels[edition]} · 第 ${p.page_number} 页 · ${p.title} · ${p.status_reasons.join('；')}`));
  const entries=[];
  for(const [offset,page] of pages.entries()){
    const r=await readFinishedRecord(directory,page.page_id,page.locale);
    entries.push({index:(page.page_number??offset+1)-1,chapter_id:page.chapter_id,sequence_id:page.sequence_id,source_backup:r.source_backup,source_sha256:r.source_sha256,video_postprocess:r.video_postprocess,duration_seconds:r.video?.duration_seconds??r.gif?.duration_seconds,relative:r.outputs[variant],gif:r.outputs.gif,warnings:r.warnings??[],width:r.width,height:r.height,media_kind:r.page_kind==='video'?'video':'image'});
  }
  const project=JSON.parse(await readFile(path.join(directory,'project.json'),'utf8'));
  const title=exportWorkTitle(project,variant==='clean'?'zh':locale);
  const stem=filenamePart(title)+'-'+scopeName+'-'+editionLabels[edition]+'-'+exportModeLabels[mode];
  return {directory,entries,mode,edition,scopeName,locale:variant==='clean'?'zh':locale,preview:mode==='preview',title,stem};
}
export async function prepareFinishedExport(selection,signal,progress) {
  const media=await prepareExportMedia(selection.directory,selection.entries,{mode:selection.mode,signal,progress});
  const sets=media.parts??[media.files];
  return {...selection,warnings:media.warnings,volumes:media.volumes,packs:sets.map((files,i)=>({files,preview:selection.preview,title:selection.title,locale:selection.locale,filename:selection.stem+(media.parts?'-'+String(i+1).padStart(2,'0'):'')+(selection.preview?'.html':'.zip')}))};
}
function choices(value,allowed){if(!Array.isArray(value)||!value.length||new Set(value).size!==value.length||value.some(v=>!allowed.includes(v)))throw new ApiError(400,'invalid_finished_export');return value;}
export async function collectFinishedSelections({projectRoot,projectId,value,readFacts,signal,progress}) {
  const modes=choices(value.modes,Object.keys(exportModeLabels)),editions=choices(value.editions,Object.keys(editionLabels));
  // 浏览器下载与本机保存共用完整预检，任何所选版本不可用时都不开始导出。
  const selections=[];
  for(const mode of modes)for(const edition of editions){
    signal.throwIfAborted();progress({message:`正在检查 ${exportModeLabels[mode]} · ${editionLabels[edition]}`});
    const result=await readFacts(projectId,({projectDirectory})=>collectFinishedExport(projectRoot,projectId,projectDirectory,{mode,variant:edition==='clean'?'clean':'lettered',locale:edition==='clean'?'zh':edition,chapter_ids:value.chapter_ids,chapter_id:value.chapter_id}));
    selections.push(result.value);
  }
  return selections;
}
export const finishedSelectionLabel=selection=>exportModeLabels[selection.mode]+' · '+editionLabels[selection.edition];
export async function createExportDirectory(directory,selections,date=new Date()) {
  const pad=n=>String(n).padStart(2,'0');
  const time=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const editions=Object.keys(editionLabels).filter(e=>selections.some(s=>s.edition===e)).map(e=>editionLabels[e]).join('_');
  const modes=Object.keys(exportModeLabels).filter(m=>selections.some(s=>s.mode===m)).map(m=>exportModeLabels[m]).join('_');
  const parent=path.join(directory,'Outputs','exports'),name=[selections[0].scopeName,editions,modes,time].join('-');
  await mkdir(parent,{recursive:true});
  for(let index=1;;index++){
    const target=path.join(parent,name+(index===1?'':'-'+index));
    try {await mkdir(target);return target;}catch(error){if(error.code!=='EEXIST')throw error;}
  }
}
export async function exportFinishedLocal({projectRoot,projectId,value,readFacts,signal,progress}) {
  const selections=await collectFinishedSelections({projectRoot,projectId,value,readFacts,signal,progress});
  return mediaCache.use(selections[0].directory,async()=>{
  signal.throwIfAborted();
  const root=await createExportDirectory(selections[0].directory,selections);
  const artifacts=[];
  try {
    for(const selection of selections){
      signal.throwIfAborted();
      const label=finishedSelectionLabel(selection);
      const prepared=await prepareFinishedExport(selection,signal,event=>progress({...event,message:label+' · '+event.message}));
      for(const pack of prepared.packs){
        const file=path.join(root,pack.filename);progress({message:`正在保存 ${pack.filename}`});
        const bytes=await writeFinishedExport(file,pack,signal,selection.mode==='eh'?policy.eh.batch_max_bytes:Infinity);
        artifacts.push({file,filename:pack.filename,mode:selection.mode,edition:selection.edition,bytes,volumes:prepared.volumes,warnings:prepared.warnings});
      }
    }
    return {directory:root,artifacts};
  } catch(error){error.exportDirectory=root;error.exported=artifacts;throw error;}
  });
}
