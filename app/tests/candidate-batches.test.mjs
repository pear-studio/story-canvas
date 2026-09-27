import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCandidateTasks,planCandidateCleanup} from '../server/candidate-batches.mjs';
const page_key={page_id:'page-001'};
test('候选按 task_id 分组，不把一张图当成一次生成；按任务时间而非图片时间排序',()=>{
  const candidates=[{candidate_id:'a',task_id:'old',generated_at:'2026-09-27T13:00:00Z'},...['b','c','d'].map(candidate_id=>({candidate_id,task_id:'new',generated_at:'2026-09-27T12:00:00Z'}))];
  const states=new Map([['old',{status:'completed',created_at:'2026-09-27T10:00:00Z',items:[{page_key},{page_key},{page_key}]}],['new',{status:'completed',created_at:'2026-09-27T11:00:00Z',items:[{page_key},{page_key},{page_key}]}]]);
  const groups=groupCandidateTasks(candidates,states,page_key);
  assert.equal(groups[0].task_id,'new');assert.equal(groups[0].available_count,3);assert.equal(groups[1].complete,false);
  const snapshot={page_key,fingerprint:'fingerprint',groups};
  const plan=planCandidateCleanup(snapshot);
  assert.deepEqual(plan.keep_candidate_ids,['b','c','d']);assert.deepEqual(plan.delete_candidate_ids,['a']);
  const explicit=planCandidateCleanup(snapshot,'old');assert.equal(explicit.keep_candidate_ids.length,1);assert.equal(explicit.complete,false);
  assert.throws(()=>planCandidateCleanup(snapshot,'missing'),e=>e.code==='candidate_batch_not_found');
  groups[1].status='running';assert.throws(()=>planCandidateCleanup(snapshot),e=>e.code==='candidate_task_active');
});
