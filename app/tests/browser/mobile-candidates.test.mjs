import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
let server,browser,origin;
before(async()=>{
 server=await createServer({cacheDir:'.temp/vite-mobile-candidates',root:fileURLToPath(new URL('../../',import.meta.url)),server:{host:'127.0.0.1',port:0},logLevel:'error'});
 await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
});

function previousIterationDetail() {
 return { candidate_id: 'candidate-0', iteration: { source_candidate_id: 'candidate-1', source_image_sha256: 'source-hash' }, seed: 321,
   generation: { prompt: { positive: 'veloria\n\n修复右手，保留其余画面。', sections: [{ kind: 'global', text: 'veloria' }, { kind: 'page', text: '修复右手，保留其余画面。' }] } } };
}
async function openReiteration(page, width, count = 3) {
 if (width < 700) {
   await page.getByRole('button', { name: `查看候选图，共 ${count} 张` }).click();
   await page.getByRole('option').first().click();
   await page.getByRole('button', { name: '重新迭代', exact: true }).click();
 } else {
   await page.locator('.candidate-entry').first().click({ button: 'right' });
   await page.getByRole('menuitem', { name: '重新迭代…', exact: true }).click();
 }
 return page.getByRole('dialog', { name: '重新迭代', exact: true });
}
for (const width of [390, 1280]) test(`重新迭代带回原始指令和 Seed，预览直接来源、提交失败保留草稿 ${width}`, async t => {
 const page = await open(t, width, 'iterated');
 await page.route('**/candidate-*.svg*', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="288"><rect width="192" height="288" fill="teal"/></svg>' }));
 let release;
 const gate = new Promise(resolve => { release = resolve; });
 await page.route('**/candidate-detail', async route => { assert.equal(route.request().postDataJSON().candidate_id, 'candidate-0'); await gate; await route.fulfill({ json: { detail: previousIterationDetail() } }); });
 const dialog = await openReiteration(page, width);
 await dialog.getByText('正在读取上次迭代指令…').waitFor();
 assert.equal(await dialog.getByRole('button', { name: '生成 1 张候选' }).isEnabled(), false);
 release();
 await page.waitForFunction(() => document.querySelector('#candidate-iteration-form textarea')?.value === '修复右手，保留其余画面。');
 assert.equal(await dialog.getByLabel('Seed').inputValue(), '321');
 assert.equal(await dialog.getByRole('combobox', { name: '生成数量' }).inputValue(), '1');
 assert.equal(await dialog.getByRole('checkbox', { name: '使用项目 Qwen LoRA' }).isChecked(), true);
 assert.match(await dialog.getByAltText('本次迭代来源').getAttribute('src'), /candidate-1\.svg/);
 await dialog.getByRole('button', { name: '放大迭代来源图' }).click();
 assert.match(await page.getByAltText('迭代来源图', { exact: true }).getAttribute('src'), /candidate-1\.svg/);
 await page.getByRole('button', { name: '关闭全屏图片' }).click();
 const bounds = await dialog.boundingBox();
 assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 845);
 await page.screenshot({ path: fileURLToPath(new URL(`../../../Saved/Tests/candidate-reiterate-${width}.png`, import.meta.url)) });
 const calls = [];
 await page.route('**/api/test-iteration', async route => { calls.push(route.request().postDataJSON()); await route.fulfill({ status: 422, json: { error: '来源图已删除' } }); });
 await dialog.getByLabel('修改要求').fill('只修复右手，不改变袖口。');
 await dialog.getByRole('button', { name: '生成 1 张候选' }).click();
 await dialog.getByRole('alert').waitFor();
 assert.equal(await dialog.getByLabel('修改要求').inputValue(), '只修复右手，不改变袖口。');
 assert.deepEqual(calls[0], { candidate_id: 'candidate-0', instruction: '只修复右手，不改变袖口。', count: 1, seed: 321, use_project_loras: true, reiterate: true });
 await page.unroute('**/api/test-iteration');
 await page.route('**/api/test-iteration', async route => { calls.push(route.request().postDataJSON()); await route.fulfill({ json: {} }); });
 await dialog.getByRole('button', { name: '生成 1 张候选' }).click();
 await dialog.waitFor({ state: 'detached' });
 assert.equal(calls.length, 2);
 if (width < 700) {
   await expectLoadedLightbox(page);
   await page.getByRole('button', { name: '迭代', exact: true }).click();
 } else {
   await page.locator('.candidate-entry').first().click({ button: 'right' });
   await page.getByRole('menuitem', { name: '迭代…', exact: true }).click();
 }
 const ordinary = page.getByRole('dialog', { name: '迭代候选图', exact: true });
 assert.equal(await ordinary.getByLabel('修改要求').inputValue(), '');
 assert.match(await ordinary.getByAltText('本次迭代来源').getAttribute('src'), /candidate-0\.svg/);
 await ordinary.getByRole('button', { name: '取消', exact: true }).click();
});

