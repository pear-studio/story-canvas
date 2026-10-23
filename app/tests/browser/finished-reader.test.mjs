import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {finishedReaderHead,finishedReaderFigure,finishedReaderAnimation,finishedReaderTail} from '../../shared/finished-reader.mjs';

const picture='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="1000" fill="teal"/></svg>');
const document=finishedReaderHead()+[1,3,4].map(n=>finishedReaderFigure(picture,n,600,1000)).join('')+finishedReaderTail;
async function setup(t,options={}){
 const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:900,height:700},...options});const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 return page;
}
test('单行工具栏、方向开关、键盘翻页及缩放保持当前位置',async t=>{
 const page=await setup(t);await page.setContent(document);
 assert.equal(await page.getByRole('switch',{name:'水平阅读',exact:true}).isVisible(),false);
 await page.getByRole('button',{name:'阅读工具',exact:true}).click();
 await page.getByRole('button',{name:'下一页',exact:true}).click();
 assert.equal(await page.getByLabel('当前页码').innerText(),'3');
 assert.equal(await page.locator('.reader-toolbar input,.reader-toolbar p').count(),0);
 await page.getByRole('button',{name:'下一页',exact:true}).click();
 assert.equal(await page.getByLabel('当前页码').innerText(),'4');
 await page.keyboard.press('ArrowLeft');assert.equal(await page.getByLabel('当前页码').innerText(),'3');
 const width=await page.locator('figure').nth(1).evaluate(el=>el.getBoundingClientRect().width);
 await page.keyboard.press('+');assert.equal(await page.getByLabel('缩放比例').innerText(),'125%');
 assert.ok(await page.locator('figure').nth(1).evaluate(el=>el.getBoundingClientRect().width)>width);
 assert.equal(await page.getByLabel('当前页码').innerText(),'3');
 await page.getByRole('switch',{name:'水平阅读',exact:true}).click();
 assert.equal(await page.getByLabel('当前页码').innerText(),'3');
 assert.ok(await page.locator('.finished-reader').evaluate(el=>el.scrollWidth>el.clientWidth&&el.scrollHeight>el.clientHeight));
 assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'true');
 await page.getByRole('switch').click();
 assert.equal(await page.getByRole('switch').innerText(),'垂直');
 assert.equal(await page.getByLabel('当前页码').innerText(),'3');
 await page.keyboard.press('0');assert.equal(await page.getByLabel('缩放比例').innerText(),'100%');
 await page.keyboard.press('End');assert.equal(await page.getByLabel('当前页码').innerText(),'4');
 await page.keyboard.press('Home');assert.equal(await page.getByLabel('当前页码').innerText(),'1');
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('navigation').isVisible(),false);
 await page.keyboard.press('m');assert.equal(await page.getByRole('navigation').isVisible(),true);
});
test('手机工具栏不溢出，轻点显隐且保留原生双指缩放',async t=>{
 const page=await setup(t,{viewport:{width:390,height:844},isMobile:true,hasTouch:true});await page.setContent(document);
 await page.locator('figure').first().tap({position:{x:150,y:150}});
 const toolbar=page.getByRole('navigation');assert.equal(await toolbar.isVisible(),true);
 const rect=await toolbar.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=390&&rect.y>=0&&rect.y+rect.height<=844);
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  const bounds=await toolbar.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.height<=54);
  const tops=await toolbar.locator('button').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().top));assert.ok(tops.every(y=>y===tops[0]));
 }
 assert.doesNotMatch(await page.locator('meta[name=viewport]').getAttribute('content'),/user-scalable=no|maximum-scale=1/);
 await page.getByRole('button',{name:'放大',exact:true}).tap();
 assert.ok(await page.locator('.finished-reader').evaluate(el=>el.scrollWidth>el.clientWidth));
 await page.getByRole('button',{name:'适合屏幕',exact:true}).tap();
 assert.equal(await page.getByLabel('缩放比例').innerText(),'100%');
 await page.getByRole('button',{name:'收起工具栏',exact:true}).tap();assert.equal(await toolbar.isVisible(),false);
});
test('缺少观察器时仍可阅读和按可见性播放，自动播放拒绝可手动开始',async t=>{
 const page=await setup(t);
 await page.addInitScript(()=>{
  window.IntersectionObserver=undefined;window.ResizeObserver=undefined;
  Object.defineProperty(HTMLMediaElement.prototype,'src',{configurable:true,set(value){this.dataset.testSrc=value;}});
  HTMLMediaElement.prototype.play=function(){if(!window.allowVideo)return Promise.reject(Error('blocked'));this.dataset.played='yes';this.dispatchEvent(new Event('playing'));return Promise.resolve();};
  HTMLMediaElement.prototype.pause=function(){this.dataset.paused='yes';};
 });
 await page.goto('about:blank');
 await page.setContent(finishedReaderHead()+finishedReaderFigure(picture,1,600,1000)+finishedReaderAnimation('data:video/mp4;base64,AAAA',3,600,1000)+finishedReaderTail);
 assert.equal(await page.locator('video').getAttribute('src'),null);
 await page.locator('video').scrollIntoViewIfNeeded();
 await page.getByRole('button',{name:'播放动画',exact:true}).waitFor();
 // 不加载有效视频，专门测试浏览器拒绝自动播放后的交互回退。
 await page.evaluate(()=>{window.allowVideo=true;});
 await page.getByRole('button',{name:'播放动画',exact:true}).click();
 assert.equal(await page.locator('video').getAttribute('data-played'),'yes');
 assert.equal(await page.getByRole('button',{name:'播放动画',exact:true}).isVisible(),false);
 await page.locator('.finished-reader').evaluate(el=>el.scrollTo(0,0));
 await page.waitForFunction(()=>document.querySelector('video').dataset.paused==='yes');
 await page.getByRole('button',{name:'阅读工具',exact:true}).click();await page.getByRole('switch',{name:'水平阅读',exact:true}).click();
 await page.setViewportSize({width:700,height:500});await page.waitForFunction(()=>Math.abs(document.querySelector('figure').getBoundingClientRect().height-500)<1);
});
