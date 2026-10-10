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
async function open(t,query,setup,options={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000},...options});page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 await page.route('**/api/projects/test/materials', route => route.fulfill({json:{materials:[{file:'reference.png',title:'角色参考',available:true,url:null}]}}));
 await page.route('**/workbench/reference-library',route=>route.fulfill({json:{entries:query.includes('extra')?[{id:'ref-33333333-3333-4333-8333-333333333333',file:'reference-extra.png',title:'附加图'}]:[],sha256:'refs'}}));
 await setup?.(page);
 await page.goto(`${origin}/tests/browser/unified-page.html?${query}`);
 if(!query.includes('collapsed')) { await page.getByTitle('展开角色引用').click(); await page.getByTitle('展开场景引用').click(); }
 return page;
}
test('Anima 放弃修改清空撤销和重做历史，之后的新编辑仍可撤销', async t => {
 const page=await open(t,'anima&collapsed',async page=>{
   await page.route('**/api/prompt-dictionary**',route=>route.fulfill({json:{available:true,suggestions:[],matches:[]}}));
 });
 const first=page.getByRole('checkbox',{name:'场景第 1 项参与生成'});
 const second=page.getByRole('checkbox',{name:'场景第 2 项参与生成'});
 const save=page.getByRole('button',{name:'保存',exact:true});
 await first.press('Space'); await second.press('Space');
 assert.equal(await first.isChecked(),false); assert.equal(await second.isChecked(),false);
 const input=page.getByRole('combobox',{name:'场景第 1 项 Prompt'});
 // 保留过去和未来两端历史，再放弃全部修改。
 await input.press('Control+z');
 assert.equal(await first.isChecked(),false); assert.equal(await second.isChecked(),true);
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 for(const key of ['Control+z','Control+y']) {
   await input.press(key);
   assert.equal(await first.isChecked(),true); assert.equal(await second.isChecked(),true);
   assert.equal(await save.isDisabled(),true);
 }
 await first.press('Space');
 assert.equal(await save.isEnabled(),true);
 await input.press('Control+z');
 await page.waitForFunction(()=>document.querySelector('[aria-label="场景第 1 项参与生成"]').checked);
 assert.equal(await first.isChecked(),true); assert.equal(await save.isDisabled(),true);
});

test('新引用按需读取，失败时保留草稿且不得保存，重试后携带读据', async t => {
 let requests=0;
 const page=await open(t,'kind=story&lazy-reference',async page=>{
   await page.route('**/workbench/setting-detail?*',async route=>{
     requests++;
     if(requests===1)return route.fulfill({status:503,json:{error:'暂时不可用'}});
     const prompt={prompt_name:'鲍勃',variants:{day:{text:requests > 2 ? '更新后的鲍勃设定' : '刚读取的鲍勃设定'},night:{text:'夜间'}}};
     return route.fulfill({json:{model_id:'qwen',model_prompts:{models:{qwen:prompt}},id:'bob',name:'鲍勃',description:'',profile_sha256:'profile',visual_sha256:'visual',prompt_sha256:'loaded',
       visual:{variants:[{id:'day',name:'白天'},{id:'night',name:'夜晚'}]},
       prompt:{prompt_name:'鲍勃',variants:{day:{text:requests > 2 ? '更新后的鲍勃设定' : '刚读取的鲍勃设定'},night:{text:'夜间'}}},
       prompt_source_versions:{qwen:{day:requests > 2 ? 'source-after-reload' : 'source-at-read'}}}});
   });
 });
 assert.equal(requests,0);
 await page.getByTitle('选择角色',{exact:true}).click();
 await page.locator('.reference-picker-menu label').filter({hasText:'鲍勃 · 白天'}).getByRole('checkbox').check();
 await page.getByRole('alert').filter({hasText:'暂时不可用'}).waitFor();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('saved-page')),null);
 await page.getByRole('button',{name:'重试',exact:true}).click();
 await page.getByLabel('鲍勃 · 白天 引用文字').waitFor();
 assert.equal(await page.getByLabel('鲍勃 · 白天 引用文字').inputValue(),'刚读取的鲍勃设定');
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 if (!await page.locator('.reference-picker-menu label').filter({hasText:'鲍勃 · 白天'}).isVisible()) await page.getByTitle('选择角色',{exact:true}).click();
 await page.locator('.reference-picker-menu label').filter({hasText:'鲍勃 · 白天'}).getByRole('checkbox').check();
 await page.waitForFunction(()=>document.querySelector('[aria-label="鲍勃 · 白天 引用文字"]')?.value==='更新后的鲍勃设定');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('submitted-sources')))['character:bob:day'],'source-after-reload');
 assert.equal(requests,3);
});

