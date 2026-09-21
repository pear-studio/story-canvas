import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
let server,browser,origin;
before(async()=>{
 server=await createServer({cacheDir:'.temp/vite-reference-library-tests',root:fileURLToPath(new URL('../../',import.meta.url)),server:{host:'127.0.0.1',port:0},logLevel:'error'});
 await server.listen(); origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
});
after(async()=>{await browser?.close();await server?.close();});
async function open(t,failSecond=false,query=''){
 const page=await browser.newPage({viewport:{width:1000,height:800}});page.setDefaultTimeout(5000);
 const errors=[]; page.on('pageerror',e=>errors.push(e.message)); t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 let entries=[],revision=0,saves=0;const writes=[];
 const png='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="pink"/></svg>');
 await page.route('**/workbench/page-media',route=>route.fulfill({json:{media:{candidates:[1,2,3].map(i=>({candidate_id:'c'+i,url:png}))}}}));
 await page.route('**/materials/file?*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'}));
 await page.route('**/workbench/reference-library',async route=>{
  const v=route.request().postDataJSON();
  if(v.action!=='read'){
   assert.equal(v.expected_sha256,String(revision));writes.push(v);
   if(v.action==='save'){
    saves++;if(failSecond&&saves===2){await route.fulfill({status:500,json:{error:'测试保存失败'}});return;}
    const e={id:v.id??'r'+saves,file:'independent-'+saves+'.png',title:v.title};
    entries=v.id?entries.map(old=>old.id===v.id?e:old):[...entries,e];
   }else if(v.action==='reorder')entries=v.ids.map(id=>entries.find(e=>e.id===id));
   else if(v.action==='delete')entries=entries.filter(e=>e.id!==v.id);
   revision++;
  }
  await route.fulfill({json:{entries,sha256:String(revision)}});
 });
 await page.route('**/api/projects/test/materials',route=>route.fulfill({json:{materials:[{file:'existing.png',title:'已有参考',available:true}]}}));
 await page.goto(origin+'/tests/browser/reference-library.html'+query);
 await page.getByRole('button',{name:'添加参考图',exact:true}).waitFor();
 return {page,writes,setEntries(value){entries=value;revision++;}};
}
test('独立参考图区跨来源多选、替换、拖拽和移除',async t=>{
 const {page,writes}=await open(t);
 assert.equal(await page.getByRole('button',{name:'导入图片'}).count(),0);
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();
 await page.getByRole('button',{name:'a · 1',exact:true}).click();
 await page.getByLabel('参考图候选来源').selectOption('b');
 await page.getByRole('button',{name:'b · 2',exact:true}).click();
 await page.getByRole('button',{name:'添加 2 张',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(await page.locator('[data-reference-card]').count(),2);
 assert.equal(await page.getByRole('button',{name:'替换',exact:true}).count(),0);
 await page.getByRole('button',{name:'查看参考图：a · 1'}).click();
 await page.locator('.image-lightbox').waitFor();
 await page.keyboard.press('ArrowRight');
 assert.equal(await page.locator('.image-lightbox img').getAttribute('alt'),'b · 2');
 await page.keyboard.press('Escape');
 await page.locator('.image-lightbox').waitFor({state:'hidden'});
 assert.deepEqual(writes.map(v=>v.page_key.page_id),['a','b']);
 const from=await page.getByRole('button',{name:'拖动排序：b · 2'}).boundingBox(),to=await page.locator('[data-reference-card]').first().boundingBox();
 await page.mouse.move(from.x+8,from.y+8);await page.mouse.down();await page.mouse.move(to.x,to.y+8,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('[data-reference-card]')?.getAttribute('data-reference-card')==='r2');
 assert.deepEqual(writes.at(-1).ids,['r2','r1']);
 assert.equal(await page.locator('.image-lightbox').count(),0);
 await page.locator('[data-reference-card]').first().click({button:'right'});
 await page.getByRole('menuitem',{name:'替换',exact:true}).click();
 await page.getByRole('button',{name:'a · 2',exact:true}).click();await page.getByRole('button',{name:'a · 3',exact:true}).click();
 assert.equal(await page.locator('.reference-candidate-choice[aria-pressed="true"]').count(),1);
 await page.getByRole('button',{name:'确认替换'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(writes.at(-1).id,'r2');assert.equal(writes.at(-1).candidate_id,'c3');
 await page.getByRole('button',{name:'查看参考图：a · 3'}).click({button:'right'});
 await page.getByRole('menuitem',{name:'移除',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-reference-card]').length===1);
 assert.equal(await page.locator('.setting-reference-default').count(),1);
 await page.setViewportSize({width:390,height:800});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});
test('部分添加失败保留已完成的图片，重试不重复添加',async t=>{
 const {page,writes}=await open(t,true);
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();
 await page.getByRole('button',{name:'a · 1',exact:true}).click();await page.getByRole('button',{name:'a · 2',exact:true}).click();
 await page.getByRole('button',{name:'添加 2 张',exact:true}).click();
 await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/已添加 1 张/);
 await page.getByRole('button',{name:'添加 1 张',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.deepEqual(writes.map(v=>v.candidate_id),['c1','c2','c2']);
 assert.equal(await page.locator('[data-reference-card]').count(),2);
});

test('剧情页选择已有图片，上传前预览命名，取消不写入',async t=>{
 const {page,writes}=await open(t,false,'?page');
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();
 await page.getByRole('button',{name:'已有参考',exact:true}).click();
 await page.getByRole('button',{name:'添加 1 张',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(writes[0].material_file,'existing.png');
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();
 await page.getByLabel('上传参考图').click();
 assert.equal(await page.getByRole('button',{name:'选择图片',exact:true}).isVisible(),true);
 const file={name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64')};
 await page.locator('input[type=file]').setInputFiles(file);
 const upload=page.getByRole('dialog',{name:'确认上传',exact:true});await upload.waitFor();
 assert.equal(writes.length,1);
 await upload.getByRole('button',{name:'取消',exact:true}).click();assert.equal(writes.length,1);
 await page.locator('input[type=file]').setInputFiles(file);
 await upload.getByLabel('图片名称 1').fill('新参考');
 await upload.getByRole('button',{name:'确认添加',exact:true}).click();
 await upload.waitFor({state:'hidden'});
 await page.getByRole('dialog',{name:'选择参考图',exact:true}).waitFor({state:'hidden'});
 assert.equal(writes[1].title,'新参考');assert.ok(writes[1].content);assert.equal(writes[1].candidate_id,undefined);
});


test('同一设定外部参考图更新后重新读取列表与指纹',async t=>{
 const {page,writes,setEntries}=await open(t);
 setEntries([{id:'external',file:'external.png',title:'外部图片'}]);
 await page.getByRole('button',{name:'模拟参考图外部更新'}).click();
 await page.getByRole('button',{name:'查看参考图：外部图片'}).waitFor();
 await page.getByRole('button',{name:'查看参考图：外部图片'}).click({button:'right'});
 await page.getByRole('menuitem',{name:'移除',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-reference-card]').length===0);assert.equal(writes.at(-1).expected_sha256,'1');
});
