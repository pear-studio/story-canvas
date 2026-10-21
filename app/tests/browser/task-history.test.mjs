import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
let server, browser, origin;
before(async () => {
  const config={root:fileURLToPath(new URL('../../',import.meta.url)),build:{outDir:fileURLToPath(new URL('../../../Saved/Tests/task-history-ui/dist',import.meta.url)),emptyOutDir:false,rollupOptions:{input:fileURLToPath(new URL('./task-history.html',import.meta.url))}},logLevel:'error'};
  await build(config);server=await preview({...config,preview:{host:'127.0.0.1',port:0}});
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
});
after(async () => { await browser?.close(); if(server)await new Promise(resolve=>server.httpServer.close(resolve)); });
async function open(t, width = 1000) {
  const page = await browser.newPage({ viewport: { width, height: 600 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
test('WebP动态成品从任务结果打开时使用图片播放器',async t=>{
  const page=await open(t);
  await page.route('**/api/tasks/**/results*',route=>route.fulfill({json:{images:[{id:'finished',url:'/test-poster.png',media_kind:'video',media_format:'webp',video_url:'/test-animation.webp'}]}}));
  await page.route('**/test-*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="green"/></svg>'}));
  await page.goto(`${origin}/tests/browser/task-history.html`);
  await page.getByRole('button',{name:'全屏查看第 1 张生成结果',exact:true}).first().click();
  const lightbox=page.locator('.image-lightbox');
  await lightbox.waitFor();assert.equal(await lightbox.locator('video').count(),0);
  assert.match(await lightbox.locator('img').getAttribute('src'),/test-animation.webp$/);
});
for (const width of [390, 1000]) test(`卡片只在可视范围请求结果，滚动才读取旧记录 ${width}`, async t => {
  const page = await open(t, width), requests = [];
  await page.route('**/api/tasks/**/results*', async route => {
    requests.push(route.request().url()); await route.fulfill({ json: { images: [] } });
  });
  await page.goto(`${origin}/tests/browser/task-history.html`);
  await page.getByText('图片已删除或不可用', { exact: true }).first().waitFor();
  assert.ok(requests.length > 0 && requests.length < 10, `${requests.length} metadata requests`);
  assert.ok(!requests.some(url => url.includes('/task-29/')));
  await page.locator('.task-card').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('.task-card')[29].textContent.includes('图片已删除或不可用'));
  assert.ok(requests.some(url => url.includes('/task-29/')));
  assert.ok(requests.length < 30);
});

test('可视卡片错误重试与身份变化重新加载，关闭结果取消未完成请求', async t => {
  const page = await open(t), requests = [], failed = [];
  let failFirst = true, unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  page.on('requestfailed', request => failed.push(request.url()));
  await page.route('**/api/tasks/**/results*', async route => {
    const url = route.request().url(); requests.push(url);
    if (url.includes('/task-0/') && failFirst) { failFirst = false; await route.fulfill({ status: 503, json: { error: { message: '暂时失败' } } }); return; }
    if (url.includes('/task-29/')) await gate;
    await route.fulfill({ json: { images: [] } }).catch(() => {});
  });
  await page.goto(`${origin}/tests/browser/task-history.html`);
  await page.getByRole('button', { name: '图片读取失败 · 重试' }).click();
  await page.locator('.task-card').first().getByText('图片已删除或不可用', { exact: true }).waitFor();
  assert.equal(requests.filter(url => url.includes('/task-0/')).length, 2);
  await page.getByRole('button', { name: '更换任务身份' }).click();
  await page.locator('.task-card').first().getByText('图片已删除或不可用', { exact: true }).waitFor();
  assert.ok(requests.some(url => url.includes('/task-0-changed/')));
  await page.locator('.task-card').last().scrollIntoViewIfNeeded();
  await page.locator('.task-card').last().getByRole('status', { name: '加载结果' }).waitFor();
  await page.getByRole('button', { name: '开关结果' }).click();
  await page.waitForFunction(() => !document.querySelectorAll('.task-card')[29].querySelector('[role="status"]'));
  unblock();
  // AbortController 确保关闭期间的响应不会写入这一卡片。
  assert.equal(await page.locator('.task-card').last().getByText('图片已删除或不可用', { exact: true }).count(), 0);
});
