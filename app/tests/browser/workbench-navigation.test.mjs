import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { defaultLetteringSettings } from "../../server/lettering-settings.mjs";

let server, browser, origin;
before(async () => {
  server = await createServer({ cacheDir: ".temp/vite-navigation-tests", root: fileURLToPath(new URL("../../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
});
after(async () => { await browser?.close(); await server?.close(); });

async function setup(t, { character = false, mobile = false, visualPages = false, longStory = false } = {}) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1500, height: 1000 }, hasTouch: mobile });
  page.setDefaultTimeout(8000);
  const errors = [], renders = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  const prompt = Object.fromEntries(["subject", "person", "setting", "camera", "avoid"].map(key => [key, []]));
  const pages = ["a", "b", "c"].map(id => ({ kind: "story", page_id: id, page_key: { page_id: id }, title: `页面${id}`, scene_description: "窗台", characters: [], dialogue: [], prompt, content_sha256: "a".repeat(64), prompt_sha256: "b".repeat(64), prompt_context_sha256: "c".repeat(64), lettering: { page: id, items: [] } }));
  const views = Object.fromEntries(["alpha", "beta"].map(id => [id, { version: 4, project: { id, title: id, canvas: "2:3", default_render_profile: "anima", lettering_settings: defaultLetteringSettings(), lettering_settings_sha256: "e".repeat(64) }, outline: { synopsis: "", chapters: [{ id: "chapter", title: "第一章", summary: "", sequences: [{ id: "sequence", title: "单元", summary: "", pages: structuredClone(pages) }] }] }, characters: [], render_capabilities: { candidates: { available: true, counts: [1, 3] } }, diagnostics: [] }]));
  if (character) views.alpha.characters = [{
    id: "alice", name: "Alice", description: "角色设定", profile_sha256: "profile",
    visual: { description: "视觉说明", variants: [{ id: "daily", name: "日常", description: "原日常说明" }, { id: "dress", name: "礼服", description: "原礼服说明" }] },
    visual_sha256: "visual", prompt_sha256: "prompt", style: null, pages: [],
    prompt: { identity: { prompt, lora: null }, variants: Object.fromEntries(["daily", "dress"].map(id => [id, { prompt: structuredClone(prompt), loras: [], identity_disabled: [] }])) },
  }];
  if (visualPages) views.alpha.characters[0].pages = ['daily', 'daily', 'dress'].map((variant_id, index) => ({
    ...structuredClone(pages[0]), kind: 'character', page_id: `portrait-${index}`, title: `视觉页${index}`,
    page_key: { page_id: `portrait-${index}` }, character_id: 'alice', variant_id, visual_goal: '自然站立',
  }));
  if (longStory) views.alpha.outline.chapters = Array.from({ length: 3 }, (_, c) => ({
    id: `chapter-${c}`, title: `章节${c + 1}`, summary: '章节摘要', sequences: Array.from({ length: 3 }, (_, s) => ({
      id: `seq-${c}-${s}`, title: `单元${c + 1}-${s + 1}`, summary: '单元摘要', pages: pages.map((item, p) => ({
        ...structuredClone(item), page_id: `p-${c}-${s}-${p}`, page_key: { page_id: `p-${c}-${s}-${p}` },
        dialogue: [{ id: 'line', mode: 'narration', text: Array(12).fill('用于验证连续阅读的位置。').join('\n') }],
      })),
    })),
  }));
  let revision = 1;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    const reply = json => route.fulfill({ json, headers: { "x-story-canvas-revision": String(revision) } });
    if (pathname === "/api/projects") return reply({ projects: ["alpha", "beta"].map(id => ({ id, title: id, pages: 3 })) });
    if (pathname === "/api/project-library") return reply({ projects: ["alpha", "beta"].map(id => ({ id, title: id, type: 'story', path: `C:/Projects/${id}`, temporary: id === 'beta', available: true })) });
    if (pathname.startsWith('/api/project-library/') && pathname.endsWith('/git')) return reply({ status: 'ready', branch: 'main', dirty: false, changes: [], remotes: [] });
    if (pathname === "/api/health") return reply({ instance_id: "test" });
    if (pathname === "/api/hardware-status") return reply({ cpu: { available: false }, memory: { available: false }, gpu: { available: false }, comfyui: { connected: false, status: "offline" } });
    if (pathname === "/api/tasks") return reply({ tasks: [], history: [] });
    if (pathname === "/api/lora-training/datasets") return reply({ datasets: [] });
    if (pathname === "/api/lora-training/tasks") return reply({ tasks: [] });
    if (pathname === "/api/lora-training/runs") return reply({ runs: [] });
    if (pathname === "/api/lora-training/recipes") return reply({ recipes: [] });
    if (pathname === "/api/lora-training/environment") return reply({ available: false, checks: [], captioning: { configured: false, ready: false } });
    const id = pathname.split("/")[3];
    if (pathname.endsWith("/revision")) return reply({ revision: String(revision) });
    if (pathname.endsWith("/workbench")) return reply(views[id]);
    if (pathname.endsWith("/candidate-counts")) return reply({ revision: "media", counts: {} });
    if (pathname.endsWith("/page-media")) return reply({ revision: "media", media: { candidates: [] } });
    if (pathname.endsWith("/page-render-inspection")) return reply({ inspection: { ready: true, blockers: [], warnings: [], structured_import: null, two_step_supported: false, draft_base: null, audit: { status: "complete", errors: [], warnings: [] }, prompt: { signature: "test", positive: "", negative: "" } } });
    if (pathname.endsWith("/render")) { renders.push(route.request().postDataJSON()); return reply({ task: { task_id: "render-test" } }); }
    if (pathname.endsWith("/navigation/delete-page")) {
      const { page_id } = route.request().postDataJSON();
      views[id].outline.chapters[0].sequences[0].pages = views[id].outline.chapters[0].sequences[0].pages.filter(item => item.page_id !== page_id);
      revision++;
      return reply({});
    }
    return route.fulfill({ status: 404, json: { error: "test_endpoint_unavailable" } });
  });
  await page.goto(`${origin}/?project=alpha&${longStory ? "tab=project-story" : character ? "tab=characters&character=alice&setting=daily" : "tab=story&page=b"}`);
  if (longStory) await page.getByRole('navigation', { name: '剧情阅读目录' }).waitFor();
  else if (character) {
    try { await page.getByLabel("重命名子设定", { exact: true }).waitFor(); }
    catch (error) { t.diagnostic(await page.locator("body").innerText()); t.diagnostic(JSON.stringify(errors)); throw error; }
  }
  else await page.locator('.tree-page.is-active').filter({ hasText: "页面b" }).waitFor({ state: mobile ? "attached" : "visible" });
  const switchTo = async id => {
    await page.locator('.project-switcher > summary').click();
    await page.locator('.project-switcher-menu').getByRole('button', { name: id, exact: true }).click();
  };
  return { page, renders, switchTo };
}

