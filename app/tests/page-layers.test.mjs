import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,key,candidateId} from './helpers/finished-fixture.mjs';
import {emptyLayers,fullCrop,imagePlacement,resizeImageBox,cropImageItem,layerGeometryErrors,validateLayers} from '../shared/image-layers.mjs';
import {readPageLayers,savePageLayers,captureLayers,inspectPageLayers,resolveLayerMedia,layerFingerprint} from '../server/page-layers.mjs';
import {importImageMaterial} from '../server/image-materials.mjs';
import {deleteMaterial,saveMaterial} from '../server/project-materials.mjs';
import {removeUnusedFile} from '../server/reference-materials.mjs';
import {createPage,duplicatePage,deletePage} from '../server/page-facts.mjs';
import {convertComicPage} from '../server/comic-pages.mjs';
import {prepareTranslationInspection,readFinishedPages,prepareFinishedPage} from '../server/finished-pages.mjs';
import {composeImageLayers} from '../server/image-layer-render.mjs';
import {collageContext,saveCollage,captureCollage,composeCollage} from '../server/collage-pages.mjs';
import {readProjectWorkbenchView} from '../server/project-workbench.mjs';
import {executeWorkbench} from '../scripts/workbench-actions/index.mjs';

async function setup(t){
  const f=await fixture(t),bytes=await sharp({create:{width:100,height:4,channels:4,background:{r:255,g:0,b:0,alpha:.5}}}).png().toBuffer();
  const material=await importImageMaterial(f.directory,'demo',{title:'title.png',content:bytes.toString('base64')}),scope=await readPageLayers(f.directory,key.page_id);
  const document={...emptyLayers(),assets:{a:material.asset},items:[{id:'title',asset_id:'a',enabled:true,box:{x:.1,y:.1,w:.8,h:.2},crop:fullCrop()}]};
  return {...f,bytes,material,scope,document,save:(doc=document,sha=scope.sha256)=>savePageLayers(f.directory,key.page_id,{document:doc,expected_sha256:sha})};
}
test('窄透明标题、同名导入、边界约束与非破坏裁剪',async t=>{
  const f=await setup(t),second=await importImageMaterial(f.directory,'demo',{title:'title.png',content:f.bytes.toString('base64')});assert.notEqual(second.asset.file,f.material.asset.file);
  await f.save();const capture=await captureLayers(f.directory,f.document);assert.deepEqual(layerGeometryErrors(f.document,capture.media,'2:3'),[]);
  const tiny=resizeImageBox(imagePlacement(f.material.media,f.document.items[0].box,fullCrop(),'2:3').box,-10,-10,'2:3');assert.ok(tiny.w>=.02-1e-8&&tiny.h<.02);
  const cropped=cropImageItem(f.document.items[0],{x:.2,y:0,w:.4,h:1},f.material.media,'2:3');assert.ok(cropped.box.x>=0&&cropped.box.y>=0&&cropped.box.x+cropped.box.w<=1);
  assert.deepEqual(await readFile(path.join(f.directory,'materials',f.material.asset.file)),f.bytes);
  const clean=await sharp({create:{width:200,height:300,channels:3,background:'blue'}}).png().toBuffer(),output=await composeImageLayers(clean,f.document,capture);
  const box=imagePlacement(f.material.media,f.document.items[0].box,fullCrop(),'2:3').box;
  const pixel=await sharp(output).extract({left:Math.round((box.x+box.w/2)*200),top:Math.round((box.y+box.h/2)*300),width:1,height:1}).removeAlpha().raw().toBuffer();assert.ok(pixel[0]>120&&pixel[2]>120,'半透明红字与蓝底混合，未填白或黑底');
});
test('禁用引用保护、冲突、复制删除与分镜转换保护',async t=>{
  const f=await setup(t);f.document.items[0].enabled=false;const saved=await f.save();
  await assert.rejects(()=>deleteMaterial(f.directory,f.material.asset.file),e=>e.code==='material_in_use');
  await assert.rejects(()=>f.save(f.document,'obsolete'),e=>e.code==='page_layers_conflict');
  await assert.rejects(()=>convertComicPage(f.root,'demo',key.page_id),e=>e.code==='comic_layers_unsupported');
  const copy=await duplicatePage(f.root,'demo',key.page_id);assert.deepEqual((await readPageLayers(f.directory,copy.page_id)).document,saved.document);
  await deletePage(f.root,'demo',key.page_id);await assert.rejects(()=>deleteMaterial(f.directory,f.material.asset.file),e=>e.code==='material_in_use');
  await deletePage(f.root,'demo',copy.page_id);await deleteMaterial(f.directory,f.material.asset.file);
});
test('输出冻结素材、clean 不叠素材、重复输出及译文 clean_locale 检查一致',async t=>{
  const f=await setup(t);const saved=await f.save(),prepared=await f.prepare();
  await writeFile(path.join(f.directory,'materials',f.material.asset.file),await sharp(f.bytes).negate({alpha:false}).png().toBuffer());
  const job=await f.run(prepared);assert.equal(job.status,'completed',job.error);
  const recordPath=path.join(f.directory,'finished/page-001.json'),record=JSON.parse(await readFile(recordPath,'utf8'));
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:key.page_id})).pages[0].status,'stale');
  const originalClean=await sharp(await readFile(path.join(f.directory,record.outputs.clean))).raw().toBuffer();
  await writeFile(path.join(f.directory,'materials',f.material.asset.file),f.bytes);
  const inspect=await prepareTranslationInspection(f.root,'demo',f.directory,{page_key:key,locale:'zh',clean_locale:'zh'});
  assert.deepEqual(await sharp(inspect.clean).raw().toBuffer(),await sharp(await readFile(path.join(f.directory,record.outputs.lettered))).raw().toBuffer());
  const second=await f.prepare();assert.ok(second.reuse);assert.equal((await f.run(second)).status,'completed');
  const next=JSON.parse(await readFile(recordPath,'utf8'));assert.deepEqual(await sharp(await readFile(path.join(f.directory,next.outputs.clean))).raw().toBuffer(),originalClean);
  assert.deepEqual(await sharp(await readFile(path.join(f.directory,next.outputs.lettered))).raw().toBuffer(),await sharp(inspect.clean).raw().toBuffer());
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:key.page_id})).pages[0].status,'ready');
  const preview=await inspectPageLayers(f.directory,'demo',{page_key:key,candidate_id:candidateId});assert.equal(preview.layers.length,1);
  await unlink(path.join(f.directory,'materials',f.material.asset.file));await assert.rejects(()=>f.prepare());
  const disabled=structuredClone(f.document);disabled.items[0].enabled=false;await f.save(disabled,saved.sha256);await f.prepare();
});
test('组图接受项目素材，新增与替换来源均校验，参考自动清理保留被引用素材',async t=>{
  const f=await setup(t),created=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'collage'}),scope=await collageContext(f.directory,created.page_id);
  const document={...scope.document,assets:f.document.assets,items:f.document.items};await saveCollage(f.directory,created.page_id,{document,expected_sha256:scope.sha256});
  const capture=await captureCollage(f.directory,document);assert.equal((await sharp(await composeCollage(document,capture,120)).metadata()).width,120);
  const broken={...scope.document,assets:{a:{file:'missing.png'}},items:f.document.items};await assert.rejects(async()=>saveCollage(f.directory,created.page_id,{document:broken,expected_sha256:(await collageContext(f.directory,created.page_id)).sha256}));
  const ref='reference-12345678.png';await saveMaterial(f.directory,'demo',{file:ref,title:'reference',encoding:'base64',content:f.bytes.toString('base64')});
  f.document.assets.a={file:ref};await f.save();await removeUnusedFile(f.directory,ref);assert.ok(await readFile(path.join(f.directory,'materials',ref)));
  const view=await readProjectWorkbenchView(f.root,'demo',{kind:'page',page_id:key.page_id});assert.ok(view.outline.chapters[0].sequences[0].pages.find(p=>p.page_id===key.page_id).layers);
});
test('素材语义操作有完整帮助',async()=>{for(const target of ['page.layers.read','page.layers.save','page.layers.import','page.layers.inspect'])assert.ok(await executeWorkbench({operation:'help',target}));});

