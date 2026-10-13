import test from 'node:test';
import assert from 'node:assert/strict';
import {savedFactReceipt} from '../server/saved-fact-receipt.mjs';
test('事实已提交后读取失败仍返回成功并提供重读入口',async()=>{
  const next={operation:'prompt.read',args:{project_id:'demo',target:{kind:'page',id:'page-001'}}};
  const result=await savedFactReceipt(async()=>{throw Object.assign(new Error('read failed'),{code:'ENOENT'});},next);
  assert.equal(result.saved,true);assert.equal(result.refresh_required,true);assert.equal(result.read_error.code,'ENOENT');assert.deepEqual(result.next,next);
  assert.deepEqual(await savedFactReceipt(async()=>({document:{title:'saved'}}),next),{saved:true,document:{title:'saved'}});
});
