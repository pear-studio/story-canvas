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

test("总览每页一个本页文本框，窄列长文本完整自适应显示", async t => {
  const { page, col } = await setup(t);
  const text = col(1).getByLabel("页面 1 本页 Prompt");
  await text.waitFor();
  assert.equal(await text.inputValue(), " dim lighting, a sentence with unrecognized words ");
  assert.equal(await col(1).locator('[data-prompt-category]').count(), 0, "不再有分类对齐表");
  assert.equal(Math.round((await col(1).boundingBox()).width), 375);
  await text.fill("一段足够长的整段页面描述，用来验证总览窄列内自动换行后高度随内容增长且完整可读，不出现内部裁切");
  await page.waitForFunction(() => { const e = document.querySelector('[data-overview-page="page-1"] textarea'); return e.clientHeight >= e.scrollHeight && e.clientHeight > 60; });
  await page.getByRole('heading', { name: 'Prompt 总览' }).click();
  await page.waitForFunction(() => { const e = document.querySelector('[data-overview-page="page-1"] textarea'); return e.clientHeight >= e.scrollHeight - 1; });
  await page.getByRole('button', { name: '导航到单元二末页' }).click();
  assert.ok(await page.locator('.prompt-overview-scroll').evaluate(e => e.scrollLeft) > 0);
  assert.equal(await page.locator('.prompt-overview-column').count(), 4);
});

test("只保存修改页，保留其余 prompt 字段；跨单元批量生成先保存再排队", async t => {
  const { page, col, writes, renders } = await setup(t);
  const text = col(1).getByLabel("页面 1 本页 Prompt");
  await text.fill("dim lighting, steel_wall");
  await page.getByRole('button', { name: '保存全部修改' }).click();
  await page.waitForFunction(() => document.querySelector('[data-overview-page="page-1"]').dataset.pagePromptDirty !== 'true');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].prompt.text, 'dim lighting, steel_wall');
  assert.equal(writes[0].prompt.reference_images[0].file, "reference-11111111.png", "附图等其余字段原样保留");
  assert.equal(writes[0].expected_context_sha256, 'context-1');
  await col(1).getByRole('checkbox', { name: '页面 1', exact: true }).check();
  await col(4).getByRole('checkbox', { name: '页面 4', exact: true }).check();
  await col(4).getByLabel("页面 4 本页 Prompt").fill('steel_wall');
  await page.getByRole('button', { name: /保存并生成/ }).click();
  await page.getByText('已排队 2 页', { exact: true }).waitFor();
  assert.deepEqual(writes.map(w => w.page_id), ['page-1', 'page-4']);
  assert.equal(renders.length, 2);
});

test("外部更新不抹掉未保存草稿，也不使用旧指纹覆盖", async t => {
  const { page, col, writes } = await setup(t);
  const text = col(1).getByLabel("页面 1 本页 Prompt");
  await text.fill('my unsaved description');
  await page.getByRole('button', { name: '模拟外部更新' }).click();
  assert.equal(await text.inputValue(), 'my unsaved description');
  await page.getByRole('button', { name: '保存全部修改' }).click();
  await col(1).getByRole('alert').waitFor();
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  await col(1).getByRole('button', { name: '放弃草稿并载入最新' }).click();
  assert.equal(await text.inputValue(), '外部改写的页面描述');
});

test("84 页总览只挂载视口附近编辑器，远端定位和往返保留草稿与勾选", async t => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  t.after(() => page.close());
  const writes = [];
  await page.route('**/workbench/page-prompt', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    return route.fulfill({ headers: { "x-story-canvas-revision": "revision-next" }, json: { kind: "story", page_id: body.page_id, prompt: body.prompt, prompt_sha256: `saved-${writes.length}` } });
  });
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
  const firstInput = first.getByLabel("页面 1 本页 Prompt");
  await firstInput.fill('unsaved across scrolling');
  await page.getByRole('button', { name: '导航到单元二末页' }).click();
  const last = page.locator('[data-overview-page="page-84"]');
  const input = last.getByLabel("页面 84 本页 Prompt");
  await input.fill('dim lighting, steel_wall');
  assert.equal(await input.inputValue(), 'dim lighting, steel_wall');
  assert.equal(await input.evaluate(e => e.clientHeight >= e.scrollHeight - 1), true);
  assert.equal(await first.locator('.prompt-overview-editor').count(), 0);
  assert.ok(await page.locator('.prompt-overview-editor').count() <= 8);
  await first.locator('header').scrollIntoViewIfNeeded();
  await firstInput.waitFor();
  assert.equal(await firstInput.inputValue(), 'unsaved across scrolling');
  assert.equal(await first.getByRole('checkbox', { name: '页面 1', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '保存全部修改' }).click();
  await page.getByText('已保存 2 页', { exact: true }).waitFor();
  assert.deepEqual(writes.map(write => [write.page_id, write.prompt.text]), [['page-1', 'unsaved across scrolling'], ['page-84', 'dim lighting, steel_wall']]);
});
