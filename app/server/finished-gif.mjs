import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,stat,copyFile,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {ApiError} from './http-support.mjs';
import {readFinishedRecord,publishFinishedPage} from './finished-pages.mjs';
import {listFinishedJobs,finishedBusyStatuses} from './finished-jobs.mjs';
import {resolveExistingProjectMedia} from './render-media.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {prepareGifFiles,gifPolicy} from './animation-output.mjs';

const fail=message=>{throw new ApiError(409,'finished_gif_error',[message]);};
async function currentRecord(directory,value) {
  const record=await readFinishedRecord(directory,value.page_key?.page_id);
  if(!record||record.page_kind!=='video'||record.media_format!=='webp')fail('需要已保存的 WebP＋GIF 动态成品');
  if(!value.expected_sha256||hashCanonicalJson(record)!==value.expected_sha256)fail('成品已变化，请重新检查');
  if((await listFinishedJobs(directory)).some(job=>job.page_id===record.page_key.page_id&&finishedBusyStatuses.has(job.status)))fail('本页正在制作成品，请完成后再优化 GIF');
  return record;
}

export async function optimizeFinishedGif({repositoryRoot,projectId,value,readFacts,mutateTargetFacts,encode=prepareGifFiles}) {
  const inspected=await readFacts(projectId,async({projectDirectory})=>{
    const record=await currentRecord(projectDirectory,value);
    const file=await resolveExistingProjectMedia(projectDirectory,record.outputs.gif);
    if(!file)fail('GIF 文件缺失');
    return {directory:projectDirectory,record,gifTarget:file.target,bytes:(await stat(file.target)).size};
  });
  const {directory,record,gifTarget,bytes}=inspected.value;
  if(bytes<=gifPolicy.max_bytes)return {...inspected,value:{changed:false,page_id:record.page_key.page_id,bytes}};
  const source=await resolveExistingProjectMedia(directory,record.source_backup);
  if(!source)fail('原片备份缺失，保留现有 GIF');
  const sourceBytes=await readFile(source.target);
  if(createHash('sha256').update(sourceBytes).digest('hex')!==record.source_sha256)fail('原片备份与成品指纹不符，保留现有 GIF');
  let encoded;
  try {encoded=await encode(sourceBytes,directory,record.video_postprocess);}
  catch(error){fail(error.message);}
  const gif=encoded.metadata.gif,info=await sharp(encoded.gif,{animated:true}).metadata();
  const duration=(info.delay??[]).reduce((sum,ms)=>sum+ms,0)/1000;
  if(encoded.gif.length>gifPolicy.max_bytes||encoded.gif.length!==gif.bytes||info.width!==gif.width||(info.pageHeight??info.height)!==gif.height||Math.abs(duration-record.gif.duration_seconds)>.011||Math.abs(duration-gif.duration_seconds)>.011)fail('新 GIF 大小、尺寸或时长校验失败，保留现有成品');
  return mutateTargetFacts(projectId,async()=>{
    await currentRecord(directory,value);
    const prefix=`Outputs/finished/${record.page_key.page_id}/gif-${randomUUID()}`;
    const output=prefix+'/animation.gif',backup=prefix+'/previous-record.json',oldGif=prefix+'/previous.gif';
    await mkdir(path.join(directory,prefix),{recursive:true});
    let published=false;
    try {
      await copyFile(gifTarget,path.join(directory,oldGif));
      await writeFile(path.join(directory,backup),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
      await writeFile(path.join(directory,output),encoded.gif,{flag:'wx'});
      const updated={...record,outputs:{...record.outputs,gif:output},gif,warnings:encoded.metadata.warnings};
      await publishFinishedPage(repositoryRoot,projectId,directory,{job:{page_id:record.page_key.page_id,locale:'zh'},expected:value.expected_sha256},updated);
      published=true;
      return {changed:true,page_id:record.page_key.page_id,before_bytes:bytes,bytes:encoded.gif.length,gif,backup_record:backup,backup_gif:oldGif};
    } finally {
      if(!published){for(const file of [output,backup,oldGif])await unlink(path.join(directory,file)).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(path.join(directory,prefix));}
    }
  });
}