test("全局训练入口保留手机状态与项目翻页，返回项目恢复页面", async t => {
  const { page } = await setup(t, { mobile: true });
  await page.locator('.page-turn-navigation').waitFor();
  await page.locator('.project-switcher > summary').click();
  await page.locator('.project-switcher-menu').getByRole('button', { name: 'LoRA 训练', exact: true }).click();
  await page.getByRole('heading', { name: '暂无数据集', exact: true }).waitFor();
  assert.equal(await page.title(), 'LoRA 训练');
  assert.equal(new URL(page.url()).searchParams.has('project'), false);
  assert.equal(await page.locator('.page-turn-navigation').count(), 0);
  assert.equal(await page.locator('.topbar-statuses > details').count(), 2);
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.locator('.navigation-drawer').getByRole('button', { name: '全部训练记录', exact: true }).click();
  await page.getByRole('heading', { name: '全部训练记录', exact: true }).waitFor();
  assert.equal(await page.title(), 'LoRA 训练');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.locator('.project-switcher h1').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.locator('.project-switcher > summary').click();
  await page.locator('.project-switcher-menu').getByRole('button', { name: 'alpha', exact: true }).click();
  await page.locator('.page-turn-navigation').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('page'), 'b');
  assert.equal(await page.title(), 'alpha');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.locator('.topbar').evaluate(node => node.scrollWidth <= node.clientWidth), true);
});