for (const width of [390, 1280]) test(`来源图已删除时重新迭代入口禁用，仍可迭代当前结果 ${width}`, async t => {
 const page = await open(t, width, 'iterated&source-missing&cached');
 if (width < 700) {
   await page.getByRole('button', { name: '查看候选图，共 2 张' }).click();
   await page.getByRole('option').first().click();
   const button = page.getByRole('button', { name: '重新迭代', exact: true });
   assert.equal(await button.isEnabled(), false);
   assert.match(await button.getAttribute('title'), /来源图已删除/);
   await page.getByRole('button', { name: '迭代', exact: true }).click();
 } else {
   await page.locator('.candidate-entry').first().click({ button: 'right' });
   assert.equal(await page.getByRole('menuitem', { name: '重新迭代…', exact: true }).isEnabled(), false);
   await page.getByRole('menuitem', { name: '迭代…', exact: true }).click();
 }
 assert.equal(await page.getByRole('dialog', { name: '迭代候选图', exact: true }).getByLabel('修改要求').inputValue(), '');
});

test('重新迭代详情读取失败可重试，取消后迟到响应不覆盖普通迭代草稿', async t => {
 const page = await open(t, 390, 'iterated&cached');
 await page.route('**/candidate-detail', route => route.fulfill({ status: 500, json: { error: '详情读取暂时失败' } }));
 const dialog = await openReiteration(page, 390);
 await dialog.getByRole('alert').waitFor();
 assert.equal(await dialog.getByRole('button', { name: '生成 1 张候选' }).isEnabled(), false);
 await page.unroute('**/candidate-detail');
 let release;
 const gate = new Promise(resolve => { release = resolve; });
 await page.route('**/candidate-detail', async route => { await gate; await route.fulfill({ json: { detail: previousIterationDetail() } }); });
 await dialog.getByRole('button', { name: '重试读取' }).click();
 await dialog.getByText('正在读取上次迭代指令…').waitFor();
 await dialog.getByRole('button', { name: '取消', exact: true }).click();
 await page.getByRole('button', { name: '迭代', exact: true }).click();
 const ordinary = page.getByRole('dialog', { name: '迭代候选图', exact: true });
 await ordinary.getByLabel('修改要求').fill('新的修改要求');
 release();
 await page.waitForResponse(response => response.url().endsWith('/candidate-detail'));
 assert.equal(await ordinary.getByLabel('修改要求').inputValue(), '新的修改要求');
});
after(async()=>{await browser?.close();await server?.close();});
async function open(t,width,query=''){
 const page=await browser.newPage({viewport:{width,height:844},isMobile:width<700,hasTouch:width<700});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
 await page.route('**/api/**',r=>r.fulfill({json:{jobs:[]}}));
 await page.route('**/render-profile?profile_id=qwen-image-2-1', r => r.fulfill({ json: { render_profiles: [{ id: 'qwen-image-2-1', inspection: { project_override: { blocked: false }, style_loras: { veloria: { filename: 'veloria/qwen/veloria-v2.safetensors', weight: 1 } } } }] } }));
 await page.route('**/candidate.svg*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="teal"/></svg>'}));
 await page.goto(`${origin}/tests/browser/mobile-candidates.html?${query}`);
 return page;
}
async function expectLoadedLightbox(page) {
 await page.waitForFunction(() => {
   const image = document.querySelector('.image-lightbox img');
   return image?.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === '1';
 }, null, { timeout: 3000 });
 assert.equal(await page.locator('.image-lightbox img').getAttribute('class'), null, '返回已加载的图片不应停留在半透明加载状态');
}
for(const width of [360,390,980])test(`候选从底栏打开，正文和成品按钮隐藏 ${width}`,async t=>{
 const page=await open(t,width,'issue');
 const trigger=page.getByRole('button',{name:'查看候选图，共 1 张'});
 await trigger.waitFor();
 assert.equal(await page.locator('.page-images').isVisible(),false);
 assert.equal(await page.getByRole('button',{name:'查看成品',exact:true}).count(),0);
 const rect=await page.locator('.mobile-generate-bar').boundingBox();
 for(const button of await page.locator('.mobile-generate-bar button:visible').all()){
  const b=await button.boundingBox();assert.ok(b.x>=0 && b.x+b.width<=width && b.y>=rect.y && b.y+b.height<=rect.y+rect.height);
 }
 await trigger.click();
 const dialog=page.getByRole('dialog',{name:'历史候选',exact:true});await dialog.waitFor();
 await dialog.getByRole('button',{name:'刷新候选'}).click();
 await page.getByRole('button',{name:'查看候选图，共 2 张'}).waitFor();
 await dialog.getByRole('option').first().click();
 await page.getByAltText('测试页 候选图',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await dialog.isVisible(),true);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 assert.equal(await dialog.count(),0);
});
for(const width of [360,390])test(`历史候选首次和重开都从顶部显示最新候选 ${width}`,async t=>{
 const page=await open(t,width,'thumbnails');
 await page.route('**/candidate-*.svg*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="teal"/></svg>'}));
 const trigger=page.getByRole('button',{name:'查看候选图，共 9 张'});
 await trigger.click();
 const dialog=page.getByRole('dialog',{name:'历史候选',exact:true});
 const grid=dialog.getByRole('listbox',{name:'历史候选列表',exact:true});
 await grid.waitFor();
 assert.equal(await grid.evaluate(element=>element.scrollTop),0);
 assert.ok(await grid.evaluate(element=>element.scrollHeight>element.clientHeight),'必须有足够候选产生滚动');
 // 保留最旧候选为当前预览后重新打开，不能再次定位到列表底部。
 await grid.getByRole('option').last().click();
 const lightbox=page.getByRole('dialog',{name:'测试页 候选图',exact:true});
 if(await lightbox.count())await page.getByRole('button',{name:'关闭全屏图片'}).click();
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await trigger.click();
 await grid.waitFor();
 await page.waitForFunction(()=>document.querySelector('.candidate-grid--history')?.scrollTop===0);
 assert.equal(await grid.evaluate(element=>element.scrollTop),0);
 const first=await grid.getByRole('option').first().boundingBox(),bounds=await grid.boundingBox();
 assert.ok(first.y>=bounds.y&&first.y+first.height<=bounds.y+bounds.height,'首屏可见最新候选');
});

