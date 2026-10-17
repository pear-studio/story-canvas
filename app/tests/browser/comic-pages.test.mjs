import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {createServer as createHttpServer} from 'node:http';
import sharp from 'sharp';
import {serveProductionAsset} from '../../server/http-support.mjs';
import {inspectFinishedLettering} from '../../server/finished-render.mjs';
import {defaultLetteringSettings} from '../../server/lettering-settings.mjs';
let server,browser,origin;
before(async()=>{
 server=await createServer({cacheDir:'../Saved/Tests/vite-comic',root:fileURLToPath(new URL('../../',import.meta.url)),server:{host:'127.0.0.1',port:0},logLevel:'error'});
 await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
});
after(async()=>{await browser?.close();await server?.close();});
async function open(t,viewport={width:1440,height:1000},query=''){
 const page=await browser.newPage({viewport}),errors=[],saved=[],layouts=[],generations=[],details=[],deletes=[],removed={};
 page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
 await page.route('**/api/**',route=>route.fulfill({json:{}}));
 await page.route('**/workbench/reference-library',route=>route.fulfill({json:{entries:[],sha256:'refs'}}));
 await page.route('**/workbench/page-text-sources/*',route=>route.fulfill({json:{document:{},expected_sha256:'sources',expected_context_sha256:'context'}}));
 await page.route('**/comic-candidate-*.svg*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#8bb7ad"/></svg>'}));
 await page.route('**/workbench/page-media',route=>{const id=route.request().postDataJSON().page_key.page_id;return route.fulfill({json:{revision:'media',media:{candidates:[1,2].filter(index=>!removed[id]?.includes(index)).map(index=>({candidate_id:index===1?'candidate-11111111-1111-4111-8111-111111111111':'candidate-22222222-2222-4222-8222-222222222222',file:`image-${index}.png`,url:`/comic-candidate-${index}.svg`,task_id:'task',seed:index}))}}});});
 await page.route('**/workbench/candidate-detail',route=>{details.push(route.request().postDataJSON());return route.fulfill({json:{detail:{seed:42,generation:{prompt:{positive:'candidate detail',negative:''},models:[],loras:[]}}}});});
 await page.route('**/workbench/candidates',route=>{const request=route.request().postDataJSON();deletes.push(request);removed[request.page_key.page_id]=request.candidate_ids.map(id=>id.startsWith('candidate-111')?1:2);return route.fulfill({json:{deleted_candidate_ids:request.candidate_ids}});});
 await page.route('**/workbench/page-render-inspection',route=>route.fulfill({json:{inspection:{ready:true,blockers:[],audit:{status:'complete',errors:[],warnings:[]},generation_signature:'signature'}}}));
 await page.route('**/workbench/page-save',route=>{
   const request=route.request().postDataJSON();saved.push(request);
   return route.fulfill({headers:{'x-story-canvas-revision':'saved'},json:{content:request.content,prompt:request.prompt,content_sha256:`saved-content-${saved.length}`,prompt_sha256:`saved-prompt-${saved.length}`,prompt_context_sha256:'context',lettering:{page:request.page_key.page_id,items:request.lettering.items},layout_sha256:`layout-${saved.length}`}});
 });
 await page.route('**/comic/save',route=>{const request=route.request().postDataJSON();layouts.push(request);return route.fulfill({json:{document:request.document,sha256:`version-${layouts.length}`}});});
 await page.route('**/workbench/render',route=>{generations.push(route.request().postDataJSON());return route.fulfill({json:{task:{task_id:'test-generation'}}});});
 await page.goto(`${origin}/tests/browser/comic-pages.html${query}`);
 await page.getByRole('tab',{name:'分镜 1',exact:true}).waitFor();
 return {page,saved,layouts,generations,details,deletes};
}
test('切格保留各自画面、Prompt及文案草稿，保存整页提交所有修改',async t=>{
 const {page,saved}=await open(t);
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();
 await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).fill('第一格的新画面');
 await page.getByLabel('本页 Prompt',{exact:true}).filter({visible:true}).fill('first panel prompt draft');
 await page.getByRole('tab',{name:'分镜 2',exact:true}).click();
 await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).fill('第二格的新画面');
 await page.getByRole('tab',{name:'嵌字',exact:true}).filter({visible:true}).click();
 await page.getByLabel('第 1 条文案',{exact:true}).filter({visible:true}).fill('第二格的新对白');
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();
 assert.equal(await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).inputValue(),'第一格的新画面');
 assert.equal(await page.getByLabel('第 1 条文案',{exact:true}).filter({visible:true}).inputValue(),'对白 1');
 await page.getByRole('tab',{name:'整页',exact:true}).click();
 await page.getByRole('button',{name:'保存整页',exact:true}).click();
 await page.getByText('整页分镜已保存',{exact:true}).waitFor();
 assert.deepEqual(saved.map(value=>[value.page_key.page_id,value.content.scene_description]),[['page-001','第一格的新画面'],['page-002','第二格的新画面']]);
 assert.equal(saved[1].content.dialogue[0].text,'第二格的新对白');
 assert.equal(saved[0].prompt.text,'first panel prompt draft');
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();
 await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).fill('第一格再次修改');
 const savedAgain=page.waitForResponse(response=>response.url().endsWith('/page-save'));
 await page.keyboard.press('Control+s');await savedAgain;
 assert.equal(saved[2].expected_layout_sha256,'layout-2','其他格保存后的最新嵌字指纹广播回第一格');
});
test('整页点击选格，拖线不触发生成也不改变阅读顺序，跨格文字不裁切',async t=>{
 const {page,layouts,generations}=await open(t);
 await page.getByRole('button',{name:'选择分镜 2',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'整页',exact:true}).getAttribute('aria-selected'),'true');
 const divider=page.getByRole('button',{name:'调整上下分隔线'}),bounds=await divider.boundingBox();
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+70);await page.mouse.up();
 await page.getByRole('button',{name:'保存整页',exact:true}).click();
 await page.waitForTimeout(100);
 assert.equal(layouts.length,1);assert.ok(layouts[0].document.layout.ratio>.5);assert.deepEqual(layouts[0].document.order,['page-001','page-002']);assert.deepEqual(generations,[]);
 const sizes=await page.locator('.comic-lettering-target .lettering-text').evaluateAll(nodes=>nodes.map(node=>parseFloat(getComputedStyle(node).fontSize)));
 assert.ok(sizes.length>=2);assert.ok(Math.abs(sizes[0]-sizes[1])<.2,'字号不随格子大小变化');
 assert.equal(await page.locator('.comic-lettering-target .lettering-overlay').first().evaluate(node=>getComputedStyle(node).overflow),'visible');
 await page.getByRole('button',{name:'嵌字',exact:true}).click();
 await page.locator('.comic-lettering-target').getByRole('group',{name:/对白 1/}).click();
 assert.equal(await page.getByRole('tab',{name:'整页',exact:true}).getAttribute('aria-selected'),'true');
 const balloon=page.locator('.comic-lettering-target [data-dialogue-id="dialogue-000000000001"]'),box=await balloon.boundingBox(),canvas=await page.locator('.comic-canvas').boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,canvas.y+canvas.height*.85);await page.mouse.up();
 assert.ok(Number((await balloon.getAttribute('data-lettering-box')).split(',')[1])>1,'文字可拖出所属格子');
 await mkdir(fileURLToPath(new URL('../../../Saved/Agent/comic-pages/',import.meta.url)),{recursive:true});
 await page.screenshot({path:fileURLToPath(new URL('../../../Saved/Agent/comic-pages/desktop.png',import.meta.url)),fullPage:true});
});
test('窄屏仍可切换分镜和查看整页',async t=>{
 const {page}=await open(t,{width:420,height:900});
 await page.getByRole('button',{name:'保存整页',exact:true}).waitFor({state:'visible'});
 await page.getByRole('tab',{name:'分镜 2',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'分镜 2',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
 await page.getByRole('button',{name:'查看候选图，共 2 张'}).click();await page.getByRole('dialog',{name:'历史候选',exact:true}).waitFor();
 await page.getByRole('dialog',{name:'历史候选',exact:true}).getByRole('option',{name:'候选 Seed 2'}).click();await page.getByRole('button',{name:'用于整页',exact:true}).waitFor();await page.getByRole('button',{name:'关闭全屏图片'}).click();
});

test('左栏沿用单页宽度且可滚动，保存生成保留在右侧，滑条收在二级菜单',async t=>{
 const {page}=await open(t,{width:1440,height:680});
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();
 const editor=page.locator('.comic-panel-view:not([hidden]) .document-editor');
 const bounds=await editor.boundingBox();
 assert.ok(bounds.width>390&&bounds.width<800);
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.wheel(0,600);
 await page.waitForTimeout(100);assert.ok(await editor.evaluate(node=>node.scrollTop)>0,'鼠标位于左栏时可滚动');
 assert.equal(await editor.getByRole('button',{name:'保存',exact:true}).count(),0);
 assert.equal(await page.locator('.comic-panel-view:not([hidden]) .desktop-page-actions').getByRole('button',{name:'保存',exact:true}).count(),1);
 await page.getByRole('tab',{name:'整页',exact:true}).click();
 assert.equal(await page.locator('.comic-preview-column').getByRole('button',{name:'保存整页'}).count(),1);
 await page.getByLabel('横向取景',{exact:true}).waitFor({state:'hidden'});
 await page.getByText('裁切与版式设置',{exact:true}).click();await page.getByLabel('横向取景',{exact:true}).waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('.comic-options-panel')?.matches(':popover-open'));await page.keyboard.press('Escape');await page.getByLabel('横向取景',{exact:true}).waitFor({state:'hidden'});
});

test('拖图和滚轮裁切、分隔线双击复位，拖动手柄交换分镜并可放大预览',async t=>{
 const {page,layouts}=await open(t);
 const image=page.getByRole('button',{name:'选择分镜 1',exact:true}),box=await image.boundingBox();
 await image.locator('img').waitFor();
 await page.mouse.move(box.x+box.width*.4,box.y+box.height*.3);await page.mouse.wheel(0,-400);await page.waitForTimeout(80);
 await page.mouse.down();await page.mouse.move(box.x+box.width*.55,box.y+box.height*.4);await page.mouse.up();
 const divider=page.getByRole('button',{name:'调整上下分隔线'});await divider.focus();await page.keyboard.press('ArrowDown');await divider.dblclick();
 await page.getByRole('button',{name:'保存整页',exact:true}).click();await page.waitForTimeout(100);
 assert.equal(layouts[0].document.layout.ratio,.5);assert.ok(layouts[0].document.panels['page-001'].crop.zoom>1);assert.ok(layouts[0].document.panels['page-001'].crop.x<.5);
 const handle=await page.getByRole('button',{name:'拖动排序分镜 1'}).boundingBox(),tab2=await page.getByRole('tab',{name:'分镜 2',exact:true}).boundingBox();
 await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(tab2.x+tab2.width/2,tab2.y+tab2.height/2);await page.mouse.up();
 await page.getByRole('button',{name:'保存整页',exact:true}).click();await page.waitForTimeout(100);
 assert.deepEqual(layouts[1].document.order,['page-002','page-001']);assert.equal(layouts[1].document.layout.first.page_id,'page-002');
 await page.getByRole('button',{name:'全屏预览',exact:true}).click();const modal=page.getByRole('dialog',{name:'整页放大预览'});await modal.waitFor();
 assert.equal(await modal.locator('.zoomable-image-stage').count(),1);await modal.getByRole('button',{name:'放大图片',exact:true}).click();await modal.getByRole('button',{name:'原始大小（1:1）',exact:true}).click();
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});assert.equal(await page.locator('.comic-canvas').count(),1);
});
test('分镜复用普通候选：右键详情、用于整页、历史、迭代和删除均保留',async t=>{
 const {page,layouts,details,deletes}=await open(t);
 await page.route('**/render-profile?*',route=>route.fulfill({json:{render_profiles:[{id:'qwen-image-2-1',inspection:{project_override:{blocked:false},style_loras:{}}}]}}));
 await page.getByRole('tab',{name:'分镜 2',exact:true}).click();
 const panel=page.locator('.comic-panel-view:not([hidden])');
 await panel.getByRole('option',{name:'候选 Seed 2'}).waitFor();
 await panel.getByRole('option',{name:'候选 Seed 2'}).click({button:'right'});
 for(const name of ['生成详情','复制候选图 ID','复制 Seed','删除候选','删除其他候选','迭代…','用于整页'])assert.equal(await page.getByRole('menuitem',{name,exact:true}).isEnabled(),true);
 await page.getByRole('menuitem',{name:'生成详情',exact:true}).click();
 const detail=page.getByRole('dialog',{name:'候选生成详情',exact:true});await detail.getByText('candidate detail',{exact:true}).waitFor();assert.equal(details[0].page_key.page_id,'page-002');await detail.getByRole('button',{name:'关闭',exact:true}).click();
 await panel.getByRole('option',{name:'候选 Seed 2'}).click({button:'right'});await page.getByRole('menuitem',{name:'用于整页',exact:true}).click();
 const layoutSaved=page.waitForResponse(response=>response.url().endsWith('/comic/save'));await page.keyboard.press('Control+s');await layoutSaved;
 assert.equal(layouts[0].document.panels['page-002'].candidate_id,'candidate-22222222-2222-4222-8222-222222222222');
 await panel.getByRole('button',{name:'打开历史候选，共 2 张'}).click();await page.getByRole('dialog',{name:'历史候选',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
 await panel.getByRole('option',{name:'候选 Seed 1'}).click({button:'right'});await page.getByRole('menuitem',{name:'迭代…',exact:true}).click();const iteration=page.getByRole('dialog',{name:'迭代候选图',exact:true});await iteration.waitFor();await iteration.getByRole('button',{name:'关闭',exact:true}).click();
 await panel.getByRole('option',{name:'候选 Seed 1'}).click({button:'right'});await page.getByRole('menuitem',{name:'删除候选',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
 await panel.getByRole('button',{name:'打开历史候选，共 1 张'}).waitFor();assert.equal(deletes[0].page_key.page_id,'page-002');
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();await page.locator('.comic-panel-view:not([hidden])').getByRole('button',{name:'打开历史候选，共 2 张'}).waitFor();
});

test('快捷键只保存或生成当前分镜；切回整页保留未保存草稿和选图',async t=>{
 const {page,saved,generations}=await open(t);
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).fill('第一格保留草稿');
 await page.getByRole('tab',{name:'分镜 2',exact:true}).click();await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).fill('第二格保存');await page.keyboard.press('Control+s');
 await page.waitForTimeout(120);assert.deepEqual(saved.map(value=>value.page_key.page_id),['page-002']);
 const generate=page.locator('.comic-panel-view:not([hidden]) .desktop-page-actions .generate-split__action');await generate.waitFor();await page.waitForFunction(()=>!document.querySelector('.comic-panel-view:not([hidden]) .desktop-page-actions .generate-split__action')?.disabled);
 await page.keyboard.press('Control+g');await page.waitForTimeout(180);assert.deepEqual(generations.map(value=>value.page_key.page_id),['page-002']);
 await page.getByRole('tab',{name:'整页',exact:true}).click();await page.keyboard.press('Control+g');await page.waitForTimeout(100);assert.equal(generations.length,1);
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();assert.equal(await page.getByLabel('画面内容',{exact:true}).filter({visible:true}).inputValue(),'第一格保留草稿');
});

test('版式与嵌字切换真实控件，布局和文案均可撤销重做',async t=>{
 const {page}=await open(t);
 await page.getByRole('button',{name:'嵌字',exact:true}).click();
 await page.locator('.comic-lettering-editor').getByLabel('第 1 条文案',{exact:true}).fill('整体编辑修改');
 await page.locator('.comic-lettering-editor').getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('.comic-lettering-editor').getByLabel('第 1 条文案',{exact:true}).inputValue(),'对白 1');
 await page.keyboard.press('Control+Shift+Z');assert.equal(await page.locator('.comic-lettering-editor').getByLabel('第 1 条文案',{exact:true}).inputValue(),'整体编辑修改');
 assert.equal(await page.getByRole('button',{name:'调整上下分隔线'}).count(),0);
 await page.getByRole('button',{name:'版式 / 裁切',exact:true}).click();await page.getByRole('button',{name:'调整上下分隔线'}).waitFor();assert.equal(await page.locator('.comic-lettering-target .is-selected').count(),0);
 await page.getByText('裁切与版式设置',{exact:true}).click();const gap=page.getByLabel('格间距',{exact:true});await gap.focus();await gap.press('ArrowRight');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'撤销布局',exact:true}).click();await page.getByText('裁切与版式设置',{exact:true}).click();assert.equal(await gap.inputValue(),'12');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'重做布局',exact:true}).click();await page.getByText('裁切与版式设置',{exact:true}).click();assert.equal(await gap.inputValue(),'13');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'放弃修改',exact:true}).filter({visible:true}).click();assert.equal(await page.locator('.comic-page-shell').getAttribute('data-project-fact-dirty'),null);
});

