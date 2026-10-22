import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,key,candidateId,json} from './helpers/finished-fixture.mjs';
import {convertComicPage,splitComicPanel,readComicDocument,saveComicPage,comicGenerationDimensions,restoreComicPage,planComicMerge,mergeComicPages} from '../server/comic-pages.mjs';
import {readProjectWorkbenchView} from '../server/project-workbench.mjs';
import {readPageIndex} from '../server/pages-store.mjs';
import {comicGeometry} from '../shared/comic-layout.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';
import {prepareFinishedPage,readFinishedPages,planFinishedBatch} from '../server/finished-pages.mjs';
import {candidateFileRelativePath} from '../server/candidate-storage.mjs';
import {compilePageRenderInspectionContext} from '../server/page-render-resolver.mjs';
import {duplicatePage,movePage,deletePage} from '../server/page-facts.mjs';

test('误转换可恢复，合并与拆回保留原身份、正文、Prompt和候选',async t=>{
  const f=await fixture(t),second=await duplicatePage(f.root,'demo',key.page_id);
  const original=await readFile(path.join(f.directory,'pages/page-001.prompt.json'),'utf8');
  const converted=await convertComicPage(f.root,'demo',second.page_id);
  assert.equal(converted.document.margin,0);assert.equal(converted.document.gutter,0);
  await assert.rejects(()=>restoreComicPage(f.root,'demo',second.page_id,{expected_sha256:'stale'}),/comic_layout_conflict/);
  await restoreComicPage(f.root,'demo',second.page_id,{expected_sha256:converted.sha256});
  assert.equal(await readComicDocument(f.directory,second.page_id),null);
  const args={page_keys:[key,{page_id:second.page_id}],axis:'x'};
  const plan=await planComicMerge(f.root,'demo',key.page_id,args);
  await assert.rejects(()=>mergeComicPages(f.root,'demo',key.page_id,{...args,expected_sha256:'stale'}),/comic_merge_conflict/);
  const merged=await mergeComicPages(f.root,'demo',key.page_id,{...args,expected_sha256:plan.sha256});
  assert.deepEqual(merged.document.order,[key.page_id,second.page_id]);assert.equal(merged.document.layout.ratio,.5);
  assert.equal(merged.document.panels[key.page_id].candidate_id,candidateId);
  assert.equal((await readPageIndex(f.directory)).pages.filter(page=>!page.parent_page_id).length,1);
  await restoreComicPage(f.root,'demo',key.page_id,{expected_sha256:merged.sha256});
  assert.equal(await readComicDocument(f.directory,key.page_id),null);
  const index=await readPageIndex(f.directory);assert.deepEqual(index.pages.map(page=>page.page_id),[key.page_id,second.page_id]);assert.ok(index.pages.every(page=>!page.parent_page_id));
  assert.equal(await readFile(path.join(f.directory,'pages/page-001.prompt.json'),'utf8'),original);assert.ok(await readFile(f.file));
});

test('转换保留原事实和候选，切分原子建立独立分镜且目录仍为一页',async t=>{
  const f=await fixture(t),content=await readFile(path.join(f.directory,'pages/page-001.content.json'),'utf8');
  const converted=await f.operations.mutateTargetFacts('demo',()=>convertComicPage(f.root,'demo',key.page_id));
  assert.equal(await readFile(path.join(f.directory,'pages/page-001.content.json'),'utf8'),content);
  assert.ok(await readFile(f.file));
  const split=(await f.operations.mutateTargetFacts('demo',()=>splitComicPanel(f.root,'demo',key.page_id,{expected_sha256:converted.value.sha256,panel_id:key.page_id,axis:'y'}))).value;
  const index=await readPageIndex(f.directory);assert.equal(index.pages.length,2);assert.equal(index.pages.find(page=>page.page_id===split.panel_id).parent_page_id,key.page_id);
  const view=await readProjectWorkbenchView(f.root,'demo',{kind:'page',page_id:key.page_id});
  const pages=view.outline.chapters[0].sequences[0].pages;
  assert.equal(pages.length,1);assert.equal(pages[0].comic.panels.length,2);
  assert.ok(pages[0].comic.panels.every(panel=>panel.prompt&&panel.render&&panel.content_sha256));
  assert.equal(pages[0].comic.panels[1].dialogue.length,0);
  const doc=await readComicDocument(f.directory,key.page_id),order=[...doc.order];doc.layout.ratio=.7;
  await f.operations.mutateTargetFacts('demo',()=>saveComicPage(f.root,'demo',key.page_id,{expected_sha256:hashCanonicalJson(split.document),document:doc}));
  assert.deepEqual((await readComicDocument(f.directory,key.page_id)).order,order);
  const dimensions=await comicGenerationDimensions(f.directory,split.panel_id);assert.ok(dimensions.width>dimensions.height);
  const context=await compilePageRenderInspectionContext({repositoryRoot:f.root,projectDirectory:f.directory,pageKey:{page_id:split.panel_id}});
  assert.deepEqual(context.candidate_recipe.resolutions[context.project.canvas],dimensions);
  await assert.rejects(()=>f.operations.mutateTargetFacts('demo',()=>saveComicPage(f.root,'demo',key.page_id,{expected_sha256:converted.value.sha256,document:doc})),/comic_layout_conflict/);
});

