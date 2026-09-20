import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
let server,browser,origin;
before(async()=>{
 server=await createServer({cacheDir:'.temp/vite-unified-page-tests',root:fileURLToPath(new URL('../../',import.meta.url)),server:{host:'127.0.0.1',port:0},logLevel:'error'});
 await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
});
after(async()=>{await browser?.close();await server?.close();});
async function open(t,query){
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 await page.goto(`${origin}/tests/browser/unified-page.html?${query}`);return page;
}
for(const kind of ['story','character','scene'])test(`${kind} 页面均可编辑人物、场景、嵌字并移除默认引用`,async t=>{
 const page=await open(t,`kind=${kind}`);
 assert.equal(await page.getByLabel('艾莲角色设定').inputValue(),'day');
 assert.equal(await page.getByLabel('页面场景设定').inputValue(),'room:day');
 await page.getByRole('tab',{name:'嵌字',exact:true}).click();
 await page.getByLabel('旁白',{exact:true}).fill('统一文案');
 await page.getByRole('button',{name:'移除艾莲',exact:true}).click();
 await page.getByRole('button',{name:'移除场景引用',exact:true}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.deepEqual(saved.content.characters,[]);assert.equal(saved.prompt.scene_id,undefined);assert.equal(saved.prompt.scene_variant_id,undefined);
 assert.equal(saved.content.dialogue[0].text,'统一文案');
 assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
});
test('场景子设定切换后失败保留全部草稿，重试提交新引用并清除旧继承调整',async t=>{
 const page=await open(t,'kind=scene&fail-once');
 await page.getByLabel('页面场景设定').selectOption('room:night');
 await page.getByLabel('艾莲角色设定').selectOption('night');
 await page.getByLabel('画面内容').fill('夜间窗边休息');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'草稿已保留'}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('saved-page')),null);
 assert.equal(await page.getByLabel('页面场景设定').inputValue(),'room:night');
 assert.equal(await page.getByLabel('艾莲角色设定').inputValue(),'night');
 assert.equal(await page.getByLabel('画面内容').inputValue(),'夜间窗边休息');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.equal(saved.prompt.scene_variant_id,'night');assert.equal(saved.content.characters[0].variant_id,'night');
 assert.equal(saved.content.scene_description,'夜间窗边休息');assert.deepEqual(saved.prompt.inheritance,{});
});

test('同页外部刷新保留人物、场景和内容草稿，保存提交编辑时指纹并报告冲突',async t=>{
 const page=await open(t,'kind=scene');
 await page.getByLabel('画面内容').fill('本地未保存内容');
 await page.getByLabel('艾莲角色设定').selectOption('night');
 await page.getByRole('button',{name:'移除场景引用',exact:true}).click();
 await page.getByRole('button',{name:'模拟外部刷新',exact:true}).click();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByLabel('画面内容').inputValue(),'本地未保存内容');
 assert.equal(await page.getByLabel('艾莲角色设定').inputValue(),'night');
 assert.equal(await page.getByLabel('页面场景设定').inputValue(),'');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'page_content_target_conflict'}).waitFor();
 const baseline=await page.evaluate(()=>JSON.parse(localStorage.getItem('submitted-baseline')));
 assert.deepEqual([baseline.content_sha256,baseline.prompt_sha256,baseline.prompt_context_sha256,baseline.layout_sha256],['content','prompt','context','external-layout'], '当前布局未变时只接纳共享布局文件的新指纹');
 assert.equal(await page.evaluate(()=>localStorage.getItem('saved-page')),null);
 assert.equal(await page.getByLabel('画面内容').inputValue(),'本地未保存内容');
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 assert.equal(await page.getByLabel('画面内容').inputValue(),'外部改写的内容');
 assert.equal(await page.getByLabel('页面场景设定').inputValue(),'room:night');
 await page.getByLabel('画面内容').fill('基于外部版本的修改');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const reloaded=await page.evaluate(()=>JSON.parse(localStorage.getItem('submitted-baseline')));
 assert.equal(reloaded.content_sha256,'external-content');
});

