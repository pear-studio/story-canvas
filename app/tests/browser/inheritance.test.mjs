import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
async function openHarness(t, query = '') {
 const server = await createServer({ cacheDir: '.temp/vite-inheritance-tests', root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
 await server.listen(); t.after(() => server.close());
 const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) }); t.after(() => browser.close());
 const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/tests/browser/inheritance.html' + query);
 return { page, errors };
}
async function openOverride(t) {
 const { page, errors } = await openHarness(t, '?override');
 await page.getByTitle('展开角色引用').click();
 const card = page.locator('[data-reference-source="character:alice:day"]');
 const field = card.getByLabel('艾莲 · 白天 引用文字');
 await field.waitFor();
 const savedPrompt = () => page.evaluate(() => JSON.parse(localStorage.getItem('saved-page') ?? 'null')?.prompt);
 return { page, errors, card, field, savedPrompt };
}
async function save(page) {
 await page.getByRole('button', { name: '保存', exact: true }).click();
 await page.waitForFunction(() => localStorage.getItem('saved-page'));
}

test('编辑继承框即成为本页 override，含显式空串；恢复继承删除 key 并跟随上游', async t => {
 const { page, errors, card, field, savedPrompt } = await openOverride(t);
 assert.equal(await field.inputValue(), '艾莲白天的上游描述');
 assert.equal(await card.getByText('已覆盖', { exact: true }).count(), 0);
 await page.getByRole('button', { name: '模拟上游文字更新' }).click();
 assert.equal(await field.inputValue(), '艾莲白天的新上游描述', '未覆盖时继承随上游更新');
 await field.fill('本页覆盖的完整描述');
 await card.getByText('已覆盖', { exact: true }).waitFor();
 await save(page);
 assert.equal((await savedPrompt()).text_overrides['character:alice:day'], '本页覆盖的完整描述');
 await page.getByRole('button', { name: '模拟上游文字更新' }).click();
 assert.equal(await field.inputValue(), '本页覆盖的完整描述', 'override 不随上游更新');
 await field.fill('');
 assert.equal(await field.inputValue(), '');
 await save(page);
 assert.equal((await savedPrompt()).text_overrides['character:alice:day'], '', '显式空串也是有效 override');
 await card.getByRole('button', { name: '恢复继承', exact: true }).click();
 assert.equal(await card.getByText('已覆盖', { exact: true }).count(), 0);
 assert.equal(await field.inputValue(), '艾莲白天的新上游描述', '恢复继承后回到当前子设定文字');
 await save(page);
 assert.equal((await savedPrompt()).text_overrides['character:alice:day'], undefined);
 assert.deepEqual(errors, []);
});

test('切换子设定清理对应文字与图片 override，切回不复活隐藏覆盖', async t => {
 const { page, errors, field, savedPrompt } = await openOverride(t);
 await field.fill('白天造型的本页覆盖');
 await save(page);
 assert.equal((await savedPrompt()).text_overrides['character:alice:day'], '白天造型的本页覆盖');
 await page.getByLabel('艾莲角色设定').selectOption('night');
 await page.locator('[data-reference-source="character:alice:night"]').getByLabel('艾莲 · 夜晚 引用文字').waitFor();
 await save(page);
 assert.deepEqual((await savedPrompt()).text_overrides, {}, '切换子设定后旧 key 不残留');
 await page.getByLabel('艾莲角色设定').selectOption('day');
 assert.equal(await field.inputValue(), '艾莲白天的上游描述', '切回不复活已清理的覆盖');
 assert.equal(await page.locator('[data-reference-source="character:alice:day"]').getByText('已覆盖', { exact: true }).count(), 0);
 assert.deepEqual(errors, []);
});

test('移除引用清理 override，本页 Prompt 随草稿保存', async t => {
 const { page, errors, field, savedPrompt } = await openOverride(t);
 await field.fill('本页覆盖的完整描述');
 await page.getByLabel('本页 Prompt').fill('艾莲坐在窗边。');
 await save(page);
 assert.equal((await savedPrompt()).text, '艾莲坐在窗边。');
 await page.getByRole('button', { name: '移除艾莲', exact: true }).click();
 await save(page);
 const prompt = await savedPrompt();
 assert.deepEqual(prompt.text_overrides, {}, '移除引用后旧 key 不残留');
 assert.equal(prompt.text, '艾莲坐在窗边。');
 assert.deepEqual(errors, []);
});

