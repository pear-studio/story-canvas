import test from 'node:test';
import assert from 'node:assert/strict';
import {submitGenerationBatch} from '../scripts/workbench-actions/generation-batch.mjs';
const args={project_id:'demo',page_keys:[1,2,3,4,5].map(n=>({page_id:`page-00${n}`})),count:3};
const accepted=id=>({value:{task:{task_id:`render-${id}`}}});

test('整批先拒绝重复页面，不发送任何请求',async()=>{
  await assert.rejects(submitGenerationBatch({...args,page_keys:[args.page_keys[0],args.page_keys[0]]},{submit:()=>assert.fail('不能发送')}),e=>e.code==='invalid_arguments');
});
test('部分拒绝继续，结果不明停止，保留已提交任务，不自动重试',async()=>{
  const sent=[];
  const result=await submitGenerationBatch(args,{submit:async a=>{
    sent.push(a.page_key.page_id);
    if(sent.length===2)throw Object.assign(new Error('无效 Prompt'),{status:422,code:'invalid_prompt'});
    if(sent.length===4)throw new Error('断线');
    return accepted(a.page_key.page_id);
  }});
  assert.equal(sent.length,4);assert.equal(new Set(sent).size,4);
  assert.deepEqual(result.counts,{total:5,submitted:2,rejected:1,unknown:1,not_submitted:1});
  assert.deepEqual(result.results.map(r=>r.status),['submitted','rejected','submitted','unknown','not_submitted']);
  assert.equal(result.wait.args.until,'all_terminal');assert.equal(result.wait.args.targets.length,2);
});
test('取消后保留已受理的任务，不继续发送；缺少任务回执与5xx不作安全拒绝',async()=>{
  const controller=new AbortController();let calls=0;
  const result=await submitGenerationBatch(args,{signal:controller.signal,submit:async a=>{calls++;controller.abort();return accepted(a.page_key.page_id);}});
  assert.equal(calls,1);assert.equal(result.counts.submitted,1);assert.equal(result.counts.not_submitted,4);
  for(const submit of [async()=>({value:{}}),async()=>{throw Object.assign(new Error('后端失败'),{status:500});}]) {
    const uncertain=await submitGenerationBatch(args,{submit});
    assert.equal(uncertain.counts.unknown,1);assert.equal(uncertain.counts.not_submitted,4);assert.equal(uncertain.wait,undefined);
  }
});