test('空候选和读取失败可在面板中查看并刷新，桌面保留原工作区',async t=>{
 const page=await open(t,390,'empty&error');
 await page.getByRole('button',{name:'查看候选图，共 0 张'}).click();
 assert.equal(await page.getByRole('dialog').getByText('媒体读取失败',{exact:true}).isVisible(),true);
 assert.equal(await page.getByText('还没有历史候选',{exact:true}).isVisible(),true);
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await page.setViewportSize({width:1400,height:900});
 assert.equal(await page.locator('.page-images').isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'查看成品',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'保存嵌字并输出成品',exact:true}).isVisible(),true);
});

for (const width of [390, 1280]) test(`候选迭代：入口、空白指令、失败保留、返回大图和重复提交保护 ${width}`, async t => {
 const page = await open(t, width, width > 700 ? 'thumbnails' : 'cached');
 await page.route('**/candidate-*.svg*', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="288"><rect width="192" height="288" fill="teal"/></svg>' }));
 if (width < 700) {
   await page.getByRole('button', { name: '查看候选图，共 1 张' }).click();
   await page.getByRole('option').first().click();
   await page.getByRole('button', { name: '迭代', exact: true }).click();
 } else {
   await page.locator('.candidate-entry').first().click({ button: 'right' });
   await page.getByRole('menuitem', { name: '迭代…' }).click();
 }
 let calls = [];
 await page.route('**/api/test-iteration', async route => { calls.push(route.request().postDataJSON()); await route.fulfill({ status: 422, json: { error: 'test' } }); });
 const dialog = page.getByRole('dialog', { name: '迭代候选图', exact: true });
 await dialog.waitFor();
 await dialog.getByText('veloria-v2 · 权重 1', { exact: true }).waitFor();
 assert.equal(await dialog.getByRole('checkbox', { name: '使用项目 Qwen LoRA' }).isChecked(), true);
 assert.equal(await dialog.getByLabel('修改要求').inputValue(), '');
 assert.equal(await dialog.getByRole('button', { name: '生成 1 张候选' }).isEnabled(), false);
 await dialog.getByLabel('修改要求').fill('修复右手，保持构图。');
 await dialog.getByLabel('修改要求').blur();
 await dialog.getByRole('button', { name: '放大迭代来源图' }).click();
 await page.getByRole('dialog', { name: '迭代来源图', exact: true }).waitFor();
 await expectLoadedLightbox(page);
 await page.getByRole('button', { name: '关闭全屏图片' }).click();
 assert.equal(await dialog.getByLabel('修改要求').inputValue(), '修复右手，保持构图。');
 const box = await dialog.boundingBox();
 assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
 assert.ok(box.y >= 0 && box.y + box.height <= 845);
 await dialog.getByRole('button', { name: '生成 1 张候选' }).click();
 await dialog.getByRole('alert').waitFor();
 assert.equal(await dialog.getByLabel('修改要求').inputValue(), '修复右手，保持构图。');
 assert.equal(calls.length, 1);
 assert.deepEqual(calls[0], { candidate_id: 'candidate-0', instruction: '修复右手，保持构图。', count: 1, use_project_loras: true });
 await page.unroute('**/api/test-iteration');
 let release;
 const gate = new Promise(resolve => { release = resolve; });
 await page.route('**/api/test-iteration', async route => { calls.push(route.request().postDataJSON()); await gate; await route.fulfill({ json: {} }); });
 await dialog.getByRole('checkbox', { name: '使用项目 Qwen LoRA' }).uncheck();
 await dialog.getByRole('button', { name: '生成 1 张候选' }).click();
 await page.getByRole('button', { name: '正在提交…' }).waitFor();
 assert.equal(await page.getByRole('button', { name: '正在提交…' }).isEnabled(), false);
 release();
 await dialog.waitFor({ state: 'detached' });
 if (width < 700) {
   await expectLoadedLightbox(page);
   await page.getByRole('button', { name: '原始大小（1:1）', exact: true }).click();
   const image = await page.locator('.image-lightbox img').boundingBox();
   assert.equal(image.width, 200);
   assert.equal(image.height, 300);
 }
 assert.equal(calls.length, 2);
 assert.equal(calls[1].use_project_loras, false);
 if (width < 700) await page.getByRole('button', { name: '迭代', exact: true }).click();
 else { await page.locator('.candidate-entry').first().click({ button: 'right' }); await page.getByRole('menuitem', { name: '迭代…' }).click(); }
 assert.equal(await dialog.getByLabel('修改要求').inputValue(), '');
 assert.equal(await dialog.getByRole('checkbox', { name: '使用项目 Qwen LoRA' }).isChecked(), true);
 // 小视口代表软键盘占据下半屏时的布局：输入和提交都必须可见。
 if (width < 700) {
   await page.setViewportSize({ width, height: 410 });
   await dialog.getByLabel('修改要求').focus();
   await page.waitForFunction(() => {
     const button = document.querySelector('.candidate-iteration-dialog button[type="submit"]');
     const bounds = button?.getBoundingClientRect();
     return bounds && bounds.y >= 0 && bounds.bottom <= 411;
   }, null, { timeout: 3000 });
   const submit = await dialog.getByRole('button', { name: '生成 1 张候选' }).boundingBox();
   assert.ok(submit.y >= 0 && submit.y + submit.height <= 411);
 }
 await dialog.getByRole('button', { name: '取消', exact: true }).click();
 if (width < 700) await expectLoadedLightbox(page);
});
