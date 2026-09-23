import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

let server, browser, origin;
before(async () => {
  server = await createServer({ cacheDir: ".temp/vite-comparison-tests", root: fileURLToPath(new URL("../../", import.meta.url)), optimizeDeps: { entries: [fileURLToPath(new URL('./comparison-experiments.html', import.meta.url))], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
});
after(async () => { await browser?.close(); await server?.close(); });

function record(id, day, { cfg = false, fixed = false } = {}) {
  const axis = (type, labels) => ({ type, values: labels.map((label, i) => ({ value_id: `${type}-${i}`, label: String(label) })) });
  const axes = [axis('input', ['明确约束原词持杯']), axis('lora_config', fixed ? ['baseline'] : ['baseline', 'v3-400']), axis('lora_weight', ['0.8']), axis('seed', fixed ? [162883670] : Array.from({ length: 10 }, (_, i) => 162883670 + i))];
  if (cfg) axes.push(axis('cfg', [4, 5]));
  const combinations = axes.reduce((cells, axis) => cells.flatMap(cell => axis.values.map(value => ({ ...cell, [axis.type]: value.value_id }))), [{}]);
  const cells = combinations.map((axis_values, ordinal) => ({ id: `cell-${ordinal}`, ordinal, axis_values }));
  return { id, manifest: { id, axes, cells, shared_seed: null, created_at: `2026-09-${day}T10:00:00Z` }, status: { status: 'completed', cells: cells.map(cell => ({ id: cell.id, ordinal: cell.ordinal, status: 'completed' })), updated_at: `2026-09-${day}T10:00:00Z` } };
}

async function setup(t, mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); assert.deepEqual(writes, []); });
  // 故意按旧到新返回，检查 UI 按创建时间排序，而不是依赖名称或服务端顺序。
  const records = [record('zzz-old-fixed', '16', { fixed: true }), record('middle-cfg', '17', { cfg: true }), record('confirm-cup-strict-v2', '18')];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/blank-input')) {
      const profileId = route.request().postDataJSON().profile_id;
      return route.fulfill({ json: { input: { id: 'input-blank', label: '测试输入', prompt: { positive: 'portrait', negative: '' }, loras: [], render: { profile: { id: profileId, architecture_family: profileId === 'qwen-image-2-1' ? 'qwen-image-2-1' : 'anima' }, workflows: {}, canvas: '2:3' }, source: null } } });
    }
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    if (path === '/api/projects') return route.fulfill({ json: { projects: [] } });
    if (path.endsWith('/input-options')) return route.fulfill({ json: { profiles: ['anima-base-v1', 'qwen-image-2-1'] } });
    if (path.endsWith('/comparison-experiments')) return route.fulfill({ json: { experiments: records } });
    if (path.endsWith('.png')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#dce6de"/><circle cx="240" cy="135" r="70" fill="#adc4b4"/><text x="240" y="260" text-anchor="middle" fill="#476056" font-size="20">Comparison preview</text></svg>' });
    return route.fulfill({ json: { experiment: records.find(record => path.endsWith(`/${record.id}`)) } });
  });
  await page.goto(`${origin}/tests/browser/comparison-experiments.html`);
  await page.locator('.comparison-experiment-list article').first().waitFor();
  const open = id => page.locator('.comparison-experiment-list article').filter({ hasText: id }).getByRole('button', { name: '查看结果' }).click();
  return { page, open };
}

test('最新实验优先，搜索和状态筛选，新建表单按需展开', async t => {
  const { page } = await setup(t);
  assert.deepEqual(await page.locator('.comparison-experiment-list article b').allTextContents(), ['confirm-cup-strict-v2', 'middle-cfg', 'zzz-old-fixed']);
  assert.deepEqual(await page.locator('.comparison-experiment-list article').first().locator('.comparison-axis-tags span').allTextContents(), ['风格 LoRA x2', 'Seed x10']);
  assert.equal(await page.locator('.comparison-experiment-form').isVisible(), false);
  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  assert.equal(await page.locator('.comparison-experiment-form').isVisible(), true);
  await page.getByRole('button', { name: '收起新建' }).click();
  await page.getByLabel('搜索实验').fill('strict');
  assert.equal(await page.locator('.comparison-experiment-list article').count(), 1);
  await page.getByLabel('实验状态').selectOption('running');
  await page.getByText('没有匹配的实验，请调整搜索或状态。').waitFor();
  await page.getByLabel('实验状态').selectOption('all');
  await page.getByLabel('搜索实验').fill('');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  assert.equal(await page.locator('.comparison-experiment-list article b').first().textContent(), 'confirm-cup-strict-v2');
});

