import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDialogue} from '../scripts/workbench-actions/dialogue-format.mjs';

test('格式清理只删除指定标点，保留措辞、说话人、ID和省略号',()=>{
  const source=[
    {id:'a',mode:'thought',speaker:'alice',text:'（再想一下……。）'},
    {id:'b',mode:'speech',speaker:'alice',text:'那是……旅馆。先去那里休息一下吧。'},
    {id:'c',mode:'narration',text:'（第二天。）'},
    {id:'d',mode:'heart',text:'咚。'},
    {id:'e',mode:'thought',text:'（回家）还是（留在这里）'},
    {id:'f',mode:'thought',text:' （外层（内层）结束。） '},
    {id:'g',mode:'thought',text:'(不匹配）'},
    {id:'h',mode:'thought',text:'（（多层。））。'},
    {id:'i',mode:'speech',text:'Wait...'},
  ];
  const before=structuredClone(source),result=normalizeDialogue(source);
  assert.deepEqual(source,before);
  assert.deepEqual(result.map(v=>v.text),['再想一下……','那是……旅馆。先去那里休息一下吧','（第二天。）','咚','（回家）还是（留在这里）',' 外层（内层）结束 ','(不匹配）','多层','Wait...']);
  assert.deepEqual(result.map(({text,...rest})=>rest),source.map(({text,...rest})=>rest));
  assert.deepEqual(normalizeDialogue(result),result);
});
