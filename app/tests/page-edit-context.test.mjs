import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentChanges } from '../server/page-edit-context.mjs';

test('局部修改保留其他模型和字段，数组替换、空数组清空、null删除覆盖',()=>{
  const original={models:{anima:{camera:[{id:'old',description:'old'}],inheritance:{source:{word:{enabled:false}}},loras:[{filename:'keep'}]},qwen:{text:'保留'}},title:'保留'};
  const before=structuredClone(original);
  const patched=applyDocumentChanges(original,{models:{anima:{camera:[],inheritance:{source:null}}}});
  assert.deepEqual(original,before);
  assert.deepEqual(patched.models.qwen,original.models.qwen);
  assert.deepEqual(patched.models.anima.loras,original.models.anima.loras);
  assert.deepEqual(patched.models.anima.camera,[]);
  assert.deepEqual(patched.models.anima.inheritance,{});
  assert.equal(patched.title,'保留');
  assert.deepEqual(applyDocumentChanges(patched,{models:{anima:{camera:[{description:'new'}]}}}).models.anima.camera,[{description:'new'}]);
});
