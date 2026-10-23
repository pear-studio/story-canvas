import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,rename,unlink,rmdir} from 'node:fs/promises';
import {ApiError,loadLocalConfig} from './http-support.mjs';
import {resolveExistingProjectMedia} from './render-media.mjs';
import {createMediaVariantTasks} from './media-variant-tasks.mjs';
import {runVideoProcess} from './video-media.mjs';
import policy from '../shared/finished-export-policy.json' with {type:'json'};
import {mediaCache} from './media-cache.mjs';

const appRoot=fileURLToPath(new URL('../',import.meta.url)),join=createMediaVariantTasks();
const fail=(entry,message)=>{throw new ApiError(409,'finished_export_not_ready',[`第 ${entry.index+1} 页 · ${message}`]);};

export async function prepareExportAnimation(directory,entry,profile,signal) {
  return mediaCache.use(directory,()=>prepareExportAnimationCache(directory,entry,profile,signal));
}
async function prepareExportAnimationCache(directory,entry,profile,signal) {
  const legacy=path.extname(entry.relative??'').toLowerCase()==='.mp4';
  const source=await resolveExistingProjectMedia(directory,legacy?entry.relative:entry.source_backup??'');
  if(!source)fail(entry,'缺少冻结原片，无法制作压缩版或离线视频；高清与已有 GIF 仍可导出');
  const bytes=await readFile(source.target,{signal}),hash=createHash('sha256').update(bytes).digest('hex');
  if(!legacy&&hash!==entry.source_sha256)fail(entry,'冻结原片校验失败');
  const settings=legacy?{}:entry.video_postprocess??{};
  const key=createHash('sha256').update(hash).update(JSON.stringify({settings,profile,version:policy.version})).digest('hex');
  const cache=path.join(directory,'Saved','media-cache','export-animation'),target=path.join(cache,key+'.'+profile.format),meta=target+'.json';
  return join(target,signal=>mediaCache.use(directory,async()=>{
    try {const data=JSON.parse(await readFile(meta,'utf8'));if((await stat(target)).size===data.bytes){await mediaCache.record(directory,[target,meta]);return {target,size:data.bytes,width:data.width,height:data.height,duration_seconds:data.duration_seconds};}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    await mkdir(cache,{recursive:true});
    const staging=path.join(directory,'Saved','staging','export-animation-'+randomUUID());await mkdir(staging,{recursive:true});
    const input=path.join(staging,'source.mp4'),output=path.join(staging,'output.'+profile.format),metadata=path.join(staging,'metadata.json');
    try {
      await writeFile(input,bytes,{flag:'wx',signal});
      const config=await loadLocalConfig(appRoot);
      if(!config.comfyui_root)fail(entry,'未配置本机视频处理环境');
      const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
      await runVideoProcess(python,['-B','-X','utf8',path.join(appRoot,'python','video-export.py'),input,output,metadata,JSON.stringify(settings),JSON.stringify(profile)],{signal,kind:'finished_export_'+profile.format,settings,sourceKey:key});
      const data=JSON.parse(await readFile(metadata,'utf8'));
      if(!legacy&&Number.isFinite(entry.duration_seconds)&&Math.abs(data.duration_seconds-entry.duration_seconds)>.011)fail(entry,'导出动画时长与成品不符');
      signal.throwIfAborted();await rename(output,target);await rename(metadata,meta);
      await mediaCache.record(directory,[target,meta],{written:true});
      return {target,size:data.bytes,width:data.width,height:data.height,duration_seconds:data.duration_seconds};
    } finally {for(const file of [input,output,metadata])await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(staging);}
  }),signal);
}

export async function prepareEhAnimation(directory,entry,signal,encode=prepareExportAnimation) {
  return mediaCache.use(directory,()=>prepareEhAnimationCache(directory,entry,signal,encode));
}
async function prepareEhAnimationCache(directory,entry,signal,encode) {
  let output;
  for(const tier of policy.eh.tiers){
    const next=await encode(directory,entry,{format:'webp',...tier},signal);
    if(!output||next.size<output.size)output={...next,compression:tier};
    if(output.size<=policy.eh.animation_target_bytes)break;
  }
  if(output.size>=policy.eh.image_max_bytes)fail(entry,'EH 动画压缩后仍达到 19 MB，请调整该页');
  if(output.width>policy.eh.max_dimension||output.height>policy.eh.max_dimension)fail(entry,'EH 动画尺寸超过平台限制');
  return {...output,warning:output.size>policy.eh.animation_target_bytes?`第 ${entry.index+1} 页 · 动画超过 9.5 MB，EH 可能重采样`:undefined};
}
