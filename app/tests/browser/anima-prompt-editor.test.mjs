function promptText(element) { const copy = element.cloneNode(true); copy.querySelectorAll('[data-prompt-note]').forEach(note => note.remove()); return copy.textContent; }
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { buildPromptDictionary, searchPromptDictionaryPage } from "../../server/prompt-dictionary.mjs";

test('空标签与空描述转换往返保留类型，页面不写入临时 ID', async t => {
  const { page } = await editor(t);
  const result = await page.evaluate(async () => {
    const {displayFragmentList,persistFragmentList}=await import('/src/prompt-fragment-draft.ts');
    const input=[{tag:''},{description:''},{tag:'long_hair',enabled:false,weight:1.2}];
    const draft=displayFragmentList(input);
    return {types:draft.map(fragment=>fragment.prompt_type),persisted:persistFragmentList(draft)};
  });
  assert.deepEqual(result.types,['danbooru','custom_description','danbooru']);
  assert.deepEqual(result.persisted,[{tag:''},{description:''},{tag:'long_hair',enabled:false,weight:1.2}]);
});

let server;
let browser;
let url;
before(async () => {
  server = await createServer({ cacheDir: ".temp/vite-anima-prompt-editor-tests", root: fileURLToPath(new URL("../../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/anima-prompt-editor.html`;
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
});
after(async () => { await browser?.close(); await server?.close(); });

async function editor(t, { viewport = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.promptTestErrors = [];
    window.addEventListener("error", event => window.promptTestErrors.push(event.message));
  });
  t.after(async () => {
    errors.push(...await page.evaluate(() => window.promptTestErrors));
    await page.close();
    assert.deepEqual(errors, [], "组件不应产生浏览器异常或 ResizeObserver 循环");
  });
  if (viewport) await page.addInitScript(() => {
    // 模拟键盘只改变 visualViewport，保留布局视口；手机实机仍需单独验收。
    const visual = new EventTarget();
    Object.assign(visual, { offsetTop: 100, offsetLeft: 160, width: 520, height: 400 });
    Object.defineProperty(window, "visualViewport", { value: visual });
  });
  await page.route("**/api/prompt-dictionary**", route => route.fulfill({ json: route.request().method() === "POST"
    ? { available: true, matches: [] }
    : { available: true, suggestions: [{ display_text: "安静", prompt_text: "quiet", source_text: "quiet" }, { display_text: "夜晚", prompt_text: "night", source_text: "night" }], has_more: false } }));
  await page.goto(url);
  const input = page.getByRole("combobox", { name: "场景第 1 项 Prompt" });
  await input.waitFor();
  return { page, input, options: page.locator("button[role=option]") };
}

test("手机词条常驻权重且同排显示，二级菜单保留开关和删除", async t => {
  const { page, input } = await editor(t);
  await page.evaluate(() => { document.querySelector('#host').style.cssText = 'width:100%;margin-top:0'; });
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 700 });
    const trigger = page.getByRole('button', { name: '场景第 1 项选项', exact: true });
    await trigger.waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 0);
    const bounds = await input.boundingBox();
    assert.ok(bounds.width > width - 190, `正文应充分利用 ${width}px 宽度：${bounds.width}`);
    const weight = page.getByRole('button', { name: /^场景第 1 项权重 / });
    const weightBounds = await weight.boundingBox();
    assert.ok(Math.max(bounds.y, weightBounds.y) < Math.min(bounds.y + bounds.height, weightBounds.y + weightBounds.height), '正文与权重同排');
    await weight.click();
    const weightRect = await page.getByRole('dialog').boundingBox();
    assert.ok(weightRect.x >= 0 && weightRect.x + weightRect.width <= width);
    await page.keyboard.press('Escape');
    const triggerBounds = await trigger.boundingBox();
    assert.ok(Math.max(bounds.y, triggerBounds.y) < Math.min(bounds.y + bounds.height, triggerBounds.y + triggerBounds.height), '正文与选项同排');
    await trigger.click();
    const menu = page.getByRole('dialog');
    assert.equal(await menu.getByRole('spinbutton').count(), 0);
    const rect = await menu.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= 700);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
  }
  const trigger = page.getByRole('button', { name: '场景第 1 项选项', exact: true });
  await page.getByRole('button', { name: /^场景第 1 项权重 / }).click();
  await page.getByRole('button', { name: '×1.5', exact: true }).click();
  assert.equal(JSON.parse(await page.locator('output').textContent()).setting[0].weight, 1.5);
  assert.match(await page.getByRole('button', { name: /^场景第 1 项权重 / }).textContent(), /1\.5/);
  await trigger.click();
  await page.locator('.prompt-fragment-mobile-actions .prompt-fragment-enabled').click();
  assert.equal(JSON.parse(await page.locator('output').textContent()).setting[0].enabled, false);
  await page.getByRole('button', { name: '删除场景第 1 项', exact: true }).click();
  assert.equal(JSON.parse(await page.locator('output').textContent()).setting.length, 0);
});

