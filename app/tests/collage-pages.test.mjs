import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,json,candidateId,key} from './helpers/finished-fixture.mjs';
import {createPage,duplicatePage,deletePage} from '../server/page-facts.mjs';
import {collageContext,listCollageSources,saveCollage,captureCollage,composeCollage,resolveCollageMedia,collageMediaFingerprint,inspectCollage} from '../server/collage-pages.mjs';
import {prepareFinishedPage,readFinishedPages} from '../server/finished-pages.mjs';
import {arrangeCollage,validateCollage,fullCrop,changeCollageCanvas,collageSize} from '../shared/collage-layout.mjs';
import {readProjectWorkbenchView} from '../server/project-workbench.mjs';
import {candidateFileRelativePath} from '../server/candidate-storage.mjs';
import {executeWorkbench} from '../scripts/workbench-actions/index.mjs';
import {readFactDraft,saveFactDraft} from '../server/fact-drafts.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';

async function setup(t){const f=await fixture(t),created=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'collage'}),scope=await collageContext(f.directory,created.page_id),sources=await listCollageSources(f.directory,'demo');const doc=scope.document;doc.assets.a=sources.pages[0].asset;doc.items=[{id:'one',asset_id:'a',enabled:true,box:{x:.1,y:.1,w:.6,h:.6},crop:fullCrop()}];return {...f,id:created.page_id,scope,doc};}

test('组图三种画幅输出标准两倍尺寸，预览保持指定宽度，切换画幅不拉伸',async t=>{
  const f=await setup(t),captured=await captureCollage(f.directory,f.doc);
  for(const [canvas,width,height] of [['3:4',1920,2560],['1:1',2048,2048],['4:3',2560,1920]]){
    const doc={...f.doc,canvas};assert.deepEqual(collageSize(canvas),{width,height});
    const result=await sharp(await composeCollage(doc,captured)).metadata();assert.equal(result.width,width);assert.equal(result.height,height);
    const preview=await sharp(await composeCollage(doc,captured,1024)).metadata();assert.equal(preview.width,1024);assert.equal(preview.height,Math.round(1024*height/width));
    const tiled=arrangeCollage(doc,undefined,captured.media),next=changeCollageCanvas(tiled,'4:3'),size=collageSize(next.canvas),box=next.items[0].box;
    assert.ok(Math.abs(box.w*size.width/(box.h*size.height)-128/192)<.001);
  }
});

test('旧组图尺寸标记过时，重出后记录与真实PNG尺寸一致且布局不变',async t=>{
  const f=await setup(t);f.doc.canvas='3:4';
  const saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  const output=async()=>assert.equal((await f.run(await prepareFinishedPage(f.root,'demo',f.directory,{page_key:{page_id:f.id}}))).status,'completed');
  await output();
  const recordPath=path.join(f.directory,'finished',f.id+'.json'),record=JSON.parse(await readFile(recordPath,'utf8'));
  assert.equal(record.width,1920);assert.equal(record.height,2560);
  const media=await sharp(path.join(f.directory,record.outputs.lettered)).metadata();assert.equal(media.width,1920);assert.equal(media.height,2560);
  await json(recordPath,{...record,width:2048,height:2731});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:f.id})).pages[0].status,'stale');
  await output();assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:f.id})).pages[0].status,'ready');
  assert.deepEqual((await collageContext(f.directory,f.id)).document,saved.document);
});

