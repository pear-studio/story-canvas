import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
let server,browser,origin;
before(async()=>{
 server=await createServer({root:fileURLToPath(new URL('../../',import.meta.url)),cacheDir:'.temp/vite-floating-tests',server:{host:'127.0.0.1',port:0},logLevel:'error'});
 await server.listen(); origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
});
after(async()=>{await browser?.close();await server?.close();});
async function insideViewport(locator,page) {
 await page.waitForFunction(n=>n.matches(":popover-open"),await locator.elementHandle());
 const box=await locator.boundingBox(); const size=page.viewportSize();
 assert.ok(box && box.x>=7 && box.y>=7 && box.x+box.width<=size.width-7 && box.y+box.height<=size.height-7,JSON.stringify(box));
 assert.equal(await locator.evaluate(n=>n.matches(':popover-open')),true);
}
test('浮层跨越裁切容器、避让屏幕边缘，支持键盘及原生 dialog',async()=>{
 const page=await browser.newPage({viewport:{width:420,height:480}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
 await page.goto(`${origin}/tests/browser/fixtures/floating-layer.html`);
 await page.getByRole('button',{name:'提示',exact:true}).hover();
 const tip=page.getByRole('tooltip');await tip.waitFor();await insideViewport(tip,page);
 await page.keyboard.press('Escape');assert.equal(await tip.count(),0);
 await page.getByRole('button',{name:'提示',exact:true}).focus();await tip.waitFor();await insideViewport(tip,page);
 await page.getByText('菜单',{exact:true}).click();
 const panel=page.locator('.project-switcher-menu');await panel.waitFor();await insideViewport(panel,page);
 await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);
 await page.getByRole('button',{name:'右键菜单',exact:true}).click();
 const menu=page.getByRole('menu');await menu.waitFor();await insideViewport(menu,page);
 assert.ok(await menu.evaluate(n=>n.scrollHeight>n.clientHeight));
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'打开弹窗'}).click();
 await page.getByRole('button',{name:'弹窗提示',exact:true}).hover();await tip.waitFor();await insideViewport(tip,page);
 await page.getByRole('button',{name:'弹窗菜单',exact:true}).click();await menu.waitFor();await insideViewport(menu,page);
 assert.equal(await menu.evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+15,r.y+15));}),true);
 assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
