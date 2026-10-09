import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {readAgentDirectory} from '../server/agent-directory.mjs';
import {fixedWaitBudget} from '../scripts/workbench-actions/wait-budget.mjs';
import {submitGenerationBatch} from '../scripts/workbench-actions/generation-batch.mjs';

test('显示页码遵从章节单元顺序，排除角色页且在筛选前编号',async t=>{
  const root='C:/Workspace/story-canvas/Saved/Tests';await mkdir(root,{recursive:true});
  const dir=await mkdtemp(root+'/page-number-');t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(dir+'/pages');await mkdir(dir+'/story');
  const put=(p,v)=>writeFile(dir+'/'+p,JSON.stringify(v));
  await put('pages/index.json',{$schema:'https://storyvisualizer.local/schemas/pages-index.schema.json',pages:[
    {page_id:'page-bbbbbbbbbbbb',owner_kind:'story',sequence_id:'b'},
    {page_id:'page-cccccccccccc',owner_kind:'character',character_id:'alice',variant_id:'base'},
    {page_id:'page-aaaaaaaaaaaa',owner_kind:'story',sequence_id:'a'}]});
  await put('story/outline.json',{chapters:[{sequences:[{id:'a'},{id:'b'}]}]});
  await put('pages/page-bbbbbbbbbbbb.content.json',{title:'第二页'});
  const result=await readAgentDirectory('',dir,{kind:'page',page_number:2});
  assert.equal(result.total,1);assert.equal(result.items[0].page_id,'page-bbbbbbbbbbbb');assert.equal(result.items[0].title,'第二页');
});
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
test('批量重生保留任务身份、数量与清理失败，不重复提交',async()=>{
  let calls=0;
  const result=await submitGenerationBatch({project_id:'p',page_keys:[{page_id:'page-aaaaaaaaaaaa'}]},
    {persist:async()=> 'batch',submit:async()=>{calls++;return {task_id:'task-a',count:1,cleanup:{status:'incomplete',requested:3,deleted:1}};}});
  assert.equal(calls,1);assert.equal(result.quantity.images_submitted,1);assert.equal(result.counts.submitted,1);
  assert.equal(result.cleanup_issues[0].task_id,'task-a');assert.equal(result.wait.args.batch_id,'batch');
});