test('Qwen 测试输入只显示已登记且架构匹配的 LoRA', async t => {
  const { page } = await setup(t);
  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '选择 LoRA', exact: true }).isDisabled(), true);
  await page.getByLabel('新输入生成配置').selectOption('qwen-image-2-1');
  await page.getByRole('button', { name: '新增空白输入' }).click();
  await page.getByRole('button', { name: '选择 LoRA', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择 LoRA', exact: true });
  assert.equal(await picker.locator('.resource-catalog-card').count(), 1);
  await picker.getByLabel('搜索 LoRA').fill('Anima');
  assert.equal(await picker.locator('.resource-catalog-card').count(), 0);
  await picker.getByLabel('搜索 LoRA').fill('');
  await picker.getByRole('checkbox', { name: '选择 维洛莉亚' }).check();
  await picker.getByRole('button', { name: '确认选择（1）' }).click();
  assert.equal(await page.locator('.comparison-selected-loras article').count(), 1);
  await page.getByRole('button', { name: '选择 LoRA', exact: true }).click();
  await picker.getByRole('button', { name: '清空选择', exact: true }).click();
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.comparison-selected-loras article').count(), 1);
  await page.getByRole('button', { name: '移除输入' }).click();
  await page.locator('.comparison-selected-loras article').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.comparison-selected-loras article').count(), 0);
  assert.equal(await page.getByRole('button', { name: '选择 LoRA', exact: true }).isDisabled(), true);
});

