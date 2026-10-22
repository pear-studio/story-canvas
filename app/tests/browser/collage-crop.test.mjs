import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {fixture} from '../helpers/finished-fixture.mjs';
import {createPage} from '../../server/page-facts.mjs';
import {createStoryCanvasServer} from '../../server/index.mjs';
import {collageContext,saveCollage,captureCollage,composeCollage} from '../../server/collage-pages.mjs';
import {imagePlacement} from '../../shared/collage-layout.mjs';

test('裁剪框对应原图像素，编辑预览在保存前后显示同一裁剪区域',async t=>{
  const f=await fixture(t);
  await writeFile(f.file,await sharp(Buffer.from('<svg width="960" height="1280"><rect width="960" height="1280" fill="red"/><rect x="480" width="480" height="640" fill="lime"/><rect y="640" width="480" height="640" fill="blue"/><rect x="480" y="640" width="480" height="640" fill="yellow"/></svg>')).png().toBuffer());
  const created=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'collage'});
  const scope=await collageContext(f.directory,created.page_id);
  const document={...scope.document,canvas:'3:4',assets:{source:{page_id:'page-001'}},items:[{id:'image',asset_id:'source',enabled:true,box:{x:.1,y:.1,w:.8,h:.8},crop:{x:0,y:0,w:1,h:1}}]};
  await saveCollage(f.directory,created.page_id,{expected_sha256:scope.sha256,document});
  const server=await createStoryCanvasServer({projectRoot:f.root,appRoot:fileURLToPath(new URL('../../',import.meta.url)),production:true,localConfig:{comfyui_urls:[]},hardwareStatusReader:async()=>({cpu:{available:false},memory:{available:false},gpu:{available:false},comfyui:{connected:false,status:'offline'}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=story&page=${created.page_id}`);
  const editor=page.locator('.collage-workspace');await editor.waitFor();
  await editor.getByRole('button',{name:'调整取景：#1-第一章-测试页',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'调整取景'}),image=dialog.getByRole('img'),crop=dialog.locator('.collage-crop');
  await image.evaluate(img=>img.decode());
  const bounds=await image.boundingBox(),frame=await crop.boundingBox();
  assert.ok(Math.abs(bounds.width-frame.width)<1&&Math.abs(bounds.height-frame.height)<1,`裁剪坐标系必须与可见原图一致：${JSON.stringify({bounds,frame})}`);
  await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height*.6);await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width*.9,bounds.y+bounds.height*.8,{steps:8});await page.mouse.up();
  await dialog.getByRole('button',{name:'完成裁切'}).click();
  function yellowPixels(pixels){
    for(const [x,y] of [[.1,.1],[.9,.1],[.1,.9],[.9,.9],[.5,.5]]){
      const offset=(Math.floor(y*pixels.info.height)*pixels.info.width+Math.floor(x*pixels.info.width))*pixels.info.channels;
      assert.ok(pixels.data[offset]>240&&pixels.data[offset+1]>240&&pixels.data[offset+2]<20,`裁剪预览应全为黄色：${[...pixels.data.subarray(offset,offset+3)]}`);
    }
  }
  async function checkYellow(container=editor){
    await container.locator('.collage-image img').evaluate(img=>img.decode());
    yellowPixels(await sharp(await container.locator('.collage-image').screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true}));
  }
  await checkYellow();
  const visible=await editor.locator('.collage-image').boundingBox(),handle=await editor.locator('.collage-handle').boundingBox();
  for(const k of ['x','y','width','height'])assert.ok(Math.abs(visible[k]-handle[k])<1,`裁剪后的拖动框应紧贴可见图片：${k} ${visible[k]} / ${handle[k]}`);
  await editor.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.collage-workspace')?.getAttribute('data-page-content-dirty')==='false');
  const saved=await collageContext(f.directory,created.page_id);
  for(const [k,v] of Object.entries({x:.6,y:.6,w:.3,h:.2}))assert.ok(Math.abs(saved.document.items[0].crop[k]-v)<.005);
  const captured=await captureCollage(f.directory,saved.document),item=saved.document.items[0];
  const composite=await composeCollage(saved.document,captured,600),box=imagePlacement(captured.media.source,item.box,item.crop,'3:4').box;
  yellowPixels(await sharp(composite).extract({left:Math.round(box.x*600)+2,top:Math.round(box.y*800)+2,width:Math.round(box.w*600)-4,height:Math.round(box.h*800)-4}).removeAlpha().raw().toBuffer({resolveWithObject:true}));
  await page.reload();await editor.waitFor();await checkYellow();
  const selected=editor.locator('.collage-handle');await selected.focus();await selected.press('ArrowRight');
  const nudged=await selected.boundingBox();assert.ok(Math.abs(nudged.y-visible.y)<1,'裁剪后键盘移动不跳位');
  await checkYellow();await editor.getByRole('button',{name:'撤销',exact:true}).click();
  await selected.focus();const grip=await selected.locator('.collage-resize').boundingBox();
  await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();await page.mouse.move(grip.x-45,grip.y-30,{steps:6});await page.mouse.up();
  const resized=await selected.boundingBox();assert.ok(resized.width<visible.width-20);assert.ok(Math.abs(resized.x-visible.x)<1&&Math.abs(resized.y-visible.y)<1,'裁剪后缩放保持左上角不跳位');await checkYellow();
  await editor.getByRole('button',{name:'撤销',exact:true}).click();
  await page.goto(`http://127.0.0.1:${server.address().port}/?project=demo&tab=project-story&page_type=collage`);
  const thumb=page.locator(`[data-page-id="${created.page_id}"] .story-page-thumbnail`);await thumb.waitFor();await checkYellow(thumb);
  await thumb.click();await checkYellow(page.getByRole('dialog'));
});
