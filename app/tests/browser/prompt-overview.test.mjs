function promptText(element) { const copy = element.cloneNode(true); copy.querySelectorAll('[data-prompt-note]').forEach(note => note.remove()); return copy.textContent; }
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

let server, browser, url;
before(async () => {
  server = await createServer({ cacheDir: ".temp/vite-prompt-overview-tests", root: fileURLToPath(new URL("../../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/prompt-overview.html`;
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
});
after(async () => { await browser?.close(); await server?.close(); });

async function setup(t) {
  const page = await browser.newPage({ viewport: { width: 1050, height: 1000 } });
  const errors = [], writes = [], renders = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route("**/api/prompt-dictionary**", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { available: true, matches: (body?.prompts ?? []).map(prompt => ({ prompt_text: prompt, matched: ["dim lighting", "steel_wall"].includes(prompt), source_text: prompt === "dim lighting" ? "dim_lighting" : prompt === "steel_wall" ? "steel_wall" : null, display_text: prompt === "dim lighting" ? "昏暗光线" : "钢墙", original_description: "Dictionary reference." })) } });
  });
  await page.route("**/workbench/page-prompt", route => {
    const body = route.request().postDataJSON(); writes.push(body);
    return route.fulfill({ headers: { "x-story-canvas-revision": "revision-next" }, json: { kind: "story", page_id: body.page_id, prompt: body.prompt, prompt_sha256: `saved-${writes.length}` } });
  });
  await page.route("**/workbench/**", route => {
    if (!route.request().url().endsWith("/render")) return route.fallback();
    renders.push(route.request().postDataJSON());
    return route.fulfill({ headers: { "x-story-canvas-revision": "revision-next" }, json: { task: { task_id: `task-${renders.length}` } } });
  });
  await page.goto(url);
  await page.locator('.prompt-overview-column').first().waitFor();
  return { page, writes, renders, col: i => page.locator(`[data-overview-page="page-${i}"]`) };
}

test("总览添加按钮留在分类栏，单条词条不撑高，角色色条贴边", async t => {
  const { col } = await setup(t);
  const category = col(1).locator('[data-prompt-category="camera"]');
  const header = category.locator('header');
  await header.hover();
  const button = header.getByRole('button', { name: '添加镜头' });
  const h = await header.boundingBox(), b = await button.boundingBox();
  assert.ok(b.x >= h.x && b.x + b.width <= h.x + h.width, '悬停按钮不得移出分类栏');
  const categoryHeight = (await category.boundingBox()).height;
  assert.ok(categoryHeight <= 60, `单条分类不额外占一行按钮或填满视口，实际 ${categoryHeight}`);
  const group = col(1).locator('[data-person-role=""]');
  assert.equal(await group.evaluate(e => Math.round(e.getBoundingClientRect().left - e.parentElement.getBoundingClientRect().left)), 0);
  assert.equal(await group.evaluate(e => getComputedStyle(e).paddingLeft), '0px');
  await button.click();
  assert.equal(await category.locator('.prompt-fragment-entry').count(), 2);
});

test("总览跨单元定位，分类对齐，窄列长文本完整显示且描述保留原文和 Wiki", async t => {
  const { page, col } = await setup(t);
  assert.equal(await col(1).locator('.prompt-fragment-table-head').isVisible(), true);
  await col(1).locator('[data-prompt-note]').first().waitFor();
  assert.equal(await col(1).locator('.prompt-fragment-display').count(), 0);
  await col(1).getByRole('combobox', { name: '场景第 1 项 Prompt' }).focus();
  await col(1).getByRole('button', { name: '查看 昏暗光线 的词条说明' }).waitFor();
  const text = col(1).getByRole('combobox', { name: '场景第 1 项 Prompt' });
  assert.equal(await text.evaluate(promptText), 'dim lighting, a sentence with unrecognized words, steel_wall');
  await col(1).getByRole('button', { name: '查看 昏暗光线 的词条说明' }).click();
  assert.match(await page.getByRole('link', { name: 'Danbooru Wiki' }).getAttribute('href'), /wiki_pages\/dim_lighting$/);
  await page.getByRole('button', { name: '关闭词条说明' }).click();
  const bounds = await page.locator('[data-prompt-category="setting"]').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().top));
  assert.ok(bounds.every(y => Math.abs(y - bounds[0]) < 2), '不同人物词条数量不应导致场景分类错位');
  await page.getByRole('heading', { name: 'Prompt 总览' }).click();
  await page.waitForFunction(() => { const e = document.querySelector('[aria-label="场景第 1 项 Prompt"]'); return e.clientHeight >= e.scrollHeight - 1 && e.scrollWidth <= e.clientWidth; });
  assert.ok(await text.evaluate(e => e.clientHeight > 32));
  await text.focus();
  await page.waitForFunction(() => { const e = document.querySelector('[aria-label="场景第 1 项 Prompt"]'); return e.clientHeight >= e.scrollHeight - 1; });
  assert.equal(Math.round((await col(1).boundingBox()).width), 375);
  await page.getByRole('button', { name: '导航到单元二末页' }).click();
  assert.ok(await page.locator('.prompt-overview-scroll').evaluate(e => e.scrollLeft) > 0);
  assert.equal(await page.locator('.prompt-overview-column').count(), 4);
});

