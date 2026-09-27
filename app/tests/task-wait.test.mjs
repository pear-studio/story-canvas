import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForTasks } from '../scripts/workbench-actions/task-wait.mjs';
const target={project_id:'demo',task_id:'render-test'};
const running={id:target.task_id,status:'running',progress:{value:1,max:100},item_counts:{total:3,available:0}};
test('整批等待不因最后提交项先结束就返回，失败计入终态但不是全部成功',async()=>{
  let calls=0;
  const targets=[target,{...target,task_id:'render-last'}];
  const result=await waitForTasks({targets,until:'all_terminal',wait_ms:1000},{intervalMs:1,read:async t=>{
    if(t.task_id==='render-last')return {...running,status:'completed',item_counts:{total:3,available:3}};
    return {...running,status:++calls===3?'failed':'running',item_counts:{total:3,available:1,failed:calls===3?2:0}};
  }});
  assert.equal(calls,3);assert.equal(result.reason,'terminal');assert.equal(result.all_terminal,true);assert.equal(result.all_succeeded,false);
  assert.equal(result.summary.completed,1);assert.equal(result.summary.failed,1);assert.equal(result.summary.items_available,4);assert.equal(result.summary.items_failed,2);
  assert.equal(result.wait,undefined);
});
test('整批超时给出全部身份的续等入口，已完成任务也纳入最终核验',async()=>{
  const result=await waitForTasks({targets:[target,{...target,task_id:'done'}],until:'all_terminal',wait_ms:10},{intervalMs:1,read:async t=>({...running,status:t.task_id==='done'?'completed':'queued'})});
  assert.equal(result.reason,'timeout');assert.equal(result.all_terminal,false);assert.equal(result.summary.pending,1);
  assert.equal(result.wait.args.targets.length,2);
  const done=await waitForTasks({...result.wait.args,wait_ms:0},{read:async()=>({...running,status:'completed',item_counts:{total:3,available:3}})});
  assert.equal(done.all_succeeded,true);assert.equal(done.summary.items_available,6);
});
test('不变状态只在到期返回；小幅采样变化不唤醒，跨10%返回',async()=>{
  let calls=0;
  const timed=await waitForTasks({targets:[target],wait_ms:35},{intervalMs:5,read:async()=>({...running,progress:{value:++calls%8,max:100}})});
  assert.equal(timed.reason,'timeout');assert.ok(calls>1);assert.equal(timed.tasks[0].changed,false);
  calls=0;
  const changed=await waitForTasks({targets:[target],until:'change',wait_ms:1000},{intervalMs:1,read:async()=>({...running,progress:{value:++calls===1?1:12,max:100}})});
  assert.equal(changed.reason,'changed');assert.equal(calls,2);
});
test('续等识别调用间变化；快照与已结束任务立即返回',async()=>{
  const snapshot=await waitForTasks({targets:[target],wait_ms:0},{read:async()=>running});
  assert.equal(snapshot.reason,'snapshot');
  const changed=await waitForTasks({targets:[{...target,after_cursor:snapshot.tasks[0].cursor}],until:'change',wait_ms:1000},{read:async()=>({...running,item_counts:{total:3,available:1}})});
  assert.equal(changed.reason,'changed');
  for(const status of ['completed','failed','cancelled']){
    const result=await waitForTasks({targets:[target]},{read:async()=>({...running,status})});
    assert.equal(result.reason,'terminal');assert.equal(result.tasks[0].terminal,true);
  }
});
test('多任务保留独立身份和错误，一项404不抹掉其他状态',async()=>{
  const result=await waitForTasks({targets:[target,{...target,project_id:'missing'}]},{read:async identity=>{
    if(identity.project_id==='missing')throw Object.assign(new Error('任务不存在'),{code:'task_not_found',status:404});return running;
  }});
  assert.equal(result.reason,'error');assert.equal(result.tasks[0].task.status,'running');assert.equal(result.tasks[1].error.status,404);
});
test('请求挂起受总期限约束；取消等待中断读取，不取消生成',async()=>{
  const read=(_target,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  // 模拟网络 socket 保持事件循环，AbortSignal.timeout 自身不会保持进程存活。
  const keepAlive=setInterval(()=>{},1000);
  try{
    const result=await waitForTasks({targets:[target],wait_ms:20},{read});
    assert.equal(result.reason,'timeout');assert.equal(result.tasks[0].error.code,'status_unknown');
    const controller=new AbortController();setTimeout(()=>controller.abort(),10);
    await assert.rejects(waitForTasks({targets:[target]},{signal:controller.signal,read}),error=>error.code==='wait_cancelled');
    const controller2=new AbortController();let calls=0;
    setTimeout(()=>controller2.abort(),10);
    await assert.rejects(waitForTasks({targets:[target]},{signal:controller2.signal,read:async()=>{calls++;return running;}}),error=>error.code==='wait_cancelled');
    assert.equal(calls,1);
  }finally{clearInterval(keepAlive);}
});

test('默认等待终态，跨进度和调用间变化不提前唤醒；续等压缩未变状态',async()=>{
  let calls=0;
  const done=await waitForTasks({targets:[target],wait_ms:1000},{intervalMs:1,read:async()=>({...running,status:++calls===4?'completed':'running',progress:{value:calls*20,max:100}})});
  assert.equal(done.reason,'terminal');assert.equal(calls,4);
  const initial=await waitForTasks({targets:[target],wait_ms:0},{read:async()=>running});
  const unchanged=await waitForTasks({targets:[{...target,after_cursor:initial.tasks[0].cursor}],wait_ms:10},{intervalMs:1,read:async()=>running});
  assert.equal(unchanged.reason,'timeout');assert.equal(unchanged.tasks[0].task,undefined);assert.equal(unchanged.tasks[0].status,'running');
});
