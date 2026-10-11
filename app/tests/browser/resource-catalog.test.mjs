import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

function registered(id, name, family, purpose, owner = {}) {
  return { id, name, kind: "lora", registered: true, storage: "repository", status: "available", architecture_family: family, relative_path: `loras/${id}.safetensors`, ...owner,
    lora_metadata: { purpose, architecture: { family, prompt_family: family }, activation: { trigger_words: [], tags: [] }, recommended_generation: { weight: { default: 1, minimum: null, maximum: null, status: "untested" } }, source: { type: "local_training" } } };
}
const models = [
  registered("style", "通用画风", "anima", "画风"),
  registered("slider", "外观调节", "anima", "外观调节", { storage: "local" }),
  registered("roxy", "洛克茜", "anima", "角色", { storage: "project", owner_project_id: "midnight-snack", owner_project_title: "午夜甜点", owner_project_type: "story" }),
  registered("veloria", "Veloria Qwen", "qwen-image-2-1", "画风", { storage: "project", owner_project_id: "dataset-273e046affd2", owner_project_title: "Veloria · 主数据集", owner_project_type: "training" }),
  registered("released", "已登记训练产物", "anima", "画风", { relative_path: "loras/training/task/run/released.safetensors" }),
  registered("local-style", "本机画风", "anima", "画风", { storage: "local" }),
  { id: "raw", name: "裸权重", kind: "lora", registered: false, status: "available", architecture_family: "other", relative_path: "loras/raw.safetensors" },
  { id: "checkpoint", name: "step-000100", kind: "lora", registered: false, status: "available", architecture_family: "other", relative_path: "loras/training/task/run/step-000100.safetensors" },
];