for(const orientation of ['portrait','landscape'])test(`${orientation} 整页、分镜与共用全屏的普通字和爱心使用相同字号基准`,async t=>{
 const {page}=await open(t,{width:1440,height:1000},`?hearts${orientation==='landscape'?'&landscape':''}`);
 await page.waitForFunction(()=>document.querySelectorAll('.comic-lettering-target .heart-lettering').length===2);
 const measure=selector=>page.locator(selector).evaluate(node=>{const overlay=node.closest('.lettering-overlay').getBoundingClientRect(),box=node.getBoundingClientRect();return {font:parseFloat(getComputedStyle(node).fontSize)/overlay.width,w:box.width/overlay.width};});
 const wholeText=await measure('.comic-lettering-target [data-dialogue-id="dialogue-000000000001"] .lettering-text'),wholeHeart=await measure('.comic-lettering-target [data-dialogue-id="dialogue-000000000010"]');
 await page.getByRole('tab',{name:'分镜 1',exact:true}).click();const normalText=await measure('.comic-panel-view:not([hidden]) .current-image__lettering-target .lettering-text'),normalHeart=await measure('.comic-panel-view:not([hidden]) .current-image__lettering-target [data-lettering-kind="heart"]');
 assert.ok(Math.abs(wholeText.font-normalText.font)<.0001);assert.ok(Math.abs(wholeHeart.w-normalHeart.w)<.001);
 await page.getByRole('tab',{name:'整页',exact:true}).click();await page.getByRole('button',{name:'全屏预览',exact:true}).click();const lightbox=page.getByRole('dialog',{name:'整页放大预览'});await lightbox.locator('.heart-lettering').first().waitFor();
 const fullHeart=await measure('.image-lightbox__content [data-dialogue-id="dialogue-000000000010"]');assert.ok(Math.abs(fullHeart.w-wholeHeart.w)<.001);
 const initial=await lightbox.locator('.image-lightbox__content').boundingBox();await lightbox.getByRole('button',{name:'放大图片'}).click();const zoomed=await lightbox.locator('.image-lightbox__content').boundingBox();assert.ok(zoomed.width>initial.width);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.comic-canvas').count(),1);
});

