import test from 'node:test';
import assert from 'node:assert/strict';
import {regeneratePage} from '../scripts/workbench-actions/regenerate-page.mjs';
const args={project_id:'demo',page_key:{page_id:'page-001'}};
test('部分清理回执保留失败 ID 与新任务，不冒充全部清理成功',async()=>{
  const result=await regeneratePage(args,{submit:async()=>({value:{task:{task_id:'new'}}}),request:async(_route,options)=>options.method==='POST'
    ? {value:{media:{candidates:[{candidate_id:'old-a'},{candidate_id:'old-b'}]}}}
    : {value:{deleted_candidate_ids:['old-a'],failed_candidates:[{candidate_id:'old-b',code:'candidate_file_busy'}]}}});
  assert.equal(result.task_id,'new');assert.equal(result.cleanup.status,'incomplete');assert.equal(result.cleanup.deleted,1);
  assert.equal(result.cleanup.failed_candidates[0].candidate_id,'old-b');
});
test('重生成只删除提交前快照，清理失败仍返回已提交任务',async()=>{
  for(const failure of [false,true]){
    const calls=[];
    const result=await regeneratePage(args,{submit:async()=>{calls.push('submit');return {value:{task:{task_id:'new'}}};},request:async(route,options)=>{
      if(options.method==='POST'){calls.push('snapshot');return {value:{media:{candidates:[{candidate_id:'old'}]}}};}
      calls.push('delete');assert.deepEqual(options.body.candidate_ids,['old']);
      if(failure)throw new Error('offline');return {value:{deleted_candidate_ids:['old']}};
    }});
    assert.deepEqual(calls,['snapshot','submit','delete']);assert.equal(result.task_id,'new');assert.equal(result.cleanup.status,failure?'incomplete':'completed');
  }
});
test('生成提交失败不删除旧候选',async()=>{
  let requests=0;
  await assert.rejects(regeneratePage(args,{submit:async()=>{throw new Error('rejected');},request:async()=>{requests++;return {value:{media:{candidates:[{candidate_id:'old'}]}}};}}),/rejected/);
  assert.equal(requests,1);
});
