import test from 'node:test';
import assert from 'node:assert/strict';
import {submitGenerationBatch as submit} from '../scripts/workbench-actions/generation-batch.mjs';
async function submitGenerationBatch(args,options) {
  let record;
  const result=await submit(args,{...options,persist:async(_kind,value)=>{record=structuredClone(value);return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}});
  return {...result,record};
}
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
  assert.deepEqual(result.record.results.map(r=>r.status),['submitted','rejected','submitted','unknown','not_submitted']);
  assert.equal(result.wait.args.batch_id,result.batch_id);assert.equal(result.record.targets.length,2);
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

test('回执落盘失败保留任务 ID，不继续生成；持久化前标为结果不明',async()=>{
  let calls=0,writes=0;
  const snapshots=[];
  const result=await submit(args,{submit:async a=>{calls++;return accepted(a.page_key.page_id);},persist:async(_kind,record)=>{
    snapshots.push(structuredClone(record));if(++writes===3)throw new Error('disk full');return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  }});
  assert.equal(calls,1);assert.equal(result.error,'receipt_write_failed');assert.equal(result.targets.length,1);
  assert.equal(snapshots[1].results[0].status,'unknown');assert.equal(snapshots[2].results[0].status,'submitted');
});
