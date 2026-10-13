import {mockSettingSave} from './setting-save-mock.mjs';
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

let server;
let browser;
let url;
before(async () => {
  server = await createServer({ cacheDir: ".temp/vite-prompt-editor-tests", root: fileURLToPath(new URL("../../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/prompt-editor.html`;
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const kind of ['character','scene']) test(`${kind} Ctrl+S 保存当前页全部修改，连续按键只提交一次`, async t => {
  const {page}=await editor(t,`?setting&${kind}`),writes=[];
  await mockSettingSave(page,writes,{delay:200});
  await page.getByLabel(kind==='scene'?'场景设定':'角色设定',{exact:true}).fill('新的说明');
  const input=page.getByLabel('Prompt 名称',{exact:true});await input.fill('新的 Prompt 名称');
  await input.press('Control+s');await page.keyboard.press('Control+s');
  await page.getByText('当前设定已保存',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].target.kind,kind);
  assert.equal(writes[0].profile.value.description,'新的说明');assert.equal(writes[0].prompt.prompt_name,'新的 Prompt 名称');
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(100);assert.equal(writes.length,1,'无修改时快捷键不重复写入');
});

test('输入法合成与打开弹窗时 Ctrl+S 不保存背景设定',async t=>{
  const {page}=await editor(t,'?setting'),writes=[];await mockSettingSave(page,writes);
  const input=page.getByLabel('Prompt 名称',{exact:true});await input.fill('草稿');
  await input.dispatchEvent('keydown',{key:'s',ctrlKey:true,isComposing:true,bubbles:true});
  await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.id='test-modal';document.body.append(dialog);dialog.showModal();});
  await page.keyboard.press('Control+s');await page.waitForTimeout(100);assert.equal(writes.length,0);
  await page.evaluate(()=>document.querySelector('#test-modal').remove());
  await input.press('Meta+s');await page.getByText('当前设定已保存',{exact:true}).waitFor();assert.equal(writes.length,1);
});

test('参考图先保留为草稿，随当前子设定统一保存',async t=>{
  const {page}=await editor(t,'?setting&variant=day'),writes=[];await mockSettingSave(page,writes);
  let immediateWrites=0;
  await page.route('**/workbench/reference-library',route=>{immediateWrites++;return route.fulfill({json:{entries:[],sha256:'unused'}});});
  await page.getByRole('button',{name:'添加参考图',exact:true}).click();
  await page.getByLabel('上传参考图').click();
  await page.locator('input[type=file]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64')});
  await page.getByRole('dialog',{name:'确认上传',exact:true}).getByRole('button',{name:'确认添加',exact:true}).click();
  await page.getByRole('dialog',{name:'选择参考图',exact:true}).waitFor({state:'hidden'});
  assert.equal(writes.length,0);assert.equal(immediateWrites,0);
  await page.getByLabel('白天 子设定 Prompt').fill('包含新参考图的描述');await page.keyboard.press('Control+s');
  await page.getByText('当前设定已保存',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].prompt.reference_images.length,2);
  assert.equal(writes[0].prompt.reference_images[1].draft,undefined);assert.ok(writes[0].reference_inputs[0].content);
});

for (const deleted of [false,true]) test(`服务器冲突刷新保留其他草稿，不重试写入：${deleted?'子设定已删除':'同范围改写'}`,async t=>{
  const {page}=await editor(t,'?setting'),writes=[];
  await page.getByLabel('Prompt 名称',{exact:true}).fill('未保存的基础');
  await page.getByRole('button',{name:'打开白天',exact:true}).click();
  await page.getByLabel('白天 子设定 Prompt').fill('过时草稿');
  await page.route('**/workbench/setting-save',route=>{writes.push(route.request().postDataJSON());return route.fulfill({status:409,json:{error:'prompt_scope_conflict',refresh_required:true}});});
  await page.route('**/workbench/setting-detail?*',async route=>{
    const setting=JSON.parse(await page.locator('#setting-state').textContent());
    setting.prompt.variants.day.text='服务器最新白天';setting.prompt_sha256='fresh';setting.prompt_scope_versions.qwen.variants.day='fresh-day';setting.model_prompts={models:{qwen:setting.prompt}};
    if (deleted) {setting.visual.variants=setting.visual.variants.filter(v=>v.id!=='day');setting.visual_sha256='deleted-day';delete setting.prompt.variants.day;delete setting.prompt_scope_versions.qwen.variants.day;}
    await route.fulfill({json:setting});
  });
  await page.keyboard.press('Control+s');
  await page.getByText('内容已更新，过时的修改已丢弃，请在最新内容上重新编辑。',{exact:true}).waitFor();
  if (!deleted) assert.equal(await page.getByLabel('白天 子设定 Prompt').inputValue(),'服务器最新白天');assert.equal(writes.length,1);
  await page.getByRole('button',{name:'打开基础',exact:true}).click();assert.equal(await page.getByLabel('Prompt 名称',{exact:true}).inputValue(),'未保存的基础');
});