for(const kind of ['story','character','scene'])test(`${kind} 页面均可编辑人物、场景、嵌字并移除默认引用`,async t=>{
 const page=await open(t,`kind=${kind}`);
 assert.equal(await page.getByLabel('艾莲角色设定').inputValue(),'day');
 assert.equal(await page.getByLabel('页面场景设定').inputValue(),'room:day');
 await page.getByRole('tab',{name:'嵌字',exact:true}).click();
 await page.getByLabel('旁白',{exact:true}).fill('统一文案');
 await page.getByRole('tab',{name:'视觉描述 / Prompt',exact:true}).click();
 await page.getByTitle('展开角色引用').click(); await page.getByTitle('展开场景引用').click();
 await page.getByRole('button',{name:'移除艾莲',exact:true}).click();
 await page.getByRole('button',{name:'移除场景引用',exact:true}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.deepEqual(saved.content.characters,[]);assert.equal(saved.prompt.scene_id,undefined);assert.equal(saved.prompt.scene_variant_id,undefined);
 assert.equal(saved.content.dialogue[0].text,'统一文案');
 assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
});

test('解除 Anima 角色引用在网页草稿中立即清除绑定词和触发词来源，保留未绑定词',async t=>{
 const page=await open(t,'bound-anima&collapsed',async page=>{
   await page.route('**/api/prompt-dictionary**',route=>route.fulfill({json:{available:true,suggestions:[],matches:[]}}));
 });
 await page.getByRole('button',{name:'移除艾莲',exact:true}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.deepEqual(saved.content.characters,[]);
 assert.deepEqual(saved.prompt.person,[{tag:'shared_word'}]);
 assert.deepEqual(saved.prompt.trigger_sources.characters,{});
});
test('参考图默认选首张，多选和停用保存在同一设定卡片；恢复默认不存重复选择',async t=>{
 const page=await open(t,'kind=story');
 const card=page.locator('[data-reference-source="character:alice:day"]');
 assert.equal(await card.locator('.reference-toggle').nth(0).getAttribute('aria-pressed'),'true');
 assert.equal(await card.locator('.reference-toggle').nth(1).getAttribute('aria-pressed'),'false');
 await card.locator('.reference-toggle').nth(1).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('saved-page')??'null')?.prompt.reference_overrides?.['character:alice:day']?.length===2);
 await card.locator('.reference-toggle').nth(0).click(); await card.locator('.reference-toggle').nth(1).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('saved-page')??'null')?.prompt.reference_overrides?.['character:alice:day']?.length===0);
 await card.getByRole('button',{name:'恢复默认',exact:true}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('saved-page')??'null')?.prompt.reference_overrides?.['character:alice:day']);
 assert.equal(await card.locator('.reference-toggle').nth(0).getAttribute('aria-pressed'),'true');
 assert.equal(await page.getByRole('button',{name:'自定义',exact:true}).count(),0);
});