test("没有项目也能直达训练，刷新与资源切换不要求项目事实", async t => {
  const { page } = await setup(t);
  await page.route('**/api/projects', route => route.fulfill({ json: { projects: [] } }));
  await page.goto(`${origin}/?tab=lora-datasets`);
  await page.getByRole('heading', { name: '暂无数据集', exact: true }).waitFor();
  await page.locator('.lora-dataset-nav-heading').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新增数据集', exact: true }).click();
  await page.getByRole('heading', { name: '新建数据集', exact: true }).waitFor();
  await page.locator('.lora-create-card').getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: '暂无数据集', exact: true }).waitFor();
  assert.equal(await page.locator('.project-switcher h1').textContent(), 'LoRA 训练');
});

test("数据集导航切换保持选择且不会反复加载", async t => {
  const { page } = await setup(t);
  const datasets = ['a', 'b'].map(id => ({ id: `dataset-${id}`, name: `数据集${id}`, item_count: 0 }));
  const requests = [];
  await page.route('**/api/lora-training/datasets', route => route.fulfill({ json: { datasets } }));
  await page.route('**/api/lora-training/datasets/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    requests.push(id);
    return route.fulfill({ json: { id, dataset: { version: 5, name: datasets.find(item => item.id === id).name, description: '', activation_terms: [], groups: [], items: [] }, items: [], captioning: { version: 1, latest: null, summary: { total: 0, with_base: 0, confirmed: 0, unconfirmed: 0 }, items: [] } } });
  });
  await page.goto(`${origin}/?tab=lora-datasets`);
  const name = page.getByRole('textbox', { name: '名称', exact: true });
  await name.waitFor();
  assert.equal(await name.inputValue(), '数据集a');
  requests.length = 0;
  for (const id of ['b', 'a', 'b']) {
    await page.locator('.lora-dataset-nav-item').filter({ hasText: `数据集${id}` }).click();
    await page.waitForFunction(expected => document.querySelector('.lora-panel--overview input')?.value === expected, `数据集${id}`);
    // 留出多个 Effect 周期，捕获曾经持续往返的导航反馈循环。
    await page.waitForTimeout(200);
    assert.equal(await name.inputValue(), `数据集${id}`);
    assert.equal(await page.locator('.lora-dataset-nav-item.is-active b').innerText(), `数据集${id}`);
  }
  assert.deepEqual(requests, ['dataset-b', 'dataset-a', 'dataset-b']);
});