test('子设定改名、ID 和 Prompt 同次保存，隐藏基础草稿不受影响',async t=>{
  const {page}=await editor(t,'?setting'),writes=[];await mockSettingSave(page,writes);
  await page.getByLabel('Prompt 名称',{exact:true}).fill('保留基础');
  await page.getByRole('button',{name:'打开白天',exact:true}).click();
  await page.getByRole('button',{name:'重命名子设定',exact:true}).click();await page.getByRole('textbox',{name:'重命名子设定',exact:true}).fill('清晨');
  await page.getByLabel('子设定 ID',{exact:true}).fill('morning');await page.getByLabel('清晨 子设定 Prompt').fill('清晨的新描述');
  await page.keyboard.press('Control+s');await page.getByText('当前设定已保存',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].variant.value.id,'morning');assert.equal(writes[0].variant.value.name,'清晨');assert.equal(writes[0].prompt.text,'清晨的新描述');
  assert.equal(await page.getByLabel('子设定 ID',{exact:true}).inputValue(),'morning');
  await page.getByRole('button',{name:'打开基础',exact:true}).click();assert.equal(await page.getByLabel('Prompt 名称',{exact:true}).inputValue(),'保留基础');
});

async function editor(t, query = "") {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "组件不应产生浏览器异常或 ResizeObserver 循环");
  });
  await page.goto(url + query);
  return { page };
}

test("自由文本框随宽度换行并随内容自适应高度，失焦后仍完整显示", async t => {
  const { page } = await editor(t);
  const input = page.getByLabel("自由文本 Prompt");
  await input.waitFor();
  await page.locator("#host").evaluate(e => { e.style.width = "180px"; });
  await input.fill("一条足够长的整段描述文字，用来验证窄宽度下自动换行后高度随内容增长，而不是裁切或出现内部滚动");
  await page.waitForFunction(() => { const e = document.querySelector("textarea.prompt-free-text"); return e.clientHeight >= e.scrollHeight && e.clientHeight > 60; });
  const grown = await input.evaluate(e => e.clientHeight);
  await input.focus(); await input.press("Tab");
  assert.equal(await input.evaluate(e => e.clientHeight), grown, "失焦不收缩");
  await input.fill("短");
  await page.waitForFunction(height => { const e = document.querySelector("textarea.prompt-free-text"); return e.clientHeight < height; }, grown);
  await page.locator("#host").evaluate(e => { e.style.display = "none"; });
  await page.waitForFunction(() => document.querySelector("textarea.prompt-free-text").clientWidth === 0);
  await page.locator("#host").evaluate(e => { e.style.width = "1000px"; e.style.display = "block"; });
  await input.focus();
  await input.fill("恢复显示后的一整段自由文本，依然完整可读");
  assert.equal(await input.inputValue(), "恢复显示后的一整段自由文本，依然完整可读");
  assert.equal(JSON.parse(await page.locator("output").textContent()).value, "恢复显示后的一整段自由文本，依然完整可读");
});

