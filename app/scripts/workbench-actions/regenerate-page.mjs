import {requestWorkbench} from '../workbench-client.mjs';
import {projectPath} from './http-action.mjs';

// 只清理提交前的快照；新任务返回后才删除，任何清理失败都不能丢失任务身份。
export async function regeneratePage(args,{submit,request=requestWorkbench,signal}={}) {
  const {project_id,page_key}=args;
  const media=await request(projectPath(args,'workbench/page-media'),{method:'POST',body:{page_key},mediaFresh:true,signal});
  const ids=media.value.media.candidates.map(candidate=>candidate.candidate_id);
  const response=await submit(args,{signal});
  const task=response.value?.task;
  if(!task?.task_id)throw Object.assign(new Error('未取得任务 ID；未执行清理，先查询任务，不直接重提'),{code:'missing_task_receipt'});
  const result={page_key,task_id:task.task_id,cleanup:{status:'completed',requested:ids.length,deleted:0},wait:{operation:'task.wait',args:{targets:[{project_id,task_id:task.task_id}]}}};
  if(!ids.length)return result;
  try {
    const deleted=await request(projectPath(args,'workbench/candidates'),{method:'DELETE',body:{page_key,candidate_ids:ids},signal});
    result.cleanup.deleted=deleted.value.deleted_candidate_ids.length;
    if(deleted.value.failed_candidates?.length) {
      result.cleanup.status='incomplete';
      result.cleanup.failed_candidates=deleted.value.failed_candidates;
      result.recovery='新任务已提交，不重复生成。旧候选已逐一尝试清理；可继续工作，排查后只处理失败 ID。';
    }
  } catch(error) {
    result.cleanup={status:'incomplete',requested:ids.length,error:error.code??'cleanup_failed',message:error.message};
    result.recovery='新任务已提交，只等待此任务。旧候选清理可能部分完成，candidate.list 核验后仅清理剩余旧候选；不得重放生成。';
  }
  return result;
}