test("只保存修改页，保留人物片段和参数；跨单元批量生成先保存再排队", async t => {
  const { page, col, writes, renders } = await setup(t);
  const text = col(1).getByRole('combobox', { name: '场景第 1 项 Prompt' });
  await text.fill('dim lighting, steel_wall'); await text.press('Tab');
  await page.getByRole('button', { name: '保存全部修改' }).click();
  await page.waitForFunction(() => document.querySelector('[data-overview-page="page-1"]').dataset.pagePromptDirty !== 'true');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].prompt.person, [{ id: 'token-appear1', tag: 'long_hair', weight: 1.2 }, { id: 'token-action1-0', description: 'standing near window 0' }]);
  assert.deepEqual(writes[0].prompt.two_step, { enabled: false, strength: .5 });
  assert.equal(writes[0].prompt.setting[0].description, 'dim lighting, steel_wall');
  assert.equal(writes[0].expected_context_sha256, 'context-1');
  await col(1).getByRole('checkbox', { name: '页面 1', exact: true }).check();
  await col(4).getByRole('checkbox', { name: '页面 4', exact: true }).check();
  await col(4).getByRole('combobox', { name: '场景第 1 项 Prompt' }).fill('steel_wall');
  await page.getByRole('button', { name: /保存并生成/ }).click();
  await page.getByText('已排队 2 页', { exact: true }).waitFor();
  assert.deepEqual(writes.map(w => w.page_id), ['page-1', 'page-4']);
  assert.equal(renders.length, 2);
});

test("外部更新不抹掉未保存草稿，也不使用旧指纹覆盖", async t => {
  const { page, col, writes } = await setup(t);
  const text = col(1).getByRole('combobox', { name: '场景第 1 项 Prompt' });
  await text.fill('my unsaved description'); await text.press('Tab');
  await page.getByRole('button', { name: '模拟外部更新' }).click();
  assert.equal(await text.evaluate(promptText), 'my unsaved description');
  await page.getByRole('button', { name: '保存全部修改' }).click();
  await col(1).getByRole('alert').waitFor();
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  await col(1).getByRole('button', { name: '放弃草稿并载入最新' }).click();
  assert.equal(await col(1).getByRole('combobox', { name: '镜头第 1 项 Prompt' }).evaluate(promptText), 'wide_shot');
  assert.equal(await text.evaluate(promptText), 'dim lighting, a sentence with unrecognized words, steel_wall');
});

test("84 页总览只挂载视口附近编辑器，远端定位和往返保留草稿与勾选", async t => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  t.after(() => page.close());
  const writes = [];
  await page.route('**/workbench/page-prompt', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    return route.fulfill({ headers: { 'x-story-canvas-revision': 'revision-next' }, json: { kind: 'story', page_id: body.page_id, prompt: body.prompt, prompt_sha256: `saved-${writes.length}` } });
  });
  await page.route('**/api/prompt-dictionary**', route => route.fulfill({ json: { available: true, matches: [] } }));
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  await page.goto(`${url}?pages=84`, { waitUntil: 'domcontentloaded' });
  await page.locator('.prompt-overview-column').last().waitFor({ timeout: 15000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const { metrics } = await session.send('Performance.getMetrics');
  const layouts = metrics.find(metric => metric.name === 'LayoutCount').value;
  assert.ok(layouts < 80, `初次加载的布局次数应有界，实际 ${layouts}`);
  assert.equal(await page.locator('.prompt-overview-column').count(), 84);
  assert.ok(await page.locator('.prompt-overview-editor').count() <= 8);
  const first = page.locator('[data-overview-page="page-1"]');
  await first.getByRole('checkbox', { name: '页面 1', exact: true }).check();
  const firstInput = first.getByRole('combobox', { name: '场景第 1 项 Prompt' });
  await firstInput.fill('unsaved across scrolling');
  await page.getByRole('button', { name: '导航到单元二末页' }).click();
  const last = page.locator('[data-overview-page="page-84"]');
  const input = last.getByRole('combobox', { name: '场景第 1 项 Prompt' });
  await input.fill('dim lighting, steel_wall');
  await input.press('Tab');
  assert.equal(await input.evaluate(promptText), 'dim lighting, steel_wall');
  assert.equal(await input.evaluate(e => e.clientHeight >= e.scrollHeight - 1), true);
  assert.equal(await first.locator('.prompt-overview-editor').count(), 0);
  assert.ok(await page.locator('.prompt-overview-editor').count() <= 8);
  await first.locator('header').scrollIntoViewIfNeeded();
  await firstInput.waitFor();
  assert.equal(await firstInput.evaluate(promptText), 'unsaved across scrolling');
  assert.equal(await first.getByRole('checkbox', { name: '页面 1', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '保存全部修改' }).click();
  await page.getByText('已保存 2 页', { exact: true }).waitFor();
  assert.deepEqual(writes.map(write => [write.page_id, write.prompt.setting[0].description]), [['page-1', 'unsaved across scrolling'], ['page-84', 'dim lighting, steel_wall']]);
});
