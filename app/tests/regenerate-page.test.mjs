import test from 'node:test';
import assert from 'node:assert/strict';
import {regeneratePage} from '../scripts/workbench-actions/regenerate-page.mjs';
const args={project_id:'demo',page_key:{page_id:'page-001'}};
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