test('场景子设定切换后失败保留全部草稿，重试提交新引用并清除旧文字覆盖',async t=>{
 const page=await open(t,'kind=scene&fail-once');
 await page.getByLabel('艾莲 · 白天 引用文字').fill('本页覆盖的角色描述');
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
 assert.equal(saved.content.scene_description,'夜间窗边休息');assert.deepEqual(saved.prompt.text_overrides,{});assert.deepEqual(saved.prompt.reference_overrides,{});
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
 assert.equal(await page.getByLabel('页面场景设定').count(),0);
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

test('展开后选择角色和场景，保存引用；移除场景后保留紧凑入口',async t=>{
 const page=await open(t,'kind=story&empty');
 await page.getByTitle('选择角色',{exact:true}).click();
 await page.locator('.reference-picker-menu label').filter({hasText:'艾莲 · 白天'}).getByRole('checkbox').check();
 await page.getByTitle('选择场景',{exact:true}).click();
 await page.getByPlaceholder('搜索场景').fill('房间');
 await page.locator('.reference-picker-menu label').filter({hasText:'房间 · 白天'}).getByRole('checkbox').check();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.equal(saved.prompt.scene_id,'room');assert.deepEqual(saved.content.characters,[{character_id:'alice',variant_id:'day'}]);
 await page.getByRole('button',{name:'移除场景引用',exact:true}).click();
 assert.equal(await page.getByLabel('页面场景设定').count(),0);
});

test('场景搜索选择与标签显示沿用角色交互，替换时保持单选，可再次取消',async t=>{
 const page=await open(t,'kind=story');
 await page.getByTitle('选择场景',{exact:true}).click();
 await page.getByPlaceholder('搜索场景').fill('街道');
 const menu=page.locator('details').filter({has:page.getByPlaceholder('搜索场景')}).last();
 const options=menu.locator('.reference-picker-menu label');
 assert.equal(await options.count(),2);
 await options.filter({hasText:'街道 · 白天'}).getByRole('checkbox').check();
 assert.equal(await page.getByLabel('页面场景设定').inputValue(),'street:day');
 await page.getByPlaceholder('搜索场景').fill('');
 assert.equal(await menu.locator('.reference-picker-menu input:checked').count(),1);
 assert.equal(await page.locator('[data-reference-source="scene:room:day"]').count(),0);
 await page.getByLabel('页面场景设定').selectOption('street:night');
 assert.equal(await options.filter({hasText:'街道 · 夜晚'}).getByRole('checkbox').isChecked(),true);
 await options.filter({hasText:'街道 · 夜晚'}).getByRole('checkbox').uncheck();
 assert.equal(await page.getByLabel('页面场景设定').count(),0);
 assert.equal(await page.getByTitle('选择场景',{exact:true}).isVisible(),true);
});

for (const width of [1400,390]) test('角色和场景默认收起，窄屏保留触屏手柄空间 '+width,async t=>{
 const page=await open(t,'kind=story&collapsed');await page.setViewportSize({width,height:1000});
 const rows=page.locator('.page-reference-rows');
 assert.equal(await rows.locator('.page-reference-row').count(),2);
 assert.equal(await rows.locator('.reference-disclosure[aria-expanded="true"]').count(),0);
 const size=await rows.boundingBox();assert.ok(size.height<=(width<680?145:80), '引用区域总高度为 '+size.height);
 assert.equal(await rows.locator('img:visible').count(),0);
 assert.equal(await rows.locator('.page-reference-header .character-setting-chip').count(),2);
 assert.equal(await page.getByLabel('页面场景设定').isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'移除艾莲',exact:true}).isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'管理参考图',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:/添加图片|上移|前移/}).count(),0);
 await page.getByTitle('展开角色引用').click();
 assert.equal(await rows.locator('img:visible').count(),2);
});

test('展开角色行后用拖拽改变引用顺序',async t=>{
 const page=await open(t,'kind=story');
 await page.getByTitle('选择角色',{exact:true}).click();
 await page.locator('.reference-picker-menu label').filter({hasText:'鲍勃 · 白天'}).getByRole('checkbox').check();
 await page.getByTitle('选择角色',{exact:true}).click();
 const from=await page.getByRole('button',{name:'拖动排序：鲍勃',exact:true}).boundingBox();
 const to=await page.getByRole('button',{name:'拖动排序：艾莲',exact:true}).boundingBox();
 await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
 await page.mouse.move(to.x,to.y+to.height/2,{steps:8});await page.mouse.up();
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')).content.characters.map(r=>r.character_id)),['bob','alice']);
});