test('正式成品共享跨格排版，气泡越过所属格子仍在整页内显示',async t=>{
 const distRoot=fileURLToPath(new URL('../../dist/',import.meta.url));
 const assets=createHttpServer((request,response)=>void serveProductionAsset(response,new URL(request.url,'http://local'),distRoot));
 await new Promise(resolve=>assets.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>assets.close(resolve)));
 const origin=`http://127.0.0.1:${assets.address().port}`,frame={x:.02,y:.02,w:.96,h:.3};
 const clean=await sharp({create:{width:1024,height:1536,channels:3,background:'#ffffff'}}).png().toBuffer();
 const lettering={page_kind:'comic',canvas:'2:3',panels:[{page_id:'page-001',frame,lettering:{canvas:'983.04:460.8',settings:defaultLetteringSettings(),dialogue:[{id:'dialogue-000000000001',mode:'speech',speaker:'npc',text:'气泡跨过格线'}],items:[{dialogue_id:'dialogue-000000000001',box:{x:.1,y:1.05,w:.6,h:.2}}]}}]};
 const rendered=await inspectFinishedLettering(clean,lettering,origin);
 assert.deepEqual(rendered.diagnostics.blockers,[]);assert.equal(rendered.diagnostics.objects.length,1);
 assert.ok(rendered.diagnostics.objects[0].box.y>frame.y+frame.h);
 assert.notDeepEqual(await sharp(rendered.image).raw().toBuffer(),await sharp(clean).raw().toBuffer());
});
