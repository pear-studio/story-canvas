import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,stat,rename} from 'node:fs/promises';
import {fixture,json,key} from './helpers/finished-fixture.mjs';
import {deletePage} from '../server/page-facts.mjs';

async function finished(f,id){
  const paths=[];
  for(const locale of ['zh','en','ja']){
    const suffix=locale==='zh'?'':`.${locale}`,media=`Outputs/finished/${id}/${locale}/output.png`;
    await mkdir(path.dirname(path.join(f.directory,media)),{recursive:true});await writeFile(path.join(f.directory,media),`pixels:${locale}`);
    const record=`finished/${id}${suffix}.json`,job=`Saved/finished/${id}${suffix}.json`;
    await json(path.join(f.directory,record),{page_key:{page_id:id},outputs:{clean:media,lettered:media}});
    await json(path.join(f.directory,job),{id:`finished-${id}-${locale}`,page_id:id,locale,status:'completed'});
    paths.push(record,job,media);
  }
  return paths;
}

test('删除页面归档三种语言的成品记录、媒体和任务，并包含内部子页',async t=>{
  const f=await fixture(t),indexFile=path.join(f.directory,'pages/index.json'),index=JSON.parse(await readFile(indexFile,'utf8'));
  index.pages.push({...index.pages[0],page_id:'page-002',parent_page_id:key.page_id});await json(indexFile,index);
  await json(path.join(f.directory,'pages/page-002.content.json'),JSON.parse(await readFile(path.join(f.directory,'pages/page-001.content.json'),'utf8')));
  const paths=[...await finished(f,key.page_id),...await finished(f,'page-002')];
  const other=await finished(f,'page-003');
  const result=await deletePage(f.root,'demo',key.page_id);
  for(const p of paths){await assert.rejects(stat(path.join(f.directory,p)),{code:'ENOENT'});assert.ok((await stat(path.join(result.archive_directory,p))).isFile());}
  for(const p of other)assert.ok((await stat(path.join(f.directory,p))).isFile(),'不触碰其他页成品');
  assert.ok(result.archived_paths.includes(`Outputs/finished/${key.page_id}`));
  assert.equal(JSON.parse(await readFile(indexFile,'utf8')).pages.length,0);
});

test('页面删除提交失败时，成品记录、媒体和任务一并回滚',async t=>{
  const f=await fixture(t),paths=await finished(f,key.page_id),indexFile=path.join(f.directory,'pages/index.json');
  await assert.rejects(deletePage(f.root,'demo',key.page_id,{beforeCommit:async()=>{
    await rename(indexFile,`${indexFile}.backup`);await mkdir(indexFile);await writeFile(path.join(indexFile,'occupied'),'模拟提交失败');
  }}));
  for(const p of paths)assert.ok((await stat(path.join(f.directory,p))).isFile());
  assert.ok((await stat(path.join(f.directory,'pages/page-001.content.json'))).isFile());
});

test('输出进行中拒绝删除页面和成品',async t=>{
  const f=await fixture(t),paths=await finished(f,key.page_id);
  await json(path.join(f.directory,`Saved/finished/${key.page_id}.en.json`),{page_id:key.page_id,status:'publishing',pid:process.pid});
  await assert.rejects(deletePage(f.root,'demo',key.page_id),e=>e.code==='page_finished_output_busy');
  for(const p of paths)assert.ok((await stat(path.join(f.directory,p))).isFile());
});