test('语义保存显式修复旧背景字段，保持排版；来源名称使用正式页码和章节',async t=>{
  const f=await setup(t),legacy={...f.doc,background:{asset_id:'a',enabled:true,crop:fullCrop(),opacity:.45,fade:false}};
  await json(path.join(f.directory,'pages',f.id+'.collage.json'),legacy);
  const next=structuredClone(legacy);delete next.background.fade;
  const saved=await saveCollage(f.directory,f.id,{document:next,expected_sha256:hashCanonicalJson(legacy)});assert.deepEqual(saved.document,next);
  const media=await resolveCollageMedia(f.directory,next);assert.equal(media.a.label,'#1-第一章-测试页');
});
async function replacement(f){
  const id='candidate-22222222-2222-4222-8222-222222222222',relative=candidateFileRelativePath(key,id),file=path.join(f.directory,relative);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,await sharp({create:{width:240,height:120,channels:3,background:'red'}}).png().toBuffer());
  await json(file.replace('image.png','result.json'),{version:1,status:'available',page_key:key,candidate_id:id,file:relative});return {id,file};
}
test('组图只保存页面引用，候选替换自动跟随、尺寸更新且排版不变；复制删除不触碰来源',async t=>{
  const f=await setup(t);let saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  assert.deepEqual(saved.document.assets.a,{page_id:'page-001'});assert.equal((await readdir(path.join(f.directory,'materials')).catch(()=>[])).length,0);
  const first=await captureCollage(f.directory,saved.document),next=await replacement(f);
  assert.match((await resolveCollageMedia(f.directory,saved.document)).a.error,/2 张候选/);
  await assert.rejects(()=>captureCollage(f.directory,saved.document),/invalid_collage/);
  await unlink(f.file.replace('image.png','result.json'));
  const updated=await captureCollage(f.directory,saved.document);assert.equal(updated.media.a.candidate_id,next.id);assert.equal(updated.media.a.width,240);assert.equal(updated.media.a.height,120);assert.notEqual(updated.sha256,first.sha256);
  assert.deepEqual((await collageContext(f.directory,f.id)).document,saved.document,'媒体变化不写入页面事实');
  const removed={...saved.document,items:[],assets:{}};const empty=await saveCollage(f.directory,f.id,{document:removed,expected_sha256:saved.sha256});assert.deepEqual(empty.document.assets,{});
  saved=await saveCollage(f.directory,f.id,{document:saved.document,expected_sha256:empty.sha256});
  const copy=await duplicatePage(f.root,'demo',f.id);await deletePage(f.root,'demo',f.id);await captureCollage(f.directory,(await collageContext(f.directory,copy.page_id)).document);assert.ok(await readFile(next.file));
});
test('缺图、零候选、多候选和删除来源明确提示；已有布局可保存，并发冲突仍拒绝',async t=>{
  const f=await setup(t);let saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  await unlink(f.file);assert.match((await resolveCollageMedia(f.directory,f.doc)).a.error,/缺失/);
  await unlink(f.file.replace('image.png','result.json'));assert.match((await listCollageSources(f.directory,'demo')).pages[0].media.error,/没有候选/);
  await assert.rejects(()=>captureCollage(f.directory,f.doc),e=>e.code==='invalid_collage');
  await assert.rejects(()=>saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:'stale'}),/collage_conflict/);
  saved.document.items[0].box.x=.2;saved=await saveCollage(f.directory,f.id,{document:saved.document,expected_sha256:saved.sha256});
  await deletePage(f.root,'demo','page-001');assert.match((await resolveCollageMedia(f.directory,saved.document)).a.error,/已移除/);
  const empty=await saveCollage(f.directory,f.id,{document:{...saved.document,items:[]},expected_sha256:saved.sha256});assert.deepEqual(empty.document.assets,{});
  for(const broken of [null,{}, {...f.doc,assets:{a:null}}, {...f.doc,items:[null]}, {...f.doc,background:{}}, {...f.doc,assets:{a:{page_id:'page-001',candidate_id:candidateId}}}])assert.ok(validateCollage(broken).length);
});
test('输出冻结当时像素，来源换图后旧成品过时且重新输出跟随新图',async t=>{
  const f=await setup(t),saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  const prepared=await prepareFinishedPage(f.root,'demo',f.directory,{page_key:{page_id:f.id}});
  const next=await replacement(f);await unlink(f.file.replace('image.png','result.json'));
  assert.equal((await f.run(prepared)).status,'completed');
  let page=(await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.id);assert.equal(page.status,'stale');
  const oldRecord=JSON.parse(await readFile(path.join(f.directory,'finished',f.id+'.json'),'utf8'));
  const oldPixel=await sharp(await readFile(path.join(f.directory,oldRecord.outputs.clean))).extract({left:700,top:700,width:1,height:1}).raw().toBuffer();assert.equal(oldPixel[0],128,'排队后替换候选不改变本次冻结像素');
  assert.equal((await f.run(await prepareFinishedPage(f.root,'demo',f.directory,{page_key:{page_id:f.id}}))).status,'completed');
  page=(await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.id);assert.equal(page.status,'ready');
  await unlink(next.file.replace('image.png','result.json'));page=(await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.id);assert.equal(page.status,'stale');assert.match(page.batch_skip_reason,/没有候选/);
  assert.deepEqual((await collageContext(f.directory,f.id)).document,saved.document);
});

