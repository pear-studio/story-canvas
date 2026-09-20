import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import sharp from "sharp";

for (const failFirst of [false, true]) test(`打开页面只读；手动重试与对比；失败后显式重试：${failFirst}`, async t => {
  const server = await createServer({ cacheDir: ".temp/vite-lora-preparation", root: fileURLToPath(new URL("../../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const group = { id: "group-111111111111", name: "角色素材", enabled: true, repeats: 1 };
  const states = ["already_good", "enhanced", "no_gain"];
  const items = states.map((decision, i) => ({ id: `item-${String(i + 1).repeat(12)}`, asset_id: `asset-${String(i + 1).repeat(12)}`,
    group_id: group.id, enabled: true, file: "assets/test/original.png", caption: "", caption_sha256: null,
    original_image_width: 300, original_image_height: 400, image_width: i === 2 ? 448 : 768, image_height: 1024, image_bytes: 12345, image_version: "a".repeat(64), media_url: `lora-training/datasets/dataset-111111111111/assets/asset-${String(i + 1).repeat(12)}/original.png` }));
  const detail = { id: "dataset-111111111111", dataset: { version: 5, name: "1024 准备测试", description: "", activation_terms: [], groups: [group], items: items.map(({ id, asset_id, group_id, enabled }) => ({ id, asset_id, group_id, enabled })) }, items,
    captioning: { version: 1, latest: null, summary: { total: 3, with_base: 0, confirmed: 0, unconfirmed: 3 }, items: [] } };
  const image = await sharp({ create: { width: 768, height: 1024, channels: 3, background: "#51847b" } }).png().toBuffer();
  let posted = 0;
  let savedDataset;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const send = value => route.fulfill({ json: value, headers: { etag: '"test-version"' } });
    if (url.pathname.includes("/media/")) return route.fulfill({ body: image, contentType: "image/png" });
    if (url.pathname.endsWith("/environment")) return send({ available: true, checks: [], runtime: null, optional_capabilities: { quality: { ready: true }, upscaler: { ready: true } }, captioning: { ready: false, configured: false } });
    if (url.pathname.endsWith("/recipes")) return send({ recipes: [] });
    if (url.pathname.endsWith("/tasks")) return send({ tasks: [] });
    if (url.pathname.endsWith("/datasets")) return send({ datasets: [{ id: detail.id, name: detail.dataset.name, item_count: 3 }] });
    if (url.pathname.endsWith(`/datasets/${detail.id}`)) {
      if (route.request().method() === "PUT") {
        savedDataset = route.request().postDataJSON();
        detail.dataset = savedDataset;
        detail.items = detail.items.map(item => ({ ...item, ...savedDataset.items.find(saved => saved.id === item.id) }));
      }
      return send(detail);
    }
    if (url.pathname.endsWith("/prepare")) {
      assert.equal(route.request().headers()["if-match"], '"test-version"');
      posted++;
      if (failFirst && posted === 1) return route.fulfill({ status: 503, json: { error: "lora_musiq_failed", details: ["测试评分环境不可用"] } });
      detail.items = items.map((item, i) => ({ ...item, preparation: { resolution: 1024, target: { width: item.image_width, height: 1024 }, before_score: i === 0 ? 75 : 50,
        after_score: i === 0 ? null : i === 1 ? 57 : 51, decision: states[i], baseline_file: `processed-${"b".repeat(64)}.png`, enhanced_file: i === 0 ? null : `processed-${"c".repeat(64)}.png` } }));
      return send({ prepared: 3, reused: 0, enhanced: 1, already_good: 1, no_gain: 1, failed: [], total: 3, dataset: detail });
    }
    return send({ available: true, matches: [], suggestions: [] });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/lora-preparation.html`);
  const button = page.getByRole("button", { name: "准备训练图片", exact: true });
  assert.equal(await button.count(), 0);
  assert.equal(posted, 0, "打开数据集不得触发处理");
  await page.getByRole("button", { name: "重试未完成图片", exact: true }).click();
  if (failFirst) {
    await page.getByText(/图片自动准备失败/).waitFor();
    await page.getByRole("button", { name: "知道了", exact: true }).click();
    await page.setViewportSize({ width: 1200, height: 900 });
    assert.equal(posted, 1, "评分失败后不得反复自动重试");
    await page.getByRole("button", { name: "重试未完成图片", exact: true }).click();
  }
  await page.getByText("MUSIQ 75.0", { exact: true }).waitFor();
  await page.getByText("MUSIQ 50.0 → 51.0（未采用）", { exact: true }).waitFor();
  assert.equal(await page.locator(".lora-quality-scores").count(), 3);
  assert.equal(await page.getByText("300×400", { exact: true }).count(), 3);
  assert.equal(await page.getByText("→ 768×1024", { exact: true }).count(), 2);
  await page.getByText("MUSIQ 50.0 → 57.0", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "超分图", exact: true }).count(), 0);
  const cards = page.locator('.lora-image-grid article');
  assert.equal(await cards.nth(0).locator('.lora-postprocess-status').count(), 0);
  assert.equal(await cards.nth(1).locator('.lora-postprocess-status').textContent(), "超分");
  assert.equal(await cards.nth(2).locator('.lora-postprocess-status').textContent(), "裁剪");
  const thumb = await cards.nth(2).locator('.lora-image-thumb').boundingBox();
  const warning = await cards.nth(2).locator('.lora-image-thumb > .lora-image-warning').boundingBox();
  assert.ok(Math.abs(warning.y - thumb.y - 7) < 1);
  assert.ok(Math.abs(thumb.x + thumb.width - warning.x - warning.width - 7) < 1);
  await page.screenshot({ path: ".temp/lora-preparation-desktop.png", fullPage: true });
  assert.equal(await page.getByRole("button", { name: "缩放图", exact: true }).count(), 0);
  await page.locator(".lora-caption-preview").click();
  await page.getByText("训练图 · 已准备", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "查看原图", exact: true }).count(), 0);
  assert.ok(!(await page.locator('.image-lightbox img').getAttribute('src')).includes('w='));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1600 });
  assert.equal(await cards.getByRole("checkbox").count(), 0, "卡片不保留常驻启用开关");
  await cards.nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "停用此图", exact: true }).click();
  assert.ok(await cards.nth(0).evaluate(node => node.classList.contains('is-disabled')));
  const groupToggle = page.locator('.lora-group-enabled input');
  await groupToggle.uncheck();
  assert.equal(await page.locator('.lora-material-group.is-disabled').count(), 1);
  await cards.nth(1).click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "停用此图", exact: true }).count(), 1, "组停用不能改写单图状态");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "保存数据集修改", exact: true }).click();
  assert.equal(savedDataset.groups[0].enabled, false);
  assert.deepEqual(savedDataset.items.map(item => item.enabled), [false, true, true]);
  await groupToggle.check();
  assert.equal(await page.locator('.lora-material-group.is-disabled').count(), 0);
  assert.ok(await cards.nth(0).evaluate(node => node.classList.contains('is-disabled')), "重新启用分组保留单图停用状态");
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("未保存名称");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".lora-quality-scores").first().isVisible(), true);
  for (const element of await page.locator('.lora-image-dimensions > span, .lora-quality-scores > span').all()) {
    assert.ok(await element.evaluate(node => node.scrollWidth <= node.clientWidth), "尺寸和评分不能被横向截断");
  }
  await page.screenshot({ path: ".temp/lora-preparation-mobile.png", fullPage: true });
  assert.equal(posted, failFirst ? 2 : 1);
  assert.deepEqual(errors, []);
});
