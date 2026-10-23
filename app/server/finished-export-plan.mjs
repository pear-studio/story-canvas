import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,stat,rename,unlink} from 'node:fs/promises';
import sharp from 'sharp';
import {ApiError} from './http-support.mjs';
import {createMediaVariantTasks} from './media-variant-tasks.mjs';
import {prepareGifFiles,gifPolicy} from './animation-output.mjs';
import {resolveExistingProjectMedia} from './render-media.mjs';
import {ensureMediaVariant} from './media-variants.mjs';
import {prepareExportAnimation,prepareEhAnimation} from './finished-export-animation.mjs';
import exportPolicy from '../shared/finished-export-policy.json' with {type:'json'};
import policy from '../shared/pixiv-export-policy.json' with {type:'json'};
import {mediaCache} from './media-cache.mjs';
export {policy as pixivPolicy};
const join=createMediaVariantTasks();
const fail=message=>{throw new ApiError(409,'finished_export_not_ready',[message]);};

export async function prepareExportMedia(directory,entries,{mode,preview,signal,progress=()=>{}}) {
  if(preview)mode='preview';
  const files=[],warnings=[];
  for(const [offset,entry] of entries.entries()) {
    signal.throwIfAborted();
    progress({message:`正在准备图片 ${offset+1}/${entries.length}`,completed:offset,total:entries.length});
    const video=entry.media_kind==='video',legacy=path.extname(entry.relative??'').toLowerCase()==='.mp4';
    const relative=mode==='pixiv'&&video&&!legacy?entry.gif:entry.relative;
    const media=relative&&await resolveExistingProjectMedia(directory,relative);
    if(!media)fail(`第 ${entry.index+1} 页成品文件缺失`);
    let exported={target:media.target,size:(await stat(media.target)).size};
    if(video&&(mode==='preview'||mode==='eh')) {
      exported=mode==='preview'?await prepareExportAnimation(directory,entry,{format:'mp4',...exportPolicy.preview},signal):await prepareEhAnimation(directory,entry,signal);
      if(exported.warning)warnings.push(exported.warning);
    } else if(video&&legacy) {
      if(mode==='pixiv') {
        const source=await readFile(media.target,{signal}),gif=await prepareGifFiles(source,directory,undefined,signal);
        exported={target:gif.gifTarget,size:gif.gif.length};
        Object.assign(entry,{source_backup:relative,source_sha256:createHash('sha256').update(source).digest('hex'),video_postprocess:{},duration_seconds:gif.metadata.gif.duration_seconds});
      } else {
        const webp=await ensureMediaVariant(directory,{target:media.target,info:await stat(media.target)},relative,'original',undefined,signal);
        exported={target:webp.target,size:(await stat(webp.target)).size};
      }
    } else if(!video) {
      if(mode==='pixiv'||mode==='eh')exported=await preparePixivJpeg(directory,media.target,signal,mode==='eh'?exportPolicy.eh.image_max_bytes:policy.image_max_bytes);
      else if(mode==='preview'){const small=await ensureMediaVariant(directory,{target:media.target,info:await stat(media.target)},relative,1024,undefined,signal);exported={target:small.target,size:(await stat(small.target)).size};}
    }
    if(mode==='pixiv'&&video){
      if(exported.size>gifPolicy.max_bytes){
        const source=entry.source_backup&&await resolveExistingProjectMedia(directory,entry.source_backup);
        const bytes=source&&await readFile(source.target,{signal});
        if(!bytes||createHash('sha256').update(bytes).digest('hex')!==entry.source_sha256)fail(`第 ${entry.index+1} 页 GIF 超过 15 MB，且缺少匹配原片`);
        const gif=await prepareGifFiles(bytes,directory,entry.video_postprocess,signal);
        exported={target:gif.gifTarget,size:gif.gif.length};
      }
      const metadata=await sharp(await readFile(exported.target,{signal}),{animated:true}).metadata();
      if((metadata.pages??1)>exportPolicy.pixiv_gif_max_frames)fail(`第 ${entry.index+1} 页 GIF 超过 500 帧，请调整该页`);
    }
    files.push({...entry,...exported,name:String(entry.index+1).padStart(3,'0')+path.extname(exported.target)});
  }
  progress({message:`图片准备完成 · ${entries.length}/${entries.length}`,completed:entries.length,total:entries.length});
  if(mode!=='pixiv'&&mode!=='eh')return {files,warnings,volumes:[]};
  const planned=mode==='pixiv'?planPixivExport(files):planEhExport(files);
  return {...planned,warnings:[...new Set([...warnings,...planned.warnings])]};
}

