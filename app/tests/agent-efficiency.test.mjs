import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedWaitBudget} from '../scripts/workbench-actions/wait-budget.mjs';
test('固定等待档位覆盖图片、视频与队列前置任务，不读取历史',()=>{
  const target={project_id:'p',task_id:'one'};
  const task={id:'one',project_id:'p',purpose:'candidate',media_kind:'image'};
  for(const [kind,pages,minutes] of [['image',1,2],['image',2,5],['image',4,5],['image',5,10],['video',1,20],['video',2,30]]) {
    const workspace={tasks:[{...task,media_kind:kind,page_count:pages}],get history(){throw Error('不应读取历史');}};
    assert.equal(fixedWaitBudget([target],workspace).wait_ms,minutes*60000);
  }
  const tasks=[{...task,id:'before',media_kind:'video'},task];
  assert.equal(fixedWaitBudget([target],{tasks}).wait_ms,1800000);
  assert.equal(fixedWaitBudget([target],{tasks:[]}).wait_ms,600000);
  const pair=[task,{...task,id:'two'}],targets=[target,{...target,task_id:'two'}];
  assert.equal(fixedWaitBudget(targets,{tasks:pair},'terminal').wait_ms,120000);
  assert.equal(fixedWaitBudget(targets,{tasks:pair},'all_terminal').wait_ms,300000);
});
