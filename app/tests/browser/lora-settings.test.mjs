import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

// 浏览器测试：vite dev server 随机端口 + playwright，路由拦截 mock /api/lora-training。
// 运行：node --test tests/browser/lora-settings.test.mjs

const TASK_ID = "dataset-111111111111";
const sha = "a".repeat(64);

function qwenSemanticConfig(overrides = {}) {
  return {
    max_pixels: 1048576,
    network_dim: 32,
    network_alpha: 32,
    learning_rate: 0.0001,
    gradient_accumulation_steps: 2,
    micro_batch_size: 1,
    optimizer: { type: "AdamW", betas: [0.9, 0.999], eps: 1e-8, weight_decay: 0.01 },
    scheduler: { type: "ConstantLR", factor: 1 / 3, total_iters: 5 },
    precision: { base: "bf16", lora: "bf16", optimizer_state: "bf16" },
    gradient_checkpointing: true,
    lora_target_modules: ["transformer_blocks.0.attn.to_q"],
    ...overrides,
  };
}

function qwenTask(overrides = {}) {
  return {
    version: 5,
    name: "主训练方案",
    dataset_id: TASK_ID,
    target: {
      family: "qwen-image-2-1",
      base: {
        dit: { relative_path: "qwen-image-2-1/dit/model.safetensors" },
        text_encoder: { relative_path: "qwen-image-2-1/text_encoder/model.safetensors" },
        vae: { relative_path: "qwen-image-2-1/vae/model.safetensors" },
        processor: { relative_path: "qwen-image-2-1/processor" },
      },
      prompt_family: "qwen-image",
      usage_defaults: { clip_skip: null, sampler: "euler", scheduler: "simple", steps: 20, cfg: 4 },
    },
    training_recipe: { id: "qwen-image21-lora-v1", overrides: { network_dim: 32, learning_rate: 0.0001, gradient_accumulation_steps: 2 } },
    run_defaults: { max_train_steps: 2000, save_every_n_steps: 500, seed: 42 },
    ...overrides,
  };
}

const datasetSummary = { id: TASK_ID, name: "主数据集", activation_terms: [], item_count: 95, enabled_item_count: 95, effective_item_count: 95 };
const datasetDetail = { id: TASK_ID, dataset: { version: 5, name: "主数据集", description: "", activation_terms: [], groups: [], items: [] }, items: [], captioning: { version: 1, latest: null, summary: { total: 0, with_base: 0, confirmed: 0, unconfirmed: 0 }, items: [] } };
const recipe = { id: "qwen-image21-lora-v1", version: 1, name: "Qwen Rank 32", description: "", family: "qwen-image-2-1", semantic_config: qwenSemanticConfig() };
const environment = { available: true, runtime: null, checks: [], captioning: { configured: true, ready: true } };

async function startFixture(page, extra) {
  await page.route("**/api/lora-training/**", async route => {
    const pathname = new URL(route.request().url()).pathname.replace("/api/lora-training", "");
    const value = await extra(pathname, route);
    if (value === undefined) return;
    await route.fulfill({ json: value.body ?? value, headers: { etag: '"lora-test"' }, status: value.status ?? 200 });
  });
}