test('多语言素材默认共用，开启后严格选图，所有版本保护且共享几何',async t=>{
  const f=await setup(t),other=await importImageMaterial(f.directory,'demo',{title:'英文',content:(await sharp(f.bytes).negate({alpha:false}).png().toBuffer()).toString('base64')});
  f.document.assets.a.localizations={en:other.asset};
  const shared=await f.save();
  assert.equal((await captureLayers(f.directory,f.document,'en')).media.a.material_file,f.material.asset.file);
  await assert.rejects(()=>deleteMaterial(f.directory,other.asset.file),e=>e.code==='material_in_use');
  f.document.assets.a.multilingual=true;
  const enabled=await f.save(f.document,shared.sha256);
  assert.equal((await captureLayers(f.directory,f.document,'en')).media.a.material_file,other.asset.file);
  assert.equal((await captureLayers(f.directory,f.document,'zh')).media.a.material_file,f.material.asset.file);
  await assert.rejects(()=>captureLayers(f.directory,f.document,'ja'),e=>e.details?.some(s=>s.includes('缺少日文素材')));
  const listing=await readFinishedPages(f.root,'demo',f.directory,{page_id:key.page_id,locale:'ja'});assert.match(listing.pages[0].batch_skip_reason,/缺少日文素材/);
  const zh=await inspectPageLayers(f.directory,'demo',{page_key:key,candidate_id:candidateId,locale:'zh'}),en=await inspectPageLayers(f.directory,'demo',{page_key:key,candidate_id:candidateId,locale:'en'});
  assert.deepEqual(zh.layers[0].visible_box,en.layers[0].visible_box);
  assert.notDeepEqual(await readFile(zh.preview.absolute_file),await readFile(en.preview.absolute_file));
  const invalid=structuredClone(f.document);invalid.assets.a.localizations.en.file='../bad.png';assert.ok(validateLayers(invalid).length);
  invalid.assets.a.localizations={fr:other.asset};assert.ok(validateLayers(invalid).length);
  invalid.assets.a.localizations={en:{...other.asset,box:fullCrop()}};assert.ok(validateLayers(invalid).length,'禁止按语言独立排版');
  f.document.items[0].enabled=false;await f.save(f.document,enabled.sha256);
  await captureLayers(f.directory,f.document,'ja');
  await assert.rejects(()=>deleteMaterial(f.directory,other.asset.file),e=>e.code==='material_in_use');
});

