import { invalid } from './contract.mjs';

// 顺序提交，每页最多一次；先验证整批身份，部分失败不丢已收到的任务 ID。
export async function submitGenerationBatch({project_id,page_keys,...settings},{submit,signal,recover}) {
  if(new Set(page_keys.map(page=>page.page_id)).size!==page_keys.length)throw invalid('page_keys 不能包含重复页面');
  const results=[],targets=[];
  let stopped=false;
  for(const page_key of page_keys) {
    if(stopped || signal?.aborted) {
      results.push({page_key,status:'not_submitted'});
      continue;
    }
    try {
      const response=await submit({project_id,page_key,...settings},{signal});
      const task=response.value?.task;
      if(!task?.task_id)throw Object.assign(new Error('未取得任务 ID，提交结果不确定'),{code:'missing_task_receipt'});
      const target={project_id,task_id:task.task_id};
      targets.push(target);
      results.push({page_key,status:'submitted',task_id:task.task_id});
    } catch(error) {
      // 仅明确的客户端拒绝可判断未提交；断线、超时和 5xx 必须核查队列。
      const rejected=error.status>=400 && error.status<500 && ![408,499].includes(error.status);
      results.push({page_key,status:rejected?'rejected':'unknown',error:{code:error.code??'submission_failed',message:error.message,...(error.status?{status:error.status}:{}),...(error.details?{details:error.details}:{})},...(recover?{recovery:recover(error,{project_id,page_key,...settings})}:{})});
      if(!rejected)stopped=true;
    }
  }
  const counts={total:results.length,submitted:0,rejected:0,unknown:0,not_submitted:0};
  for(const result of results)counts[result.status]++;
  return {counts,results,...(targets.length?{wait:{operation:'task.wait',args:{targets,until:'all_terminal'}}}:{}),
    ...(counts.rejected||counts.unknown||counts.not_submitted?{recovery:'已提交项只等待原任务；rejected 修正后仅重提该页；unknown 先用 task.list / task.history 核对，不能直接重提；not_submitted 尚未发送。不要重放整批。'}:{})};
}
