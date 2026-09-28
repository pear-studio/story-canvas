import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,readdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

async function fixture(t) {
  const source=fileURLToPath(new URL('../../',import.meta.url)),tests=path.join(source,'Saved/Tests');
  await mkdir(tests,{recursive:true});const root=await mkdtemp(path.join(tests,'receipts-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const file of ['app/scripts/workbench-actions/operation-records.mjs','app/scripts/workbench-actions/contract.mjs','app/server/file-replace.mjs']) {
    await mkdir(path.dirname(path.join(root,file)),{recursive:true});await cp(path.join(source,file),path.join(root,file));
  }
  return {...await import(pathToFileURL(path.join(root,'app/scripts/workbench-actions/operation-records.mjs'))),directory:path.join(root,'Saved/Agent/workbench-operations')};
}
test('批次回执短暂占用只重试文件替换，旧回执完整且最终可读',async t=>{
  const f=await fixture(t),id=await f.saveOperationRecord('generation',{status:'before'});
  let attempts=0;const waits=[];
  await f.saveOperationRecord('generation',{status:'after'},id,{platform:'win32',wait:async ms=>waits.push(ms),renameFile:async(source,target)=>{
    assert.equal(JSON.parse(await readFile(target,'utf8')).status,'before');
    if(++attempts<3)throw Object.assign(new Error('busy'),{code:'EPERM'});
    await rename(source,target);
  }});
  assert.deepEqual(waits,[10,20]);assert.deepEqual(await f.readOperationRecord('generation',id),{status:'after'});
  assert.equal((await readdir(f.directory)).length,1);
});
test('持续占用有界退出，旧回执不丢失，临时文件清理',async t=>{
  const f=await fixture(t),id=await f.saveOperationRecord('generation',{task_id:'render-existing'});
  let attempts=0,waited=0;const error=Object.assign(new Error('busy'),{code:'EPERM'});
  await assert.rejects(f.saveOperationRecord('generation',{task_id:'new'},id,{platform:'win32',wait:async ms=>{waited+=ms;},renameFile:async()=>{attempts++;throw error;}}),e=>e===error);
  assert.equal(attempts,8);assert.equal(waited,1270);
  assert.deepEqual(await f.readOperationRecord('generation',id),{task_id:'render-existing'});
  assert.deepEqual(await readdir(f.directory),[`generation-${id}.json`]);
});
