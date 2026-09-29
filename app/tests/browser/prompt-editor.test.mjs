import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

let server;
let browser;
let url;
before(async () => {
  server = await createServer({ cacheDir: ".temp/vite-prompt-editor-tests", root: fileURLToPath(new URL("../../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/prompt-editor.html`;
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
});
after(async () => { await browser?.close(); await server?.close(); });

async function editor(t, query = "") {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "组件不应产生浏览器异常或 ResizeObserver 循环");
  });
  await page.goto(url + query);
  return { page };
}

test("自由文本框随宽度换行并随内容自适应高度，失焦后仍完整显示", async t => {
  const { page } = await editor(t);
  const input = page.getByLabel("自由文本 Prompt");
  await input.waitFor();
  await page.locator("#host").evaluate(e => { e.style.width = "180px"; });
  await input.fill("一条足够长的整段描述文字，用来验证窄宽度下自动换行后高度随内容增长，而不是裁切或出现内部滚动");
  await page.waitForFunction(() => { const e = document.querySelector("textarea.prompt-free-text"); return e.clientHeight >= e.scrollHeight && e.clientHeight > 60; });
  const grown = await input.evaluate(e => e.clientHeight);
  await input.focus(); await input.press("Tab");
  assert.equal(await input.evaluate(e => e.clientHeight), grown, "失焦不收缩");
  await input.fill("短");
  await page.waitForFunction(height => { const e = document.querySelector("textarea.prompt-free-text"); return e.clientHeight < height; }, grown);
  await page.locator("#host").evaluate(e => { e.style.display = "none"; });
  await page.waitForFunction(() => document.querySelector("textarea.prompt-free-text").clientWidth === 0);
  await page.locator("#host").evaluate(e => { e.style.width = "1000px"; e.style.display = "block"; });
  await input.focus();
  await input.fill("恢复显示后的一整段自由文本，依然完整可读");
  assert.equal(await input.inputValue(), "恢复显示后的一整段自由文本，依然完整可读");
  assert.equal(JSON.parse(await page.locator("output").textContent()).value, "恢复显示后的一整段自由文本，依然完整可读");
});

test("输入法合成确认保留中文与未提交英文，组合中的 Enter 不误判提交", async t => {
  const { page } = await editor(t);
  const input = page.getByLabel("自由文本 Prompt");
  await input.waitFor();
  await input.focus();
  await input.press("Control+End");
  await input.pressSequentially(" abc");
  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await client.send("Input.insertText", { text: "你好" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await input.inputValue(), "quiet hallway under dim lights abc你好");
  assert.equal(JSON.parse(await page.locator("output").textContent()).value, "quiet hallway under dim lights abc你好");
  await input.press("Control+a");
  await client.send("Input.imeSetComposition", { text: "整段替换", selectionStart: 4, selectionEnd: 4 });
  await client.send("Input.insertText", { text: "整段替换" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await input.inputValue(), "整段替换");
  await client.detach();
});

test("设定页编辑 Prompt 名称与子设定文字，只保存各自范围并保留参考图", async t => {
  const { page } = await editor(t, "?setting");
  const writes = [];
  await page.route("**/api/agent/prompt/save", route => {
    const input = route.request().postDataJSON();
    writes.push(input);
    return route.fulfill({ json: { document: input.changes, save: { args: { expected_sha256: `saved-${writes.length}` } } } });
  });
  await page.route("**/workbench/reference-library", route => route.fulfill({ json: { entries: [{ id: "ref-11111111-1111-4111-8111-111111111111", file: "reference-11111111.png", title: "正面" }], sha256: "refs" } }));
  const name = page.getByLabel("Prompt 名称", { exact: true });
  await name.waitFor();
  assert.equal(await name.inputValue(), "艾莲", "创建时默认复制显示名");
  await name.fill("艾莲·Qwen");
  await page.getByRole("button", { name: "保存 Prompt", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("角色 Prompt 已保存"));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].target, { kind: 'character', id: 'alice', model_id: 'qwen', scope: 'base' });
  assert.deepEqual(writes[0].changes, { prompt_name: "艾莲·Qwen" });
  assert.equal(writes[0].expected_sha256, "base-version");
  await page.goto(`${url}?setting&variant=day`);
  const text = page.getByLabel("白天 子设定 Prompt");
  await text.waitFor();
  assert.equal(await text.inputValue(), "艾莲白天的完整描述");
  assert.equal(await page.getByLabel("机位控制", { exact: true }).count(), 0);
  assert.equal(await page.getByText("基础 LoRA", { exact: true }).count(), 0);
  await text.fill("重写后的整段造型描述\n第二行补充");
  await page.getByRole("button", { name: "保存 Prompt", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("角色 Prompt 已保存"));
  assert.deepEqual(writes.at(-1).target, { kind: 'character', id: 'alice', model_id: 'qwen', scope: 'variant', variant_id: 'day' });
  assert.equal(writes.at(-1).expected_sha256, "day-version");
  assert.deepEqual(Object.keys(writes.at(-1).changes), ["text", "reference_images"], "子设定只有整段文字与参考图");
  assert.equal(writes.at(-1).changes.text, "重写后的整段造型描述\n第二行补充");
  assert.equal(writes.at(-1).changes.reference_images[0].file, "reference-11111111.png", "参考图条目随保存保留");
});

test("设定范围独立保留草稿，兄弟范围刷新不冲突且保存只清除当前范围", async t => {
  const { page } = await editor(t, "?setting");
  const writes = [];
  await page.route("**/api/agent/prompt/save", route => {
    const input = route.request().postDataJSON();
    writes.push(input);
    return route.fulfill({ json: { document: input.changes, save: { args: { expected_sha256: `saved-${writes.length}` } } } });
  });
  await page.route("**/workbench/reference-library", route => route.fulfill({ json: { entries: [], sha256: "refs" } }));
  await page.getByLabel("Prompt 名称", { exact: true }).fill("基础名称草稿");
  await page.getByRole('button', { name: '打开白天', exact: true }).click();
  await page.getByLabel("白天 子设定 Prompt").fill("白天草稿");
  await page.getByRole('button', { name: '外部更新夜晚', exact: true }).click();
  assert.equal(await page.getByLabel("白天 子设定 Prompt").inputValue(), '白天草稿');
  assert.equal(await page.getByText('设定已被其他操作修改，当前草稿保留。').count(), 0);
  await page.getByRole('button', { name: '保存 Prompt', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("角色 Prompt 已保存"));
  assert.equal(writes[0].expected_sha256, 'day-version');
  assert.equal(writes[0].changes.text, '白天草稿');
  await page.getByRole('button', { name: '打开基础', exact: true }).click();
  assert.equal(await page.getByLabel("Prompt 名称", { exact: true }).inputValue(), '基础名称草稿');
  assert.equal(await page.getByRole('button', { name: '保存 Prompt', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '打开夜晚', exact: true }).click();
  assert.equal(await page.getByLabel("夜晚 子设定 Prompt").inputValue(), '外部更新的夜晚描述');
  assert.equal(await page.getByRole('button', { name: '保存 Prompt', exact: true }).isDisabled(), true);
});

test("同范围外部变化保留脏草稿，保存仍使用实际读到的旧版本", async t => {
  const { page } = await editor(t, "?setting&variant=night");
  const writes = [];
  await page.route("**/api/agent/prompt/save", route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: '当前范围已变化，请重新读取' } });
  });
  await page.route("**/workbench/reference-library", route => route.fulfill({ json: { entries: [], sha256: "refs" } }));
  const text = page.getByLabel("夜晚 子设定 Prompt");
  await text.fill('尚未保存的夜晚草稿');
  await page.getByRole('button', { name: '外部更新夜晚', exact: true }).click();
  await page.getByText('设定已被其他操作修改，当前草稿保留。').waitFor();
  assert.equal(await text.inputValue(), '尚未保存的夜晚草稿');
  await page.getByRole('button', { name: '保存 Prompt', exact: true }).click();
  await page.getByText('当前操作无法完成（当前范围已变化，请重新读取）', { exact: true }).waitFor();
  assert.equal(writes[0].expected_sha256, 'night-version');
  assert.equal(writes[0].changes.text, '尚未保存的夜晚草稿');
  assert.equal(await text.inputValue(), '尚未保存的夜晚草稿');
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  await page.getByRole('button', { name: '放弃草稿并载入最新', exact: true }).click();
  assert.equal(await text.inputValue(), '外部更新的夜晚描述');
});

test("Prompt 名称为空时禁止保存并提示", async t => {
  const { page } = await editor(t, "?setting");
  const name = page.getByLabel("Prompt 名称", { exact: true });
  await name.waitFor();
  await name.fill("");
  assert.equal(await page.getByRole("button", { name: "保存 Prompt", exact: true }).isDisabled(), true);
  await page.getByText("Prompt 名称不能为空。").waitFor();
});
