import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("训练设置统一保存，刷新保留，梯度自动计算，预设先确认", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../../", import.meta.url)), cacheDir: ".temp/vite-lora-tests", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const semantic = { resolution: 1024, effective_batch_size: 4, network_dim: 32, network_alpha: 32, learning_rate: 0.00005 };
    const recipe = { id: "anima-character-r32-v1", name: "Anima Rank 32", family: "anima", semantic_config: { ...semantic, effective_batch_size: 1, optimizer_type: "AdamW8bit" } };
    let task = { version: 4, name: "主训练方案", dataset_id: "dataset-111111111111", target: { family: "anima", base: { dit: { relative_path: "anima.safetensors" } } }, training_recipe: { id: recipe.id, overrides: semantic }, run_defaults: { max_train_steps: 400, save_every_n_steps: 100, seed: 20260917, micro_batch_size: 1, max_data_loader_n_workers: 2, blocks_to_swap: 4 } };
    const dataset = { id: task.dataset_id, name: "主数据集", activation_terms: [], item_count: 95, enabled_item_count: 95, effective_item_count: 95 };
    const lastConfig = { ...semantic, train_batch_size: 1, gradient_accumulation_steps: 4, ...task.run_defaults };
    let saves = 0;
    await page.route("**/api/lora-training/**", async route => {
      const pathname = new URL(route.request().url()).pathname.replace("/api/lora-training", "");
      let value;
      if (pathname === "/datasets") value = { datasets: [dataset] };
      else if (pathname === `/datasets/${dataset.id}`) value = { id: dataset.id, dataset: { version: 5, name: dataset.name, description: "", activation_terms: [], groups: [], items: [] }, items: [], captioning: { summary: { total: 0, with_base: 0, confirmed: 0, unconfirmed: 0 }, items: [] } };
      else if (pathname === "/tasks") value = { tasks: [{ id: "lora-111111111111", name: task.name, dataset, runs: [] }] };
      else if (pathname === "/recipes") value = { recipes: [recipe] };
      else if (pathname.includes("environment")) value = { available: true, runtime: null, checks: [], captioning: { configured: true, ready: true } };
      else if (pathname.endsWith("run-settings")) value = { recipe, semantic_config: { ...semantic, optimizer_type: "AdamW8bit" }, values: task.run_defaults, last_run: { id: "run-111111111111", config: lastConfig } };
      else if (pathname === "/tasks/lora-111111111111") {
        if (route.request().method() === "PUT") { task = route.request().postDataJSON(); saves++; }
        value = { id: "lora-111111111111", task, dataset, runs: [] };
      } else value = { runs: [] };
      await route.fulfill({ json: value, headers: { etag: '"settings-test"' } });
    });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/tests/browser/fixtures/lora-settings.html`);
    const save = page.getByRole("button", { name: "保存配置", exact: true });
    await save.waitFor();
    assert.equal(await save.isDisabled(), true);
    const input = label => page.locator("label").filter({ has: page.locator("span.lora-field-label", { hasText: label }) }).locator("input");
    await input("总步数").fill("600");
    await input("随机种子").fill("42");
    await input("Micro Batch").fill("2");
    assert.equal(await input("梯度累积").inputValue(), "2");
    assert.equal(await save.isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "执行预检" }).isDisabled(), true);
    await save.click();
    await page.waitForFunction(() => document.querySelector(".lora-state")?.textContent === "已保存");
    assert.equal(saves, 1);
    assert.equal(task.run_defaults.max_train_steps, 600);
    assert.equal(task.run_defaults.seed, 42);
    assert.equal(task.run_defaults.gradient_accumulation_steps, undefined);
    await page.reload();
    await save.waitFor();
    assert.equal(await input("总步数").inputValue(), "600");
    assert.equal(await input("随机种子").inputValue(), "42");
    await input("Micro Batch").fill("3");
    assert.equal(await save.isDisabled(), true);
    await input("Micro Batch").fill("1");
    await page.getByText(/LoRA 与优化器 ·/).click();
    await page.getByRole("button", { name: "应用 Anima Rank 32" }).click();
    await page.getByRole("button", { name: "应用到草稿" }).waitFor();
    assert.equal(task.training_recipe.overrides.effective_batch_size, 4);
    await page.getByRole("button", { name: "应用到草稿" }).click();
    assert.equal(await input("有效 Batch").inputValue(), "1");
    assert.equal(await input("总步数").inputValue(), "600");
    assert.equal(saves, 1);
    await page.screenshot({ path: fileURLToPath(new URL("../../../runtime/lora-settings-desktop.png", import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
