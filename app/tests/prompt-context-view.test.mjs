import test from 'node:test';
import assert from 'node:assert/strict';
import { editingContext } from '../scripts/workbench-actions/prompt-context-view.mjs';

test('精简视图保留上游全文、权重、关闭项、图片选择与异常，不修改原上下文', () => {
  const original = {
    status:'incomplete',model_id:'anima',render:{model_id:'anima',canvas:{width:1024,height:1024}},
    references:[{source:'character:a:default',inherited_prompt:{person:[
      {id:'token-1',tag:'blue_hair',inheritance_source:'基础身份'},
      {id:'token-2',description:'long text '.repeat(1000),weight:1.4,enabled:false},
    ],setting:[]},reference_images:[{id:'image1',file:'reference.png'}],selected_image_ids:[]}],
    final:{positive:'完整正向',negative:'完整负向',images:[{file:'effective.png'}],parts:{trace:'大量追踪'},sections:['重复正文']},
    page:{model_input:{text:'重复草稿'}},audit:{status:'incomplete',errors:['缺少引用'],warnings:['提示'],stats:{total:99}},diagnostics:['配置冲突'],
  };
  const before=structuredClone(original), compact=editingContext(original);
  assert.deepEqual(original,before);
  assert.deepEqual(compact.references['character:a:default'],{
    inherited:{person:['blue_hair',{text:'long text '.repeat(1000),weight:1.4,enabled:false}]},
    images:[{id:'image1',file:'reference.png'}],selected:[],
  });
  assert.deepEqual(compact.final,{positive:'完整正向',negative:'完整负向',images:[{file:'effective.png'}]});
  assert.deepEqual(compact.audit,{errors:['缺少引用'],warnings:['提示']});
  assert.deepEqual(compact.diagnostics,['配置冲突']);
  assert.equal(compact.status,'incomplete');assert.equal(compact.page,undefined);
});

test('Qwen 保留恢复继承需要的上游原文；不可用编译结果保持 null',()=>{
  const context=editingContext({status:'incomplete',model_id:'qwen',references:[{
    source:'scene:room:night',current_text:'完整上游原文',override:'本页覆盖',effective_text:'本页覆盖',
  }],final:null,audit:{errors:[],warnings:[],stats:{total:0}},diagnostics:[]});
  assert.deepEqual(context.references,{'scene:room:night':{text:'完整上游原文'}});
  assert.equal(context.final,null);assert.equal(context.audit,undefined);
});