test('分镜成品列表区分候选计数不适用、未选图及已选图片丢失，批量预检跳过不可输出页',async t=>{
  const f=await fixture(t),converted=await convertComicPage(f.root,'demo',key.page_id);
  const listing=async()=>(await readFinishedPages(f.root,'demo',f.directory)).pages[0];
  let page=await listing();
  assert.equal(page.candidate_count,null);assert.equal(page.batch_skip_reason,null);assert.equal(page.status,'missing');
  const split=await splitComicPanel(f.root,'demo',key.page_id,{expected_sha256:converted.sha256,panel_id:key.page_id,axis:'x'});
  assert.equal((await listing()).batch_skip_reason,'部分分镜尚未选图');
  const document=structuredClone(split.document),image=path.join(f.directory,candidateFileRelativePath({page_id:split.panel_id},candidateId));
  await mkdir(path.dirname(image),{recursive:true});await writeFile(image,await readFile(f.file));
  await json(image.replace('image.png','result.json'),{version:1,status:'available',page_key:{page_id:split.panel_id},candidate_id:candidateId,file:candidateFileRelativePath({page_id:split.panel_id},candidateId),task_id:'test'});
  document.panels[split.panel_id].candidate_id=candidateId;
  await saveComicPage(f.root,'demo',key.page_id,{expected_sha256:hashCanonicalJson(split.document),document});
  assert.equal((await listing()).batch_skip_reason,null);
  assert.equal((await planFinishedBatch(f.root,'demo',f.directory)).targets.length,1);
  await unlink(image);
  page=await listing();
  assert.equal(page.candidate_count,null);assert.equal(page.batch_skip_reason,'部分分镜选图已不存在，请重新选图');
  const plan=await planFinishedBatch(f.root,'demo',f.directory);
  assert.deepEqual(plan.targets,[]);assert.equal(plan.skipped[0].reason,page.batch_skip_reason);
  await assert.rejects(prepareFinishedPage(f.root,'demo',f.directory,{page_key:key}),/部分分镜选图已不存在/);
  await assert.rejects(readFile(path.join(f.directory,'Saved/finished/page-001.json')),{code:'ENOENT'});
});

