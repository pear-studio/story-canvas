import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fixture,key,json,candidateId} from './helpers/finished-fixture.mjs';
import {readPageTranslation,savePageTranslation,readTranslationDocument,validateTranslationDocument} from '../server/page-translations.mjs';
import {readProjectWorkbenchView,savePageContent} from '../server/project-workbench.mjs';
import {prepareFinishedPage,readFinishedPages,readFinishedRecord,deleteFinishedPage} from '../server/finished-pages.mjs';
import {duplicatePage,deletePage} from '../server/page-facts.mjs';
const first='dialogue-123456789abc',second='dialogue-223456789abc';
async function content(f){const file=path.join(f.directory,'pages/page-001.content.json'),value=JSON.parse(await readFile(file,'utf8'));await json(file,{...value,dialogue:[{id:first,mode:'speech',speaker:'npc',text:'早上好'},{id:second,mode:'heart',text:'喜欢你'}]});}
async function save(f,locale,entries,baseline){const value=baseline??await readPageTranslation(f.directory,{page_key:key,locale});return f.operations.mutateTargetFacts('demo',()=>savePageTranslation(f.directory,{page_key:key,locale,entries,expected_source_sha256:value.expected_source_sha256,expected_translation_sha256:value.expected_translation_sha256})).then(result=>result.value);}
test('译文分支独立；同语言冲突保护；原文变化仅使相关行过时，显式沿用更新指纹',async t=>{
  const f=await fixture(t);await content(f);
  const en=await readPageTranslation(f.directory,{page_key:key,locale:'en'}),ja=await readPageTranslation(f.directory,{page_key:key,locale:'ja'});
  assert.equal(en.summary.missing,2);
  await save(f,'en',{[first]:'Good morning.',[second]:'Love you.'},en);
  await save(f,'ja',{[first]:'おはよう。',[second]:'好き。'},ja);
  await assert.rejects(save(f,'en',{[first]:'Hi.'},en),/本语言译文已变化/);
  const view=await readProjectWorkbenchView(f.root,'demo'),page=view.pages[0];
  await f.operations.mutateTargetFacts('demo',()=>savePageContent(f.root,'demo',{page_key:key,expected_sha256:page.content_sha256,content:{title:page.title,scene_description:page.scene_description,characters:[],dialogue:page.dialogue.map(line=>line.id===first?{...line,text:'早安，朋友'}:line)}}));
  const stale=await readPageTranslation(f.directory,{page_key:key,locale:'en'});assert.equal(stale.summary.stale,1);assert.equal(stale.lines[1].status,'ready');
  const confirmed=await save(f,'en',{[first]:'Good morning.'},stale);assert.equal(confirmed.summary.stale,0);
  assert.equal((await readPageTranslation(f.directory,{page_key:key,locale:'ja'})).summary.stale,1);
});
test('中文删除条目同步清理译文；页面复制和归档包含译文',async t=>{
  const f=await fixture(t);await content(f);await save(f,'en',{[first]:'Good morning.',[second]:'Love you.'});
  const view=await readProjectWorkbenchView(f.root,'demo'),page=view.pages[0];
  await f.operations.mutateTargetFacts('demo',()=>savePageContent(f.root,'demo',{page_key:key,expected_sha256:page.content_sha256,content:{title:page.title,scene_description:page.scene_description,characters:[],dialogue:page.dialogue.slice(0,1)}}));
  const document=await readTranslationDocument(f.directory,key.page_id);assert.deepEqual(Object.keys(document.en.dialogue),[first]);assert.deepEqual(validateTranslationDocument(document,{dialogue:page.dialogue.slice(0,1)}),[]);
  const duplicate=(await f.operations.mutateTargetFacts('demo',()=>duplicatePage(f.root,'demo',key.page_id))).value;
  assert.deepEqual(await readTranslationDocument(f.directory,duplicate.page_id),document);
  await f.operations.mutateTargetFacts('demo',()=>deletePage(f.root,'demo',duplicate.page_id));assert.equal(await readTranslationDocument(f.directory,duplicate.page_id),null);
});
test('外语成品阻止缺译；复用中文底图；语言输出、过时和删除互不干扰',async t=>{
  const f=await fixture(t);await content(f);await f.run(await f.prepare());
  await assert.rejects(prepareFinishedPage(f.root,'demo',f.directory,{page_key:key,locale:'en',candidate_id:candidateId}),/译文未就绪/);
  await save(f,'en',{[first]:'Good morning.',[second]:'Love you.'});await save(f,'ja',{[first]:'おはよう。',[second]:'好き。'});
  const zh=await readFinishedRecord(f.directory,key.page_id);
  for(const locale of ['en','ja']){const prepared=(await f.operations.mutateDerived('demo',()=>prepareFinishedPage(f.root,'demo',f.directory,{page_key:key,locale,candidate_id:candidateId}))).value;assert.ok(prepared.reuse);assert.equal(prepared.snapshot.lettering.locale,locale);assert.equal((await f.run(prepared,{upscale:()=>assert.fail('不应再次超分')})).status,'completed');assert.equal((await readFinishedPages(f.root,'demo',f.directory,{locale})).pages[0].status,'ready');}
  const ja=await readFinishedRecord(f.directory,key.page_id,'ja');await save(f,'en',{[first]:'Morning.'});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{locale:'en'})).pages[0].status,'stale');assert.equal((await readFinishedPages(f.root,'demo',f.directory,{locale:'ja'})).pages[0].status,'ready');
  const page=(await readFinishedPages(f.root,'demo',f.directory,{locale:'en'})).pages[0];await f.operations.mutateTargetFacts('demo',()=>deleteFinishedPage(f.directory,{page_key:key,locale:'en',expected_sha256:page.record.sha256}));
  assert.deepEqual(await readFinishedRecord(f.directory,key.page_id),zh);assert.deepEqual(await readFinishedRecord(f.directory,key.page_id,'ja'),ja);assert.equal(await readFinishedRecord(f.directory,key.page_id,'en'),null);
});
