import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {encodePageKey} from './page-key.mjs';
import {resolveExistingProjectMedia,resolveProjectMediaTarget} from './render-media.mjs';
import {replaceFileWithRetry} from './file-replace.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {commitFactChanges} from './fact-commit.mjs';
import {listFinishedJobs,finishedBusyStatuses} from './finished-jobs.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'finished_clean_error'});};
function requirePage(id){encodePageKey({page_id:id});return id;}
export const finishedRecordMedia=record=>[...Object.values(record?.outputs??{}),record?.poster,record?.source_backup].filter(Boolean);
export function sharedFinishedCleanPath(id,bytes){return `Outputs/finished/${requirePage(id)}/clean/${sha(bytes)}.png`;}

export async function writeSharedFinishedClean(directory,id,bytes) {
  const relative=sharedFinishedCleanPath(id,bytes),media=await resolveProjectMediaTarget(directory,relative,{createParent:true});
  if(media.exists){if(sha(await readFile(media.target))!==sha(bytes))fail('共享底图内容与文件名指纹不符');return relative;}
  const temporary=media.target+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,bytes,{flag:'wx'});await replaceFileWithRetry(temporary,media.target);}
  finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return relative;
}
async function pageRecords(directory,id) {
  requirePage(id);
  return Promise.all(['zh','en','ja'].map(async locale=>{
    const relative=`finished/${id}${locale==='zh'?'':'.'+locale}.json`,media=await resolveExistingProjectMedia(directory,relative);
    const record=media?JSON.parse(await readFile(media.target,'utf8')):null;
    if(record&&record.page_key?.page_id!==id)fail('成品记录页面身份不匹配');
    return {locale,relative,record};
  }));
}

// 调用者持有项目写锁；任何读取异常都保留媒体，清理失败不改变事实提交结果。
export async function cleanupFinishedMedia(directory,id,relatives) {
  const result={removed:[],warnings:[]};
  try {
    const records=await pageRecords(directory,id),used=new Set(records.flatMap(({record})=>finishedRecordMedia(record)));
    for(const relative of new Set(relatives)) {
      if(typeof relative!=='string'||!relative.startsWith(`Outputs/finished/${id}/`)||used.has(relative))continue;
      try {
        const media=await resolveExistingProjectMedia(directory,relative);
        if(media){await unlink(media.target);result.removed.push(relative);await rmdir(path.dirname(media.target)).catch(()=>{});}
      }catch(error){result.warnings.push({file:relative,message:error.message});}
    }
  }catch(error){result.warnings.push({message:error.message});}
  if(result.warnings.length)console.warn('[story-canvas] 成品媒体清理未完成',result.warnings);
  return result;
}

async function sharingPlan(directory,value) {
  const id=requirePage(value.page_key?.page_id);
  if((await listFinishedJobs(directory)).some(job=>job.page_id===id&&finishedBusyStatuses.has(job.status)))fail('本页正在制作成品，请完成后再归并底图');
  const records=await pageRecords(directory,id),groups=new Map(),mediaIdentity=[];
  for(const entry of records) {
    const r=entry.record;if(!r||r.page_kind==='video'||!r.outputs?.clean?.endsWith('.png'))continue;
    const media=await resolveExistingProjectMedia(directory,r.outputs.clean);
    if(!media)fail('成品底图缺失：'+entry.locale);
    if(!r.outputs.clean.startsWith(`Outputs/finished/${id}/`))fail('底图不属于本页');
    const bytes=await readFile(media.target),hash=sha(bytes);
    mediaIdentity.push({locale:entry.locale,file:r.outputs.clean,sha256:hash});
    if(!groups.has(hash))groups.set(hash,{sha256:hash,target:sharedFinishedCleanPath(id,bytes),bytes,entries:[],files:new Set()});
    const group=groups.get(hash);group.entries.push(entry);group.files.add(r.outputs.clean);
  }
  const repeated=[...groups.values()].filter(g=>g.files.size>1);
  const plan={page_id:id,expected_sha256:hashCanonicalJson({records,media:mediaIdentity}),groups:repeated.map(g=>({sha256:g.sha256,target:g.target,files:[...g.files],locales:g.entries.map(e=>e.locale),bytes:g.bytes.length,saving_bytes:(g.files.size-1)*g.bytes.length})),saving_bytes:repeated.reduce((s,g)=>s+(g.files.size-1)*g.bytes.length,0)};
  return {plan,groups:repeated};
}
export async function inspectFinishedCleanSharing(directory,value){return (await sharingPlan(directory,value)).plan;}
export async function shareFinishedClean(directory,value) {
  const {plan,groups}=await sharingPlan(directory,value);
  if(!value.expected_sha256||value.expected_sha256!==plan.expected_sha256)fail('成品记录已变化，请重新检查共享计划');
  const writes=[],targets=[];
  try {
    for(const group of groups) {
      await writeSharedFinishedClean(directory,plan.page_id,group.bytes);targets.push(group.target);
      for(const entry of group.entries)if(entry.record.outputs.clean!==group.target)writes.push({relative:entry.relative,before:entry.record,after:{...entry.record,outputs:{...entry.record.outputs,clean:group.target}}});
    }
    await commitFactChanges(directory,writes,{cleanupReferences:false});
  }catch(error){await cleanupFinishedMedia(directory,plan.page_id,targets);throw error;}
  const cleanup=await cleanupFinishedMedia(directory,plan.page_id,groups.flatMap(g=>[...g.files]));
  return {changed:writes.length>0,updated_records:writes.length,...plan,...cleanup};
}