test('整页输出冻结各格选图与裁切，合成后布局修改标记成品过时',async t=>{
  const f=await fixture(t);
  const converted=await convertComicPage(f.root,'demo',key.page_id);
  const split=await splitComicPanel(f.root,'demo',key.page_id,{expected_sha256:converted.sha256,panel_id:key.page_id,axis:'y'});
  const document=structuredClone(split.document);
  document.panels[key.page_id].candidate_id=candidateId;
  document.panels[split.panel_id].candidate_id=candidateId;
  const image=path.join(f.directory,candidateFileRelativePath({page_id:split.panel_id},candidateId));
  await mkdir(path.dirname(image),{recursive:true});await writeFile(image,await sharp({create:{width:192,height:128,channels:3,background:'#ff0000'}}).png().toBuffer());
  await json(image.replace('image.png','result.json'),{version:1,status:'available',page_key:{page_id:split.panel_id},candidate_id:candidateId,file:candidateFileRelativePath({page_id:split.panel_id},candidateId),task_id:'test'});
  await saveComicPage(f.root,'demo',key.page_id,{expected_sha256:hashCanonicalJson(split.document),document});
  const prepared=await prepareFinishedPage(f.root,'demo',f.directory,{page_key:key});
  const job=await f.run(prepared);assert.equal(job.status,'completed',job.error);
  const result=await readFinishedPages(f.root,'demo',f.directory);assert.equal(result.pages.length,1);assert.equal(result.pages[0].status,'ready');
  const record=JSON.parse(await readFile(path.join(f.directory,'finished/page-001.json'),'utf8'));
  const pixels=await sharp(path.join(f.directory,record.outputs.clean)).raw().toBuffer({resolveWithObject:true});
  assert.equal(pixels.info.width,2048);
  const frame=comicGeometry(document).frames[split.panel_id],offset=(Math.floor((frame.y+frame.h/2)*pixels.info.height)*pixels.info.width+Math.floor(pixels.info.width/2))*pixels.info.channels;
  assert.equal(pixels.data[offset],255);assert.equal(pixels.data[offset+1],0);
  const before=hashCanonicalJson(document);document.layout.ratio=.6;
  await saveComicPage(f.root,'demo',key.page_id,{expected_sha256:before,document});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages[0].status,'stale');
});

test('复制、移动和删除目录页连同内部格子处理，副本独立保留',async t=>{
  const f=await fixture(t),converted=await convertComicPage(f.root,'demo',key.page_id);
  const split=await splitComicPanel(f.root,'demo',key.page_id,{expected_sha256:converted.sha256,panel_id:key.page_id,axis:'x'});
  const originals=[];
  for(const pageId of split.document.order){
    const file=path.join(f.directory,`pages/${pageId}.content.json`),content=JSON.parse(await readFile(file,'utf8'));
    content.dialogue=[{id:'dialogue-aaaa00000001',mode:'heart',text:'同一原 ID 的独立对白'}];await json(file,content);originals.push(content);
  }
  const copied=await duplicatePage(f.root,'demo',key.page_id),copy=await readComicDocument(f.directory,copied.page_id);
  const copiedIds=[];
  for(const [index,pageId] of copy.order.entries()){
    const content=JSON.parse(await readFile(path.join(f.directory,`pages/${pageId}.content.json`),'utf8'));
    copiedIds.push(content.dialogue[0].id);assert.notEqual(content.dialogue[0].id,originals[index].dialogue[0].id);
    assert.deepEqual({...content.dialogue[0],id:originals[index].dialogue[0].id},originals[index].dialogue[0]);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.directory,`pages/${split.document.order[index]}.content.json`),'utf8')),originals[index]);
  }
  assert.equal(new Set(copiedIds).size,2);
  assert.equal(copy.order.length,2);assert.ok(copy.order.includes(copied.page_id));assert.ok(copy.order.every(id=>!split.document.order.includes(id)));
  assert.ok(Object.values(copy.panels).every(panel=>panel.candidate_id===null));
  const file=path.join(f.directory,'story/outline.json'),outline=JSON.parse(await readFile(file,'utf8'));
  outline.chapters[0].sequences.push({id:'other',title:'另一个单元',summary:'测试'});await json(file,outline);
  await movePage(f.root,'demo',key.page_id,{owner_kind:'story',sequence_id:'other'});
  assert.ok((await readPageIndex(f.directory)).pages.filter(page=>split.document.order.includes(page.page_id)).every(page=>page.sequence_id==='other'));
  await assert.rejects(()=>movePage(f.root,'demo',split.panel_id,{owner_kind:'story',sequence_id:'other'}),/panel_owned_by_page/);
  const removed=await deletePage(f.root,'demo',key.page_id);
  assert.ok(removed.archived_paths.includes(`pages/${split.panel_id}.content.json`));
  assert.ok((await readPageIndex(f.directory)).pages.every(page=>copy.order.includes(page.page_id)));
  assert.equal((await readComicDocument(f.directory,copied.page_id)).order.length,2);
});