test('语言成品冻结对应素材、共用 clean，其他语言变更不会误报当前成品过时',async t=>{
  const f=await setup(t),enBytes=await sharp(f.bytes).negate({alpha:false}).png().toBuffer();
  const en=await importImageMaterial(f.directory,'demo',{title:'en',content:enBytes.toString('base64')});
  const ja=await importImageMaterial(f.directory,'demo',{title:'ja',content:f.bytes.toString('base64')});
  f.document.assets.a={...f.material.asset,multilingual:true,localizations:{en:en.asset,ja:ja.asset}};await f.save();
  assert.equal((await f.run(await f.prepare())).status,'completed');
  const prepared=(await f.operations.mutateDerived('demo',()=>prepareFinishedPage(f.root,'demo',f.directory,{page_key:key,candidate_id:candidateId,locale:'en'}))).value;
  assert.ok(prepared.reuse);assert.equal(prepared.layerCapture.media.a.material_file,en.asset.file);
  await writeFile(path.join(f.directory,'materials',en.asset.file),f.bytes);
  assert.equal((await f.run(prepared)).status,'completed');
  const record=JSON.parse(await readFile(path.join(f.directory,'finished/page-001.en.json'),'utf8'));
  const expected=await composeImageLayers(await readFile(path.join(f.directory,record.outputs.clean)),f.document,prepared.layerCapture);
  assert.deepEqual(await sharp(await readFile(path.join(f.directory,record.outputs.lettered))).raw().toBuffer(),await sharp(expected).raw().toBuffer());
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:key.page_id,locale:'en'})).pages[0].status,'stale');
  await writeFile(path.join(f.directory,'materials',en.asset.file),enBytes);
  await writeFile(path.join(f.directory,'materials',ja.asset.file),enBytes);
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:key.page_id,locale:'en'})).pages[0].status,'ready');
  const inspect=await prepareTranslationInspection(f.root,'demo',f.directory,{page_key:key,locale:'en',clean_locale:'zh'});
  assert.deepEqual(await sharp(inspect.clean).raw().toBuffer(),await sharp(expected).raw().toBuffer());
  const media=await resolveLayerMedia(f.directory,f.document,'en'),before=layerFingerprint(f.document,media,'en');
  const changed=structuredClone(f.document);changed.assets.a.localizations.ja=en.asset;
  assert.equal(layerFingerprint(changed,media,'en'),before,'其他语言的引用变化不影响英文');
});