test('窄屏 Qwen LoRA 选择器可筛选和查看资料，没有横向溢出', async t => {
  const { page } = await setup(t, true);
  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  await page.getByLabel('新输入生成配置').selectOption('qwen-image-2-1');
  await page.getByRole('button', { name: '新增空白输入' }).click();
  await page.getByRole('button', { name: '选择 LoRA', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择 LoRA', exact: true });
  await picker.getByLabel('搜索 LoRA').fill('维洛莉亚');
  assert.equal(await picker.locator('.resource-catalog-card').count(), 1);
  await picker.getByRole('button', { name: '查看详情' }).click();
  const detail = page.getByRole('dialog', { name: '查看资源：维洛莉亚' });
  await detail.getByText('Qwen 角色 LoRA', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  await picker.getByRole('checkbox', { name: '选择 维洛莉亚' }).check();
  await picker.getByRole('button', { name: '确认选择（1）' }).click();
  assert.equal(await page.locator('.comparison-selected-loras article').count(), 1);
});

test('有变化的轴默认展开，变种计数、固定条件、行列交换和筛选导航', async t => {
  const { page, open } = await setup(t);
  await open('confirm-cup-strict-v2');
  assert.equal(await page.getByLabel('列维度', { exact: true }).inputValue(), 'lora_config');
  assert.equal(await page.getByLabel('行维度', { exact: true }).inputValue(), 'seed');
  assert.deepEqual(await page.getByLabel('列维度', { exact: true }).locator('option').allTextContents(), ['风格 LoRA x2', 'Seed x10']);
  assert.equal(await page.locator('.comparison-result-grid__cell').count(), 20);
  assert.equal(await page.locator('.comparison-axis-overview .is-fixed').count(), 2);
  assert.equal(await page.locator('.comparison-axis-overview dt').count(), 4);
  assert.equal(await page.locator('.comparison-axis-overview > div').filter({ hasText: 'Seed' }).locator('dd span').count(), 10);
  await page.getByRole('button', { name: '交换行列' }).click();
  assert.equal(await page.getByLabel('列维度', { exact: true }).inputValue(), 'seed');
  assert.equal(await page.getByLabel('行维度', { exact: true }).inputValue(), 'lora_config');
  await page.getByRole('button', { name: '恢复默认布局' }).click();
  await page.screenshot({ path: fileURLToPath(new URL('../../../runtime/comparison-ui-desktop.png', import.meta.url)) });
  await page.getByRole('button', { name: '改为单行浏览' }).click();
  assert.equal(await page.locator('.comparison-result-grid__cell').count(), 2);
  assert.equal(await page.getByRole('button', { name: '上一个Seed' }).isDisabled(), true);
  await page.getByRole('button', { name: '下一个Seed' }).click();
  assert.equal(await page.locator('.comparison-slice small').innerText(), '2 / 10');
  assert.equal(await page.locator('.comparison-browse-settings .comparison-slice kbd').innerText(), '← →');
  await page.locator('.comparison-slice select').selectOption('seed-1');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.comparison-slice small').innerText(), '3 / 10');
  await page.screenshot({ path: fileURLToPath(new URL('../../../runtime/comparison-ui-browse.png', import.meta.url)) });
  await page.locator('.comparison-slice select').selectOption('seed-9');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.comparison-slice small').innerText(), '9 / 10');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('button', { name: '下一个Seed' }).isDisabled(), true);
  await page.waitForFunction(() => document.querySelectorAll('.comparison-result-grid__image.is-loaded').length === 2);
  assert.deepEqual(await page.locator('.comparison-result-grid__cell img').evaluateAll(nodes => nodes.map(node => new URL(node.src).pathname.split('/').at(-1))), ['cell-9.png', 'cell-19.png']);
  await page.getByRole('button', { name: '下一个实验' }).click();
  await page.getByRole('dialog', { name: '对比实验详情：middle-cfg', exact: true }).waitFor();
  assert.equal(await page.locator('.comparison-slice small').innerText(), '1 / 2');
  await page.getByLabel('行维度', { exact: true }).selectOption('');
  await page.getByLabel('左右键切换', { exact: true }).selectOption('cfg');
  assert.equal(await page.getByLabel('上下键切换', { exact: true }).inputValue(), 'seed');
  assert.equal(await page.locator('.comparison-browse-settings .comparison-keyboard-settings').count(), 1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await page.locator('.comparison-slice small').allTextContents(), ['2 / 10', '2 / 2']);
  assert.equal(await page.getByLabel('左右键切换', { exact: true }).inputValue(), 'cfg');
  await page.getByRole('button', { name: '下一个实验' }).click();
  await page.getByRole('dialog', { name: '对比实验详情：zzz-old-fixed', exact: true }).waitFor();
  assert.equal(await page.locator('.comparison-result-grid__cell').count(), 1);
  assert.equal(await page.getByRole('button', { name: '下一个实验' }).isDisabled(), true);
  await page.getByRole('button', { name: '上一个实验' }).click();
  await page.getByRole('button', { name: '上一个实验' }).click();
  assert.equal(await page.getByLabel('行维度', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.comparison-slice small').innerText(), '10 / 10');
});

test('手机详情控件不溢出，宽结果网格独立横向滚动', async t => {
  const { page, open } = await setup(t, true);
  await open('confirm-cup-strict-v2');
  assert.equal(await page.locator('.modal__body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  const grid = page.locator('.comparison-result-grid');
  assert.equal(await grid.evaluate(node => node.scrollWidth > node.clientWidth), true);
  await grid.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  assert.ok(await grid.evaluate(node => node.scrollLeft) > 0);
  await page.screenshot({ path: fileURLToPath(new URL('../../../runtime/comparison-ui-mobile.png', import.meta.url)) });
});

test('后台进度刷新不关闭大图，图片说明包含完整条件', async t => {
  const { page, open } = await setup(t);
  await open('confirm-cup-strict-v2');
  await page.locator('.comparison-result-grid__image.is-loaded').first().click();
  await page.locator('.image-lightbox').waitFor();
  assert.match(await page.locator('.image-lightbox').innerText(), /Seed：162883670/);
  const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/comparison-experiments/confirm-cup-strict-v2'));
  // 模拟 App 在弹窗外投递新的任务进度，不能通过点击遮罩关闭大图。
  await page.locator('#simulate-progress').evaluate(node => node.click());
  await response;
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.image-lightbox').isVisible(), true);
});

test('切片慢速加载保留图片尺寸和滚动位置，连续切换不回显过期图片', async t => {
  const { page, open } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route('**/results/cell-*.png', async route => {
    if (/\/cell-(1|11)\.png$/.test(new URL(route.request().url()).pathname)) await gate;
    await route.fallback();
  });
  await open('confirm-cup-strict-v2');
  await page.getByRole('button', { name: '改为单行浏览' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.comparison-result-grid__image.is-loaded').length === 2);
  await page.locator('.modal__body').evaluate(node => { node.scrollTop = 180; });
  const geometry = () => page.evaluate(() => ({
    scroll: document.querySelector('.modal__body').scrollTop,
    images: [...document.querySelectorAll('.comparison-result-grid__image')].map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }),
  }));
  const before = await geometry();
  await page.keyboard.press('ArrowRight');
  await page.locator('.comparison-result-grid__image.is-loading').first().waitFor();
  assert.deepEqual(await geometry(), before);
  assert.deepEqual(await page.locator('.comparison-result-grid__image img:not(.comparison-result-grid__pending)').evaluateAll(nodes => nodes.map(node => new URL(node.src).pathname.split('/').at(-1))), ['cell-0.png', 'cell-10.png']);
  await page.locator('.comparison-result-grid__image').first().dispatchEvent('click');
  assert.equal(await page.locator('.image-lightbox').count(), 0, '旧预览等待替换时不能打开新条件对应的大图');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelectorAll('.comparison-result-grid__image.is-loaded').length === 2);
  assert.deepEqual(await geometry(), before);
  release();
  await page.waitForTimeout(150);
  assert.deepEqual(await page.locator('.comparison-result-grid__image img').evaluateAll(nodes => nodes.map(node => new URL(node.src).pathname.split('/').at(-1))), ['cell-2.png', 'cell-12.png']);
  assert.deepEqual(await geometry(), before);
});


test('全局新建一次性导入、自由文本编辑与批量清理', async t => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const sample = { id: 'sample-a', label: '窗边肖像', prompt: { positive: 'portrait by a window', negative: 'blur' }, loras: [], render: { profile: { id: 'anima-base-v1' }, workflows: {}, canvas: '2:3' }, source: { project_id: 'source', imported_at: '2026-09-18T01:00:00Z' } };
  let created = null, submitted = null, imports = 0, deleted = null;
  await page.route('**/api/**', route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === '/api/projects') return route.fulfill({ json: { projects: [{ id: 'source', title: '来源项目' }] } });
    if (path.endsWith('/input-options')) return route.fulfill({ json: { profiles: ['anima-base-v1'] } });
    if (path.endsWith('/workbench')) return route.fulfill({ json: { outline: { chapters: [{ sequences: [{ pages: [{ page_key: { page_id: 'page-1' }, page_id: 'page-1', title: '窗边肖像', kind: 'story' }] }] }] }, characters: [] } });
    if (path.endsWith('/import')) { imports++; return route.fulfill({ json: { inputs: [sample] } }); }
    if (request.method() === 'DELETE') { deleted = request.postDataJSON().ids; created = null; return route.fulfill({ json: { deleted } }); }
    if (path.endsWith('/comparison-experiments') && request.method() === 'POST') {
      submitted = request.postDataJSON(); created = record(submitted.id, '18', { fixed: true });
      return route.fulfill({ json: { experiment: created } });
    }
    if (path.endsWith('/comparison-experiments')) return route.fulfill({ json: { experiments: created ? [created] : [] } });
    return route.fulfill({ json: { experiment: created } });
  });
  await page.goto(`${origin}/tests/browser/comparison-experiments.html`);
  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  await page.getByLabel('来源项目', { exact: true }).selectOption('source');
  await page.getByRole('checkbox', { name: '窗边肖像' }).check();
  await page.getByRole('button', { name: '导入所选页面（1）' }).click();
  await page.getByRole('textbox', { name: '窗边肖像 正向 Prompt', exact: true }).fill('portrait, warm light');
  await page.getByRole('textbox', { name: '窗边肖像 负向 Prompt', exact: true }).fill('');
  await page.screenshot({ path: '.temp/comparison-global-inputs.png', fullPage: true });
  await page.getByRole('button', { name: '开始实验', exact: true }).click();
  await page.locator('.comparison-experiment-list article').waitFor();
  assert.equal(imports, 1);
  assert.equal(submitted.inputs[0].prompt.positive, 'portrait, warm light');
  assert.equal(submitted.inputs[0].prompt.negative, '');
  assert.equal(submitted.axes[0].type, 'input');
  assert.equal(submitted.project_id, undefined);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByPlaceholder('留空使用整组共享随机 Seed', { exact: true }).fill('123, 456');
  await page.getByPlaceholder('留空沿用输入 CFG', { exact: true }).fill('4, 5');
  await page.getByRole('button', { name: '清空重置', exact: true }).click();
  assert.equal(await page.locator('.comparison-input-card').count(), 0);
  assert.equal(await page.getByLabel('来源项目', { exact: true }).inputValue(), '');
  assert.equal(await page.getByPlaceholder('留空使用整组共享随机 Seed', { exact: true }).inputValue(), '');
  assert.equal(await page.getByPlaceholder('留空沿用输入 CFG', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '开始实验', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.comparison-experiment-list article').count(), 1);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('checkbox', { name: `选择清理 ${created.id}` }).check();
  await page.getByRole('button', { name: '清理所选（1）' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.comparison-experiment-list article').length === 0);
  assert.deepEqual(deleted, [submitted.id]);
  assert.deepEqual(errors, []);
});
