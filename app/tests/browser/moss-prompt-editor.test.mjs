import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
let server,browser,url;
before(async()=>{
  await mkdir(fileURLToPath(new URL('../../../Saved/Tests/moss-integration/',import.meta.url)),{recursive:true});
  server=await createServer({cacheDir:fileURLToPath(new URL('../../../Saved/Tests/moss-integration/vite-cache',import.meta.url)),root:fileURLToPath(new URL('../../',import.meta.url)),server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();url=`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/moss-prompt-editor.html`;
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
});
after(async()=>{await browser?.close();await server?.close();});
async function editor(t,width=1200){
  const page=await browser.newPage({viewport:{width,height:850}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/prompt-dictionary**',route=>route.fulfill({json:{available:true,matches:[],suggestions:[],has_more:false}}));
  t.after(async()=>{await page.close();assert.deepEqual(errors,[],'无浏览器异常');});
  await page.goto(url);await page.getByLabel('场景第 1 项 Prompt',{exact:true}).waitFor();return page;
}
const value=async(page,id)=>JSON.parse(await page.locator(`#${id}`).textContent());
for(const width of [1200,390])test(`MOSS 空人物组直接选择归属，键盘追加和自由人物 ${width}`,async t=>{
  const page=await editor(t,width);await page.goto(`${url}?page`);
  const add=page.getByRole('button',{name:'＋ 人物',exact:true});
  await add.focus();await page.keyboard.press('Enter');
  const picker=page.getByRole('menu',{name:'选择人物描述归属',exact:true});
  await picker.waitFor();
  assert.equal(await page.getByRole('menuitem',{name:'艾莲',exact:true}).evaluate(element=>element===document.activeElement),true);
  await page.keyboard.press('Escape');await picker.waitFor({state:'detached'});
  assert.equal(await add.evaluate(element=>element===document.activeElement),true);
  assert.deepEqual((await value(page,'page-prompt')).person,[]);
  await page.keyboard.press('Enter');await picker.waitFor();await page.keyboard.press('Enter');
  const bound=page.getByLabel('人物·艾莲第 1 项 Prompt',{exact:true});
  await bound.waitFor();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='人物·艾莲第 1 项 Prompt');
  await bound.fill('She holds a letter.');
  assert.equal((await value(page,'page-prompt')).person[0].character_id,'alice');
  await bound.press('Enter');await page.getByLabel('人物·艾莲第 2 项 Prompt',{exact:true}).fill('She smiles.');
  assert.deepEqual((await value(page,'page-prompt')).person.map(entry=>entry.character_id),['alice','alice']);
  await addEntry(page,'人物');await picker.waitFor();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  const free=page.getByLabel('人物·未绑定第 1 项 Prompt',{exact:true});await free.fill('A passerby watches.');
  assert.equal((await value(page,'page-prompt')).person[2].character_id,undefined);
  assert.equal((await value(page,'page-prompt')).person[2].description,'A passerby watches.');
  assert.equal(await page.locator('.prompt-natural-role').count(),0,'不恢复人物标题行');
});
test('MOSS 避免默认继承，编辑其他分类不固化，覆盖后可清空并恢复',async t=>{
  const page=await editor(t);await page.goto(`${url}?page`);
  await page.getByText('避免 · 继承项目',{exact:true}).click();
  const field=page.getByLabel('避免第 1 项 Prompt',{exact:true});
  assert.equal(await field.inputValue(),'watermark, logo');assert.equal(await field.isDisabled(),true);
  await page.getByLabel('构图第 1 项 Prompt',{exact:true}).fill('An edited scene.');
  assert.equal(Object.hasOwn(await value(page,'page-prompt'),'avoid'),false);
  await page.getByRole('button',{name:'本页覆盖避免',exact:true}).click();
  await field.fill('logo');assert.equal((await value(page,'page-prompt')).avoid[0].description,'logo');
  await page.getByRole('button',{name:'删除避免第 1 项',exact:true}).click();
  assert.deepEqual((await value(page,'page-prompt')).avoid,[]);
  await page.getByRole('button',{name:'恢复项目避免',exact:true}).click();
  assert.equal(await field.inputValue(),'watermark, logo');assert.equal(await field.isDisabled(),true);
  assert.equal(Object.hasOwn(await value(page,'page-prompt'),'avoid'),false);
});
async function drag(page,locator,dx,dy){const box=await locator.boundingBox();assert.ok(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:8});await page.mouse.up();}
async function layoutReady(page){await page.waitForFunction(()=>{const e=document.querySelector('.moss-layout-stage');if(!e)return false;const rect=e.getBoundingClientRect();return Math.abs(rect.width/rect.height-parseFloat(getComputedStyle(e).aspectRatio))<.01;},{},{timeout:5000});}
async function addEntry(root,label){const button=root.getByRole('button',{name:`添加${label}`,exact:true});await button.locator('..').locator('..').hover();await button.click();}

test('MOSS 自然条目支持增删、逐项启停、输入法与 Enter/Shift+Enter',async t=>{
  const page=await editor(t),first=page.getByLabel('场景第 1 项 Prompt',{exact:true});
  await first.fill('Soft sunlight.');await first.press('End');await first.press('Shift+Enter');await first.press('A');
  assert.equal((await value(page,'entries'))[0].description,'Soft sunlight.\nA');
  await first.press('Enter');assert.equal((await value(page,'entries')).length,3);
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='场景第 2 项 Prompt');
  await page.getByLabel('场景第 2 项 Prompt',{exact:true}).fill('Gentle shadows.');
  await page.getByLabel('场景第 2 项参与生成').locator('..').click();assert.equal((await value(page,'entries'))[1].enabled,false);
  await page.getByRole('button',{name:'删除场景第 2 项',exact:true}).click();assert.equal((await value(page,'entries')).length,2);
  await addEntry(page,'场景');assert.equal((await value(page,'entries')).length,3);
  await first.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal((await value(page,'entries')).length,3);
  assert.equal(await page.getByRole('button',{name:/权重/}).count(),0);
});
test('MOSS 自然条目拖拽后撤销恢复顺序',async t=>{
  const page=await editor(t),handle=page.getByRole('button',{name:'拖动场景第 1 项排序',exact:true}),second=await page.getByLabel('场景第 2 项 Prompt',{exact:true}).boundingBox(),first=await handle.boundingBox();
  await drag(page,handle,0,second.y+second.height-first.y);
  assert.equal((await value(page,'entries'))[0].id,'two');
  await page.getByLabel('场景第 1 项 Prompt',{exact:true}).focus();await page.keyboard.press('Control+z');
  assert.deepEqual((await value(page,'entries')).map(entry=>entry.id),['one','two']);
});
test('MOSS Layout 的移动、缩放、数值修改与取消/应用',async t=>{
  const page=await editor(t),original=await value(page,'layout');
  await page.getByRole('button',{name:'编辑 Layout',exact:true}).click();let dialog=page.getByRole('dialog',{name:'MOSS Layout',exact:true});
  await dialog.getByLabel('左 %',{exact:true}).fill('25');await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(await value(page,'layout'),original);
  await page.getByRole('button',{name:'编辑 Layout',exact:true}).click();dialog=page.getByRole('dialog',{name:'MOSS Layout',exact:true});
  await layoutReady(page);const stage=await dialog.getByLabel('Layout 画布',{exact:true}).boundingBox();
  await drag(page,dialog.getByRole('button',{name:'定位 艾莲',exact:true}),stage.width*.1,stage.height*.05);
  assert.ok(Math.abs(Number(await dialog.getByLabel('左 %',{exact:true}).inputValue())-25)<.5,`移动后左=${await dialog.getByLabel('左 %',{exact:true}).inputValue()}, stage=${JSON.stringify(stage)}`);
  await drag(page,dialog.getByRole('button',{name:'调整 艾莲 大小',exact:true}),stage.width*.1,-stage.height*.05);
  assert.ok(Math.abs(Number(await dialog.getByLabel('宽 %',{exact:true}).inputValue())-40)<.5);
  await dialog.getByLabel('左 %',{exact:true}).fill('99');
  const x=Number(await dialog.getByLabel('左 %',{exact:true}).inputValue()),w=Number(await dialog.getByLabel('宽 %',{exact:true}).inputValue());assert.ok(x+w<=100.1,'数值操作不能越界');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();assert.notDeepEqual(await value(page,'layout'),original);
  await page.getByRole('button',{name:'编辑 Layout',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
});
test('MOSS Layout 添加角色、物体和文字，角色只引用同一份描述',async t=>{
  const page=await editor(t);await page.getByRole('button',{name:'编辑 Layout',exact:true}).click();const dialog=page.getByRole('dialog',{name:'MOSS Layout',exact:true});
  await dialog.getByLabel('添加角色布局').selectOption('bob');assert.equal(await dialog.getByText('A man wearing a hat.',{exact:true}).count(),1);
  await dialog.getByRole('button',{name:'添加物体',exact:true}).click();await addEntry(dialog,'描述');await dialog.getByLabel('描述第 1 项 Prompt',{exact:true}).fill('A wooden table.');
  await dialog.getByRole('button',{name:'添加文字',exact:true}).click();await dialog.getByLabel('布局文字内容').fill('Welcome');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();const layout=await value(page,'layout');
  assert.equal(layout.items.length,4);assert.deepEqual(Object.keys(layout.items[1]).sort(),['bbox','character_id','id']);assert.equal(layout.items[2].entries[0].description,'A wooden table.');assert.equal(layout.items[3].text,'Welcome');
});
test('MOSS 条目和 Layout 在桌面/窄屏适配横竖画幅且不横向溢出',async t=>{
  const page=await editor(t);
  for(const width of [1200,360]){
    await page.setViewportSize({width,height:850});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const input=await page.getByLabel('场景第 1 项 Prompt',{exact:true}).boundingBox();assert.ok(input.width>width*.35,'正文保留可用宽度');
    for(const ratio of [.75,4/3]){
      await page.getByRole('button',{name:'编辑 Layout',exact:true}).click();await layoutReady(page);const dialog=page.getByRole('dialog',{name:'MOSS Layout',exact:true}),stage=await dialog.getByLabel('Layout 画布',{exact:true}).boundingBox();
      await page.screenshot({path:fileURLToPath(new URL(`../../../Saved/Tests/moss-integration/layout-${width}-${ratio.toFixed(2)}.png`,import.meta.url)),fullPage:true});
      assert.ok(Math.abs(stage.width/stage.height-ratio)<.01,`布局比例匹配生成画幅: ${JSON.stringify(stage)}, expected=${ratio}, viewport=${width}`);assert.ok(stage.width>100&&stage.height>100);
      assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'弹窗不横向溢出');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'切换画幅',exact:true}).click();
    }
  }
});
test('MOSS 页面角色描述保持实时继承，覆盖和恢复互不污染项目画风',async t=>{
  const page=await editor(t);await page.goto(`${url}?page`);await page.getByRole('button',{name:'更新来源设定',exact:true}).waitFor();
  await page.getByTitle('展开角色引用',{exact:true}).click();
  const source=page.locator('[data-reference-source="character:alice:day"]');await source.getByLabel('描述第 1 项 Prompt',{exact:true}).waitFor();
  assert.equal(await source.getByLabel('描述第 1 项 Prompt',{exact:true}).inputValue(),'A woman in a blue coat.');
  await page.getByRole('button',{name:'更新来源设定',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-reference-source="character:alice:day"] textarea')?.value==='A woman in a red coat.',{},{timeout:5000});
  await source.getByLabel('描述第 1 项 Prompt',{exact:true}).fill('A woman holding a letter.');assert.equal((await value(page,'page-prompt')).entry_overrides['character:alice:day'][0].description,'A woman holding a letter.');
  await source.getByRole('button',{name:'恢复继承',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-reference-source="character:alice:day"] textarea')?.value==='A woman in a red coat.',{},{timeout:5000});
  await page.getByText('画风 · 继承项目',{exact:true}).click();await page.getByRole('button',{name:'本页覆盖画风',exact:true}).click();await page.getByLabel('画风第 1 项 Prompt',{exact:true}).fill('Crisp anime line art.');
  assert.equal((await value(page,'page-prompt')).project_overrides.style[0].description,'Crisp anime line art.');
  await page.getByRole('button',{name:'恢复项目画风',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="画风第 1 项 Prompt"]')?.value==='Detailed watercolor.',{},{timeout:5000});assert.equal((await value(page,'page-prompt')).project_overrides.style,undefined);
  assert.equal(await page.locator('[data-prompt-category="camera"]').count(),0,'空分类只显示添加入口，不占用整行');
  await page.getByRole('button',{name:'＋ 镜头',exact:true}).click();await page.getByLabel('镜头第 1 项 Prompt',{exact:true}).fill('Eye-level medium shot.');
  assert.equal((await value(page,'page-prompt')).camera[0].description,'Eye-level medium shot.');
  await page.screenshot({path:fileURLToPath(new URL('../../../Saved/Tests/moss-integration/page-desktop.png',import.meta.url)),fullPage:true});
});