test('错误与复杂信息持久展示，右下角仅显示简短结果', async t => {
 const {page, errors} = await openHarness(t, '?feedback');
 await page.clock.install();
 await page.getByRole('button', {name:'触发错误'}).click();
 const dialog=page.getByRole('dialog', {name:'操作失败'});
 await dialog.waitFor();
 assert.match(await dialog.innerText(), /hair_over_one_eye/);
 assert.equal(await page.locator('.feedback-toast').count(),0);
 await page.clock.fastForward(10000);
 assert.equal(await dialog.isVisible(),true);
 await dialog.getByRole('button', {name:'知道了'}).click();
 await page.getByRole('button', {name:'触发复杂信息'}).click();
 await page.getByRole('dialog', {name:'提示'}).waitFor();
 assert.equal(await page.locator('.feedback-toast').count(),0);
 await page.getByRole('button', {name:'知道了'}).click();
 await page.getByRole('button', {name:'触发成功'}).click();
 assert.match(await page.locator('.feedback-toast').innerText(),/已保存/);
 assert.equal(await page.getByRole('dialog').count(),0);
 assert.deepEqual(errors,[]);
});

test('场景标签可切换、移除并从选择菜单重新添加', async t => {
 const {page, errors} = await openHarness(t);
 const scene = page.locator('.participant-editor');
 assert.equal(await scene.getByLabel('页面场景设定').inputValue(), 'steel:default');
 await scene.getByTitle('选择场景').click();
 await scene.getByPlaceholder('搜索场景').fill('星空');
 await scene.getByRole('checkbox', {name:'暗紫星空 · 默认 默认', exact:true}).check();
 assert.equal(await scene.getByLabel('页面场景设定').inputValue(), 'space:default');
 await scene.getByRole('button', {name:'移除场景引用'}).click();
 assert.equal(await scene.getByLabel('页面场景设定').count(), 0);
 await scene.getByPlaceholder('搜索场景').fill('钢墙');
 await scene.getByRole('checkbox', {name:'冷蓝灰钢墙 · 默认 默认', exact:true}).check();
 assert.equal(await scene.getByLabel('页面场景设定').inputValue(), 'steel:default'); assert.deepEqual(errors, []);
});

test('生成预览区分无候选与不符候选，二级详情展示实际文字变化', async t => {
 const {page, errors} = await openHarness(t, '?candidates');
 const sections = [{ kind: 'page', text: 'stone wall' }];
 const current = {ready:true,blockers:[],prompt:{positive:'stone wall',negative:'blur',sections,images:[]},generation_signature:'new'};
 await page.route('**/workbench/story-candidate-refresh', route => route.fulfill({json:{pages:['empty','changed'].map(id=>({page_key:{page_id:id},status:'ready',signature:'new',matched:0,candidate_ids:id==='empty'?[]:['old'],all_candidate_ids:id==='empty'?[]:['old']}))}}));
 await page.route('**/workbench/page-render-inspection', route => route.fulfill({json:{inspection:current}}));
 await page.route('**/workbench/candidate-detail', route => route.fulfill({json:{detail:{seed:42,generation:{prompt:{positive:'steel wall',negative:'blur',sections:[{ kind: 'page', text: 'steel wall' }]}}}}}));
 await page.getByRole('button', {name:'生成候选',exact:true}).click();
 const preview=page.getByRole('dialog', {name:'生成候选',exact:true});
 await preview.getByRole('button', {name:'生成 2 张',exact:true}).waitFor();
 assert.match(await preview.innerText(), /尚无候选 1 页 · 已有候选但无相符结果 1 页/);
 await preview.locator('li').filter({hasText:'没有候选的页面'}).getByRole('button',{name:'查看详情'}).click();
 let detail=page.getByRole('dialog',{name:'候选差异详情'});
 await detail.getByText('本页没有候选图，没有旧 Prompt 可比较。').waitFor();
 await detail.getByRole('button',{name:'关闭',exact:true}).last().click();
 await preview.locator('li').filter({hasText:'有变化的页面'}).getByRole('button',{name:'查看详情'}).click();
 detail=page.getByRole('dialog',{name:'候选差异详情'});
 await detail.locator('.candidate-prompt-added').waitFor();
 assert.equal(await detail.locator('.candidate-prompt-removed').innerText(),'steel wall');
 assert.equal(await detail.locator('.candidate-prompt-added').innerText(),'stone wall');
 assert.match(await detail.innerText(),/负向 Prompt · 完全一致/);
 await page.screenshot({path:process.env.TEMP+'/story-candidate-difference.png',fullPage:true});
 assert.deepEqual(errors,[]);
});
