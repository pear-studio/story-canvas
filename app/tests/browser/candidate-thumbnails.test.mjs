import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="teal"/></svg>';
let server, browser, origin;
before(async () => {
  server = await createServer({ cacheDir: '.temp/vite-candidate-thumbnails', root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(t, { width = 1400, canvas = '2:3', route } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route('**/api/**', r => r.fulfill({ json: { jobs: [] } }));
  await page.route('**/candidate-*.svg*', async r => {
    if (new URL(r.request().url()).searchParams.get('w') !== '320') return r.fulfill({ contentType: 'image/svg+xml', body: svg });
    return route(r);
  });
  return { page, goto: () => page.goto(`${origin}/tests/browser/mobile-candidates.html?thumbnails&canvas=${encodeURIComponent(canvas)}`) };
}

function sameSize(before, after) {
  assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1, JSON.stringify({ before, after }));
}

test('候选缩略图按最新优先分配三路加载名额，等待和加载完成时尺寸稳定', async t => {
  const pending = new Map(), requests = [];
  const { page, goto } = await open(t, { width: 390, route: r => {
    const index = Number(new URL(r.request().url()).pathname.match(/candidate-(\d+)/)[1]);
    requests.push(index); pending.set(index, r);
  } });
  // 刻意逆序交付同一轮可见性回调，验证队列顺序不依赖浏览器回调次序。
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    let callbacks = [], timer;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        super((entries, observer) => {
          if (!entries.some(e => e.target.classList.contains('candidate-thumbnail'))) return callback(entries, observer);
          callbacks.push(() => callback(entries, observer));
          if (!timer) timer = setTimeout(async () => {
            timer = null;
            const batch = callbacks; callbacks = [];
            for (const fn of batch.reverse()) { fn(); await Promise.resolve(); }
          }, 0);
        }, options);
      }
    };
  });
  await goto();
  await page.getByRole('button', { name: '查看候选图，共 9 张' }).click();
  const grid = page.getByRole('listbox', { name: '历史候选列表', exact: true });
  const buttons = grid.getByRole('option');
  await buttons.last().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.candidate-thumbnail[data-state="loading"] img').length === 3);
  assert.deepEqual(requests.slice().sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(await grid.locator('.candidate-thumbnail[data-state="waiting"] img').count(), 0);
  const before = await buttons.first().boundingBox();
  assert.ok(Math.abs(before.width / before.height - 2 / 3) < .01);
  await pending.get(0).fulfill({ contentType: 'image/svg+xml', body: svg }); pending.delete(0);
  await grid.locator('.candidate-thumbnail[data-state="loaded"]').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.candidate-thumbnail img').length === 4);
  assert.equal(requests[3], 3);
  sameSize(before, await buttons.first().boundingBox());
  assert.equal(pending.size, 3);
  // 离开页面后清除排队项并释放名额，后续测试不能被未完成请求堵住。
  await page.goto('about:blank');
});

for (const width of [390, 1400]) test(`缩略图失败隐藏破图并自动恢复，历史候选保持画布比例 ${width}`, async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const { page, goto } = await open(t, { width, canvas: '3:2', route: async r => {
    await ready;
    if (new URL(r.request().url()).pathname === '/candidate-0.svg' && ++attempts === 1) return r.fulfill({ status: 503 });
    return r.fulfill({ contentType: 'image/svg+xml', body: svg });
  } });
  await goto();
  const trigger = page.getByRole('button', { name: /(?:打开历史候选|查看候选图)，共 9 张/ });
  await trigger.click();
  const grid = page.getByRole('listbox', { name: '历史候选列表', exact: true });
  const first = grid.getByRole('option').first();
  const before = await first.boundingBox();
  assert.ok(Math.abs(before.width / before.height - 3 / 2) < .01);
  assert.equal(await first.locator('img').isVisible(), false);
  release();
  // 历史窗口和常驻栏可能各加载一次；检查其中实际经历失败的缩略图。
  const failed = page.locator('.candidate-thumbnail[data-state="error"]').first();
  await failed.waitFor();
  assert.equal(await failed.locator('img').isVisible(), false);
  assert.equal(await failed.textContent(), '缩略图暂不可用');
  await page.waitForFunction(() => !document.querySelector('.candidate-thumbnail[data-state="error"]'));
  await first.locator('.candidate-thumbnail[data-state="loaded"]').waitFor();
  sameSize(before, await first.boundingBox());
  assert.equal(await first.locator('img').isVisible(), true);
});

test('同一候选缩略图地址更新后重新排队并隐藏旧图，布局不跳动', async t => {
  let nextRequest;
  const { page, goto } = await open(t, { route: r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/candidate-0.svg' && url.searchParams.get('v') === '1') { nextRequest = r; return; }
    return r.fulfill({ contentType: 'image/svg+xml', body: svg });
  } });
  await goto();
  const first = page.getByRole('listbox', { name: '候选列表', exact: true }).getByRole('option').first();
  await first.locator('.candidate-thumbnail[data-state="loaded"]').waitFor();
  const before = await first.boundingBox();
  await page.getByRole('button', { name: '更新缩略图地址' }).click();
  await first.locator('.candidate-thumbnail[data-state="loading"] img').waitFor({ state: 'attached' });
  assert.equal(await first.locator('img').isVisible(), false);
  sameSize(before, await first.boundingBox());
  assert.ok(nextRequest);
  await nextRequest.fulfill({ contentType: 'image/svg+xml', body: svg });
  await first.locator('.candidate-thumbnail[data-state="loaded"]').waitFor();
  sameSize(before, await first.boundingBox());
});
