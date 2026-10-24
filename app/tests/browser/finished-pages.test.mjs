import {finishedReaderDocument,finishedReaderHead,finishedReaderFigure,finishedReaderAnimation,finishedReaderTail} from '../../shared/finished-reader.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile, cp, truncate, stat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import sharp from "sharp";
import { chromium } from "playwright";
import { fixture, key, candidateId, json } from "../helpers/finished-fixture.mjs";
import { PAGES_INDEX_SCHEMA_ID } from "../../server/pages-store.mjs";
import { candidateFileRelativePath } from "../../server/candidate-storage.mjs";
import { prepareFinishedPage, readFinishedRecord } from "../../server/finished-pages.mjs";
import { defaultLetteringSettings } from "../../server/lettering-settings.mjs";
import { serveProductionAsset } from "../../server/http-support.mjs";
import { renderFinishedImage } from "../../server/finished-render.mjs";
import { createStoryCanvasServer } from "../../server/index.mjs";
import { hashCanonicalJson } from "../../server/workflow-definition.mjs";
import {createPage} from '../../server/page-facts.mjs';

const testAppRoot=process.env.STORY_CANVAS_TEST_APP_ROOT??fileURLToPath(new URL('../../',import.meta.url));

async function selectExports(dialog,modes,editions) {
  await dialog.getByRole('checkbox',{name:'全文',exact:true}).check();
  for(const name of ['高清','EH','Pixiv','网页'])await dialog.getByRole('checkbox',{name,exact:true}).setChecked(modes.includes(name));
  for(const name of ['中文','英文','日文','无字'])await dialog.getByRole('checkbox',{name,exact:true}).setChecked(editions.includes(name));
}

test('离线动画只在可见时载入播放，离开暂停；画面点击无暂停且无控件',async t=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  await page.addInitScript(()=>{
    HTMLMediaElement.prototype.play=function(){this.dataset.state='playing';return Promise.resolve();};
    HTMLMediaElement.prototype.pause=function(){this.dataset.state='paused';};
  });
  await page.goto('about:blank');
  const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1600"><rect width="768" height="1600" fill="green"/></svg>');
  await page.setContent(finishedReaderHead()+finishedReaderFigure(svg,1,768,1600)+finishedReaderAnimation('data:video/mp4;base64,AAAA',2,768,1024)+finishedReaderTail);
  assert.equal(await page.locator('video').getAttribute('src'),null);
  assert.equal(await page.locator('video').getAttribute('controls'),null);
  await page.locator('video').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('video').dataset.state==='playing');
  const bounds=await page.locator('video').boundingBox();await page.mouse.click(bounds.x+100,Math.max(30,bounds.y+100));
  assert.equal(await page.locator('video').getAttribute('data-state'),'playing');
  await page.locator('.finished-reader').evaluate(el=>el.scrollTo(0,0));
  await page.waitForFunction(()=>document.querySelector('video').dataset.state==='paused');
});

test('WebP阅读原图按需载入，失败保留小图且可重试',async t=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});t.after(()=>browser.close());
  const page=await browser.newPage(),requests=[];
  let fail=true,smallFail=false;
  await page.route('https://media.test/**',route=>{
    requests.push(route.request().url());
    if(route.request().url().endsWith('/small-failure.webp')&&smallFail)return route.fulfill({status:503,body:'unavailable'});
    if(route.request().url().endsWith('/original.webp')&&fail)return route.fulfill({status:503,body:'unavailable'});
    return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="green"/></svg>'});
  });
  await page.setContent(finishedReaderDocument([{src:'https://media.test/small.webp',original_src:'https://media.test/original.webp',media_kind:'image',number:1,width:640,height:480}]));
  await page.locator('img').waitFor();
  assert.equal(requests.some(url=>url.endsWith('/original.webp')),false);
  await page.getByRole('button',{name:'查看原图',exact:true}).click();
  await page.getByRole('button',{name:'原图加载失败，重试',exact:true}).waitFor();
  assert.match(await page.locator('img').getAttribute('src'),/small.webp$/);assert.equal(await page.locator('img').isVisible(),true);
  fail=false;await page.getByRole('button',{name:'原图加载失败，重试',exact:true}).click();
  await page.getByRole('button',{name:'返回动图预览',exact:true}).waitFor();
  assert.match(await page.locator('img').getAttribute('src'),/original.webp$/);assert.equal(await page.locator('video').count(),0);
  await page.getByRole('button',{name:'返回动图预览',exact:true}).click();
  assert.match(await page.locator('img').getAttribute('src'),/small.webp$/);
  smallFail=true;
  await page.setContent(finishedReaderDocument([{src:'https://media.test/small-failure.webp',original_src:'https://media.test/original.webp',media_kind:'image',number:1,width:640,height:480}]));
  await page.locator('.reader-placeholder').waitFor();
  await page.getByRole('button',{name:'查看原图',exact:true}).click();
  await page.getByRole('button',{name:'返回动图预览',exact:true}).waitFor();
  assert.equal(await page.locator('img').isVisible(),true);assert.equal(await page.locator('.reader-placeholder').count(),0);
});

