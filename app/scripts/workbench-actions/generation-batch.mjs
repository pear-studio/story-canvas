import { invalid } from './contract.mjs';
import {saveOperationRecord} from './operation-records.mjs';

function countsFor(results) {
  const counts={total:results.length,submitted:0,rejected:0,unknown:0,not_submitted:0};
  for(const result of results)counts[result.status]++;
  return counts;
}
export function generationQuantity(record) {
  const perPage=record.images_per_page;
  const submitted=record.results.filter(row=>row.status==='submitted');
  const actualCounts=submitted.map(row=>row.count??perPage);
  const actualTotal=actualCounts.every(Number.isInteger)?actualCounts.reduce((n,c)=>n+c,0):null;
  return {pages:record.results.length,tasks_submitted:record.results.filter(row=>row.status==='submitted').length,
    images_per_page:perPage??null,images_requested:perPage===undefined?null:record.results.length*perPage,
    images_submitted:actualTotal};
}
function receiptFailure(error,batch_id,record,phase) {
  const {results,targets}=record;
  return {batch_id,error:'receipt_write_failed',phase,message:error.message,quantity:generationQuantity(record),counts:countsFor(results),results,targets,
    ...(targets.length?{wait:{operation:'task.wait',args:{targets}}}:{}),
    recovery:'以本次返回的 results/targets 为准，磁盘批次回执可能过期。submitted 只等待原任务；unknown 核对后再决定；not_submitted 确认未发送。不要重放整批。'};
}

// 顺序提交，每页最多一次；先验证整批身份，部分失败不丢已收到的任务 ID。
export async function submitGenerationBatch({project_id,page_keys,...settings},{submit,signal,recover,persist=saveOperationRecord}) {
  if(new Set(page_keys.map(page=>page.page_id)).size!==page_keys.length)throw invalid('page_keys 不能包含重复页面');
  const results=page_keys.map(page_key=>({page_key,status:'not_submitted'})),targets=[];
  const record={project_id,created_at:new Date().toISOString(),images_per_page:settings.count,results,targets};
  let batch_id;
  try{batch_id=await persist('generation',record);}
  catch(error){return receiptFailure(error,undefined,record,'initialize');}
  let stopped=false;
  for(const [index,page_key] of page_keys.entries()) {
    if(stopped || signal?.aborted) {
      continue;
    }
    // 发出请求前先记录不确定状态，进程中断后也不会将已发出的请求误判为未提交。
    results[index]={page_key,status:'unknown'};
    try{await persist('generation',record,batch_id);}
    catch(error){
      // 请求还没有发出；只有磁盘预写状态需要保守，当前调用可以确定未提交。
      results[index]={page_key,status:'not_submitted'};
      return receiptFailure(error,batch_id,record,'before_submit');
    }
    if(signal?.aborted){
      results[index]={page_key,status:'not_submitted'};
      try{await persist('generation',record,batch_id);}
      catch(error){return receiptFailure(error,batch_id,record,'before_submit');}
      break;
    }
    try {
      const response=await submit({project_id,page_key,...settings},{signal});
      const task=response.value?.task ?? response;
      if(!task?.task_id)throw Object.assign(new Error('未取得任务 ID，提交结果不确定'),{code:'missing_task_receipt'});
      const target={project_id,task_id:task.task_id};
      targets.push(target);
      results[index]={page_key,status:'submitted',task_id:task.task_id,count:task.count??settings.count,...(response.cleanup?{cleanup:response.cleanup}:{})};
    } catch(error) {
      // 仅明确的客户端拒绝可判断未提交；断线、超时和 5xx 必须核查队列。
      const rejected=error.status>=400 && error.status<500 && ![408,499].includes(error.status);
      results[index]={page_key,status:rejected?'rejected':'unknown',error:{code:error.code??'submission_failed',message:error.message,...(error.status?{status:error.status}:{}),...(error.details?{details:error.details}:{})},...(recover?{recovery:recover(error,{project_id,page_key,...settings})}:{})};
      if(!rejected)stopped=true;
    }
    try{await persist('generation',record,batch_id);}
    catch(error){return receiptFailure(error,batch_id,record,'after_submit');}
  }
  const counts=countsFor(results);
  const cleanupIssues=results.filter(r=>r.cleanup&&r.cleanup.status!=='completed');
  return {batch_id,...(cleanupIssues.length?{cleanup_issues:cleanupIssues.map(r=>({page_key:r.page_key,task_id:r.task_id,cleanup:r.cleanup})),cleanup_hint:'新任务已提交，只等待原任务；核验剩余旧候选，不重放生成。'}:{}),quantity:generationQuantity(record),message:record.images_per_page===undefined?`已提交 ${counts.submitted} 个页面任务，共 ${generationQuantity(record).images_submitted??'待核验'} 个候选；各页采用自己的默认数量，等待原任务即可。`:`已提交 ${counts.submitted} 个页面任务，每页 ${record.images_per_page} 张，共 ${generationQuantity(record).images_submitted} 张；counts 按任务计数，等待原任务即可。`,counts,inspect:{operation:'task.batch.read',args:{batch_id}},...(targets.length?{wait:{operation:'task.wait',args:{batch_id}}}:{}),
    ...(counts.rejected||counts.unknown?{issues:results.filter(r=>['rejected','unknown'].includes(r.status)).slice(0,5)}:{}),
    ...(counts.rejected||counts.unknown||counts.not_submitted?{recovery:'已提交项只等待原任务；rejected 修正后仅重提该页；unknown 先用 task.list / task.history 核对，不能直接重提；not_submitted 尚未发送。不要重放整批。'}:{})};
}
