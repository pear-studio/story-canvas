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
after(async()=>{await browser?.close();await server?.close();});
async function open(t,width,query=''){
 const page=await browser.newPage({viewport:{width,height:844},isMobile:width<700,hasTouch:width<700});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
 await page.route('**/api/**',r=>r.fulfill({json:{jobs:[]}}));
 await page.route('**/candidate.svg*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="teal"/></svg>'}));
 await page.goto(`${origin}/tests/browser/mobile-candidates.html?${query}`);
 return page;
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