test('手机触屏可跨行拖动角色，顺序随页面保存',async t=>{
 const page=await open(t,'kind=story&collapsed',undefined,{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await page.evaluate(()=>{const meta=document.createElement('meta');meta.name='viewport';meta.content='width=device-width, initial-scale=1';document.head.append(meta);document.querySelector('#root > div').style.padding='8px';});
 await page.getByTitle('选择角色',{exact:true}).click();
 await page.locator('.reference-picker-menu label').filter({hasText:'鲍勃 · 白天'}).getByRole('checkbox').check();
 await page.getByTitle('选择角色',{exact:true}).click();
 // 让标签换行，验证真实 touch 输入不会被浏览器滚动接管。
 await page.locator('.reference-chips').first().evaluate(e=>e.style.maxWidth='210px');
 const handle=page.getByRole('button',{name:'拖动排序：鲍勃',exact:true});
 await handle.scrollIntoViewIfNeeded();
 const from=await handle.boundingBox();
 const to=await page.getByRole('button',{name:'拖动排序：艾莲',exact:true}).boundingBox();
 assert.ok(from.width>=44 && from.height>=44);
 assert.ok(from.y>to.y,'标签应跨行');
 const cdp=await page.context().newCDPSession(page);
 const start={x:from.x+from.width/2,y:from.y+from.height/2};
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
 for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(to.x-start.x)*step/8,y:start.y+(to.y+to.height/2-start.y)*step/8}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await cdp.detach();
 await page.setViewportSize({width:1400,height:1000});
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')).content.characters.map(r=>r.character_id)),['bob','alice']);
});

test('手机人数选择与无人物切换保存为原有人数词',async t=>{
 const page=await open(t,'anima&collapsed',undefined,{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await page.evaluate(()=>{const meta=document.createElement('meta');meta.name='viewport';meta.content='width=device-width, initial-scale=1';document.head.append(meta);document.querySelector('#root > div').style.padding='8px';});
 await page.getByLabel('girl 人数选择',{exact:true}).selectOption('2');
 await page.getByLabel('boy 人数选择',{exact:true}).selectOption('1');
 await page.setViewportSize({width:1400,height:1000});
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')).prompt.population.map(f=>f.tag)),['2girls','1boy']);
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('checkbox',{name:'无人物',exact:true}).check();
 await page.setViewportSize({width:1400,height:1000});
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('saved-page')).prompt.population[0]?.tag==='no_humans');
 assert.equal(await page.getByLabel('girl 人数选择',{exact:true}).inputValue(),'0');
});

test('引用文字默认生效，缩略图切换颜色，底部只读汇总随草稿变化并包含附图',async t=>{
 const page=await open(t,'kind=story&extra');
 const card=page.locator('[data-reference-source="character:alice:day"]');
 const images=page.getByLabel('最终启用的参考图');
 assert.equal(await images.locator('img').count(),3);
 assert.equal(await images.locator('.inherited-reference-image').count(),2);
 assert.equal(await images.getByRole('button',{name:'添加参考图',exact:true}).count(),1);
 const textField=card.getByLabel('艾莲 · 白天 引用文字');
 assert.equal(await textField.inputValue(),'艾莲白天的完整描述');
 assert.equal(await card.getByText('已覆盖',{exact:true}).count(),0);
 await textField.fill('本页覆盖的角色描述');
 await card.getByText('已覆盖',{exact:true}).waitFor();
 assert.equal(await card.locator('.reference-selection input').count(),0);
 assert.equal(await card.locator('.reference-selection').innerText(),'');
 const second=card.locator('.reference-toggle').nth(1);
 assert.equal(await second.locator('img').evaluate(e=>getComputedStyle(e).filter),'grayscale(1)');
 await second.press('Space');
 assert.equal(await images.locator('img').count(),4);
 assert.equal(await second.getAttribute('aria-pressed'),'true');
 await card.locator('.reference-toggle').nth(0).click();
 assert.equal(await images.locator('img').count(),3);
 const files=await images.locator('img').evaluateAll(imgs=>imgs.map(img=>new URL(img.src).searchParams.get('file')));
 assert.deepEqual(files,['reference-22222222.png','reference-11111111.png','reference-extra.png']);
 const root=page.locator('.current-workbench-prompts');
 assert.equal(await root.getByLabel('最终启用的参考图').isVisible(),true);
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.equal(saved.prompt.text_overrides['character:alice:day'],'本页覆盖的角色描述');
 assert.equal(await images.locator('img').count(),3);
});


test('未保存内容可添加附图，放弃恢复，保存失败保留附图草稿',async t=>{
 const page=await open(t,'kind=story&fail-once');let writes=0;
 await page.route('**/workbench/reference-library',route=>{writes++;return route.fulfill({json:{entries:[],sha256:'refs'}});});
 await page.getByLabel('画面内容').fill('未保存的画面');
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();
 await page.getByRole('button',{name:'角色参考',exact:true}).click();
 await page.getByRole('button',{name:'添加 1 张',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(writes,0);assert.equal(await page.getByLabel('画面内容').inputValue(),'未保存的画面');
 assert.equal(await page.locator('[data-reference-card]').count(),1);
 await page.getByRole('button',{name:'放弃修改',exact:true}).click();assert.equal(await page.locator('[data-reference-card]').count(),0);
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();await page.getByRole('button',{name:'角色参考',exact:true}).click();await page.getByRole('button',{name:'添加 1 张',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').filter({hasText:'草稿已保留'}).waitFor();assert.equal(await page.locator('[data-reference-card]').count(),1);
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')).prompt.reference_images[0].draft.material_file),'reference.png');assert.equal(writes,0);
});

for (const outcome of ['success','save-failure','missing-saved-image']) test('附图草稿保存并生成完整检查：'+outcome,async t=>{
 const events=[],requests=[]; let savedPrompt=null;
 const page=await open(t,'kind=story&workspace&extra&collapsed',async page=>{
  await page.route('**/workbench/page-media',route=>route.fulfill({json:{media:{candidates:[]},revision:'media'}}));
  await page.route('**/workbench/page-render-inspection',route=>{
   const body=route.request().postDataJSON();requests.push(body);
   const strict=!body.prompt;if(strict)events.push('strict-inspection');
   const missing=(body.prompt?.reference_images??[]).some(entry=>entry.file!=='reference-extra.png')||(strict&&outcome==='missing-saved-image');
   return route.fulfill({json:{inspection:{ready:!missing,blockers:missing?[{code:'reference_image_unavailable',message:'真实图片缺失'}]:[],audit:{status:'complete',errors:[],warnings:[]},generation_signature:'signature'}}});
  });
  await page.route('**/workbench/page-save',route=>{
   events.push('save');const body=route.request().postDataJSON();
   if(outcome==='save-failure')return route.fulfill({status:409,json:{error:'模拟保存失败'}});
   assert.ok(body.reference_inputs.length);savedPrompt=body.prompt;
   return route.fulfill({json:{content:body.content,prompt:body.prompt,lettering:body.lettering,content_sha256:'saved-content',prompt_sha256:'saved-prompt',prompt_context_sha256:'context',layout_sha256:'layout'}});
  });
  await page.route('**/workbench/render',route=>{events.push('render');return route.fulfill({json:{task:{task_id:'render-test'}}});});
 });
 await page.getByRole('button',{name:'添加参考图',exact:true}).click();
 await page.getByRole('button',{name:'角色参考',exact:true}).click();
 await page.getByRole('button',{name:'添加 1 张',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.waitForTimeout(400);
 assert.deepEqual(requests.at(-1).prompt.reference_images.map(entry=>entry.file),['reference-extra.png'],'检查只跳过待保存附图，保留真实附图');
 const generate=page.locator('.desktop-page-actions .generate-split__action');
 assert.equal(await generate.isDisabled(),false);
 await generate.click();
 if(outcome==='success'){
  await page.waitForFunction(()=>document.body.innerText.includes('已启动当前页面任务'));
  assert.deepEqual(events,['save','strict-inspection','render']);assert.equal(savedPrompt.reference_images.length,2);
 }else{
  await page.getByText(outcome==='save-failure'?'保存未完成，已取消生成':'真实图片缺失',{exact:true}).first().waitFor();
  assert.deepEqual(events,outcome==='save-failure'?['save']:['save','strict-inspection']);
 }
});

test('机位独立参数保存、重开恢复与清除不影响自由镜头',async t=>{
 const page=await open(t,'anima&collapsed');
 await page.getByRole('button',{name:'机位控制',exact:true}).click();
 const dialog=page.getByRole('dialog');
 for(const name of ['中景','特写','越肩','强调透视','透视缩短','女性第一人称'])assert.equal(await dialog.getByRole('button',{name,exact:true}).count(),0);
 await dialog.getByRole('button',{name:'侧面',exact:true}).click();
 await dialog.getByRole('button',{name:'全身',exact:true}).click();
 await dialog.getByRole('button',{name:'运动线',exact:true}).click();
 assert.match(await dialog.getByLabel('机位 Prompt 预览').textContent(),/from_side, full_body, motion_lines/);
 await dialog.getByRole('button',{name:'应用到草稿'}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>localStorage.getItem('saved-page'));
 let saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('saved-page')));
 assert.deepEqual(saved.prompt.camera_settings,{direction:'side',shot:'full_body',motionLines:true});
 assert.deepEqual(saved.prompt.camera,[]);
 await page.getByRole('button',{name:'机位控制',exact:true}).click();
 assert.equal(await dialog.getByRole('button',{name:'运动线',exact:true}).getAttribute('aria-pressed'),'true');
 await dialog.getByRole('button',{name:'清除机位'}).click();await dialog.getByRole('button',{name:'应用到草稿'}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('saved-page')).prompt.camera_settings);
});