test('不依赖模型创建与输出，语言共享成品；布局修改后标记过时',async t=>{
  const f=await setup(t);let saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  const project=JSON.parse(await readFile(path.join(f.directory,'project.json'),'utf8'));project.default_render_profile='missing-model';await json(path.join(f.directory,'project.json'),project);
  const created=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'collage'});assert.ok(created.page_id);
  const view=await readProjectWorkbenchView(f.root,'demo',{kind:'page',page_id:f.id});assert.ok(view.outline.chapters[0].sequences[0].pages.find(p=>p.page_id===f.id).collage);
  const prepared=await prepareFinishedPage(f.root,'demo',f.directory,{page_key:{page_id:f.id},locale:'ja'});
  const job=await f.run(prepared,{upscale:()=>assert.fail('不应超分'),render:()=>assert.fail('不应嵌字')});assert.equal(job.status,'completed',job.error);
  const pages=await readFinishedPages(f.root,'demo',f.directory,{page_id:f.id,locale:'ja'});assert.equal(pages.pages.find(p=>p.page_id===f.id).status,'ready');
  saved.document.background={asset_id:'a',enabled:true,crop:fullCrop(),opacity:.45};saved=await saveCollage(f.directory,f.id,{document:saved.document,expected_sha256:saved.sha256});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.id).status,'stale');
});
test('几何平铺不裁图、不移动旧图片；背景及前景合成顺序正确',async t=>{
  const f=await setup(t),doc=f.doc;doc.items.push({id:'two',asset_id:'a',enabled:true,box:fullCrop(),crop:fullCrop()});
  const tiled=arrangeCollage(doc,['two'],await resolveCollageMedia(f.directory,doc));assert.deepEqual(tiled.items[0],doc.items[0]);
  for(const canvas of ['1:1','4:3','9:16']){const next=changeCollageCanvas(tiled,canvas),size=collageSize(canvas);assert.equal(validateCollage(next).length,0);assert.ok(Math.abs(next.items[1].box.w*size.width/(next.items[1].box.h*size.height)-128/192)<.001);}
  doc.items=[{...doc.items[0],box:{x:.25,y:.25,w:.5,h:.5}}];doc.background={asset_id:'a',enabled:true,crop:fullCrop(),opacity:.5};
  const pixels=await sharp(await composeCollage(doc,await captureCollage(f.directory,doc),100)).raw().toBuffer({resolveWithObject:true});
  const pixel=(x,y)=>pixels.data[(y*pixels.info.width+x)*pixels.info.channels];assert.equal(pixel(50,75),128);assert.ok(Math.abs(pixel(0,0)-64)<=1);
});