test("标签底色和自动释义常驻，补全只替换句内标记并保留权重", async t => {
  const { page, input, options } = await editor(t);
  const queries = [];
  await page.route("**/api/prompt-dictionary**", route => {
    const request = route.request();
    if (request.method() === "POST") return route.fulfill({ json: { available: true, matches: request.postDataJSON().prompts.map(prompt => ({ prompt_text: prompt, matched: prompt === "blue eyes", source_text: prompt === "blue eyes" ? "blue_eyes" : undefined, display_text: "蓝眼睛" })) } });
    queries.push(new URL(request.url()).searchParams.get("q"));
    return route.fulfill({ json: { available: true, suggestions: [{ prompt_text: "blue eyes", display_text: "蓝眼睛", source_text: "blue_eyes" }] } });
  });
  await input.fill("a person with ({blue ey}:0.8), walking outside");
  await input.press("Control+Home");
  for (let i = 0; i < "a person with ({blue ey".length; i++) await input.press("ArrowRight");
  await options.first().click();
  assert.ok(queries.includes("blue ey"));
  assert.equal(await input.evaluate(promptText), "a person with ({blue eyes}:0.8), walking outside");
  await input.press("Tab");
  const explanation = page.getByRole("button", { name: "查看 蓝眼睛 的词条说明" });
  await explanation.waitFor();
  assert.equal(await page.locator(".prompt-inline-input mark").textContent(), "{blue eyes}");
  assert.notEqual(await page.locator(".prompt-inline-input mark").evaluate(e => getComputedStyle(e).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_type, "custom_description");
  assert.equal(await page.getByLabel("场景第 1 项中文提示").count(), 0);
  await explanation.click();
  assert.match(await page.getByRole("link", { name: "Danbooru Wiki" }).getAttribute("href"), /blue_eyes$/);
  await page.getByRole("button", { name: "关闭词条说明" }).click();
  await input.fill(",blue");
  await options.first().click();
  assert.equal(await input.evaluate(promptText), ",blue eyes");
  // 上一次补全的光标恢复完成后，再开始下一次独立编辑。
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await input.fill("a person with {blue");
  await options.first().click();
  assert.equal(await input.evaluate(promptText), "a person with {blue eyes}");
  await input.fill("a plain sentence without a tag");
  await input.press("Tab");
  await page.locator(".prompt-inline-input [data-prompt-note]").waitFor({ state: "hidden" });
  assert.equal(await input.evaluate(e => getComputedStyle(e.parentElement).gridColumnStart), "1");
});

test("编辑已有词条时用完整文字容错搜索，近似候选只替换当前标签", async t => {
  const { page, input, options } = await editor(t);
  const entries = buildPromptDictionary("looking_back,0,100,", "looking_back,回头看");
  const queries = [];
  await page.route("**/api/prompt-dictionary?**", route => {
    const query = new URL(route.request().url()).searchParams.get("q");
    queries.push(query);
    return route.fulfill({ json: { available: true, ...searchPromptDictionaryPage(entries, query, { scope: "page" }) } });
  });
  for (const [text, prefix, expected] of [
    ["night, looking bak, rain", "night, ", "night, looking back, rain"],
    ["night, (looking bak:1.2), rain", "night, (", "night, (looking back:1.2), rain"],
    ["a person with ({looking bak}:0.8), rain", "a person with ({", "a person with ({looking back}:0.8), rain"],
    ["a person with {looking bak", "a person with {", "a person with {looking back}"],
  ]) {
    await input.fill(text);
    await input.press("Control+Home");
    for (let i = 0; i < prefix.length + 3; i++) await input.press("ArrowRight");
    await options.filter({ hasText: "近似匹配" }).first().waitFor();
    assert.equal(queries.at(-1), "looking bak");
    assert.equal(await input.evaluate(promptText), text, "搜索不自动修改草稿");
    await options.first().click();
    assert.equal(await input.evaluate(promptText), expected);
  }
});

const referenceEntries = Object.fromEntries([
  ['long_hair', '长发', 'Long hair. See [[short_hair|短发]] and [[smile|微笑]].\n[[not_in_dictionary|未收录]] [[series_name|作品]]'],
  ['short_hair', '短发', 'Short hair. See [[smile]].'],
  ['smile', '微笑', 'A smile. See [[long_hair|长发]].'],
  ['blue_eyes', '蓝眼睛', 'Blue eyes.'],
  ['series_name', '作品', 'A copyright tag.'],
].map(([tag, label, body]) => [tag, { source_text: tag, prompt_text: tag.replaceAll('_', ' '), display_text: label, matched: true, allowed: tag !== 'series_name', original_description: body, description: body, description_language: 'original' }]));

async function referenceEditor(t, { readonly = false, mobile = false } = {}) {
  const { page } = await editor(t);
  await page.route('**/api/prompt-dictionary**', route => {
    const request = route.request();
    return route.fulfill({ json: request.method() === 'POST'
      ? { available: true, matches: request.postDataJSON().prompts.map(prompt => ({ ...(referenceEntries[prompt.replaceAll(' ', '_')] ?? { matched: false, allowed: false }), prompt_text: prompt })) }
      : { available: true, suggestions: [referenceEntries.long_hair], has_more: false } });
  });
  if (mobile) await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${url}?references${readonly ? '&readonly' : ''}`);
  await page.locator('#host').evaluate(e => { e.style.cssText = 'width:100%;margin-top:0'; });
  const input = page.getByRole(readonly ? 'textbox' : 'combobox', { name: readonly ? '人物第 1 项 Prompt' : '人物·甲第 1 项 Prompt' });
  await input.getByRole('button', { name: '查看 长发 的词条说明' }).waitFor();
  const read = async () => JSON.parse(await page.locator('output').textContent());
  const open = async () => {
    await input.getByRole('button', { name: '查看 长发 的词条说明' }).click();
    await page.getByRole('dialog', { name: '长发', exact: true }).waitFor();
  };
  return { page, input, read, open };
}

async function closeDetailsAfterAction(page) {
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').evaluate(element => element.matches(':modal')), true, '操作后详情保持打开');
  assert.equal(await page.getByRole('dialog').evaluate(element => element.contains(document.activeElement)), true, '操作后焦点留在详情中');
  await page.getByRole('button', { name: '关闭词条说明' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

test('词条引用连续浏览和返回保持草稿，替换始终作用于最初词条并保留权重与角色', async t => {
  const { page, input, read, open } = await referenceEditor(t);
  const before = await read();
  await open();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click();
  await page.getByRole('dialog', { name: '短发', exact: true }).waitFor();
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).click();
  await page.getByRole('dialog', { name: '微笑', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回上一词条' }).click();
  await page.getByRole('dialog', { name: '短发', exact: true }).waitFor();
  assert.deepEqual(await read(), before);
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '替换「long_hair」', exact: true }).click();
  await closeDetailsAfterAction(page);
  assert.deepEqual((await read()).person[0], { ...before.person[0], prompt_text: 'smile' });
  assert.deepEqual((await read()).person.slice(1), before.person.slice(1));
  await page.waitForFunction(element=>document.activeElement===element,await input.elementHandle());
  assert.equal(await input.evaluate(e => document.activeElement === e), true);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await read(), before);
});

for (const action of ['replace', 'insert', 'negative']) test(`详情标题操作 ${action} 使用当前浏览词条并保留最初编辑位置`, async t => {
  const { page, read, open } = await referenceEditor(t, { mobile: action === 'negative' });
  const before = await read();
  await open();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click();
  await page.getByRole('dialog', { name: '短发', exact: true }).waitFor();
  const heading = page.getByRole('heading', { name: '短发', exact: true });
  if (action === 'replace') await page.getByRole('button', { name: '当前词条操作', exact: true }).click();
  else if (action === 'insert') await heading.click({ button: 'right' });
  else {
    const bounds = await heading.boundingBox();
    const touch = await page.context().newCDPSession(page);
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
    await page.getByRole('menu').waitFor();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const rect = await page.getByRole('menu').boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 700);
  }
  assert.equal(await page.getByRole('menuitem', { name: '查看词条说明', exact: true }).count(), 0);
  assert.deepEqual(await read(), before, '打开标题菜单不修改草稿');
  const labels = { replace: '替换「long_hair」', insert: '紧随原词条后加入', negative: '加入负向词条' };
  await page.getByRole('menuitem', { name: labels[action], exact: true }).click();
  await closeDetailsAfterAction(page);
  const after = await read();
  if (action === 'replace') assert.deepEqual(after.person, [{ ...before.person[0], prompt_text: 'short hair' }, ...before.person.slice(1)]);
  else if (action === 'insert') {
    assert.deepEqual(after.person.map(entry => entry.prompt_text), ['long_hair', 'short hair', 'blue_eyes', 'smile']);
    assert.equal(after.person[1].role, 'alice');
  } else {
    assert.deepEqual(after.person, before.person);
    assert.equal(after.avoid[0].prompt_text, 'short hair');
  }
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await read(), before);
});

test('候选详情标题补齐匹配信息后可直接替换，只读详情不显示操作按钮', async t => {
  const { page, input, read } = await referenceEditor(t);
  await page.route('**/api/prompt-dictionary?**', route => {
    const { matched, allowed, ...suggestion } = referenceEntries.short_hair;
    return route.fulfill({ json: { available: true, suggestions: [suggestion], has_more: false } });
  });
  const before = await read();
  await input.fill('short');
  await page.getByRole('button', { name: '查看 短发 的词条说明', exact: true }).click();
  await page.getByRole('button', { name: '当前词条操作', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '替换「short」', exact: true }).click();
  await closeDetailsAfterAction(page);
  assert.deepEqual((await read()).person, [{ ...before.person[0], prompt_text: 'short hair' }, ...before.person.slice(1)]);
  await page.goto(`${url}?references&readonly`);
  await page.getByRole('button', { name: '查看 长发 的词条说明', exact: true }).click();
  await page.getByRole('dialog', { name: '长发', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '当前词条操作', exact: true }).count(), 0);
});

for (const action of ['insert', 'negative']) test(`词条引用 ${action} 写入正确位置，保留来源且一次可撤销`, async t => {
  const { page, read, open } = await referenceEditor(t);
  const before = await read();
  await open();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action === 'insert' ? '紧随原词条后加入' : '加入负向词条', exact: true }).click();
  await closeDetailsAfterAction(page);
  const after = await read();
  if (action === 'insert') {
    assert.deepEqual(after.person.map(e => e.prompt_text), ['long_hair', 'short hair', 'blue_eyes', 'smile']);
    assert.deepEqual(after.person.filter((_, i) => i !== 1), before.person);
    assert.equal(after.person[1].role, 'alice');
    assert.equal(after.person[1].weight ?? 1, 1);
  } else {
    assert.deepEqual(after.person, before.person);
    assert.equal(after.avoid[0].prompt_text, 'short hair');
    assert.equal(after.avoid[0].role, undefined);
  }
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '人物·甲第 1 项 Prompt');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await read(), before);
});

for (const mobile of [false, true]) test(`详情中连续加入、替换和加入负向词条无需重新打开 ${mobile ? '手机' : '桌面'}`, async t => {
  const { page, read, open } = await referenceEditor(t, { mobile });
  const before = await read();
  await open();
  const snapshots = [before];
  const useReference = async (name, action) => {
    const dialog = page.getByRole('dialog');
    await page.getByRole('link', { name, exact: true }).click({ button: 'right' });
    const scroll = await dialog.locator('.prompt-dictionary-details-content').evaluate(element => element.scrollTop);
    await page.getByRole('menuitem', { name: action, exact: true }).click();
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await dialog.evaluate(element => element.matches(':modal')), true);
    assert.equal(await dialog.locator('.prompt-dictionary-details-content').evaluate(element => element.scrollTop), scroll);
    assert.equal(await page.getByRole('alert').count(), 0);
    snapshots.push(await read());
  };
  await useReference('短发 · short hair', '紧随原词条后加入');
  await useReference('微笑 · smile', '紧随原词条后加入');
  assert.deepEqual((await read()).person.map(entry => entry.prompt_text), ['long_hair', 'smile', 'short hair', 'blue_eyes', 'smile']);
  await useReference('短发 · short hair', '替换「long_hair」');
  await useReference('微笑 · smile', '替换「short hair」');
  await useReference('短发 · short hair', '加入负向词条');
  await useReference('微笑 · smile', '加入负向词条');
  assert.deepEqual((await read()).person[0], { ...before.person[0], prompt_text: 'smile' });
  assert.deepEqual((await read()).avoid.map(entry => entry.prompt_text), ['short hair', 'smile']);
  assert.equal(await page.getByRole('dialog', { name: '长发', exact: true }).count(), 1, '编辑不改变当前浏览词条');
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click();
  await page.getByRole('dialog', { name: '短发', exact: true }).waitFor();
  await page.getByRole('button', { name: '当前词条操作' }).click();
  await page.getByRole('menuitem', { name: '替换「smile」', exact: true }).click();
  snapshots.push(await read());
  await closeDetailsAfterAction(page);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '人物·甲第 1 项 Prompt');
  for (let index = snapshots.length - 2; index >= 0; index--) {
    await page.keyboard.press('Control+z');
    assert.deepEqual(await read(), snapshots[index], '每次操作可以独立撤销');
  }
});

test('点击重复标签的说明按该标签位置替换，保留括号权重和未提交草稿，撤销恢复草稿', async t => {
  const { page, read } = await referenceEditor(t);
  const input = page.getByRole('combobox', { name: '场景第 1 项 Prompt' });
  const draft = 'beside {long_hair}, ({long_hair}:1.3), outside';
  const before = await read();
  await input.fill(draft);
  await input.press('Control+Home');
  await input.getByRole('button', { name: '查看 长发 的词条说明' }).nth(1).click();
  assert.deepEqual(await read(), before, '打开详情不提交草稿');
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '替换「long_hair」', exact: true }).click();
  await closeDetailsAfterAction(page);
  assert.equal(await input.evaluate(promptText), 'beside {long_hair}, ({short hair}:1.3), outside');
  await page.keyboard.press('Control+z');
  assert.equal(await input.evaluate(promptText), draft);
  assert.equal((await read()).setting[0].prompt_text, draft);
});

test('描述内连续替换按更新后的标签长度定位，补齐花括号不会重复添加', async t => {
  const { page, read } = await referenceEditor(t);
  const input = page.getByRole('combobox', { name: '场景第 1 项 Prompt' });
  await input.fill('beside {long_hair}, ({long_hair}:1.3), outside');
  await input.getByRole('button', { name: '查看 长发 的词条说明' }).nth(1).click();
  for (const [name, source, expected] of [
    ['短发 · short hair', 'long_hair', 'beside {long_hair}, ({short hair}:1.3), outside'],
    ['微笑 · smile', 'short hair', 'beside {long_hair}, ({smile}:1.3), outside'],
    ['短发 · short hair', 'smile', 'beside {long_hair}, ({short hair}:1.3), outside'],
  ]) {
    await page.getByRole('link', { name, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: `替换「${source}」`, exact: true }).click();
    assert.equal((await read()).setting[0].prompt_text, expected);
    assert.equal(await page.getByRole('alert').count(), 0);
  }
  await closeDetailsAfterAction(page);
  await input.fill('beside {long');
  await page.locator('.prompt-fragment-suggestions').getByRole('button', { name: '查看 长发 的词条说明', exact: true }).click();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '替换「long」', exact: true }).click();
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '替换「short hair」', exact: true }).click();
  assert.equal((await read()).setting[0].prompt_text, 'beside {smile}');
});

test('手机引用长按弹菜单不触发跳转，滚动手势不触发菜单，Escape 只关闭菜单', async t => {
  const { page, open, read } = await referenceEditor(t, { mobile: true });
  await open();
  const link = page.getByRole('link', { name: '短发 · short hair', exact: true });
  await link.scrollIntoViewIfNeeded();
  const bounds = await link.boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.getByRole('menuitem', { name: '加入负向词条' }).waitFor();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByRole('dialog', { name: '长发', exact: true }).waitFor();
  const rect = await page.getByRole('menu').boundingBox();
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 700);
  await page.screenshot({ path: fileURLToPath(new URL('../../../Saved/Tests/prompt-reference-menu-mobile.png', import.meta.url)) });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 1);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - 30 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(800);
  assert.equal(await page.getByRole('menu').count(), 0);
  await link.scrollIntoViewIfNeeded();
  const nextBounds = await link.boundingBox();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nextBounds.x + nextBounds.width / 2, y: nextBounds.y + nextBounds.height / 2 }] });
  await page.getByRole('menuitem', { name: '加入负向词条' }).waitFor();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByRole('menuitem', { name: '加入负向词条' }).click();
  assert.equal((await read()).avoid[0].prompt_text, 'short hair');
});

test('只读详情和不适用或未收录引用仅可查看，查询返回时不重新打开已关闭菜单', async t => {
  const { page, open } = await referenceEditor(t, { readonly: true });
  await open();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click({ button: 'right' });
  await page.getByRole('menu', { name: '短发 · short hair', exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['查看词条说明']);
  await page.getByRole('menuitem', { name: '查看词条说明' }).click();
  await page.getByRole('dialog', { name: '短发', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回上一词条' }).click();
  for (const name of ['作品 · series name', '未收录 · not in dictionary']) {
    await page.getByRole('link', { name, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: name.startsWith('作品') ? '此词条不适用于当前编辑范围' : '本地词库未收录此引用' }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: /^替换|加入/ }).count(), 0);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: '关闭词条说明' }).click();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/prompt-dictionary/matches', async route => {
    await pending;
    await route.fulfill({ json: { available: true, matches: route.request().postDataJSON().prompts.map(prompt => ({ ...(referenceEntries[prompt] ?? { matched: false, allowed: false }), prompt_text: prompt })) } });
  });
  await open();
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '正在读取词条…' }).waitFor();
  await page.getByRole('heading', { name: '长发', exact: true }).click();
  release();
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('menu').count(), 0);
});

test('引用读取的迟到结果不覆盖后开的词条，未收录引用可返回且不修改草稿', async t => {
  const { page, open, read } = await referenceEditor(t);
  const before = await read();
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route('**/api/prompt-dictionary/matches', async route => {
    await delayed;
    await route.fulfill({ json: { available: true, matches: route.request().postDataJSON().prompts.map(prompt => ({ ...(referenceEntries[prompt] ?? { matched: false, allowed: false }), prompt_text: prompt })) } });
  });
  await open();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '正在读取词条' }).waitFor();
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).click();
  release();
  await page.getByRole('dialog', { name: '微笑', exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog', { name: '微笑', exact: true }).count(), 1);
  await page.getByRole('button', { name: '返回上一词条' }).click();
  await page.getByRole('link', { name: '未收录 · not in dictionary', exact: true }).click();
  await page.getByRole('dialog', { name: 'not_in_dictionary', exact: true }).waitFor();
  assert.match(await page.getByRole('dialog').textContent(), /本地词库未收录此引用/);
  await page.getByRole('button', { name: '返回上一词条' }).click();
  await page.getByRole('dialog', { name: '长发', exact: true }).waitFor();
  assert.deepEqual(await read(), before);
});

test('说明引用批量补齐中英文，重复引用共用查询，无译名保留英文，菜单复用结果', async t => {
  const { page, open, read } = await referenceEditor(t);
  const before = await read();
  const requests = [];
  await page.route('**/api/prompt-dictionary/matches', route => {
    const prompts = route.request().postDataJSON().prompts;
    requests.push(prompts);
    return route.fulfill({ json: { available: true, matches: prompts.map(prompt => ({
      ...(referenceEntries[prompt] ?? { matched: true, allowed: true, source_text: prompt, display_text: prompt.replaceAll('_', ' ') }), prompt_text: prompt,
      ...(prompt === 'short_hair' ? { original_description: '[[smile]] [[smile|笑容]] [[english_only]]' } : {}),
    })) } });
  });
  await open();
  await page.getByRole('link', { name: '短发 · short hair', exact: true }).click();
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).waitFor();
  await page.getByRole('link', { name: '笑容 · smile', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'english only', exact: true }).count(), 1);
  assert.deepEqual(requests, [['short_hair', 'smile', 'not_in_dictionary', 'series_name'], ['english_only']]);
  await page.getByRole('link', { name: '微笑 · smile', exact: true }).click({ button: 'right' });
  await page.getByRole('menu', { name: '微笑 · smile', exact: true }).waitFor();
  assert.equal(requests.length, 2, '菜单不重复请求已读取的引用');
  assert.deepEqual(await read(), before);
});

for (const mobile of [false, true]) for (const keyboard of [false, true]) {
  test(`候选词详情不被补全浮层遮挡，关闭后保留草稿与选择 ${mobile ? '手机' : '桌面'} ${keyboard ? 'F1' : '点击'}`, async t => {
    const { page, input, options } = await editor(t);
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 600 });
      await page.locator('#host').evaluate(e => { e.style.cssText = 'width:100%;margin-top:380px'; });
    }
    const saved = await page.locator('output').textContent();
    await input.fill('quiet evening');
    await options.first().waitFor();
    await input.press('ArrowDown');
    const activeId = await input.getAttribute('aria-activedescendant');
    if (keyboard) await input.press('F1');
    else await page.getByRole('button', { name: '查看 安静 的词条说明', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '安静', exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.prompt-dictionary-details')?.matches(':modal'));
    assert.equal(await page.locator('.prompt-fragment-suggestions').count(), 0, '详情打开期间不挂载候选浮层');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    assert.equal(await input.getAttribute('aria-controls'), null);
    assert.equal(await page.locator('output').textContent(), saved, '查看详情不会提交或替换草稿');
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await dialog.locator('.prompt-dictionary-details-content').evaluate(e => { e.scrollTop = e.scrollHeight; });
    const visible = await dialog.evaluate(e => {
      const rect = e.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { inside: e.contains(hit), candidate: Boolean(hit?.closest('.prompt-fragment-suggestions')), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    });
    assert.equal(visible.inside, true);
    assert.equal(visible.candidate, false);
    assert.ok(visible.x >= 0 && visible.y >= 0 && visible.right <= page.viewportSize().width && visible.bottom <= page.viewportSize().height);
    if (keyboard) await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: '关闭词条说明' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await options.first().waitFor();
    assert.equal(await input.evaluate(e => document.activeElement === e), true);
    assert.equal(await input.evaluate(promptText), 'quiet evening');
    assert.equal(await input.getAttribute('aria-activedescendant'), activeId);
    await input.press('Enter');
    assert.equal(await input.evaluate(promptText), 'quiet', '关闭详情后仍能采用原先选中的候选词');
  });
}

test("Prompt 随宽度自动换行，失焦后仍完整显示", async t => {
  const { page, input } = await editor(t);
  await page.locator("#host").evaluate(e => { e.style.width = "180px"; });
  await page.waitForFunction(() => { const e = document.querySelector("[contenteditable=true][role=combobox]"); return e.clientHeight >= e.scrollHeight && e.clientHeight >= 80; });
  const narrowHeight = await input.evaluate(e => e.clientHeight);
  await input.focus(); await input.press("Tab");
  assert.equal(await input.evaluate(e => e.clientHeight), narrowHeight);
  await page.locator("#host").evaluate(e => { e.style.display = "none"; });
  await page.waitForFunction(() => document.querySelector("[contenteditable=true][role=combobox]").clientWidth === 0);
  await page.locator("#host").evaluate(e => { e.style.width = "1000px"; e.style.display = "block"; });
  await input.focus();
  await page.waitForFunction(height => { const e = document.querySelector("[contenteditable=true][role=combobox]"); return e.clientHeight >= e.scrollHeight && e.clientHeight < height; }, narrowHeight);
  assert.match(await input.evaluate(promptText), /soft evening shadows$/);
});

test("独立镜头文本正常编辑，不携带机位参数", async t => {
  const { page } = await editor(t);
  const entry = { prompt_text: "from above", matched: true, allowed: true, source_text: "from_above", display_text: "俯视" };
  await page.route("**/api/prompt-dictionary**", route => route.fulfill({ json: { available: true, ...(route.request().method() === "POST" ? { matches: [entry] } : { suggestions: [entry] }) } }));
  await page.goto(`${url}?camera`);
  const input = page.getByRole("combobox", { name: "镜头第 1 项 Prompt" });
  await input.fill("from above"); await page.getByRole("option").first().click(); await input.press("Tab");
  await page.waitForFunction(() => JSON.parse(document.querySelector("#persisted-camera").textContent)[0].tag === "from above");
  const [fragment] = JSON.parse(await page.locator("#persisted-camera").textContent());
  assert.equal(fragment.camera_settings, undefined);
  assert.equal(fragment.id, undefined);
  assert.equal(await page.getByLabel("机位控制", { exact: true }).count(), 0);
});

test("行内中文不进入剪贴板、退格与粘贴；词库异步更新保留选区和输入框位置", async t => {
  const { page, input } = await editor(t);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  await page.route("**/api/prompt-dictionary/matches", async route => {
    await ready;
    await route.fulfill({ json: { available: true, matches: route.request().postDataJSON().prompts.map(prompt => ({ prompt_text: prompt, matched: prompt === "exhausted", source_text: "exhausted", display_text: "精疲力竭" })) } });
  });
  await input.fill("she is {exhausted}, resting");
  const before = await input.boundingBox();
  await input.press("Control+Home");
  for (let i = 0; i < "she is {exhausted}".length; i++) await input.press("ArrowRight");
  release();
  await input.getByRole("button", { name: "查看 精疲力竭 的词条说明" }).waitFor();
  const after = await input.boundingBox();
  assert.equal(after.x, before.x);
  assert.equal(after.width, before.width);
  assert.equal(await input.evaluate(e => document.activeElement === e), true);
  await input.press("Backspace");
  assert.equal(await input.evaluate(promptText), "she is {exhausted, resting");
  await input.pressSequentially("}");
  await input.press("Control+a");
  const copied = await input.evaluate(e => {
    const data = new DataTransfer();
    e.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData("text/plain");
  });
  assert.equal(copied, "she is {exhausted}, resting");
  await input.evaluate(e => {
    const data = new DataTransfer(); data.setData("text/plain", "a person with {unknown_tag_987}"); data.setData("text/html", "<b>不应粘贴</b>");
    e.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await input.evaluate(promptText), "a person with {unknown_tag_987}");
  assert.equal(await page.getByRole("alert").count(), 0, "编辑期间不显示暂未完成的圈选错误");
  await input.press("Tab");
  await page.getByRole("alert").getByText("圈选标签不在词库中：unknown_tag_987").waitFor();
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, "a person with {unknown_tag_987}");
});

for(const width of [390,1200])for(const prefix of ['', 'prefix,\n'])test(`候选补全后原生删除不留下多余换行 ${width} ${prefix?'保留原有换行':'清空文字'}`,async t=>{
  const {page,input,options}=await editor(t);
  await page.setViewportSize({width,height:700});
  await page.route('**/api/prompt-dictionary/matches',route=>route.fulfill({json:{available:true,matches:route.request().postDataJSON().prompts.map(prompt=>({prompt_text:prompt,matched:prompt==='quiet',allowed:true,source_text:prompt==='quiet'?'quiet':undefined,display_text:'安静'}))}}));
  if(prefix){await input.fill('prefix,');await input.press('Shift+Enter');await input.pressSequentially('qui');}
  else await input.fill('qui');
  await options.first().click();
  await input.getByRole('button',{name:'查看 安静 的词条说明'}).waitFor();
  assert.equal(await input.evaluate(promptText),`${prefix}quiet`);
  // 软键盘的原生编辑不会经过组件拦截的 Backspace keydown。
  await input.press('Control+End');
  await input.dispatchEvent('compositionstart');
  for(let index=0;index<6;index++)await input.press('Backspace');
  await input.dispatchEvent('compositionend');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  assert.equal(await input.evaluate(promptText),prefix);
  await input.evaluate(()=>document.execCommand('insertText',false,'soft light'));
  assert.equal(await input.evaluate(promptText),`${prefix}soft light`);
  await input.press('Tab');
  assert.equal(JSON.parse(await page.locator('output').textContent()).setting[0].prompt_text,`${prefix}soft light`);
});

test("悬停候选后直接 Enter 保留原文；点击候选仍然补全", async t => {
  const { page, input, options } = await editor(t);
  await input.fill("quiet night");
  await options.first().hover();
  assert.equal(await input.getAttribute("aria-activedescendant"), null);
  await input.press("Enter");
  assert.equal(await input.evaluate(promptText), "quiet night");
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, "quiet night");
  await input.fill("quiet evening");
  await options.first().click();
  assert.equal(await input.evaluate(promptText), "quiet");
  assert.equal(await input.evaluate(e => document.activeElement === e), true);
});

test("方向键明确选择才由 Enter 补全；继续输入撤销旧选择", async t => {
  const { input, options } = await editor(t);
  await input.fill("quiet night");
  await options.first().waitFor();
  await input.press("ArrowDown");
  await input.press("Enter");
  assert.equal(await input.evaluate(promptText), "quiet");
  await input.fill("quiet evening");
  await options.first().waitFor();
  await input.press("ArrowDown");
  await input.press("End");
  await input.pressSequentially(" light");
  await input.press("Enter");
  assert.equal(await input.evaluate(promptText), "quiet evening light");
});

test("输入法确认 Enter 不提交草稿或应用候选", async t => {
  const { page, input, options } = await editor(t);
  const initial = await page.locator("output").textContent();
  await input.fill("quiet night");
  await options.first().waitFor();
  await input.press("ArrowDown");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  assert.equal(await input.evaluate(promptText), "quiet night");
  assert.equal(await page.locator("output").textContent(), initial);
});

test("完整输入法合成确认保留中文与未提交英文，替换选区后可正常保存", async t => {
  for (const replaceAll of [false, true]) await t.test(replaceAll ? "替换整个选区" : "接续未提交英文", async t => {
    const { page, input } = await editor(t);
    const initial = await input.evaluate(promptText);
    await input.focus(); await input.press("Control+End");
    await input.pressSequentially(" abc");
    if (replaceAll) await input.press("Control+a");
    const client = await page.context().newCDPSession(page);
    await client.send("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
    await client.send("Input.insertText", { text: "你好" });
    const expected = replaceAll ? "你好" : `${initial} abc你好`;
    // 跨过 React effect 与下一帧，避免只断言合成中的原生 DOM。
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await input.evaluate(promptText), expected);
    assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, initial, "输入法确认仍只修改草稿");
    await input.press("Tab");
    assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, expected);
    await client.detach();
  });
});

test("描述允许 Shift+Enter 换行，精确匹配词库后仍保留手选类型", async t => {
  const { page, input, options } = await editor(t);
  await page.route("**/api/prompt-dictionary/matches", route => route.fulfill({ json: { available: true, matches: [{ prompt_text: "quiet", matched: true, allowed: true }] } }));
  await input.fill("quiet");
  await options.first().waitFor();
  await input.press("Enter");
  await page.locator("output").click();
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_type, "custom_description");
  await input.focus();
  await input.press("End");
  await input.press("Shift+Enter");
  await input.pressSequentially("soft light");
  await input.press("Enter");
  assert.equal(await input.evaluate(promptText), "quiet\nsoft light");
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, "quiet\nsoft light");
});

test("向上展开的少量候选贴住输入框，跟随输入框高度变化", async t => {
  const { page, input, options } = await editor(t);
  await page.locator("#host").evaluate(e => { e.style.marginTop = "440px"; e.style.width = "500px"; });
  await input.fill("quiet evening");
  await options.first().waitFor();
  const attached = () => page.waitForFunction(() => {
    const input = document.querySelector("[contenteditable=true][role=combobox]").getBoundingClientRect();
    const list = document.querySelector("[role=listbox]")?.getBoundingClientRect();
    return list && Math.abs(input.top - list.bottom - 4) <= 1;
  });
  await attached();
  await input.fill("quiet hallway under dim lights with a window and soft evening shadows");
  await options.first().waitFor();
  await attached();
  const scrollY = await page.evaluate(() => window.scrollY);
  await input.press("ArrowDown");
  assert.equal(await page.evaluate(() => window.scrollY), scrollY);
});

test("可见视口缩小和偏移时候选保持在可见范围内", async t => {
  const { page, input, options } = await editor(t, { viewport: true });
  await input.fill("quiet night");
  await options.first().waitFor();
  const contained = () => page.waitForFunction(() => {
    const r = document.querySelector("[role=listbox]")?.getBoundingClientRect();
    const v = window.visualViewport;
    return r && r.top >= v.offsetTop + 7 && r.bottom <= v.offsetTop + v.height - 7 && r.left >= v.offsetLeft + 7 && r.right <= v.offsetLeft + v.width - 7;
  });
  await contained();
  await page.evaluate(() => {
    Object.assign(window.visualViewport, { offsetTop: 200, offsetLeft: 180, width: 420, height: 280 });
    window.visualViewport.dispatchEvent(new Event("resize"));
    window.visualViewport.dispatchEvent(new Event("scroll"));
  });
  await contained();
});



test("人物词条拖入空角色区绑定，拖回解除，保存属性和原有操作控件保留", async t => {
  const { page } = await editor(t);
  await page.goto(`${url}?roles`);
  const row = page.locator('[data-fragment-id="person-probe"]');
  const target = page.locator('[data-person-role="alice"]');
  assert.deepEqual(await page.locator('[data-person-role]').evaluateAll(groups => groups.map(group => group.dataset.personRole)), ['alice', 'bob', '']);
  assert.equal(await target.getAttribute('title'), '甲');
  assert.equal(await target.locator('header').count(), 0);
  assert.ok((await target.boundingBox()).height >= 26);
  assert.equal(await page.locator('.prompt-person-drop-line').count(), 0);
  const handle = await row.locator('.prompt-fragment-drag').boundingBox();
  const destination = await target.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 12 });
  await target.locator('.prompt-person-drop-line').waitFor();
  await page.mouse.up();
  await target.locator('[data-fragment-id="person-probe"]').waitFor();
  assert.equal(await page.locator('.prompt-person-drop-line').count(), 0);
  let value = JSON.parse(await page.locator('output').textContent());
  assert.deepEqual(value.person.find(x => x.id === 'person-probe'), { id: 'person-probe', prompt_type: 'danbooru', prompt_text: 'long_hair', weight: 1.2, role: 'alice' });
  assert.equal(await row.locator('select').count(), 0);
  assert.equal(await row.getByRole('checkbox').isVisible(), true);
  assert.equal(await row.locator('.prompt-fragment-delete').isVisible(), true);
  assert.equal(await page.locator('[data-person-role=""]').count(), 0, '空未绑定区不占行');
  const boundGrip = await row.locator('.prompt-fragment-drag').boundingBox();
  await page.mouse.move(boundGrip.x + boundGrip.width / 2, boundGrip.y + boundGrip.height / 2);
  await page.mouse.down();
  const unbound = page.locator('[data-person-role=""]');
  await unbound.waitFor();
  const unboundBox = await unbound.boundingBox();
  await page.mouse.move(unboundBox.x + 10, unboundBox.y + unboundBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.locator('[data-person-role=""] [data-fragment-id="person-probe"]').waitFor();
  value = JSON.parse(await page.locator('output').textContent());
  assert.equal(value.person.find(x => x.id === 'person-probe').role, undefined);
});

test("人物合并视图的候选词搜索不携带词库分类参数", async t => {
  const { page } = await editor(t);
  await page.goto(`${url}?roles`);
  const searches = [];
  await page.route("**/api/prompt-dictionary**", route => {
    const request = route.request();
    if (request.method() === "POST") return route.fulfill({ json: { available: true, matches: [] } });
    searches.push(new URL(request.url()).searchParams);
    return route.fulfill({ json: { available: true, suggestions: [{ prompt_text: "long hair", display_text: "长发", source_text: "long_hair" }], has_more: false } });
  });
  const input = page.getByRole("combobox", { name: "人物·未绑定第 1 项 Prompt" });
  await input.click();
  await input.fill("lo");
  await page.locator("button[role=option]").first().waitFor();
  assert.ok(searches.length > 0);
  for (const params of searches) {
    assert.equal(params.get("category"), null, "person 是合并视图而非词库分类,搜索不应携带 category");
    assert.equal(params.get("scope"), "page");
  }
});

test("输入后立即拖动词条，未提交草稿随拖拽先提交不丢失", async t => {
  const { page } = await editor(t);
  await page.goto(`${url}?roles`);
  const input = page.getByRole("combobox", { name: "人物·未绑定第 1 项 Prompt" });
  await input.fill("short_hair");
  const row = page.locator('[data-fragment-id="person-probe"]');
  const target = page.locator('[data-person-role="alice"]');
  const handle = await row.locator('.prompt-fragment-drag').boundingBox();
  const destination = await target.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 12 });
  await target.locator('.prompt-person-drop-line').waitFor();
  await page.mouse.up();
  await target.locator('[data-fragment-id="person-probe"]').waitFor();
  const value = JSON.parse(await page.locator('output').textContent());
  const moved = value.person.find(x => x.id === 'person-probe');
  assert.equal(moved.prompt_text, 'short_hair', "拖拽开始时未提交的草稿应先提交");
  assert.equal(moved.role, 'alice');
});

test("保存/生成快捷键不让输入框失焦，词条随按键直接提交草稿", async t => {
  const { page, input } = await editor(t);
  await input.fill("quiet night");
  await input.press("Control+s");
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, "quiet night");
  assert.equal(await input.evaluate(e => document.activeElement === e), true, "快捷键提交不应抢焦点");
  await input.fill("quiet dawn");
  await input.press("Control+g");
  assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, "quiet dawn");
});


test("花括号包围正反选区，保留文本并可撤销，不抢输入法组合", async t => {
  const { page, input } = await editor(t);
  for (const reverse of [false, true]) {
    await input.fill("long hair");
    await input.press("Control+s");
    await input.press(reverse ? "Control+End" : "Control+Home");
    await input.press(reverse ? "Control+Shift+Home" : "Control+Shift+End");
    await input.dispatchEvent("keydown", { key: "{", isComposing: true, bubbles: true });
    assert.equal(await input.evaluate(promptText), "long hair");
    await input.press("{");
    assert.equal(await input.evaluate(promptText), "{long hair}");
    await input.press("Control+z");
    assert.equal(await input.evaluate(promptText), "long hair");
    await input.press("Control+a");
    await input.press("{");
    await input.press("Control+s");
    assert.equal(JSON.parse(await page.locator("output").textContent()).setting[0].prompt_text, "{long hair}");
  }
});
