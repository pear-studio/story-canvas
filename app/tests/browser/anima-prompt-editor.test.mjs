function promptText(element) { const copy = element.cloneNode(true); copy.querySelectorAll('[data-prompt-note]').forEach(note => note.remove()); return copy.textContent; }
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

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
  await input.fill("a person with {blue");
  await options.first().click();
  assert.equal(await input.evaluate(promptText), "a person with {blue eyes}");
  await input.fill("a plain sentence without a tag");
  await input.press("Tab");
  await page.locator(".prompt-inline-input [data-prompt-note]").waitFor({ state: "hidden" });
  assert.equal(await input.evaluate(e => getComputedStyle(e.parentElement).gridColumnStart), "1");
});

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