async function fixture(t) {
  const server = await createServer({ root: fileURLToPath(new URL("../../", import.meta.url)), cacheDir: "../Saved/Tests/vite-resource-catalog", optimizeDeps: { entries: [fileURLToPath(new URL("./fixtures/resource-catalog.html", import.meta.url))], include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"] }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route("**/api/resources", route => route.fulfill({ json: { models_root: "models", models } }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/fixtures/resource-catalog.html`);
  await page.getByText("通用画风", { exact: true }).waitFor();
  return page;
}

async function selectFacet(page, label, choices) {
  await page.getByRole("button", { name: `${label}筛选`, exact: true }).click();
  const panel = page.getByRole("group", { name: `${label}选项`, exact: true });
  await panel.getByRole("button", { name: "清空", exact: true }).click();
  for (const choice of choices) await panel.getByRole("checkbox", { name: choice, exact: true }).check();
  await panel.getByRole("button", { name: "完成", exact: true }).click();
}

test("LoRA 总览组合筛选、可读归属与三个分区，窄屏没有横向溢出", async t => {
  const page = await fixture(t);
  assert.equal(await page.locator(".resource-catalog-card").count(), 6);
  assert.deepEqual(await page.getByRole("region", { name: "画风资源", exact: true }).locator(".resource-catalog-card__tags span:last-child").allTextContents(), ["仓库", "仓库", "项目", "本机"]);
  assert.equal(await page.getByText("裸权重", { exact: true }).count(), 0);
  assert.equal(await page.locator(".resource-catalog-card header small").filter({ hasText: "训练项目：Veloria · 主数据集" }).count(), 1);
  assert.equal(await page.locator(".resource-catalog-card header small").filter({ hasText: "剧情项目：午夜甜点" }).count(), 1);
  assert.equal(await page.getByText("项目：dataset-273e046affd2", { exact: true }).count(), 0);
  await selectFacet(page, "归属", ["训练项目：Veloria · 主数据集"]);
  await selectFacet(page, "用途分类", ["画风"]);
  await selectFacet(page, "底座", ["QWEN-IMAGE-2-1"]);
  assert.equal(await page.locator(".resource-catalog-card").count(), 1);
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  await page.getByText("dataset-273e046affd2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await selectFacet(page, "底座", ["ANIMA"]);
  await page.getByText("没有匹配的 LoRA，请调整筛选条件。").waitFor();
  await page.getByRole("button", { name: "清空筛选" }).click();
  await selectFacet(page, "归属", ["仓库", "本机"]);
  assert.equal(await page.locator(".resource-catalog-card").count(), 4);
  await page.getByRole("button", { name: "清空筛选" }).click();
  await page.getByLabel("搜索 LoRA").fill("午夜甜点");
  assert.equal(await page.locator(".resource-catalog-card").count(), 1);
  await page.getByRole("button", { name: "清空筛选" }).click();
  await page.getByRole("button", { name: "未登记文件（1）", exact: true }).click();
  await page.getByText("裸权重", { exact: true }).waitFor();
  assert.equal(await page.getByText("step-000100", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "训练 checkpoint（1）", exact: true }).click();
  await page.getByText("step-000100", { exact: true }).waitFor();
  assert.equal(await page.locator(".resource-compact-list > article").count(), 1);
  await page.getByRole("button", { name: "已登记（6）", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const output = new URL("../../../Saved/Tests/", import.meta.url);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("resource-catalog-mobile.png", output)), fullPage: true });
});

test("LoRA 选择器共用筛选，切换分区不丢失已选资源", async t => {
  const page = await fixture(t);
  await page.getByRole("button", { name: "打开选择器" }).click();
  await selectFacet(page, "归属", ["剧情项目：午夜甜点"]);
  assert.equal(await page.locator(".resource-catalog-card").count(), 1);
  await page.getByRole("checkbox", { name: "选择 洛克茜", exact: true }).check();
  await page.getByLabel("资源范围", { exact: true }).selectOption("raw");
  await page.getByText("裸权重", { exact: true }).waitFor();
  assert.equal(await page.getByText("step-000100", { exact: true }).count(), 0);
  await page.getByLabel("资源范围", { exact: true }).selectOption("checkpoints");
  await page.getByText("step-000100", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("已选资源 ID").textContent(), "roxy");
  await page.getByLabel("资源范围", { exact: true }).selectOption("registered");
  assert.equal(await page.getByRole("checkbox", { name: "选择 洛克茜", exact: true }).isChecked(), true);
});

test("多选筛选支持并集、全选和空选择，数量忽略自身筛选并联动其他维度", async t => {
  const page = await fixture(t);
  await selectFacet(page, "用途分类", ["画风", "角色"]);
  assert.equal(await page.locator(".resource-catalog-card").count(), 5);
  await selectFacet(page, "底座", ["ANIMA"]);
  assert.equal(await page.locator(".resource-catalog-card").count(), 4);
  await page.getByRole("button", { name: "用途分类筛选", exact: true }).click();
  const panel = page.getByRole("group", { name: "用途分类选项", exact: true });
  assert.equal(await panel.getByLabel("画风资源数量", { exact: true }).textContent(), "3");
  assert.equal(await panel.getByLabel("外观调节资源数量", { exact: true }).textContent(), "1");
  assert.equal(await panel.getByLabel("角色资源数量", { exact: true }).textContent(), "1");
  assert.equal(await panel.getByRole("checkbox", { name: "用途分类全选", exact: true }).evaluate(node => node.indeterminate), true);
  await panel.getByRole("checkbox", { name: "用途分类全选", exact: true }).check();
  assert.equal(await page.locator(".resource-catalog-card").count(), 5);
  await panel.getByRole("button", { name: "清空", exact: true }).click();
  assert.equal(await page.locator(".resource-catalog-card").count(), 0);
  assert.equal(await panel.getByLabel("画风资源数量", { exact: true }).textContent(), "3");
  await panel.getByRole("checkbox", { name: "角色", exact: true }).check();
  await page.keyboard.press("Escape");
  assert.equal(await panel.count(), 0);
  assert.equal(await page.getByRole("button", { name: "用途分类筛选", exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator(".resource-catalog-card").count(), 1);
  await page.getByRole("button", { name: "清空筛选" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "归属筛选", exact: true }).click();
  const ownerPanel = page.getByRole("group", { name: "归属选项", exact: true });
  const bounds = await ownerPanel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.getByLabel("搜索 LoRA").click();
  assert.equal(await ownerPanel.count(), 0);
});
