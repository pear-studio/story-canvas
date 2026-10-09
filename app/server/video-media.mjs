import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadLocalConfig} from './http-support.mjs';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function writeVideoPreview(source, target, width) {
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root)throw Error('动态预览需要已配置的 comfyui_root');
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  await promisify(execFile)(python,[path.join(appRoot,'python','video-preview.py'),source,target,String(width)],{timeout:120000,windowsHide:true,maxBuffer:1024*1024});
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
