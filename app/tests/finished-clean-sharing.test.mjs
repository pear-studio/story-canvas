import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,key,candidateId,json} from './helpers/finished-fixture.mjs';
import {prepareFinishedPage,readFinishedRecord,deleteFinishedPage} from '../server/finished-pages.mjs';
import {inspectFinishedCleanSharing,shareFinishedClean,sharedFinishedCleanPath} from '../server/finished-media.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';
import {executeWorkbench} from '../scripts/workbench-actions/index.mjs';
import {deletePage} from '../server/page-facts.mjs';

const exists=target=>stat(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const at=(f,relative)=>path.join(f.directory,relative);
async function make(f,locale='zh',adjust=()=>{}) {
  const p=(await f.operations.mutateDerived('demo',()=>prepareFinishedPage(f.root,'demo',f.directory,{page_key:key,candidate_id:candidateId,locale}))).value;
  adjust(p);return f.run(p);
}
async function remove(f,locale){const record=await readFinishedRecord(f.directory,key.page_id,locale);return f.operations.mutateTargetFacts('demo',()=>deleteFinishedPage(f.directory,{page_key:key,locale,expected_sha256:hashCanonicalJson(record)}));}

test('三语言共用同页底图，重制保留共享文件，最后一份记录删除才回收',async t=>{
  const f=await fixture(t),records=[];
  for(const locale of ['zh','en','ja']){assert.equal((await make(f,locale)).status,'completed');records.push(await readFinishedRecord(f.directory,key.page_id,locale));}
  assert.equal(new Set(records.map(r=>r.outputs.clean)).size,1);assert.equal(new Set(records.map(r=>r.outputs.lettered)).size,3);
  const clean=at(f,records[0].outputs.clean),bytes=await readFile(clean);
  assert.equal(records[0].outputs.clean,sharedFinishedCleanPath(key.page_id,bytes));
  assert.equal((await make(f,'en')).status,'completed');assert.deepEqual(await readFile(clean),bytes);
  assert.equal(await exists(at(f,records[1].outputs.lettered)),false);
  await remove(f,'en');await remove(f,'ja');assert.equal(await exists(clean),true);
  await remove(f,'zh');assert.equal(await exists(clean),false);
});

test('换候选像素后保留其他语言旧底图，删除旧语言不误删新底图',async t=>{
  const f=await fixture(t);await make(f);await make(f,'en');
  const old=await readFinishedRecord(f.directory,key.page_id),oldClean=at(f,old.outputs.clean);
  await writeFile(f.file,await sharp({create:{width:128,height:192,channels:3,background:'#ff0000'}}).png().toBuffer());
  assert.equal((await make(f)).status,'completed');
  const current=await readFinishedRecord(f.directory,key.page_id);assert.notEqual(current.outputs.clean,old.outputs.clean);
  assert.equal(await exists(oldClean),true);await remove(f,'en');
  assert.equal(await exists(oldClean),false);assert.equal(await exists(at(f,current.outputs.clean)),true);
});

test('新语言发布失败只清理自身产物，保留其他语言引用的共享底图',async t=>{
  const f=await fixture(t);await make(f);const current=await readFinishedRecord(f.directory,key.page_id);
  assert.equal((await make(f,'ja',p=>{p.expected='changed';})).status,'failed');
  assert.equal(await readFinishedRecord(f.directory,key.page_id,'ja'),null);
  assert.equal(await exists(at(f,current.outputs.clean)),true);assert.equal(await exists(at(f,current.outputs.lettered)),true);
});

test('显式归并旧副本仅更改clean引用，像素、嵌字、原创建时间及其他记录字段保持不变',async t=>{
  const f=await fixture(t);await make(f);await make(f,'en');
  const before=[];
  for(const locale of ['zh','en']){
    const record=await readFinishedRecord(f.directory,key.page_id,locale),relative=`Outputs/finished/${key.page_id}/${locale}/legacy-clean.png`;
    await mkdir(path.dirname(at(f,relative)),{recursive:true});await writeFile(at(f,relative),await readFile(at(f,record.outputs.clean)));
    record.outputs.clean=relative;await json(at(f,`finished/${key.page_id}${locale==='zh'?'':'.'+locale}.json`),record);before.push({locale,record});
  }
  const plan=await inspectFinishedCleanSharing(f.directory,{page_key:key});assert.equal(plan.groups.length,1);
  const result=(await f.operations.mutateTargetFacts('demo',()=>shareFinishedClean(f.directory,{page_key:key,expected_sha256:plan.expected_sha256}))).value;
  assert.equal(result.updated_records,2);assert.equal(result.removed.length,2);assert.deepEqual(result.warnings,[]);
  for(const {locale,record} of before){
    const after=await readFinishedRecord(f.directory,key.page_id,locale);
    assert.deepEqual(after,{...record,outputs:{...record.outputs,clean:plan.groups[0].target}});
    assert.equal(await exists(at(f,record.outputs.clean)),false);assert.equal(await exists(at(f,record.outputs.lettered)),true);
  }
  await assert.rejects(shareFinishedClean(f.directory,{page_key:key,expected_sha256:plan.expected_sha256}),/已变化/);
  assert.deepEqual((await inspectFinishedCleanSharing(f.directory,{page_key:key})).groups,[]);
});

test('底图缺失或成品指纹变化时拒绝归并，Agent语义接口要求先检查再提交',async t=>{
  const f=await fixture(t);await make(f);const record=await readFinishedRecord(f.directory,key.page_id);
  await assert.rejects(shareFinishedClean(f.directory,{page_key:key,expected_sha256:'bad'}),/已变化/);
  await unlink(at(f,record.outputs.clean));await assert.rejects(inspectFinishedCleanSharing(f.directory,{page_key:key}),/缺失/);
  const help=await executeWorkbench({operation:'help',target:'finished.clean.share'});
  assert.ok(help.parameters.required.includes('expected_sha256'));
});

test('检查后底图字节变化也拒绝迁移，整页删除一起归档共享文件及语言记录',async t=>{
  const f=await fixture(t);await make(f);await make(f,'en');
  const record=await readFinishedRecord(f.directory,key.page_id),clean=at(f,record.outputs.clean),bytes=await readFile(clean);
  const plan=await inspectFinishedCleanSharing(f.directory,{page_key:key});
  await writeFile(clean,await sharp(bytes).tint('#ff0000').png().toBuffer());
  await assert.rejects(shareFinishedClean(f.directory,{page_key:key,expected_sha256:plan.expected_sha256}),/已变化/);
  await writeFile(clean,bytes);
  const result=(await f.operations.mutateTargetFacts('demo',()=>deletePage(f.root,'demo',key.page_id))).value;
  assert.ok(result.archived_paths.includes(`Outputs/finished/${key.page_id}`));
  assert.deepEqual(await readFile(path.join(result.archive_directory,record.outputs.clean)),bytes);
  for(const suffix of ['','.en']){
    const archived=JSON.parse(await readFile(path.join(result.archive_directory,`finished/${key.page_id}${suffix}.json`),'utf8'));
    assert.equal(archived.outputs.clean,record.outputs.clean);
  }
});
