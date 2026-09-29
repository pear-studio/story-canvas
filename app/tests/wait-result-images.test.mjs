import test from 'node:test';
import assert from 'node:assert/strict';
import {waitResultImages} from '../scripts/workbench-actions/wait-result-images.mjs';
const task=id=>({project_id:'demo',task_id:id,purpose:'candidate',terminal:true,task:{status:'completed',item_counts:{available:20}}});
test('等待图片限制总量并提供从未返回项开始的分页入口',async()=>{
  let reads=0;
  const result=await waitResultImages({tasks:[task('a'),task('b')]},{request:async()=>{reads++;return {value:{images:Array.from({length:20},(_,i)=>({candidate_id:String(i),absolute_file:`C:/images/${i}.png`}))}};}});
  assert.equal(reads,1);assert.equal(result.images.length,12);assert.equal(result.more_images[0].args.offset,12);assert.equal(result.more_images[1].args.task_id,'b');
});
test('图片查询失败保留查询入口，跳过非终态与未变化的已送达结果',async()=>{
  let reads=0;
  const result=await waitResultImages({tasks:[task('a'),{...task('b'),terminal:false},{...task('c'),changed:false,task:undefined}]},{request:async()=>{reads++;throw new Error('offline');}});
  assert.equal(reads,1);assert.equal(result.images,undefined);assert.equal(result.image_errors[0].message,'offline');
});