export async function preparePixivJpeg(directory,target,signal,maxBytes=policy.image_max_bytes) {
  return mediaCache.use(directory,()=>preparePixivJpegCache(directory,target,signal,maxBytes));
}
async function preparePixivJpegCache(directory,target,signal,maxBytes) {
  const input=await readFile(target,{signal});
  const key=createHash('sha256').update(input).update(JSON.stringify({policy,maxBytes})).digest('hex');
  const cache=path.join(directory,'Saved','media-cache','pixiv'),output=path.join(cache,key+'.jpg');
  return join(output,signal=>mediaCache.use(directory,async()=>{
    try {const size=(await stat(output)).size;if(size>0&&size<maxBytes){await mediaCache.record(directory,[output]);return {target:output,size};}}catch(error){if(error.code!=='ENOENT')throw error;}
    await mkdir(cache,{recursive:true});
    for(const tier of policy.jpeg) {
      signal.throwIfAborted();
      const temp=output+'.'+randomUUID()+'.tmp';
      try {
        const info=await sharp(input).rotate().resize({width:tier.edge,height:tier.edge,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:tier.quality,chromaSubsampling:'4:4:4',mozjpeg:true}).toFile(temp);
        signal.throwIfAborted();
        if(info.size<maxBytes){await rename(temp,output);await mediaCache.record(directory,[output],{written:true});return {target:output,size:info.size};}
      } finally {await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
    fail(`单张 JPEG 压缩后仍达到 ${maxBytes/1_000_000} MB，请调整该页`);
  }),signal);
}

// 在连续候选边界中求页数方差最小的切分，不按容量贪心塞满前卷。
export function balancedVolumes(files,boundaries,count,{maxPages=policy.max_pages,maxBytes=Infinity}={}) {
  const n=files.length,prefix=[0];for(const f of files)prefix.push(prefix.at(-1)+f.size);
  let states=new Map([[0,{score:0,cuts:[]}]]);
  for(let k=1;k<=count;k++) {
    const next=new Map();
    for(const end of boundaries)for(const [start,state] of states) {
      if(end<=start||end-start>maxPages||prefix[end]-prefix[start]>maxBytes)continue;
      const score=state.score+(end-start-n/count)**2;
      if(!next.has(end)||score<next.get(end).score)next.set(end,{score,cuts:[...state.cuts,end]});
    }
    states=next;
  }
  const final=states.get(n);if(!final)return null;
  let start=0;return final.cuts.map(end=>{const volume=files.slice(start,end);start=end;return volume;});
}


function partition(files,maxPages,maxBytes) {
  if(!files.length)return [];
  if(files.some(f=>f.size>maxBytes))fail('单页超过分包大小限制');
  const boundarySets=['chapter_id','sequence_id',null].map(field=>files.flatMap((f,i)=>!field||i===files.length-1||f[field]!==files[i+1][field]?[i+1]:[]));
  const minCount=Math.max(Math.ceil(files.length/maxPages),Math.ceil(files.reduce((s,f)=>s+f.size,0)/maxBytes));
  for(const boundaries of boundarySets)for(let count=minCount;count<=boundaries.length;count++) {
    const volumes=balancedVolumes(files,boundaries,count,{maxPages,maxBytes});
    if(volumes)return volumes;
  }
  fail('无法满足分包限制');
}
function summarize(volume,folder,kind) {
  return {folder,kind,first:volume[0].index+1,last:volume.at(-1).index+1,pages:volume.length,bytes:volume.reduce((s,f)=>s+f.size,0),compressed:volume.filter(f=>f.compression).map(f=>({page:f.index+1,...f.compression}))};
}
export function planPixivExport(files,{maxBytes=policy.max_bytes,maxPages=policy.max_pages}={}) {
  const stills=files.filter(f=>f.media_kind!=='video'),animations=files.filter(f=>f.media_kind==='video');
  if(stills.some(f=>f.size>=policy.image_max_bytes)||animations.some(f=>f.size>gifPolicy.max_bytes))fail('Pixiv 单文件超限（GIF ≤15 MB，JPEG <30 MB）');
  const volumes=partition(stills,maxPages,maxBytes),summary=volumes.map((v,i)=>summarize(v,'静态投稿/'+String(i+1).padStart(2,'0')+'-'+String(v[0].index+1).padStart(3,'0')+'-'+String(v.at(-1).index+1).padStart(3,'0'),'static'));
  const output=volumes.flatMap((v,i)=>v.map(f=>({...f,name:summary[i].folder+'/'+f.name})));
  if(animations.length){summary.push(summarize(animations,'动画GIF','animations'));output.push(...animations.map(f=>({...f,name:'动画GIF/'+f.name})));}
  return {files:output,volumes:summary,warnings:[]};
}
export function planEhExport(files,{maxBytes=exportPolicy.eh.batch_max_bytes}={}) {
  if(files.length>exportPolicy.eh.max_pages||files.reduce((s,f)=>s+f.size,0)>exportPolicy.eh.gallery_max_bytes)fail('EH 单画廊超过 2,000 张或 10 GB，请选择章节导出');
  if(files.some(f=>f.size>=exportPolicy.eh.image_max_bytes))fail('EH 单文件达到 19 MB');
  // Store ZIP 仍有目录和文件头；预留逐项开销，实际写出时再核对包大小。
  const weighted=files.map(f=>({...f,size:f.size+512+2*Buffer.byteLength(f.name),original:f}));
  const volumes=partition(weighted,exportPolicy.eh.max_pages,maxBytes-1024).map(v=>v.map(f=>f.original));
  return {files,volumes:volumes.map((v,i)=>summarize(v,String(i+1).padStart(2,'0'),'batch')),parts:volumes,warnings:[]};
}
