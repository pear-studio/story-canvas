import {readPageMedia} from './page-media.mjs';
import {readRenderTaskState} from './render-task-storage.mjs';
import {deletePageCandidates} from './candidate-delete.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {ApiError} from './http-support.mjs';
import {decodePageKey} from './page-key.mjs';

const fingerprint=candidates=>hashCanonicalJson(candidates.map(c=>[c.candidate_id,c.task_id]).sort((a,b)=>a[0].localeCompare(b[0])));
export function groupCandidateTasks(candidates,states,pageKey) {
  const groups=new Map();
  for(const candidate of candidates) {
    if(!groups.has(candidate.task_id)) {
      const state=states.get(candidate.task_id);
      groups.set(candidate.task_id,{task_id:candidate.task_id,status:state?.status??'unknown',created_at:state?.created_at??candidate.generated_at,
        expected_count:state?.items?.filter(i=>i.page_key.page_id===pageKey.page_id).length??null,candidates:[]});
    }
    groups.get(candidate.task_id).candidates.push(candidate);
  }
  return [...groups.values()].map(g=>({...g,available_count:g.candidates.length,complete:g.status==='completed' && g.expected_count===g.candidates.length}))
    .sort((a,b)=>String(b.created_at??'').localeCompare(String(a.created_at??''))||b.task_id.localeCompare(a.task_id));
}
export async function readCandidateBatches({projectRoot,projectDirectory,projectId},pageKey) {
  decodePageKey(pageKey);
  const {media}=await readPageMedia(projectRoot,projectId,{page_key:pageKey});
  const states=new Map(await Promise.all([...new Set(media.candidates.map(c=>c.task_id))].map(async id=>[id,await readRenderTaskState(projectDirectory,id)])));
  return {page_key:pageKey,fingerprint:fingerprint(media.candidates),groups:groupCandidateTasks(media.candidates,states,pageKey)};
}
function selections(value) {
  if(!Array.isArray(value)||!value.length||value.length>32)throw new ApiError(400,'invalid_cleanup_selection');
  const ids=value.map(v=>decodePageKey(v.page_key).page_id);
  if(new Set(ids).size!==ids.length)throw new ApiError(400,'duplicate_cleanup_page');
}
export function planCandidateCleanup(snapshot,keepTaskId) {
  const keep=keepTaskId?snapshot.groups.find(g=>g.task_id===keepTaskId):snapshot.groups[0];
  if(!keep)throw new ApiError(404,'candidate_batch_not_found');
  if(!keepTaskId && keep.status!=='completed')throw new ApiError(409,'candidate_batch_not_completed',['最新批次未成功完成，请指定要保留的任务或等待完成']);
  return {page_key:snapshot.page_key,expected_fingerprint:snapshot.fingerprint,keep_task_id:keep.task_id,
    keep_candidate_ids:keep.candidates.map(c=>c.candidate_id),delete_candidate_ids:snapshot.groups.filter(g=>g.task_id!==keep.task_id).flatMap(g=>g.candidates.map(c=>c.candidate_id)),
    expected_count:keep.expected_count,complete:keep.complete};
}
export async function previewCandidateCleanup(context,rows) {
  selections(rows);
  const plans=[];
  for(const row of rows)plans.push(planCandidateCleanup(await readCandidateBatches(context,row.page_key),row.keep_task_id));
  return {project_id:context.projectId,plans};
}
// 每页核对预览集合，绝不把后来生成的图片加入删除范围；复用候选删除短锁。
export async function applyCandidateCleanup(context,plans) {
  selections(plans);
  const results=[];
  for(const plan of plans) {
    try {
      const current=await readCandidateBatches(context,plan.page_key);
      const expected=planCandidateCleanup(current,plan.keep_task_id);
      if(current.fingerprint!==plan.expected_fingerprint || hashCanonicalJson(expected.delete_candidate_ids.slice().sort())!==hashCanonicalJson(plan.delete_candidate_ids.slice().sort())
        || hashCanonicalJson(expected.keep_candidate_ids.slice().sort())!==hashCanonicalJson(plan.keep_candidate_ids.slice().sort()))throw new ApiError(409,'candidate_cleanup_conflict',['候选集合已变化，重新预览；不重放旧计划']);
      const deleted=plan.delete_candidate_ids.length?await deletePageCandidates(context.projectRoot,context.projectId,{page_key:plan.page_key,candidate_ids:plan.delete_candidate_ids}):{deleted_candidate_ids:[]};
      results.push({page_key:plan.page_key,status:deleted.failed_candidates?.length?'error':'cleaned',deleted:deleted.deleted_candidate_ids.length,kept:expected.keep_candidate_ids.length,...(deleted.failed_candidates?.length?{failed_candidates:deleted.failed_candidates,recovery:deleted.recovery}:{})});
    }catch(error){results.push({page_key:plan.page_key,status:'error',error:{code:error.code??'cleanup_failed',status:error.status,message:error.message},recovery:'本页可能已有部分删除；重新查询并预览本页，其他成功页不重放。'});}
  }
  return {results,cleaned:results.filter(r=>r.status==='cleaned').length,failed:results.filter(r=>r.status==='error').length,deleted:results.reduce((n,r)=>n+(r.deleted??0),0)};
}