test("Qwen 训练设置统一保存，刷新保留，梯度累积可编辑，预设先确认", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../../", import.meta.url)), cacheDir: ".temp/vite-lora-tests", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let task = qwenTask();
    let saves = 0;
    await startFixture(page, async (pathname, route) => {
      if (pathname === "/datasets") return { datasets: [datasetSummary] };
      if (pathname === `/datasets/${TASK_ID}`) return datasetDetail;
      if (pathname === "/tasks") return { tasks: [{ id: TASK_ID, name: task.name, family: "qwen-image-2-1", dataset: datasetSummary, runs: [] }] };
      if (pathname === "/recipes") return { recipes: [recipe] };
      if (pathname.includes("environment")) return environment;
      if (pathname.endsWith("run-settings")) return { recipe: { id: recipe.id, version: recipe.version, name: recipe.name }, semantic_config: qwenSemanticConfig(), values: { ...task.run_defaults, gradient_accumulation_steps: task.training_recipe.overrides.gradient_accumulation_steps }, last_run: { id: "run-111111111111", created_at: "2026-09-22T10:00:00.000Z", status: "completed", config: { max_train_steps: 2000, save_every_n_steps: 500, seed: 42 } } };
      if (pathname === `/tasks/${TASK_ID}`) {
        if (route.request().method() === "PUT") { task = route.request().postDataJSON(); saves++; }
        return { id: TASK_ID, task, dataset: datasetSummary, runs: [] };
      }
      return { runs: [] };
    });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/tests/browser/fixtures/lora-settings.html`);
    const save = page.getByRole("button", { name: "保存配置", exact: true });
    await save.waitFor().catch(async (error) => { throw new Error(`${error.message}\n页面错误：${JSON.stringify(errors)}\n${await page.locator('body').innerText()}`); });
    assert.equal(await save.isDisabled(), true);
    const input = label => page.locator("label").filter({ has: page.locator("span.lora-field-label", { hasText: label }) }).locator("input");
    assert.equal(await input("总更新步数").inputValue(), "2000");
    await input("总更新步数").fill("2500");
    await input("随机种子").fill("123");
    await page.getByText(/LoRA 与优化器 ·/).click();
    assert.equal(await input("Alpha").inputValue(), "32");
    assert.equal(await input("Micro Batch").inputValue(), "1");
    await input("梯度累积").fill("4");
    await page.getByText("有效 Batch 4 · 本轮图片处理量 10000 张次").waitFor();
    assert.equal(await save.isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "执行预检" }).isDisabled(), true);
    await save.click();
    await page.waitForFunction(() => document.querySelector(".lora-state")?.textContent === "已保存");
    assert.equal(saves, 1);
    assert.deepEqual(task.run_defaults, { max_train_steps: 2500, save_every_n_steps: 500, seed: 123 });
    assert.equal(task.training_recipe.overrides.gradient_accumulation_steps, 4);
    await page.reload();
    await save.waitFor();
    assert.equal(await input("总更新步数").inputValue(), "2500");
    assert.equal(await input("随机种子").inputValue(), "123");
    await page.getByText(/LoRA 与优化器 ·/).click();
    assert.equal(await input("梯度累积").inputValue(), "4");
    await page.getByRole("button", { name: "应用 Qwen Rank 32" }).click();
    await page.getByRole("button", { name: "应用到草稿" }).waitFor();
    assert.equal(task.training_recipe.overrides.gradient_accumulation_steps, 4);
    await page.getByRole("button", { name: "应用到草稿" }).click();
    assert.equal(await input("梯度累积").inputValue(), "2");
    assert.equal(await input("总更新步数").inputValue(), "2500");
    assert.equal(saves, 1);
    await page.screenshot({ path: fileURLToPath(new URL("../../../runtime/lora-settings-desktop.png", import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});

test("训练记录显示阶段与恢复可用性，续训校验目标并处理陈旧来源，legacy 只读", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../../", import.meta.url)), cacheDir: ".temp/vite-lora-tests", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const task = qwenTask();
    const v5Run = {
      id: "run-aaaaaaaaaaaa",
      created_at: "2026-09-22T10:00:00.000Z",
      resumable: true,
      manifest: { task_id: TASK_ID, task_name: "主训练方案", dataset_name: "主数据集", created_at: "2026-09-22T10:00:00.000Z", run: { max_train_steps: 2000, save_every_n_steps: 500, seed: 42, note: "首轮" }, semantic_config: { network_dim: 32, learning_rate: 0.0001 } },
      status: { status: "completed", phase: null, completed_at: "2026-09-22T11:04:00.000Z", step: 2000, loss: 0.0831, lr: 0.0001, samples_seen: 2000, eta_seconds: null, error: null, checkpoints: [{ id: "checkpoint-1", file: "step-002000.safetensors", step: 2000, sha256: sha, size: 160000000 }], resume: { snapshot_id: "step-002000", step: 2000, sha256: sha }, performance: { wall_seconds: 3840.5, phase_seconds: { cache: 94.2, train: 3745 }, seconds_per_update: 1.845, samples_seen: 2000, runner: null }, loss_history: [{ step: 1, loss: 0.42 }, { step: 2000, loss: 0.0831 }], log_tail: "" },
      disk_bytes: 123456789,
    };
    const legacyRun = {
      id: "run-bbbbbbbbbbbb",
      created_at: "2026-09-17T10:00:00.000Z",
      legacy: true,
      legacy_note: "Anima 历史记录，不支持精确续训",
      resumable: false,
      manifest: { task_id: TASK_ID, task_name: "旧 Anima 训练", dataset_name: "主数据集", created_at: "2026-09-17T10:00:00.000Z", config: { max_train_steps: 400, resolution: 1024, network_dim: 32, learning_rate: 0.00005 } },
      status: { status: "completed", completed_at: "2026-09-17T11:00:00.000Z", step: 400, loss: 0.12, eta_seconds: null, error: null, checkpoints: [] },
      disk_bytes: 456789,
    };
    const resumeRequests = [];
    await startFixture(page, async (pathname, route) => {
      if (pathname === "/datasets") return { datasets: [datasetSummary] };
      if (pathname === `/datasets/${TASK_ID}`) return datasetDetail;
      if (pathname === "/tasks") return { tasks: [{ id: TASK_ID, name: task.name, family: "qwen-image-2-1", dataset: datasetSummary, runs: [] }] };
      if (pathname === "/recipes") return { recipes: [recipe] };
      if (pathname.includes("environment")) return environment;
      if (pathname.endsWith("/resume")) {
        resumeRequests.push({ body: route.request().postDataJSON(), ifMatch: route.request().headers()["if-match"] });
        if (resumeRequests.length === 1) return { status: 409, body: { error: "lora_training_resume_source_stale", message: "lora_training_resume_source_stale", details: ["来源快照已不是本任务最新完整状态，请重新读取训练记录"] } };
        return { status: 202, body: { run: { id: "run-cccccccccccc", status: "running" }, manifest: {} } };
      }
      if (pathname === `/tasks/${TASK_ID}`) return { id: TASK_ID, task, dataset: datasetSummary, runs: [v5Run, legacyRun] };
      return { runs: [] };
    });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/tests/browser/fixtures/lora-runs.html`);
    const resumeButton = page.getByRole("button", { name: "继续训练", exact: true });
    await resumeButton.waitFor();
    // 列表与详情：恢复可用性、LR、张次、性能摘要。
    await page.getByText("可从第 2000 步恢复").first().waitFor();
    await page.getByText("1.00e-4").waitFor();
    await page.getByText(/缓存 94.2 秒 · 训练 1 小时 2 分 · 每更新 1.8 秒/).waitFor();
    // 续训对话框：目标必须大于当前步。
    await resumeButton.click();
    const target = page.getByLabel("累计目标步数");
    await target.waitFor();
    assert.equal(await page.getByRole("button", { name: "开始续训" }).isDisabled(), true);
    await target.fill("1500");
    await page.getByText("累计目标步数必须为大于 2000 的整数。").waitFor();
    assert.equal(await page.getByRole("button", { name: "开始续训" }).isDisabled(), true);
    await target.fill("4000");
    await page.getByLabel("备注（可选）").fill("预算扩大到 4000");
    await page.getByRole("button", { name: "开始续训" }).click();
    // 第一次提交返回 409 陈旧来源：关闭对话框、提示刷新并已重新读取列表。
    await page.getByText(/恢复状态已被更新的训练取代/).waitFor();
    assert.equal(resumeRequests.length, 1);
    assert.deepEqual(resumeRequests[0].body, { max_train_steps: 4000, note: "预算扩大到 4000", source_snapshot_id: "step-002000", source_sha256: sha });
    assert.equal(resumeRequests[0].ifMatch, '"lora-test"');
    // 重新打开后提交成功。
    await resumeButton.click();
    await page.getByLabel("累计目标步数").fill("4000");
    await page.getByRole("button", { name: "开始续训" }).click();
    await page.waitForFunction(() => !document.querySelector(".modal"));
    assert.equal(resumeRequests.length, 2);
    assert.deepEqual(resumeRequests[1].body, { max_train_steps: 4000, source_snapshot_id: "step-002000", source_sha256: sha });
    // legacy 历史记录：只读标记，没有续训入口。
    await page.getByRole("button", { name: /旧 Anima 训练/ }).click();
    await page.getByText("Anima 历史记录，不支持精确续训").waitFor();
    assert.equal(await page.getByRole("button", { name: "继续训练", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
