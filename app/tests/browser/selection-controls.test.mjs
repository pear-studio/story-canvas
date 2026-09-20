import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, devices } from 'playwright';

let server, browser, origin;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), cacheDir: '.temp/vite-selection-controls', optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
});
after(async () => { await browser?.close(); await server?.close(); });

test('桌面下拉菜单、透明标签选择器和勾选控件保留键盘语义', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.goto(`${origin}/tests/browser/selection-controls.html`);
  const select = page.getByLabel('用途分类');
  await select.click();
  await select.getByRole('option', { name: '画风', exact: true }).click();
  assert.equal(await select.inputValue(), '画风');
  await select.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await select.inputValue(), '角色');
  const overlay = page.getByLabel('角色归属');
  await overlay.click();
  await overlay.getByRole('option', { name: '配角', exact: true }).click();
  assert.equal(await overlay.inputValue(), '配角');
  const checkbox = page.getByLabel('启用资源');
  await checkbox.focus();
  await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await checkbox.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
  await page.getByLabel('仅当前页').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByLabel('全部页面').isChecked(), true);
  assert.equal(await page.getByLabel('仅当前页').isChecked(), false);
  assert.equal(await page.getByLabel('不可用资源').isDisabled(), true);
  assert.equal(await page.locator('#partial').evaluate(e => e.indeterminate), true);
});

test('触屏仍使用原生选择器，标签点按区域至少 44px，禁用项不响应', async t => {
  const page = await browser.newPage({ ...devices['Pixel 7'] });
  t.after(() => page.close());
  await page.goto(`${origin}/tests/browser/selection-controls.html`);
  const select = page.getByLabel('用途分类');
  assert.equal(await select.evaluate(e => getComputedStyle(e).appearance), 'auto');
  assert.ok((await select.boundingBox()).height >= 44);
  assert.ok(await select.evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 16));
  const label = page.locator('label').filter({ hasText: '启用资源' });
  assert.ok((await label.boundingBox()).height >= 44);
  await label.tap();
  assert.equal(await page.getByLabel('启用资源').isChecked(), true);
  await page.getByText('不可用资源', { exact: true }).tap({ force: true });
  assert.equal(await page.getByLabel('不可用资源').isChecked(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
