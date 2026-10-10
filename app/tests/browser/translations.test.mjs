import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {fixture,key,json} from '../helpers/finished-fixture.mjs';
import {createStoryCanvasServer} from '../../server/index.mjs';
import {createCharacter} from '../../server/character-facts.mjs';
import {defaultLetteringSettings} from '../../server/lettering-settings.mjs';
import {inspectFinishedLettering,renderFinishedImage} from '../../server/finished-render.mjs';

test('工作台独立语言草稿、保存、外语横排、缺译留空；Agent 实际排版与输出同源',async t=>{
  const f=await fixture(t),contentFile=path.join(f.directory,'pages/page-001.content.json'),original=JSON.parse(await readFile(contentFile,'utf8'));
  await f.operations.mutateTargetFacts('demo',()=>createCharacter(f.root,'demo','sigrid',{name:'希格莉德'}));
  const lines=[{id:'dialogue-123456789abc',mode:'speech',speaker:'npc',text:'早上好'},{id:'dialogue-223456789abc',mode:'heart',text:'喜欢你'},{id:'dialogue-323456789abc',mode:'thought',speaker:'sigrid',text:'好安静'},{id:'dialogue-423456789abc',mode:'narration',text:'阳光照进房间'}];
  await json(contentFile,{...original,dialogue:lines});
  const settings=defaultLetteringSettings();settings.npc_speech.direction='vertical';await json(path.join(f.directory,'lettering/settings.json'),settings);
  const server=await createStoryCanvasServer({projectRoot:f.root,appRoot:fileURLToPath(new URL('../../',import.meta.url)),production:true,localConfig:{comfyui_urls:[]},hardwareStatusReader:async()=>({cpu:{available:false},memory:{available:false},gpu:{available:false},comfyui:{connected:false,status:'offline'}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  await page.goto(`${origin}/?project=demo&tab=story&page=${key.page_id}`);
  try{await page.getByRole('tab',{name:'嵌字',exact:true}).click();}catch(error){t.diagnostic(await page.locator('body').innerText());t.diagnostic(JSON.stringify(errors));throw error;}
  await page.getByLabel('嵌字语言',{exact:true}).selectOption('en');const first=page.getByLabel(`English译文 ${lines[0].id}`,{exact:true});await first.waitFor();
  assert.equal(await page.locator('[data-dialogue-id]').count(),0,'缺译不显示中文');
  await first.fill('Good morning.');await page.getByLabel(`English译文 ${lines[1].id}`,{exact:true}).fill('Love you.');await page.getByLabel(`English译文 ${lines[2].id}`,{exact:true}).fill('So quiet.');await page.getByLabel(`English译文 ${lines[3].id}`,{exact:true}).fill('Sunlight fills the room.');
  await page.getByLabel('嵌字语言',{exact:true}).selectOption('ja');await page.getByLabel(`日本語译文 ${lines[0].id}`,{exact:true}).fill('おはよう。');
  await page.getByLabel('嵌字语言',{exact:true}).selectOption('en');assert.equal(await first.inputValue(),'Good morning.');
  await page.waitForFunction(()=>document.querySelectorAll('[data-lettering-direction="horizontal"]').length===3);
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.workbench-page-editor')?.getAttribute('data-page-content-dirty')&&!document.querySelector('.workbench-page-editor')?.getAttribute('data-page-prompt-dirty'));
  await page.waitForFunction(async()=>{const r=await fetch('/api/projects/demo/workbench/translation/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:{page_id:'page-001'},locale:'en'})});const v=await r.json();return v.summary?.missing===0;});
  const document=JSON.parse(await readFile(path.join(f.directory,'pages/page-001.translations.json'),'utf8'));assert.equal(document.ja.dialogue[lines[0].id].text,'おはよう。');assert.deepEqual(JSON.parse(await readFile(contentFile,'utf8')).dialogue,lines);
  async function agentWrite(text){const route=`${origin}/api/projects/demo/workbench/translation/`;const read=await(await page.request.post(route+'read',{data:{page_key:key,locale:'en'}})).json();const response=await page.request.post(route+'save',{data:{page_key:key,locale:'en',entries:{[lines[0].id]:text},expected_source_sha256:read.expected_source_sha256,expected_translation_sha256:read.expected_translation_sha256}});assert.equal(response.status(),200);}
  await agentWrite('Morning!');await page.waitForFunction(id=>document.querySelector(`[aria-label="English译文 ${id}"]`)?.value==='Morning!',lines[0].id);
  await first.fill('My morning draft.');await agentWrite('Hello!');await page.waitForTimeout(3200);assert.equal(await first.inputValue(),'My morning draft.','Agent 写入不覆盖人类脏草稿');
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText(/English 保存失败，草稿已保留/).waitFor();assert.equal(await first.inputValue(),'My morning draft.');
  assert.equal(JSON.parse(await readFile(path.join(f.directory,'pages/page-001.translations.json'),'utf8')).en.dialogue[lines[0].id].text,'Hello!');
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();await page.waitForFunction(id=>document.querySelector(`[aria-label="English译文 ${id}"]`)?.value==='Hello!',lines[0].id);
  const folder=fileURLToPath(new URL('../../../Saved/Tests/multilingual-lettering',import.meta.url));await mkdir(folder,{recursive:true});await page.screenshot({path:path.join(folder,'workbench-en.png')});
  const lettering={locale:'ja',source_dialogue:lines,dialogue:lines.map((line,index)=>({...line,text:['おはよう。','好き。','静かだ。','陽光が部屋に差し込む。'][index]})),items:[],settings:{...settings,font_family:'SVTranslation'},canvas:'2:3'};
  const clean=await sharp({create:{width:1024,height:1536,channels:3,background:'#80b0a0'}}).png().toBuffer();
  const inspected=await inspectFinishedLettering(clean,lettering,origin);assert.ok(inspected.diagnostics.objects.length===3);assert.ok(inspected.diagnostics.objects.every(object=>Number.isFinite(object.box.w)));if(inspected.diagnostics.blockers.length)t.diagnostic(JSON.stringify(inspected.diagnostics));assert.deepEqual(inspected.diagnostics.blockers,[]);
  const rendered=await renderFinishedImage(clean,lettering,origin);assert.deepEqual(inspected.image,rendered,'检查图与成品使用相同渲染');
  await page.goto(`${origin}/?project=demo&tab=finished`);await page.getByLabel('嵌字语言',{exact:true}).selectOption('ja');await page.getByText('缺译 3 · 原文变化 0',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});
