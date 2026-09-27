import { invalid } from './contract.mjs';
import {saveOperationRecord} from './operation-records.mjs';

// 顺序提交，每页最多一次；先验证整批身份，部分失败不丢已收到的任务 ID。
export async function submitGenerationBatch({project_id,page_keys,...settings},{submit,signal,recover,persist=saveOperationRecord}) {
  if(new Set(page_keys.map(page=>page.page_id)).size!==page_keys.length)throw invalid('page_keys 不能包含重复页面');
  const results=page_keys.map(page_key=>({page_key,status:'not_submitted'})),targets=[];
  const record={project_id,created_at:new Date().toISOString(),results,targets};
  const batch_id=await persist('generation',record);
  let stopped=false;
  for(const [index,page_key] of page_keys.entries()) {
    if(stopped || signal?.aborted) {
      continue;
    }
    // 发出请求前先记录不确定状态，进程中断后也不会将已发出的请求误判为未提交。
    results[index]={page_key,status:'unknown'};
    try{await persist('generation',record,batch_id);}
    catch(error){return {batch_id,error:'receipt_write_failed',message:error.message,results,targets,recovery:'未继续发送；已受理任务按回执查询，不重放。'};}
    try {
      const response=await submit({project_id,page_key,...settings},{signal});
      const task=response.value?.task;
      if(!task?.task_id)throw Object.assign(new Error('未取得任务 ID，提交结果不确定'),{code:'missing_task_receipt'});
      const target={project_id,task_id:task.task_id};
      targets.push(target);
      results[index]={page_key,status:'submitted',task_id:task.task_id};
    } catch(error) {
      // 仅明确的客户端拒绝可判断未提交；断线、超时和 5xx 必须核查队列。
      const rejected=error.status>=400 && error.status<500 && ![408,499].includes(error.status);
      results[index]={page_key,status:rejected?'rejected':'unknown',error:{code:error.code??'submission_failed',message:error.message,...(error.status?{status:error.status}:{}),...(error.details?{details:error.details}:{})},...(recover?{recovery:recover(error,{project_id,page_key,...settings})}:{})};
      if(!rejected)stopped=true;
    }
    try{await persist('generation',record,batch_id);}
    catch(error){return {batch_id,error:'receipt_write_failed',message:error.message,results,targets,recovery:'已受理任务见回执，不重放；按任务 ID 查询。'};}
  }
  const counts={total:results.length,submitted:0,rejected:0,unknown:0,not_submitted:0};
  for(const result of results)counts[result.status]++;
  return {batch_id,counts,inspect:{operation:'task.batch.read',args:{batch_id}},...(targets.length?{wait:{operation:'task.wait',args:{batch_id}}}:{}),
    ...(counts.rejected||counts.unknown?{issues:results.filter(r=>['rejected','unknown'].includes(r.status)).slice(0,5)}:{}),
    ...(counts.rejected||counts.unknown||counts.not_submitted?{recovery:'已提交项只等待原任务；rejected 修正后仅重提该页；unknown 先用 task.list / task.history 核对，不能直接重提；not_submitted 尚未发送。不要重放整批。'}:{})};
}