test("训练记录独立列出、轮询保留选择并实时绘制 loss", async t => {
  const { page } = await setup(t);
  const id = "lora-123456abcdef";
  let count = 2;
  const run = index => ({ id: `run-${index}`, manifest: { task_id: id, task_name: `冻结名称${index}`, dataset_name: '素材', created_at: "2026-09-18T00:00:00Z", config: { max_train_steps: 800, resolution: 1024, network_dim: 32, learning_rate: 0.00002 } }, status: { status: index === 0 ? "running" : "interrupted", step: count * 10, loss: 0.1, eta_seconds: 60, error: null, checkpoints: [], log_tail: `steps: 1%|x| ${count * 10}/800 [00:01, avr_loss=0.1]` }, disk_bytes: 100 });
  await page.route('**/api/lora-training/runs', route => route.fulfill({ json: { runs: Array.from({ length: count }, (_, i) => run(i)) } }));
  await page.route('**/api/lora-training/tasks', route => route.fulfill({ json: { tasks: [{ id, name: "测试训练", runs: [{ id: "run-0", status: "running" }] }] } }));
  await page.route(`**/api/lora-training/tasks/${id}`, route => route.fulfill({ json: { id, task: { name: "测试训练", target: { base: { dit: { relative_path: "test.safetensors" } } }, training_recipe: { id: "test", overrides: {} }, run_defaults: {} }, dataset: { name: "测试素材", effective_item_count: 194 }, runs: Array.from({ length: count }, (_, i) => run(i)) } }));
  await page.route(`**/api/lora-training/tasks/${id}/run-settings`, route => route.fulfill({ json: { values: {}, recommendations: {} } }));
  await page.goto(`${origin}/?tab=lora-history`);
  await page.locator('.lora-task-list button').filter({hasText:'冻结名称1'}).waitFor();
  assert.equal(await page.locator('.lora-task-list button').count(), 2);
  await page.locator('.lora-task-list button').filter({hasText:'冻结名称1'}).click();
  await page.getByRole('img', { name: /Loss 随 step 变化/ }).waitFor();
  count = 3;
  await page.locator('.lora-task-list button').filter({hasText:'冻结名称2'}).waitFor();
  await page.locator('.lora-loss-heading').getByText(/Step 30/).waitFor();
  assert.equal(await page.locator('.lora-task-workspace h3').innerText(), '冻结名称1');
  assert.equal(await page.locator('.lora-task-workspace select').count(), 1, '保留已有的图表选项');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.lora-loss-chart').evaluate(node => node.scrollWidth <= node.clientWidth), true);
});

test("项目切换直接进入基本信息，拒绝放弃草稿时保留当前项目和输入", async t => {
  const { page, switchTo } = await setup(t);
  await page.reload();
  await page.locator('.tree-page.is-active').filter({ hasText: "页面b" }).waitFor();
  await switchTo("beta");
  await page.getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  assert.equal(new URL(page.url()).search, '?project=beta&tab=project-settings');
  const title = page.getByLabel('项目名称', { exact: true });
  await title.fill('未保存名称');
  await switchTo('alpha');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await title.inputValue(), '未保存名称');
  assert.equal(new URL(page.url()).searchParams.get('project'), 'beta');
  await switchTo('alpha');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForURL('**/?project=alpha&tab=project-settings');
  await page.getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  assert.equal(await title.inputValue(), 'alpha');
});