test('关闭图层保留排版与引用，不参与合成、平铺或来源就绪检查，重新开启恢复',async t=>{
  const f=await setup(t),original=structuredClone(f.doc.items[0]);
  f.doc.items[0].enabled=false;
  let saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  assert.deepEqual(saved.document.assets,f.doc.assets);
  assert.deepEqual(arrangeCollage(saved.document).items,saved.document.items,'关闭的图片不被重新平铺');
  const captured=await captureCollage(f.directory,saved.document);assert.deepEqual(captured.buffers,{});
  const pixels=await sharp(await composeCollage(saved.document,captured,100)).removeAlpha().raw().toBuffer();assert.ok(pixels.every(value=>value===0),'关闭的图片不出现在合成图');
  const before=collageMediaFingerprint(saved.document,captured.media);
  await replacement(f);
  const unavailable=await captureCollage(f.directory,saved.document);assert.match(unavailable.media.a.error,/2 张候选/);assert.equal(unavailable.sha256,before,'关闭图片的候选变化不影响成品指纹');
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.id).batch_skip_reason,'组图尚未选图');
  await assert.rejects(()=>prepareFinishedPage(f.root,'demo',f.directory,{page_key:{page_id:f.id}}),/组图尚未选图/);
  saved.document.items[0].enabled=true;saved=await saveCollage(f.directory,f.id,{document:saved.document,expected_sha256:saved.sha256});
  assert.deepEqual(saved.document.items[0],original);await assert.rejects(()=>captureCollage(f.directory,saved.document),/invalid_collage/);
  await unlink(f.file.replace('image.png','result.json'));
  assert.ok((await captureCollage(f.directory,saved.document)).buffers.a);
  const missing=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'});
  saved.document.assets.b={page_id:missing.page_id};saved.document.items.push({...original,id:'hidden',asset_id:'b',enabled:false});
  saved=await saveCollage(f.directory,f.id,{document:saved.document,expected_sha256:saved.sha256});
  assert.equal((await f.run(await prepareFinishedPage(f.root,'demo',f.directory,{page_key:{page_id:f.id}}))).status,'completed','关闭图片缺少候选不阻挡其他图片输出');
  const finished=(await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.id);assert.equal(finished.status,'ready');assert.equal(finished.batch_skip_reason,null);
});
test('Agent 组图操作帮助完整且选图参数可选',async()=>{
  const read=await executeWorkbench({operation:'help',target:'page.collage.sources'});assert.deepEqual(read.parameters.required,['project_id']);
  const list=await executeWorkbench({operation:'help',target:'page.collage'});assert.equal(list.operations.length,7);
  const inspect=await executeWorkbench({operation:'help',target:'page.collage.inspect'});assert.deepEqual(inspect.parameters.required,['project_id']);
});

test('背景关闭保留设置和素材，检查接口提供坐标与两张可读图，来源缺失不阻挡已关闭层',async t=>{
  const f=await setup(t);f.doc.background={asset_id:'a',enabled:false,crop:fullCrop(),opacity:.32};
  const saved=await saveCollage(f.directory,f.id,{document:f.doc,expected_sha256:f.scope.sha256});
  const inspect=await inspectCollage(f.root,f.directory,'demo',{page_key:{page_id:f.id}});
  assert.equal(inspect.sha256,saved.sha256);assert.deepEqual(inspect.document,saved.document);assert.equal(inspect.layers[0].enabled,false);
  assert.equal(inspect.layers[1].box_pixels.x,205);assert.ok(inspect.layers[1].visible_box_pixels.w<=inspect.layers[1].box_pixels.w);
  assert.deepEqual(Object.keys(inspect.layers[1].source).sort(),['file','height','page_id','width']);
  assert.equal((await sharp(inspect.preview.absolute_file).metadata()).width,1024);assert.equal((await sharp(inspect.source_sheet.absolute_file).metadata()).width,480);
  f.doc.items[0].enabled=false;await unlink(f.file.replace('image.png','result.json'));
  const hidden=await inspectCollage(f.root,f.directory,'demo',{document:f.doc});assert.deepEqual(hidden.issues,[]);assert.ok(hidden.preview);
  f.doc.background.enabled=true;const missing=await inspectCollage(f.root,f.directory,'demo',{document:f.doc});assert.equal(missing.preview,null);assert.equal(missing.issues.length,1);
  assert.deepEqual((await collageContext(f.directory,f.id)).document,saved.document,'检查草稿不会保存事实');
  await assert.rejects(()=>inspectCollage(f.root,f.directory,'demo',{document:f.doc,page_key:{page_id:f.id}}),/invalid_collage/);
});
test('含组图的剧情索引可沿用语义编辑，不误报缺少 Prompt',async t=>{
  const f=await setup(t),target={domain:'story',kind:'index',projectId:'demo'};
  const draft=await readFactDraft(f.root,target);
  const result=await saveFactDraft(f.root,{...target,document:draft.document,expectedSha256:draft.expected_sha256,expectedContextSha256:draft.expected_context_sha256});
  assert.deepEqual(result.downstream_diagnostics,[]);
});
