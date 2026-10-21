import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,stat,rename,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {loadLocalConfig} from './http-support.mjs';
import {runVideoProcess} from './video-media.mjs';
import {ensureMediaVariant} from './media-variants.mjs';
import {createMediaVariantTasks} from './media-variant-tasks.mjs';
import {normalizeVideoPostprocess} from '../shared/video-postprocess.mjs';
import {webpPlaybackMetadata} from './webp-timing.mjs';

const appRoot=fileURLToPath(new URL('../',import.meta.url)),join=createMediaVariantTasks();

// 同一冻结源和设置共用缓存；完成前不发布 metadata，缓存缺失可直接重建。
export async function prepareAnimationFiles(bytes,directory,postprocess,signal) {
  const settings=normalizeVideoPostprocess(postprocess);
  const key=createHash('sha256').update(bytes).update(JSON.stringify(settings)).update('gif-480-12-v1').digest('hex');
  const cache=path.join(directory,'Saved','media-cache');
  const target={gif:path.join(cache,key+'.gif'),poster:path.join(cache,key+'.png'),metadata:path.join(cache,key+'.json')};
  return join(target.metadata,async signal=>{
    await mkdir(cache,{recursive:true});
    const temporary=path.join(directory,'Saved','staging','animation-'+randomUUID());
    await mkdir(temporary,{recursive:true});
    const source=path.join(temporary,'source.mp4'),gif=path.join(temporary,'animation.gif'),poster=path.join(temporary,'poster.png'),metadata=path.join(temporary,'metadata.json');
    try {
      await writeFile(source,bytes,{flag:'wx',signal});
      const webp=await ensureMediaVariant(directory,{target:source,info:await stat(source),sourceBytes:bytes},'source.mp4','original',settings,signal);
      let data;
      try {data=JSON.parse(await readFile(target.metadata,'utf8'));await stat(target.gif);await stat(target.poster);}catch {data=null;}
      if(!data){
        const config=await loadLocalConfig(appRoot);
        if(!config.comfyui_root)throw Error('动态成品需要已配置的 comfyui_root');
        const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
        await runVideoProcess(python,['-B',path.join(appRoot,'python','video-gif.py'),source,gif,poster,metadata,JSON.stringify(settings)],{signal,kind:'gif_output',settings,width:480,sourceKey:key});
        data=JSON.parse(await readFile(metadata,'utf8'));
        signal.throwIfAborted();
        await rename(gif,target.gif);await rename(poster,target.poster);await rename(metadata,target.metadata);
      }
      const webpBytes=await readFile(webp.target,{signal});
      const timing=webpPlaybackMetadata(webpBytes);
      const dimensions=await sharp(webpBytes,{animated:true}).metadata();
      if(dimensions.width!==data.width||(dimensions.pageHeight??dimensions.height)!==data.height)throw Error('WebP 成品尺寸不符');
      return {webpTarget:webp.target,gifTarget:target.gif,webp:webpBytes,gif:await readFile(target.gif,{signal}),poster:await readFile(target.poster,{signal}),
        metadata:{...data,...timing,duration_seconds:timing.duration_seconds??data.duration_seconds}};
    } finally {
      for(const file of [source,gif,poster,metadata])await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await rmdir(temporary);
    }
  },signal);
}
