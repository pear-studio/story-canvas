import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadLocalConfig} from './http-support.mjs';
import {normalizeVideoPostprocess} from '../shared/video-postprocess.mjs';
import {createPerformanceLog} from './performance-log.mjs';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const persistVideoLog=createPerformanceLog(path.dirname(appRoot),5*1024*1024,'video-processing.jsonl');
export function logVideoProcessing(record) {
  console.info(JSON.stringify(record));
  void persistVideoLog(record);
}
// 等待子进程真正退出后才清理临时文件；断开请求不会留下编码进程。
export async function runVideoProcess(python, args, {signal,kind,settings,width,sourceKey}={}) {
  signal?.throwIfAborted();
  const id=randomUUID(),started=performance.now();
  logVideoProcessing({event:'video_processing',id,kind,status:'started',settings,width,source:sourceKey});
  let status='completed',failure;
  try {
    await new Promise((resolve,reject)=>{
      const child=execFile(python,args,{timeout:120000,windowsHide:true,maxBuffer:1024*1024},error=>{
        signal?.removeEventListener('abort',abort);
        if(signal?.aborted)reject(signal.reason);
        else if(error)reject(error);
        else resolve();
      });
      const abort=()=>child.kill();
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  } catch(error) {status=signal?.aborted?'cancelled':'failed';failure=status==='failed'?String(error.stderr||error.message).slice(-2000):undefined;throw error;}
  finally {logVideoProcessing({event:'video_processing',id,kind,status,elapsed_ms:Math.round(performance.now()-started),settings,width,source:sourceKey,error:failure});}
}
export async function writeVideoPreview(source, target, width, postprocess, signal) {
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root)throw Error('动态预览需要已配置的 comfyui_root');
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const settings=normalizeVideoPostprocess(postprocess);
  await runVideoProcess(python,['-B',path.join(appRoot,'python','video-preview.py'),source,target,String(width),JSON.stringify(settings)],{signal,kind:'webp_preview',settings,width,sourceKey:path.basename(path.dirname(source))});
}
export async function processVideoBytes(bytes, directory, postprocess) {
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root)throw Error('动态后处理需要已配置的 comfyui_root');
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const temporary=path.join(directory,'Saved','staging','video-edit-'+randomUUID());
  await mkdir(temporary,{recursive:true});
  try {
    const source=path.join(temporary,'source.mp4'),target=path.join(temporary,'processed.mp4'),poster=path.join(temporary,'poster.png'),metadata=path.join(temporary,'metadata.json');
    await writeFile(source,bytes,{flag:'wx'});
    const settings=normalizeVideoPostprocess(postprocess);
    await runVideoProcess(python,['-B',path.join(appRoot,'python','video-postprocess.py'),source,target,poster,metadata,JSON.stringify(settings)],{kind:'mp4_output',settings});
    return {bytes:await readFile(target),poster:await readFile(poster),metadata:JSON.parse(await readFile(metadata,'utf8'))};
  } finally {await rm(temporary,{recursive:true,force:true});}
}
export async function inspectVideoBytes(bytes,directory,expected) {
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root)throw Error('本机视频审阅需要已配置的 comfyui_root');
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const temporary=path.join(directory,'Saved','staging','video-'+randomUUID());
  await mkdir(temporary,{recursive:true});
  try {
    const source=path.join(temporary,'video.mp4');await writeFile(source,bytes);
    await promisify(execFile)(python,[path.join(appRoot,'python','video-review.py'),source,temporary],{timeout:120000,windowsHide:true,maxBuffer:1024*1024});
    const metadata=JSON.parse(await readFile(path.join(temporary,'video.json'),'utf8'));
    if(metadata.frames!==expected.frames)throw Error('视频实际帧数与冻结任务不符');
    return {metadata,poster:await readFile(path.join(temporary,'image.png')),review:await readFile(path.join(temporary,'review.jpg')),bytes};
  } finally {await rm(temporary,{recursive:true,force:true});}
}