for (const mobile of [false, true]) test(`项目弹出菜单直接切换设置，保护草稿与视口边界（${mobile ? '手机' : '桌面'}）`, async t => {
  const { page } = await setup(t, { mobile });
  await page.route('**/api/projects/*/render-profile', route => route.fulfill({ json: { render_profiles: [] }, headers: { 'x-story-canvas-revision': '1' } }));
  await page.route('**/api/projects/*/render-profile-override', route => route.fulfill({ json: { override: null }, headers: { 'x-story-canvas-revision': '1' } }));
  await page.route('**/api/lora-resources', route => route.fulfill({ json: { resources: [], raw: [] } }));
  const showMenu = async () => {
    if (mobile && !await page.locator('.navigation-drawer').isVisible()) await page.getByRole('button', { name: '目录', exact: true }).click();
    await page.getByLabel('项目选项', { exact: true }).click();
    await page.getByLabel('项目选项列表').waitFor();
  };
  await showMenu();
  const menu = page.getByLabel('项目选项列表');
  assert.deepEqual(await menu.getByRole('button').allTextContents(), ['基本信息', '生成设置', '参考材料', '任务历史', '创建临时副本', '从列表移除']);
  assert.equal(await menu.evaluate(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; }), true);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await showMenu();
  await menu.getByRole('button', { name: '基本信息', exact: true }).click();
  await page.getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  const title = page.getByLabel('项目名称', { exact: true });
  await title.fill('保留这份草稿');
  await showMenu();
  await menu.getByRole('button', { name: '生成设置', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存修改' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await title.inputValue(), '保留这份草稿');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'project-settings');
  await showMenu();
  await menu.getByRole('button', { name: '生成设置', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存修改' }).getByRole('button', { name: '确认', exact: true }).click();
  await page.getByRole('heading', { name: '生成设置', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'project-render-profile');
  await showMenu();
  assert.equal(await menu.getByRole('button', { name: '生成设置', exact: false }).getAttribute('aria-current'), 'page');
  await page.screenshot({ path: fileURLToPath(new URL(`../../../Saved/Tests/project-menu-${mobile ? 'mobile' : 'desktop'}.png`, import.meta.url)) });
});

test("添加入口与当前项目管理分开，取消移除不发送修改请求", async t => {
  const { page, switchTo } = await setup(t);
  const mutations = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/project-library')) mutations.push(request.url()); });
  await page.locator('.project-switcher > summary').click();
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加项目', exact: true });
  await dialog.getByLabel('项目文件夹').waitFor();
  assert.equal(await dialog.getByText('从列表移除', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await switchTo('beta');
  await page.getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  assert.equal(await page.getByLabel('项目目录', { exact: true }).inputValue(), 'C:/Projects/beta');
  assert.equal(await page.getByRole('button', { name: '重命名目录', exact: true }).count(), 0);
  await page.getByLabel('项目选项', { exact: true }).click();
  const menu = page.getByLabel('项目选项列表');
  await menu.getByRole('button', { name: '保留为正式项目', exact: true }).waitFor();
  await menu.getByRole('button', { name: '删除临时项目', exact: true }).waitFor();
  await menu.getByRole('button', { name: '从列表移除', exact: true }).click();
  await page.getByRole('dialog', { name: '从列表移除', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(mutations, []);
});

test("Ctrl 和 Shift 点击只打开一个页面，生成只提交当前页", async t => {
  const { page, renders } = await setup(t);
  await page.locator('.tree-page').filter({ hasText: '页面a' }).click({ modifiers: ['Control'] });
  await page.locator('.tree-page').filter({ hasText: '页面c' }).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.tree-page[aria-selected="true"]').count(), 1);
  assert.equal(await page.locator('.tree-page.is-active').textContent(), '03页面c0 张');
  await page.locator('.workbench-page-editor .generate-split__action').click();
  await page.getByText('已启动当前页面任务', { exact: true }).waitFor();
  assert.deepEqual(renders.map(item => item.page_key), [{ page_id: 'c' }]);
});

test("手机生成默认三张，长按选择张数不误触生成", async t => {
  const { page, renders } = await setup(t, { mobile: true });
  const action = page.locator('.current-workbench-page .generate-split__action').filter({ visible: true }).last();
  await action.waitFor();
  await action.scrollIntoViewIfNeeded();
  await page.waitForFunction(button => !button.disabled, await action.elementHandle(), { timeout: 8000 });
  assert.match(await action.innerText(), /×3/);
  assert.equal(await page.locator('.current-workbench-page .generate-split__toggle').filter({ visible: true }).count(), 0);
  const bounds = await action.boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
  const choice = page.getByRole('menuitemradio', { name: '生成 ×1', exact: true });
  await choice.waitFor();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await choice.tap();
  assert.equal(renders.length, 0, '长按及选择张数不提交任务');
  assert.match(await action.innerText(), /×1/);
  await action.tap();
  await page.getByText('已启动当前页面任务', { exact: true }).waitFor();
  assert.equal(renders.length, 1);
  assert.equal(renders[0].count, 1);
});

test("导航菜单删除当前页后依次回退到后一页、前一页和空态", async t => {
  const { page } = await setup(t);
  for (const [deleted, expected] of [['b', 'c'], ['c', 'a'], ['a', null]]) {
    await page.locator('.tree-page.is-active').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除页面', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.locator('.tree-page').filter({ hasText: `页面${deleted}` }).waitFor({ state: 'detached' });
    if (expected) await page.locator('.tree-page.is-active').filter({ hasText: `页面${expected}` }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('page'), expected);
  }
  assert.equal(await page.locator('.tree-page.is-active').count(), 0);
});


test("同角色切换子设定保留共享草稿不提示放弃，离开角色编辑器仍保护草稿", async t => {
  const { page, switchTo } = await setup(t, { character: true });
  const name = page.getByLabel('重命名子设定', { exact: true });
  const navigation = page.getByLabel('角色与视觉页', { exact: true });
  const rename = async value => { await name.click(); await name.fill(value); };
  await rename('日常未保存修改');
  await navigation.getByRole('button', { name: '礼服', exact: true }).click();
  await page.waitForURL('**setting=dress', { timeout: 3000 });
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.waitForFunction(() => document.querySelector('[aria-label="重命名子设定"]')?.textContent === '礼服');
  assert.equal(await name.textContent(), '礼服');
  await rename('礼服未保存修改');
  await navigation.getByRole('button', { name: '日常', exact: true }).click();
  await page.waitForURL('**setting=daily', { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('[aria-label="重命名子设定"]')?.textContent === '日常未保存修改');
  assert.equal(await name.textContent(), '日常未保存修改');
  await navigation.getByRole('button', { name: '礼服', exact: true }).click();
  await page.waitForURL('**setting=dress', { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('[aria-label="重命名子设定"]')?.textContent === '礼服未保存修改');
  assert.equal(await name.textContent(), '礼服未保存修改');
  await switchTo('beta');
  await page.getByRole('dialog', { name: '放弃未保存修改' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get('project'), 'alpha');
  assert.equal(await name.textContent(), '礼服未保存修改');
  await switchTo('beta');
  await page.getByRole('dialog', { name: '放弃未保存修改' }).getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForURL('**/?project=beta&tab=project-settings');
  await page.getByRole('heading', { name: '基本信息', exact: true }).waitFor();
});

test("Ctrl+S 保存包含词条输入框中未提交的草稿", async t => {
  const { page } = await setup(t);
  const saves = [];
  await page.route("**/api/projects/*/workbench/page-save", route => {
    const body = route.request().postDataJSON();
    saves.push(body);
    return route.fulfill({ json: { content: body.content, content_sha256: "saved-content", prompt: body.prompt, prompt_sha256: "d".repeat(64), lettering: { page: body.page_key.page_id, items: body.lettering.items }, layout_sha256: "saved-layout" }, headers: { "x-story-canvas-revision": "2" } });
  });
  await page.getByRole("button", { name: "＋ 场景", exact: true }).click();
  const input = page.getByRole("combobox", { name: "场景第 1 项 Prompt" });
  await input.fill("a lamp by the window");
  await input.press("Control+s");
  await page.getByText("文案与布局已保存", { exact: true }).waitFor();
  assert.equal(saves.length, 1, "Ctrl+S 应触发一次 Prompt 保存");
  assert.equal(saves[0].prompt.setting[0].tag, "a lamp by the window", "保存内容应包含未提交草稿");
});

test("分区浏览不离开草稿，搜索实际打开页面并同步目录和前后历史", async t => {
  const { page } = await setup(t);
  const search = page.getByRole('combobox', { name: '搜索项目内容' });
  await page.getByLabel('画面内容', { exact: true }).fill('未保存的画面');
  await page.locator('.navigation-sections').getByRole('button', { name: '设定', exact: true }).click();
  assert.equal(await page.getByLabel('画面内容', { exact: true }).inputValue(), '未保存的画面');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await search.fill('3'); await search.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get('page'), 'b');
  assert.equal(await page.getByRole('button', { name: '后退', exact: true }).isDisabled(), true);
  await search.fill('3'); await search.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForURL('**page=c');
  assert.equal(await page.locator('.navigation-sections').getByRole('button', { name: '系列', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.waitForURL('**page=b');
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await page.waitForURL('**page=c');
  await page.locator('.navigation-sections').getByRole('button', { name: '系列', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新增章节', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.tree-page.is-active').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新增页面', exact: true }).waitFor();
});

test("角色视觉页按子设定分别编号，搜索跳转保持所在组的序号", async t => {
  const { page } = await setup(t, { character: true, visualPages: true });
  const tree = page.getByLabel('角色与视觉页', { exact: true });
  assert.deepEqual(await tree.locator('.navigation-page-number').allTextContents(), ['01', '02']);
  await tree.getByRole('button', { name: '展开子设定“礼服”的视觉页', exact: true }).click();
  assert.deepEqual(await tree.locator('.navigation-page-number').allTextContents(), ['01', '02', '01']);
  await page.getByRole('combobox', { name: '搜索项目内容' }).fill('视觉页2');
  await page.getByRole('combobox', { name: '搜索项目内容' }).press('Enter');
  await page.waitForURL('**page=portrait-2**');
  assert.equal(await tree.locator('.tree-page.is-active .navigation-page-number').textContent(), '01');
});

test("跳转项目嵌字样式后返回恢复页内标签，后退取消保留样式草稿", async t => {
  const { page } = await setup(t);
  await page.getByRole('tab', { name: '嵌字', exact: true }).click();
  await page.getByRole('button', { name: '项目嵌字样式 ↗', exact: true }).click();
  await page.getByRole('heading', { name: '嵌字设置', exact: true }).waitFor();
  assert.equal(await page.locator('.navigation-sections').getByRole('button', { name: '输出', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.waitForURL('**page=b');
  assert.equal(await page.getByRole('tab', { name: '嵌字', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await page.getByRole('heading', { name: '嵌字设置', exact: true }).waitFor();
  const size = page.locator('.lettering-style-settings--standalone input[type="number"]').first();
  await size.fill('36');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await size.inputValue(), '36');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'project-lettering');
});


test("迟到的训练进度保留任务草稿及其保存版本", async t => {
  const { page } = await setup(t);
  const id = "lora-123456abcdef";
  const task = { version: 3, name: "原任务", dataset_id: "dataset-123456abcdef", target: { base: { dit: { relative_path: "anima.safetensors" } } }, training_recipe: { id: "recipe", overrides: { effective_batch_size: 1 } }, run_defaults: { micro_batch_size: 1, max_train_steps: 800, save_every_n_steps: 100 } };
  const detail = { id, task, dataset: { name: "素材", effective_item_count: 1 }, runs: [{ id: "run", manifest: { task_id: id, task_name: task.name, dataset_name: "素材", created_at: "2026-09-18T00:00:00Z", config: { max_train_steps: 800 } }, status: { status: "running", step: 1 }, disk_bytes: 0 }] };
  let reads = 0, release, saved;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/lora-training/tasks", route => route.fulfill({ json: { tasks: [{ id, name: "原任务", dataset: { name: "素材" }, runs: [] }] } }));
  await page.route(`**/api/lora-training/tasks/${id}/run-settings`, route => route.fulfill({ json: { values: {}, recommendations: {}, sources: {}, semantic_config: {} }, headers: { etag: '"auxiliary"' } }));
  await page.route(`**/api/lora-training/tasks/${id}`, async route => {
    if (route.request().method() === "PUT") {
      saved = { task: route.request().postDataJSON(), revision: route.request().headers()["if-match"] };
      return route.fulfill({ json: { ...detail, task: saved.task }, headers: { etag: '"saved"' } });
    }
    reads++;
    if (reads > 1) await pending;
    return route.fulfill({ json: reads > 1 ? { ...detail, task: { ...task, name: "另一个窗口" }, runs: [] } : detail, headers: { etag: reads > 1 ? '"new"' : '"original"' } });
  });
  await page.goto(`${origin}/?tab=lora-tasks`);
  const name = page.getByLabel("方案名称", { exact: true });
  try { await name.waitFor(); } catch (error) { t.diagnostic(`reads=${reads} ${await page.locator("body").innerText()}`); throw error; }
  const poll = await page.waitForRequest(request => request.url().endsWith(`/tasks/${id}`) && request.method() === "GET");
  await name.fill("我的草稿");
  const response = page.waitForResponse(value => value.request() === poll);
  release();
  await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await name.inputValue(), "我的草稿");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.getByText("已保存", { exact: true }).waitFor();
  assert.equal(saved.task.name, "我的草稿");
  assert.equal(saved.revision, '"original"');
});






test('子设定 ID 草稿跨子设定切换保留且离开设定仍提示', async t => {
 const { page, switchTo } = await setup(t, { character: true });
 const id = page.getByLabel('子设定 ID', { exact: true });
 await id.fill('daily-new');
 const navigation = page.getByLabel('角色与视觉页', { exact: true });
 await navigation.getByRole('button', { name: '礼服', exact: true }).click();
 await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'dress'));
 await id.fill('dress-new');
 await navigation.getByRole('button', { name: '日常', exact: true }).click();
 await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'daily-new'));
 assert.equal(await id.inputValue(), 'daily-new');
 await navigation.getByRole('button', { name: '礼服', exact: true }).click();
 await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'dress-new'));
 assert.equal(await id.inputValue(), 'dress-new');
 await switchTo('beta');
 await page.getByRole('dialog', { name: '放弃未保存修改' }).getByRole('button', { name: '取消', exact: true }).click();
 assert.equal(await id.inputValue(), 'dress-new');
});
test("剧情范围目录全部展开，局部渲染且后台刷新不抢滚动", async t => {
  const { page } = await setup(t, { longStory: true });
  const directory = page.getByRole('navigation', { name: '剧情阅读目录' });
  assert.equal(await directory.getByRole('button').count(), 13);
  assert.equal(await page.locator('.story-overview-page').count(), 27);
  await directory.getByRole('button', { name: '2. 章节2', exact: true }).click();
  assert.equal(await page.locator('.story-overview-page').count(), 9);
  await directory.getByRole('button', { name: /2\.2 单元2-2/ }).click();
  assert.equal(await page.locator('.story-overview-page').count(), 3);
  assert.equal(await directory.getByRole('button').count(), 13);
  assert.equal(await page.locator('.story-overview-page-number').first().innerText(), '13');
  await page.getByRole('button', { name: '下一个情节单元', exact: true }).click();
  assert.match(await page.locator('.story-reading-location').innerText(), /单元2-3/);
  await page.locator('.story-reading-controls').getByRole('button', { name: '更多', exact: true }).click();
  assert.match(await page.locator('.story-reading-actions').innerText(), /当前范围：章节2 \/ 单元2-3/);
  await page.locator('.story-reading-controls').getByRole('button', { name: '更多', exact: true }).click();
  await page.locator('.project-main').evaluate(node => node.scrollBy(0, 450));
  const position = await page.locator('.project-main').evaluate(node => node.scrollTop);
  assert.ok(position > 200);
  // 等待真实后台轮询触发父组件刷新，不能重新执行定位。
  await page.waitForResponse(response => response.url().includes('/api/hardware-status'));
  await page.waitForTimeout(150);
  assert.ok(Math.abs(await page.locator('.project-main').evaluate(node => node.scrollTop) - position) < 3);
  await directory.getByRole('button', { name: '全文', exact: true }).click();
  assert.equal(await page.locator('.story-overview-page').count(), 27);
  await page.screenshot({ path: 'Saved/story-overview-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await directory.getByRole('button', { name: /2\.2 单元2-2/ }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.querySelector('.story-reading-toolbar').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom - 1), true, '手机阅读栏避开顶部状态栏');
  await page.screenshot({ path: 'Saved/story-overview-mobile.png' });
});
