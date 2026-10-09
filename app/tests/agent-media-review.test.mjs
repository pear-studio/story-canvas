import test from 'node:test';
import assert from 'node:assert/strict';
import {waitResultImages,compactWaitImage} from '../scripts/workbench-actions/wait-result-images.mjs';

test('混合任务等待结果明确区分视频抽帧和图片，缺审阅图不误用封面',async()=>{
  const rows=[{media_kind:'video',absolute_file:'poster.png',absolute_review:'review.jpg'},
    {absolute_file:'image.png'},{media_kind:'video',absolute_file:'poster2.png'}];
  const result=await waitResultImages({tasks:[{terminal:true,project_id:'demo',task_id:'task'}]},
    {request:async()=>({value:{images:rows}})});
  assert.equal(result.images[0].absolute_review,'review.jpg');
  assert.equal(result.images[0].absolute_file,undefined);
  assert.equal(result.images[1].absolute_file,'image.png');
  assert.equal(result.images[2].absolute_review,null);
  assert.equal(result.images[2].absolute_file,undefined);
  assert.match(result.read_with,/不能验证播放速度/);
});
test('等待图片省略重复身份、网页地址和审阅对象，保留精确操作与读取信息',()=>{
  const identity={project_id:'demo',task_id:'task',purpose:'candidate'};
  const row={id:'duplicate',candidate_id:'candidate',page_key:{page_id:'page'},absolute_file:'C:/image.png',url:'/image.png',review:{kind:'image',file:'C:/image.png'},metadata:'large'.repeat(100)};
  assert.deepEqual(compactWaitImage(row,identity),{...identity,candidate_id:'candidate',page_key:{page_id:'page'},absolute_file:'C:/image.png'});
  assert.deepEqual(compactWaitImage({id:'finished',absolute_file:'C:/finished.png'},identity),{...identity,id:'finished',absolute_file:'C:/finished.png'});
});
