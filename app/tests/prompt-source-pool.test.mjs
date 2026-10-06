import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSourcePool} from '../scripts/workbench-actions/prompt-source-pool.mjs';

test('来源展示去重可无损还原每页启用、权重、消耗与覆盖状态',()=>{
  const first={ref:'source-1',source:'character/alice',model_id:'anima',sha256:'a'.repeat(64),entries:Array.from({length:10},(_,i)=>({key:`k${i}`,text:`appearance tag ${i}`,enabled:true,weight:1,consumed:false}))};
  const second=structuredClone(first);second.ref='source-2';
  Object.assign(second.entries[2],{enabled:false,weight:1.3,consumed:true,override:{enabled:false}});
  const third={...structuredClone(second),ref:'source-3',sha256:'b'.repeat(64)};
  const fourth={...structuredClone(second),ref:'source-4',model_id:'other'};
  const input=[first,second,third,fourth],before=structuredClone(input),output=compactSourcePool(input);
  assert.equal(output[1].base_ref,'source-1');assert.equal(output[1].entries.length,1);
  const restored=output.map(s=>{
    if(!s.base_ref)return s;
    const base=output.find(b=>b.ref===s.base_ref);
    return {...base,ref:s.ref,entries:base.entries.map(e=>s.entries.find(change=>change.key===e.key)??e)};
  });
  assert.deepEqual(restored,input);assert.deepEqual(input,before);
  assert.equal(output[2].base_ref,undefined);assert.equal(output[3].base_ref,undefined);
  assert.ok(JSON.stringify(output).length<JSON.stringify(input).length);
});