test('正式渲染的横竖屏、译文和分镜均沿用竖屏短边字号',async t=>{
  const distRoot=path.join(testAppRoot,'dist');
  const server=createServer((request,response)=>void serveProductionAsset(response,new URL(request.url,'http://local'),distRoot));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/finished-render.html`);
  await page.waitForFunction(()=>Boolean(window.renderFinishedLettering));
  const settings={...defaultLetteringSettings(),font_size:28};
  const source=[{id:'dialogue-123456789abc',mode:'speech',speaker:'npc',text:'你好'},{id:'dialogue-223456789abc',mode:'heart',text:'喜爱'},{id:'dialogue-323456789abc',mode:'narration',text:'旁白'}];
  const items=[{dialogue_id:source[0].id,box:{x:.1,y:.1,w:.7,h:.2}},{dialogue_id:source[1].id,box:{x:.1,y:.4,w:.5,h:.2},heart:{font_size:48,rotation:0,seed:123}}];
  for(const locale of ['zh','en']){
    let baseline;
    for(const comic of [false,true])for(const [canvas,width,height] of [['3:4',768,1024],['4:3',1024,768],['1:1',768,768]]){
      await page.setViewportSize({width,height});
      const frame={x:.05,y:.05,w:.6,h:.8};
      const lettering={settings,items,locale,source_dialogue:source,dialogue:locale==='zh'?source:source.map((line,index)=>({...line,text:['Hi','Love','Caption'][index]})),canvas:comic?`${width*frame.w}:${height*frame.h}`:canvas};
      const value=comic?{page_kind:'comic',canvas,panels:[{page_id:'page-001',frame,lettering}]}:lettering;
      const result=await page.evaluate(async value=>{
        const diagnostics=await window.renderFinishedLettering(value,true);
        const heart=document.querySelector('[data-lettering-kind="heart"]').getBoundingClientRect();
        const balloon=document.querySelector('[data-dialogue-id="dialogue-123456789abc"]').getBoundingClientRect();
        return {blockers:diagnostics.blockers,font:parseFloat(getComputedStyle(document.querySelector('.lettering-text')).fontSize),narration:parseFloat(getComputedStyle(document.querySelector('.narration-bar__text')).fontSize),heartWidth:heart.width,heartHeight:heart.height,balloonWidth:balloon.width,balloonHeight:balloon.height};
      },value);
      assert.deepEqual(result.blockers,[],`${locale} ${canvas} comic=${comic}`);
      baseline??=result;
      assert.ok(Math.abs(result.font-28*768/1024)<.05);
      for(const key of ['font','narration','heartWidth','heartHeight','balloonWidth','balloonHeight'])assert.ok(Math.abs(result[key]-baseline[key])<.2,`${locale} ${canvas} comic=${comic} ${key} 保持一致`);
    }
  }
});

test("正式嵌字使用浏览器共享排版，输出保持尺寸且无字时保留底图像素", async t => {
  const distRoot = path.join(testAppRoot,'dist');
  const server = createServer((request, response) => void serveProductionAsset(response, new URL(request.url, "http://local"), distRoot));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const clean = await sharp({ create: { width: 512, height: 768, channels: 3, background: "#80b0a0" } }).png().toBuffer();
  const lettering = { dialogue: [], items: [], settings: defaultLetteringSettings(), canvas: "2:3" };
  const empty = await renderFinishedImage(clean, lettering, origin);
  assert.deepEqual(await sharp(empty).removeAlpha().raw().toBuffer(), await sharp(clean).raw().toBuffer());
  lettering.dialogue = [{ id: "dialogue-123456789abc", mode: "narration", text: "阳光照进房间" }, { id: "dialogue-223456789abc", mode: "heart", text: "喜欢你" }, { id: "dialogue-323456789abc", mode: "speech", speaker: "npc", text: "早上好" }];
  const image = await renderFinishedImage(clean, lettering, origin);
  const info = await sharp(image).metadata();
  assert.equal(info.width, 512); assert.equal(info.height, 768);
  assert.notEqual(hashCanonicalJson([...image]), hashCanonicalJson([...empty]));
});

test('四版导出界面独立检查、手机可选择版本、实际下载无字 ZIP',async t=>{
  const f=await fixture(t);await f.run(await f.prepare());
  const warning='GIF 超过 16 MB，发布前请检查平台文件限制';
  const record=await readFinishedRecord(f.directory,key.page_id);
  await json(path.join(f.directory,'finished',`${key.page_id}.json`),{...record,warnings:[warning]});
  await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'text'});
  const server=await createStoryCanvasServer({projectRoot:f.root,appRoot:testAppRoot,production:true,localConfig:{comfyui_urls:[]},hardwareStatusReader:async()=>({cpu:{available:false},memory:{available:false},gpu:{available:false},comfyui:{connected:false,status:'offline'}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{}),downloadsPath:path.join(f.root,'downloads')});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=finished`);
  await page.getByRole('button',{name:'导出',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'导出成品',exact:true});
  assert.equal(await dialog.getByLabel('保存方式').count(),0);
  assert.equal(await dialog.locator('input:checked').count(),0,'默认所有范围、用途和版本不勾选');
  for(const name of ['浏览器下载','批量保存'])assert.equal(await dialog.getByRole('button',{name,exact:true}).isDisabled(),true);
  await selectExports(dialog,['高清'],['中文']);
  await dialog.getByText('部分所选版本尚未就绪，请处理后再导出。').waitFor();
  for(const name of ['浏览器下载','批量保存'])assert.equal(await dialog.getByRole('button',{name,exact:true}).isDisabled(),true);
  await selectExports(dialog,['高清'],['无字']);
  await dialog.getByText(/无字版去掉嵌字/).waitFor();
  assert.equal(await dialog.getByText(`第 1 页 · ${warning}`,{exact:true}).count(),0);
  await page.waitForFunction(()=>!document.querySelector('[role="dialog"] button.button--primary')?.disabled);
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:1000});
    for(const name of ['无字','网页']){
      const bounds=await dialog.getByRole('checkbox',{name,exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    }
    for(const name of ['浏览器下载','批量保存']){
      const bounds=await dialog.getByRole('button',{name,exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=1000);
    }
  }
  const downloaded=page.waitForEvent('download');await dialog.getByRole('button',{name:'浏览器下载',exact:true}).click();
  const download=await downloaded;assert.match(download.suggestedFilename(),/全文-无字-高清\.zip$/);assert.match(download.url(),/\/finished\/export\?ticket=/);
  const file=path.join(f.root,'finished-clean.zip');await download.saveAs(file);
  const zip=await readFile(file);assert.equal(zip.readUInt32LE(0),0x04034b50);assert.ok(zip.includes(Buffer.from('001.png')));assert.ok(!zip.includes(Buffer.from('002.png')));assert.ok(!zip.includes(Buffer.from('发布提示.txt')));
  await page.getByRole('button',{name:'导出',exact:true}).click();
  await selectExports(dialog,['Pixiv'],['无字']);
  await dialog.getByRole('button',{name:'浏览器下载',exact:true}).click();
  const summary=page.getByRole('dialog',{name:'导出清单',exact:true});await summary.waitFor();
  assert.match(await summary.innerText(),/静态卷 1.*1 张/);
  const nextDownload=page.waitForEvent('download');await summary.getByRole('button',{name:'开始下载',exact:true}).click();
  const pixiv=await nextDownload;assert.match(pixiv.suggestedFilename(),/无字-Pixiv\.zip$/);
  const pixivFile=path.join(f.root,'pixiv-clean.zip');await pixiv.saveAs(pixivFile);assert.ok((await readFile(pixivFile)).includes(Buffer.from('静态投稿/01-001-001/001.jpg')));
  await page.getByRole('button',{name:'导出',exact:true}).click();
  await selectExports(dialog,['高清','网页'],['无字']);
  const multiple=[];const collect=d=>multiple.push(d);page.on('download',collect);
  await dialog.getByRole('button',{name:'浏览器下载',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.finished-options a[download]').length===2);
  for(let i=0;i<50&&multiple.length<2;i++)await new Promise(resolve=>setTimeout(resolve,100));
  page.off('download',collect);assert.equal(multiple.length,2);
  for(const item of multiple)assert.equal(await item.failure(),null);
  assert.ok(multiple.some(d=>d.suggestedFilename().endsWith('全文-无字-网页.html')));
  await page.getByRole('button',{name:'导出',exact:true}).click();
  assert.equal(await dialog.getByRole('checkbox',{name:'网页',exact:true}).isChecked(),true,'两种保存操作共用并保留选择');
  await dialog.getByRole('button',{name:'批量保存',exact:true}).click();
  await page.getByRole('button',{name:'复制目录',exact:true}).waitFor();
  const directory=await page.locator('.finished-options code').innerText();
  assert.ok(directory.startsWith(path.join(f.directory,'Outputs','exports')));
  for(const [folder,extension] of [['高清','zip'],['网页','html']])assert.ok((await stat(path.join(directory,`成品测试-全文-无字-${folder}.${extension}`))).size>0);
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=project-settings`);
  await page.getByLabel('作品名称 · 中文（可选）',{exact:true}).fill('完整作品名称');
  await page.getByLabel('作品名称 · 英文（可选）',{exact:true}).fill('Full Work Title');
  await page.getByLabel('作品名称 · 日文（可选）',{exact:true}).fill('作品タイトル');
  await page.getByRole('button',{name:'保存基础设置',exact:true}).click();
  await page.getByRole('button',{name:'保存基础设置',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-project-fact-dirty="true"]')===null);
  await page.reload();assert.equal(await page.getByLabel('作品名称 · 英文（可选）',{exact:true}).inputValue(),'Full Work Title');
  assert.equal(await page.getByLabel('项目名称',{exact:true}).inputValue(),'成品测试');
});

test('大成品 ZIP 直接下载到磁盘，在受限网页堆内存下保持页面可用',async t=>{
  const f=await fixture(t);await f.run(await f.prepare());
  const record=await readFinishedRecord(f.directory,key.page_id);
  // 隔离成品尾部填充，模拟远大于网页堆上限的媒体；不制造真实项目文件。
  const mediaSize=128*1024*1024;
  await truncate(path.join(f.directory,record.outputs.lettered),mediaSize);
  const server=await createStoryCanvasServer({projectRoot:f.root,appRoot:testAppRoot,production:true,localConfig:{comfyui_urls:[]},hardwareStatusReader:async()=>({cpu:{available:false},memory:{available:false},gpu:{available:false},comfyui:{connected:false,status:'offline'}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),args:['--js-flags=--max-old-space-size=64'],downloadsPath:path.join(f.root,'downloads')});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage();
  // 若回退成 fetch 整包或 Blob 下载，立即失败，避免测试本身拖垮浏览器。
  await page.addInitScript(()=>{
    const fetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await fetch(...args);
      if(response.headers.get('content-type')?.includes('application/zip'))throw new Error('ZIP 不应进入网页 fetch');
      return response;
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=finished`);
  await page.getByRole('button',{name:'导出',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'导出成品',exact:true});
  await selectExports(dialog,['高清'],['中文']);
  const downloading=page.waitForEvent('download');await dialog.getByRole('button',{name:'浏览器下载',exact:true}).click();
  const download=await downloading;assert.match(download.url(),/\/finished\/export\?ticket=/);assert.match(download.suggestedFilename(),/中文-高清\.zip$/);
  const target=path.join(f.root,'large.zip');await download.saveAs(target);assert.equal(await download.failure(),null);
  const size=(await stat(target)).size;assert.ok(size>mediaSize);
  const file=await open(target,'r');
  try{
    const head=Buffer.alloc(4),tail=Buffer.alloc(65536);await file.read(head,0,4,0);await file.read(tail,0,tail.length,size-tail.length);
    assert.equal(head.readUInt32LE(),0x04034b50);assert.ok(tail.includes(Buffer.from('001.png')));assert.ok(tail.includes(Buffer.from([0x50,0x4b,0x05,0x06])),'中央目录写入完成');
  }finally{await file.close();}
  await page.getByRole('button',{name:'导出',exact:true}).click();await dialog.waitFor();
});

test("浏览器成品导航、返回编辑与输出按钮可用", async t => {
  const f = await fixture(t);
  const narrativePath = path.join(f.directory, `pages/${key.page_id}.content.json`);
  const narrative = JSON.parse(await readFile(narrativePath, "utf8"));
  await json(narrativePath, { ...narrative, dialogue: [
    { id: "dialogue-123456789abc", mode: "narration", text: "阳光照进房间" },
    { id: "dialogue-223456789abc", mode: "heart", text: "喜欢你" },
    { id: "dialogue-323456789abc", mode: "speech", speaker: "npc", text: "早上好" },
  ] });
  await writeFile(f.file, await sharp({ create: { width: 1280, height: 1920, channels: 3, background: "#80b0a0" } }).png().toBuffer());
  await f.run(await f.prepare(), { upscale: source => sharp(source).resize(2560, 3840).png().toBuffer() });
  const secondKey = { ...key, page_id: "page-002" };
  for (const suffix of ["content", "prompt"]) await writeFile(path.join(f.directory, `pages/page-002.${suffix}.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.${suffix}.json`)));
  await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [key, secondKey].map(key => ({ page_id: key.page_id, owner_kind: "story", sequence_id: "sequence" })) });
  const secondFile = path.join(f.directory, candidateFileRelativePath(secondKey, candidateId));
  await cp(path.dirname(f.file), path.dirname(secondFile), { recursive: true });
  await f.run((await f.operations.mutateDerived("demo", () => prepareFinishedPage(f.root, "demo", f.directory, { page_key: secondKey, candidate_id: candidateId }))).value, { upscale: source => sharp(source).resize(2560, 3840).png().toBuffer() });
  const nextCandidate = "candidate-22222222-2222-4222-8222-222222222222";
  const nextFile = path.join(f.directory, candidateFileRelativePath(key, nextCandidate));
  await cp(path.dirname(f.file), path.dirname(nextFile), { recursive: true });
  await json(nextFile.replace("image.png", "result.json"), { version: 1, status: "available", page_key: key, candidate_id: nextCandidate, file: candidateFileRelativePath(key, nextCandidate), seed: 5678, task_id: "render-20260826T010203Z" });
  let releaseOutput;
  const outputGate = new Promise(resolve => { releaseOutput = resolve; });
  let rendering;
  const renderingStarted = new Promise(resolve => { rendering = resolve; });
  const running = f.run(await f.prepare(), { render: async clean => { rendering(); await outputGate; return clean; } });
  t.after(async () => { releaseOutput(); await running; });
  await renderingStarted;
  const server = await createStoryCanvasServer({ projectRoot: f.root, appRoot: testAppRoot, production: true, localConfig: { comfyui_urls: [] }, hardwareStatusReader: async () => ({ cpu: { available: false }, memory: { available: false }, gpu: { available: false }, comfyui: { connected: false, status: "offline" } }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=finished`);
  try { await page.getByRole("heading", { name: "成品", exact: true }).waitFor({ timeout: 10000 }); }
  catch (error) { t.diagnostic(await page.locator("body").innerText()); t.diagnostic(JSON.stringify(errors)); throw error; }
  await page.locator(".task-status-menu summary").click();
  const activeTask = page.locator(".task-card--running");
  await activeTask.getByText(/正在嵌字/).waitFor();
  assert.equal(await activeTask.getByRole("button", { name: "暂停", exact: true }).count(), 0);
  await activeTask.locator(".task-card__open").click();
  await page.getByRole("dialog").getByText(/正在嵌字/).waitFor();
  await page.keyboard.press("Escape");
  releaseOutput(); const completed = await running;
  await page.getByRole("button", { name: "刷新成品状态", exact: true }).click();
  await page.waitForFunction(id => document.querySelector(".finished-card img")?.getAttribute("src")?.includes(id), completed.id);
  assert.match(await page.locator(".finished-card img").first().getAttribute("src"), /lettered.png(?:\?|$)/);
  assert.equal(await page.getByRole("button", { name: "查看无字版", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "重新输出", exact: true }).count(), 0);
  assert.equal(await page.locator(".finished-page-link").first().getAttribute("title"), "第一章 / 片段 / 测试页");
  await page.locator(".finished-image").first().click();
  await page.getByRole("dialog", { name: "001 嵌字版" }).waitFor();
  const variantSrc = await page.locator(".image-lightbox img").getAttribute("src");
  assert.equal(new URL(variantSrc, page.url()).search, "?w=1024", "灯箱默认加载压缩变体");
  const variantResponse = await page.request.get(new URL(variantSrc, page.url()).href);
  assert.equal(variantResponse.headers()["content-type"], "image/webp");
  await page.getByRole("button", { name: "查看原图", exact: true }).click();
  await page.getByRole("button", { name: "已显示原图", exact: true }).waitFor();
  const originalSrc = await page.locator(".image-lightbox img").getAttribute("src");
  assert.equal(new URL(originalSrc, page.url()).search, "");
  const originalResponse = await page.request.get(new URL(originalSrc, page.url()).href);
  const originalRecord = JSON.parse(await readFile(path.join(f.directory, "finished/page-001.json"), "utf8"));
  assert.deepEqual(await originalResponse.body(), await readFile(path.join(f.directory, originalRecord.outputs.lettered)), "大图接口应逐字节返回原始 PNG");
  await page.getByRole("button", { name: "已显示原图", exact: true }).click();
  await page.waitForFunction(src => document.querySelector(".image-lightbox img")?.getAttribute("src") === src, variantSrc);
  await page.getByRole("button", { name: "查看原图", exact: true }).waitFor();
  await page.locator(".image-lightbox img").evaluate(img => img.decode());
  await page.getByRole("button", { name: "原始大小（1:1）", exact: true }).click();
  await page.waitForFunction(() => {
    const img = document.querySelector(".image-lightbox img");
    return img?.getBoundingClientRect().width === img?.naturalWidth && img?.getBoundingClientRect().height === img?.naturalHeight;
  });
  assert.equal(await page.locator(".image-lightbox output").innerText(), "100%");
  await page.getByRole("button", { name: "适合窗口", exact: true }).click();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.locator(".image-lightbox img").evaluate(img => img.decode());
    const image = await page.locator(".image-lightbox img").boundingBox();
    const stage = await page.locator(".image-lightbox__media").boundingBox();
    assert.ok(image.x >= stage.x - 1 && image.y >= stage.y - 1 && image.x + image.width <= stage.x + stage.width + 1 && image.y + image.height <= stage.y + stage.height + 1, "完整大图应适合可用区域");
    assert.ok(Math.abs(image.width / image.height - 2 / 3) < 0.01);
  }
  await page.getByRole("button", { name: "下一张", exact: true }).click();
  await page.getByRole("dialog", { name: "002 嵌字版" }).waitFor();
  await page.getByRole("button", { name: "上一张", exact: true }).click();
  await page.getByRole("dialog", { name: "001 嵌字版" }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".image-lightbox__media").click({ position: { x: 5, y: 5 } });
  assert.equal(await page.locator(".image-lightbox").count(), 0);
  await page.locator(".finished-image").first().click();
  await page.getByRole("button", { name: "放大图片" }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("dialog", { name: "002 嵌字版" }).waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector(".image-lightbox img").getBoundingClientRect();
    const stage = document.querySelector(".image-lightbox__media").getBoundingClientRect();
    return img.width <= stage.width + 1 && img.height <= stage.height + 1;
  });
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("dialog", { name: "002 嵌字版" }).count(), 1);
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("dialog", { name: "001 嵌字版" }).waitFor();
  await page.keyboard.press("Escape");
  // 阅读预览使用与离线 HTML 相同的文档，水平模式接受纵向鼠标滚轮。
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByRole("button", { name: "阅读预览", exact: true }).click();
  const readerFrame = page.frameLocator('iframe[title="成品连续阅读"]');
  await readerFrame.getByRole("button", { name: "阅读工具", exact: true }).click();
  await readerFrame.getByRole("switch", { name: "水平阅读", exact: true }).click();
  const reader = readerFrame.locator(".finished-reader");
  await reader.locator("img").first().evaluate(img => img.decode());
  await reader.hover();
  await page.mouse.wheel(0, 900);
  await readerFrame.getByLabel("当前页码").filter({ hasText: /^2$/ }).waitFor({ state: "attached" });
  assert.ok(await reader.evaluate(element => element.scrollLeft > 0 && element.scrollTop === 0));
  assert.equal(await reader.locator("figcaption, h1, h2").count(), 0, "阅读区仅显示图片");
  await readerFrame.getByRole("switch", { name: "水平阅读", exact: true }).click();
  await readerFrame.getByLabel("当前页码").filter({ hasText: /^2$/ }).waitFor({ state: "attached" });
  assert.ok(await reader.evaluate(element => element.scrollTop > 0 && element.scrollLeft === 0));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "阅读预览", exact: true }).waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".finished-card img").first().evaluate(img => img.decode());
  await mkdir(fileURLToPath(new URL("../../runtime/", import.meta.url)), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../../runtime/finished-ui.png", import.meta.url)) });
  await page.locator(".finished-page-link").first().click();
  const output = page.getByRole("button", { name: "输出成品", exact: true });
  await output.waitFor();
  assert.equal(await output.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "查看成品", exact: true }).count(), 0);
  const bounds = await output.boundingBox();
  assert.ok(bounds.y + bounds.height <= 1000, "输出按钮应在当前页面可见区域内");
  await page.getByRole("tab", { name: "嵌字", exact: true }).click();
  await page.getByLabel("旁白", { exact: true }).fill("尚未保存的旁白");
  await page.locator(".current-image__lettering-target .heart-lettering").waitFor();
  const normalizedBoxes = selector => page.locator(selector).evaluate(overlay => {
    const host = overlay.getBoundingClientRect();
    return [...overlay.querySelectorAll(".lettering-object")].map(item => {
      const rect = item.getBoundingClientRect();
      return [(rect.x - host.x) / host.width, (rect.y - host.y) / host.height, rect.width / host.width, rect.height / host.height];
    });
  });
  const expectedBoxes = await normalizedBoxes(".current-image__lettering-target .lettering-overlay");
  await page.getByTitle("点击放大查看", { exact: true }).click();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.locator(".image-lightbox__lettering .heart-lettering").waitFor();
    await page.locator(".image-lightbox__lettering").getByText("尚未保存的旁白", { exact: true }).waitFor();
    await page.getByRole("button", { name: "原始大小（1:1）", exact: true }).click();
    const boxes = await normalizedBoxes(".image-lightbox__lettering .lettering-overlay");
    assert.equal(boxes.length, expectedBoxes.length);
    boxes.forEach((box, index) => box.forEach((value, axis) => assert.ok(Math.abs(value - expectedBoxes[index][axis]) < 0.005, "大图文案相对位置与编辑预览一致")));
    const image = await page.locator(".image-lightbox img").boundingBox();
    const overlay = await page.locator(".image-lightbox__lettering").boundingBox();
    assert.deepEqual(overlay, image, "文字层必须与原图边界完全重合");
    await page.getByRole("button", { name: "适合窗口", exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const candidateSrc = await page.locator(".image-lightbox img").getAttribute("src");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(src => document.querySelector(".image-lightbox img")?.getAttribute("src") !== src, candidateSrc);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(src => document.querySelector(".image-lightbox img")?.getAttribute("src") === src, candidateSrc);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: fileURLToPath(new URL("../../runtime/finished-editor-ui.png", import.meta.url)) });
  await page.reload();
  await page.getByRole("button", { name: "输出", exact: true }).click();
  await page.getByRole("button", { name: "成品", exact: true }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await selectExports(page.getByRole("dialog",{name:"导出成品",exact:true}),["高清"],["中文"]);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "浏览器下载", exact: true }).click();
  assert.match((await download).suggestedFilename(), /高清.zip$/);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await selectExports(page.getByRole("dialog",{name:"导出成品",exact:true}),["网页"],["中文"]);
  const htmlDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "浏览器下载", exact: true }).click();
  const offline = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  await offline.context().setOffline(true);
  await offline.setContent(await readFile(await (await htmlDownload).path(), "utf8"));
  await offline.locator("img").evaluateAll(images => Promise.all(images.map(img => img.decode())));
  assert.equal(await offline.locator("img").count(), 2);
  await offline.getByRole("button", { name: "阅读工具", exact: true }).click();
  await offline.getByRole("switch", { name: "水平阅读", exact: true }).click();
  await offline.locator(".finished-reader").hover();
  await offline.mouse.wheel(0, 900);
  await offline.getByLabel("当前页码").filter({ hasText: /^2$/ }).waitFor({ state: "attached" });
  await offline.getByRole("switch", { name: "水平阅读", exact: true }).click();
  assert.ok(await offline.locator(".finished-reader").evaluate(element => element.scrollTop > 0));
  await offline.close();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator(".finished-toolbar").evaluate(element => element.getBoundingClientRect().right <= innerWidth), "手机工具栏不横向溢出");
  await page.screenshot({ path: fileURLToPath(new URL("../../runtime/finished-mobile-ui.png", import.meta.url)) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const point of [{ x: 420, y: 410 }, { x: 670, y: 520 }, { x: 1430, y: 990 }]) {
    await page.locator(".finished-image").first().evaluate((element, point) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: point.x, clientY: point.y })), point);
    const menu = page.getByRole("menu", { name: "成品 001" });
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert.ok(Math.abs(bounds.x - Math.max(8, Math.min(point.x, 1440 - bounds.width - 8))) <= 1, `菜单横坐标应跟随指针：${JSON.stringify(bounds)}`);
    assert.ok(Math.abs(bounds.y - Math.max(8, Math.min(point.y, 1000 - bounds.height - 8))) <= 1, `菜单纵坐标应跟随指针：${JSON.stringify(bounds)}`);
    await page.keyboard.press("Escape");
  }
  await page.locator(".finished-image").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除成品", exact: true }).click();
  await page.getByRole("dialog", { name: "删除成品 001" }).getByRole("button", { name: "删除成品", exact: true }).click();
  await page.locator(".finished-card").first().getByText("尚未制作", { exact: true }).first().waitFor();
  assert.equal(await page.locator(".finished-card").first().getByRole("heading").innerText(), "001");
  assert.equal(await page.locator(".finished-card").first().locator("img").count(), 0);
  assert.deepEqual(errors, []);
});


test('导出范围默认不选，多章合并且全文互斥，下载与本机保存共用范围',async t=>{
  const f=await fixture(t),outlineFile=path.join(f.directory,'story/outline.json'),outline=JSON.parse(await readFile(outlineFile,'utf8'));
  outline.chapters.push({id:'second',title:'第二章',summary:'测试',sequences:[{id:'seq-two',title:'第二段',summary:'测试'}]},{id:'third',title:'第三章',summary:'测试',sequences:[{id:'seq-three',title:'第三段',summary:'测试'}]});
  await json(outlineFile,outline);
  const second=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'seq-two'},{pageKind:'text'});
  await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'seq-three'},{pageKind:'text'});
  await f.run(await f.prepare());await f.run(await prepareFinishedPage(f.root,'demo',f.directory,{page_key:second.page_key}));
  const server=await createStoryCanvasServer({projectRoot:f.root,appRoot:testAppRoot,production:true,localConfig:{comfyui_urls:[]},hardwareStatusReader:async()=>({cpu:{available:false},memory:{available:false},gpu:{available:false},comfyui:{connected:false,status:'offline'}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:1000,height:900}});
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=finished`);
  await page.getByRole('button',{name:'导出',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'导出成品',exact:true}),checkbox=name=>dialog.getByRole('checkbox',{name,exact:true});
  assert.equal(await dialog.locator('input:checked').count(),0);
  await checkbox('网页').check();await checkbox('中文').check();
  assert.equal(await dialog.getByRole('button',{name:'浏览器下载',exact:true}).isDisabled(),true);
  await checkbox('全文').check();await checkbox('第二章').check();assert.equal(await checkbox('全文').isChecked(),false);
  await checkbox('第一章').check();
  for(const width of [1000,390]){
    await page.setViewportSize({width,height:900});
    const grids=await dialog.locator('fieldset').evaluateAll(els=>els.map(el=>getComputedStyle(el).display));assert.deepEqual(grids,['grid','grid','grid']);
    const bounds=await checkbox('第二章').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
  }
  const downloaded=page.waitForEvent('download');await dialog.getByRole('button',{name:'浏览器下载',exact:true}).click();
  const download=await downloaded;assert.match(download.suggestedFilename(),/第一章_第二章-中文-网页.html$/);
  const file=path.join(f.root,'combined.html');await download.saveAs(file);
  assert.deepEqual([...(await readFile(file,'utf8')).matchAll(/data-page="(\d+)"/g)].map(m=>m[1]),['1','2']);
  await page.getByRole('button',{name:'导出',exact:true}).click();
  assert.equal(await checkbox('第二章').isChecked(),true);
  await dialog.getByRole('button',{name:'批量保存',exact:true}).click();
  await page.getByRole('button',{name:'复制目录',exact:true}).waitFor();
  const directory=await page.locator('.finished-options code').innerText();assert.match(path.basename(directory),/^第一章_第二章-中文-网页-/);
  assert.ok((await stat(path.join(directory,download.suggestedFilename()))).size>0);
  await page.getByRole('button',{name:'导出',exact:true}).click();await checkbox('全文').check();
  assert.equal(await checkbox('第一章').isChecked(),false);assert.equal(await checkbox('第二章').isChecked(),false);
  await dialog.getByText('部分所选版本尚未就绪，请处理后再导出。').waitFor();
  await checkbox('全文').uncheck();assert.equal(await dialog.getByRole('button',{name:'批量保存',exact:true}).isDisabled(),true);
});