test("输入法合成确认保留中文与未提交英文，组合中的 Enter 不误判提交", async t => {
  const { page } = await editor(t);
  const input = page.getByLabel("自由文本 Prompt");
  await input.waitFor();
  await input.focus();
  await input.press("Control+End");
  await input.pressSequentially(" abc");
  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await client.send("Input.insertText", { text: "你好" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await input.inputValue(), "quiet hallway under dim lights abc你好");
  assert.equal(JSON.parse(await page.locator("output").textContent()).value, "quiet hallway under dim lights abc你好");
  await input.press("Control+a");
  await client.send("Input.imeSetComposition", { text: "整段替换", selectionStart: 4, selectionEnd: 4 });
  await client.send("Input.insertText", { text: "整段替换" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await input.inputValue(), "整段替换");
  await client.detach();
});

test("设定页编辑 Prompt 名称与子设定文字，只保存各自范围并保留参考图", async t => {
  const { page } = await editor(t, "?setting");
  const writes = [];
  await mockSettingSave(page,writes);
  await page.route("**/workbench/reference-library", route => route.fulfill({ json: { entries: [{ id: "ref-11111111-1111-4111-8111-111111111111", file: "reference-11111111.png", title: "正面" }], sha256: "refs" } }));
  const name = page.getByLabel("Prompt 名称", { exact: true });
  await name.waitFor();
  assert.equal(await name.inputValue(), "艾莲", "创建时默认复制显示名");
  await name.fill("艾莲·Qwen");
  await page.getByRole("button", { name: "保存当前设定", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("当前设定已保存"));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].target, { kind: 'character', id: 'alice', model_id: 'qwen', scope: 'base' });
  assert.deepEqual(writes[0].prompt, { prompt_name: "艾莲·Qwen" });
  assert.equal(writes[0].expected_prompt_sha256, "base-version");
  await page.goto(`${url}?setting&variant=day`);
  const text = page.getByLabel("白天 子设定 Prompt");
  await text.waitFor();
  assert.equal(await text.inputValue(), "艾莲白天的完整描述");
  assert.equal(await page.getByLabel("机位控制", { exact: true }).count(), 0);
  assert.equal(await page.getByText("基础 LoRA", { exact: true }).count(), 0);
  await text.fill("重写后的整段造型描述\n第二行补充");
  await page.getByRole("button", { name: "保存当前设定", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("当前设定已保存"));
  assert.deepEqual(writes.at(-1).target, { kind: 'character', id: 'alice', model_id: 'qwen', scope: 'variant', variant_id: 'day' });
  assert.equal(writes.at(-1).expected_prompt_sha256, "day-version");
  assert.deepEqual(Object.keys(writes.at(-1).prompt), ["text", "reference_images"], "子设定只有整段文字与参考图");
  assert.equal(writes.at(-1).prompt.text, "重写后的整段造型描述\n第二行补充");
  assert.equal(writes.at(-1).prompt.reference_images[0].file, "reference-11111111.png", "参考图条目随保存保留");
});

test("设定范围独立保留草稿，兄弟范围刷新不冲突且保存只清除当前范围", async t => {
  const { page } = await editor(t, "?setting");
  const writes = [];
  await mockSettingSave(page,writes);
  await page.route("**/workbench/reference-library", route => route.fulfill({ json: { entries: [], sha256: "refs" } }));
  await page.getByLabel("Prompt 名称", { exact: true }).fill("基础名称草稿");
  await page.getByRole('button', { name: '打开白天', exact: true }).click();
  await page.getByLabel("白天 子设定 Prompt").fill("白天草稿");
  await page.getByRole('button', { name: '外部更新夜晚', exact: true }).click();
  assert.equal(await page.getByLabel("白天 子设定 Prompt").inputValue(), '白天草稿');
  assert.equal(await page.getByText('设定已被其他操作修改，当前草稿保留。').count(), 0);
  await page.getByRole('button', { name: '保存当前设定', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("当前设定已保存"));
  assert.equal(writes[0].expected_prompt_sha256, 'day-version');
  assert.equal(writes[0].prompt.text, '白天草稿');
  await page.getByRole('button', { name: '打开基础', exact: true }).click();
  assert.equal(await page.getByLabel("Prompt 名称", { exact: true }).inputValue(), '基础名称草稿');
  assert.equal(await page.getByRole('button', { name: '保存当前设定', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '打开夜晚', exact: true }).click();
  assert.equal(await page.getByLabel("夜晚 子设定 Prompt").inputValue(), '外部更新的夜晚描述');
  assert.equal(await page.locator('[data-project-fact-dirty=true]').count(),1,'基础草稿仍保留');
});

test("同范围外部变化直接丢弃过时草稿，其他基础草稿保留", async t => {
  const {page}=await editor(t,'?setting');
  await page.getByLabel('Prompt 名称',{exact:true}).fill('基础草稿保留');
  await page.getByRole('button',{name:'打开夜晚',exact:true}).click();
  const input=page.getByLabel('夜晚 子设定 Prompt');await input.fill('尚未保存的草稿');
  await page.getByRole('button',{name:'外部更新夜晚',exact:true}).click();
  await page.getByText('内容已更新，过时的修改已丢弃，请在最新内容上重新编辑。',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),'外部更新的夜晚描述');
  await page.getByRole('button',{name:'打开基础',exact:true}).click();
  assert.equal(await page.getByLabel('Prompt 名称',{exact:true}).inputValue(),'基础草稿保留');
});

test("Prompt 名称为空时禁止保存并提示", async t => {
  const { page } = await editor(t, "?setting");
  const name = page.getByLabel("Prompt 名称", { exact: true });
  await name.waitFor();
  await name.fill("");
  assert.equal(await page.getByRole("button", { name: "保存当前设定", exact: true }).isDisabled(), true);
  await page.getByText("Prompt 名称不能为空。").waitFor();
});
