import { generatedRunRoot, runRoot } from "../server/lora-training-support.mjs";
import { registerProject } from "../server/project-registry.mjs";
import { datasetRoot, taskRoot } from "../server/lora-training-support.mjs";
import { createLoraTrainingDataset } from "./training-project-fixture.mjs";
import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { snapshotRun } from "../server/lora-training-plan.mjs";
import { updateRunStatus, readLoraTrainingRun } from "../server/lora-training-runtime.mjs";
import { inventoryCheckpoints } from "../server/lora-training-run-index.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";
import { listLoraTrainingDatasets, listLoraTrainingTasks } from "../server/lora-training-facts.mjs";

import {
  chooseLoraUpscaleScale,
  compileLoraTrainingArguments,
  copyLoraTrainingItem,
  previewLoraTrainingPostprocess,
  prepareLoraTrainingDataset,
  applyLoraTrainingPostprocess,
  restoreLoraTrainingOriginal,
  
  createLoraTrainingTask,
  effectiveTrainingConfig,
  executeLoraUpscale,
  importLoraTrainingAssets,
  parseLoraTrainingLine,
  preflightLoraTraining,
  readLoraTrainingRunSettings,
  readLoraTrainingEnvironment,
  readCachedLoraTrainingEnvironment,
  readCaptionAuditSnapshot,
  readLoraCaptionAudit,
  readLoraCaptioning,
  recordLoraCaptionAudit,
  runLoraCaptioning,
  updateLoraCaptioningItem,
  readLoraTrainingDataset,
  readLoraTrainingTask,
  mergeLoraRunStatus,
  deleteLoraTrainingRun,
  recoverLoraTrainingRuns,
  saveLoraTrainingCaption,
  updateLoraTrainingDataset,
  planLoraBulkUpscale,
  updateLoraTrainingTask,
  validateLoraTrainingDataset,
  validateLoraTrainingTask,
} from "../server/lora-training.mjs";
import {
  listLocalLoraResources,
  openLoraResourceMedia,
  readLocalLoraResource,
  validateLoraResource,
} from "../server/lora-resources.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-lora-"));
  const project = path.join(root, "workspace", "test-project");
  await Promise.all([
    mkdir(path.join(project, "inputs"), { recursive: true }),
    mkdir(path.join(root, "library", "lora-training", "recipes"), { recursive: true }),
    mkdir(path.join(root, "library", "render-profiles"), { recursive: true }),
    mkdir(path.join(root, "library", "prompt-policies"), { recursive: true }),
    mkdir(path.join(root, "library", "render-recipes"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(project, "project.json"), JSON.stringify({ default_render_profile: "test" })),
    writeFile(path.join(root, "library", "render-profiles", "test.json"), JSON.stringify({})),
    writeFile(path.join(root, "library", "prompt-policies", "test-policy.json"), JSON.stringify({ family: "anima" })),
    writeFile(path.join(root, "library", "render-recipes", "test-candidate.json"), JSON.stringify({ clip_skip: null, sampler: "euler", scheduler: "simple", steps: 24, cfg: 4 })),
    writeFile(path.join(root, "library", "lora-training", "trainer.json"), JSON.stringify({ reference_models: { anima: { dit: { relative_path: "diffusion_models/anima.safetensors", sha256: "1".repeat(64) }, text_encoder: { relative_path: "text_encoders/qwen.safetensors", sha256: "2".repeat(64) }, vae: { relative_path: "vae/qwen.safetensors", sha256: "3".repeat(64) } } } })),
    writeFile(path.join(root, "library", "lora-training", "recipes", "anima-character-r32-v1.json"), JSON.stringify({ id: "anima-character-r32-v1", version: 1, name: "Anima 角色 LoRA", family: "anima", semantic_config: { resolution: 1024, effective_batch_size: 1, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit" } })),
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));
  registerFixtureProjects(root); return { root, project };
}

async function imageBuffer(width = 640, height = 768, color = { r: 40, g: 80, b: 120 }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

test("数据集导航只读取清单，图片完整性仍在详情检查", async context => {
  const { project } = await fixture(context);
  const dataset = await createLoraTrainingDataset(project, { name: "轻量目录" });
  const detail = await importLoraTrainingAssets(project, dataset.id, { group_id: dataset.dataset.groups[0].id, files: [{ filename: "look.png", buffer: await imageBuffer(), caption: "standing" }] });
  const image = path.join(datasetRoot(project, dataset.id), detail.items[0].file);
  await writeFile(image, "已损坏");
  const collection = await listLoraTrainingDatasets(project);
  assert.equal(collection.datasets[0].name, "轻量目录");
  assert.equal(collection.datasets[0].item_count, 1);
  assert.equal(collection.datasets[0].effective_item_count, 1);
  assert.equal(collection.datasets[0].error, undefined);
  await assert.rejects(readLoraTrainingDataset(project, dataset.id), { code: "invalid_lora_training_asset_meta" });
});

test("迟到的 LoRA 进度不能覆盖退出或关闭终态", () => {
  const completed = { status: "completed", step: 300, loss: 0.1, updated_at: "2026-08-19T00:00:00.000Z" };
  const stopping = { status: "stopping", step: 240, loss: 0.2, updated_at: "2026-08-19T00:00:00.000Z" };
  const delayedProgress = { status: "running", step: 250, loss: 0.15, eta_seconds: 30 };
  assert.equal(mergeLoraRunStatus(completed, delayedProgress), completed);
  assert.equal(mergeLoraRunStatus(stopping, delayedProgress), stopping);

  assert.deepEqual(
    mergeLoraRunStatus({ status: "running", step: 200 }, delayedProgress, "2026-08-19T00:01:00.000Z"),
    { ...delayedProgress, updated_at: "2026-08-19T00:01:00.000Z" },
  );
});

test("训练项目使用 Anima，素材与当前设置共享项目身份", async (context) => {
  const { root, project } = await fixture(context);
  const createdDataset = await createLoraTrainingDataset(project, { name: "制服素材", description: "制服训练素材", activation_terms: ["test_uniform"] });
  const createdTask = await createLoraTrainingTask(root, project, { name: "制服训练", dataset_id: createdDataset.id });
  assert.match(createdDataset.id, /^dataset-[a-f0-9]{12}$/);
  assert.equal(createdTask.id, createdDataset.id);
  assert.equal(createdTask.task.dataset_id, createdDataset.id);
  assert.equal(createdTask.task.target.family, "anima");
  assert.equal(createdTask.task.target.base.dit.sha256, JSON.parse(await readFile(new URL("../../library/lora-training/trainer.json", import.meta.url), "utf8")).reference_models.anima.dit.sha256);
  assert.equal(createdTask.task.target.prompt_family, "anima");
  assert.equal(createdTask.task.target.usage_defaults.clip_skip, null);
  assert.equal(createdDataset.dataset.version, 5);
  assert.equal(createdDataset.dataset.description, "制服训练素材");
  assert.deepEqual(createdDataset.dataset.activation_terms, ["test_uniform"]);
  const groupId = createdDataset.dataset.groups[0].id;
  const imported = await importLoraTrainingAssets(project, createdDataset.id, { group_id: groupId, files: [
    { filename: "look.png", buffer: await imageBuffer(), caption: "test_uniform, standing", source: "官方角色展示页", asset_id: "official-001" },
    { filename: "look-back.png", buffer: await imageBuffer(640, 768, { r: 60, g: 90, b: 120 }), caption: "test_uniform, from behind", asset_id: "official-003" },
    { filename: "upload.png", buffer: await imageBuffer(640, 768, { r: 80, g: 100, b: 120 }), caption: "test_uniform, portrait" },
  ] });
  const item = imported.items[0];
  assert.match(item.id, /^item-[a-f0-9]{12}$/);
  assert.deepEqual(imported.items.slice(0, 2).map((entry) => entry.asset_id), ["official-001", "official-003"]);
  assert.match(imported.items[2].asset_id, /^asset-[a-f0-9]{12}$/);
  assert.equal(item.caption, "test_uniform, standing");
  assert.equal(item.source, "官方角色展示页");
  assert.equal(item.image_width, 640);
  assert.equal(item.image_height, 768);
  assert.match(item.image_version, /^[a-f0-9]{64}$/);
  const datasetText = await readFile(path.join(datasetRoot(project, createdDataset.id), "project.json"), "utf8");
  const assetMeta = JSON.parse(await readFile(path.join(datasetRoot(project, createdDataset.id), "assets", item.asset_id, "meta.json"), "utf8"));
  const taskText = await readFile(path.join(taskRoot(project, createdTask.id), "settings.json"), "utf8");
  assert.equal(datasetText.includes("standing"), false);
  assert.equal(datasetText.includes("官方角色展示页"), false);
  assert.equal(assetMeta.source, "官方角色展示页");
  assert.equal(assetMeta.original.file, "original.png");
  assert.equal(assetMeta.current.file, "original.png");
  assert.equal(assetMeta.processing, null);
  assert.equal(await readFile(path.join(datasetRoot(project, createdDataset.id), "assets", item.asset_id, "caption.txt"), "utf8"), "test_uniform, standing\n");
  assert.equal(taskText.includes('"items"'), false);
  assert.equal(taskText.includes('"concept"'), false);
  await saveLoraTrainingCaption(project, createdDataset.id, item.id, "test_uniform, walking");
  const updated = await readLoraTrainingDataset(project, createdDataset.id);
  assert.equal(updated.items[0].caption, "test_uniform, walking");
  assert.equal(validateLoraTrainingDataset(updated.dataset).length, 0);
  assert.equal(validateLoraTrainingTask((await readLoraTrainingTask(project, createdTask.id)).task).length, 0);
});

test("数据集允许不设置激活标签，并拒绝空值和重复标签", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "柔光风格" });
  assert.deepEqual(created.dataset.activation_terms, []);
  const invalid = structuredClone(created.dataset);
  invalid.activation_terms = ["soft_light", "SOFT_LIGHT", ""];
  const errors = validateLoraTrainingDataset(invalid);
  assert.ok(errors.some((message) => message.includes("重复标签")));
  assert.ok(errors.some((message) => message.includes("非空字符串")));
});

test("逐图 Caption 更新只写同名 txt，生成结果记录单独保存", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "角色" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const item = imported.items[0];
  await updateLoraCaptioningItem(project, created.id, item.id, "ellen joe, maid outfit");
  const projection = await readLoraCaptioning(project, created.id);
  assert.equal(projection.summary.with_base, 0);
  assert.equal(projection.items[0].state, "unconfirmed");
  assert.equal(projection.items[0].current_prompt, "ellen joe, maid outfit");
});

test("Caption 汇总的待确认数量已包含未打标图片且不重复计算", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "Caption 汇总" });
  await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [
    { filename: "subject-a.png", buffer: await imageBuffer(), caption: "" },
    { filename: "subject-b.png", buffer: await imageBuffer(800, 900), caption: "" },
  ] });
  const projection = await readLoraCaptioning(project, created.id);
  assert.deepEqual(projection.summary, { total: 2, with_base: 0, confirmed: 0, unconfirmed: 2 });
});

test("Caption 确认绑定当前图片和文本哈希，并在修改或后处理后失效", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "角色" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "" }] });
  const item = imported.items[0];
  const captioner = (prompt) => ({ lora_training: { captioning: { id: "fixture", version: "1", command: process.execPath, args: ["-e", "const fs=require('fs'); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(process.env.LORA_CAPTION_INPUT,'utf8')); process.stdout.write(JSON.stringify({items:x.items.map(i=>({item_id:i.item_id,prompt:p,raw_tags:[p]}))}));", prompt] } } });
  const generated = await runLoraCaptioning(root, project, created.id, "missing", captioner("ellen joe, maid outfit"));
  assert.equal(generated.updated, 1);
  assert.equal((await readLoraCaptioning(project, created.id)).items[0].state, "unconfirmed");
  await saveLoraTrainingCaption(project, created.id, item.id, "ellen joe, maid outfit");
  assert.equal((await readLoraCaptioning(project, created.id)).items[0].state, "unconfirmed");
  await updateLoraCaptioningItem(project, created.id, item.id, "ellen joe, maid outfit", { confirm: true });
  const confirmedBeforeImageChange = (await readLoraCaptioning(project, created.id)).items[0];
  assert.equal(confirmedBeforeImageChange.state, "confirmed");
  assert.equal(confirmedBeforeImageChange.base_prompt, "ellen joe, maid outfit");
  await saveLoraTrainingCaption(project, created.id, item.id, "ellen joe, school uniform");
  assert.equal((await readLoraCaptioning(project, created.id)).items[0].state, "unconfirmed");
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, { item_id: item.id, crop: { x: 0, y: 0, width: 0.9, height: 1 }, upscale: false }, {});
  await applyLoraTrainingPostprocess(root, project, created.id, { item_id: item.id, crop: { x: 0, y: 0, width: 0.9, height: 1 }, upscale: false, preview_id: preview.preview_id }, {});
  assert.equal((await readLoraCaptioning(project, created.id)).items[0].state, "unconfirmed");
  await updateLoraCaptioningItem(project, created.id, item.id, "ellen joe, school uniform", { confirm: true });
  const confirmedAfterImageChange = (await readLoraCaptioning(project, created.id)).items[0];
  assert.equal(confirmedAfterImageChange.state, "confirmed");
  assert.equal(confirmedAfterImageChange.base_prompt, null);
  assert.deepEqual(confirmedAfterImageChange.raw_tags, []);
});

test("单图重新打标覆盖当前 Caption 必须显式确认且不触碰其他图片", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "单图打标" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [
    { filename: "subject-a.png", buffer: await imageBuffer(), caption: "old caption" },
    { filename: "subject-b.png", buffer: await imageBuffer(800, 900), caption: "keep caption" },
  ] });
  const target = imported.items[0];
  const untouched = imported.items[1];
  const captioner = { lora_training: { captioning: { id: "fixture", version: "1", command: process.execPath, args: ["-e", "const fs=require('fs'); const x=JSON.parse(fs.readFileSync(process.env.LORA_CAPTION_INPUT,'utf8')); process.stdout.write(JSON.stringify({items:x.items.map(i=>({item_id:i.item_id,prompt:'new caption',raw_tags:[]}))}));"] } } };
  await assert.rejects(() => runLoraCaptioning(root, project, created.id, "all", captioner), (error) => error.code === "invalid_lora_caption_run_mode");
  await assert.rejects(() => runLoraCaptioning(root, project, created.id, "single", captioner, { item_id: target.id }), (error) => error.code === "lora_caption_single_overwrite_confirmation_required");
  const result = await runLoraCaptioning(root, project, created.id, "single", captioner, { item_id: target.id, confirm_overwrite: true });
  assert.equal(result.updated, 1);
  const dataset = await readLoraTrainingDataset(project, created.id);
  assert.equal(dataset.items.find((item) => item.id === target.id).caption, "new caption");
  assert.equal(dataset.items.find((item) => item.id === untouched.id).caption, "keep caption");
  const captioning = await readLoraCaptioning(project, created.id);
  assert.equal(captioning.items.find((item) => item.item_id === target.id).state, "unconfirmed");
  assert.equal(captioning.items.find((item) => item.item_id === untouched.id).current_prompt, "keep caption");
});

test("删除数据集图片时同步清理最新基础 Prompt 记录", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "角色" });
  const imported = await importLoraTrainingAssets(project, created.id, {
    group_id: created.dataset.groups[0].id,
    files: [
      { filename: "subject-a.png", buffer: await imageBuffer(), caption: "" },
      { filename: "subject-b.png", buffer: await imageBuffer(800, 900), caption: "" },
    ],
  });
  const captioner = { lora_training: { captioning: { id: "fixture", version: "1", command: process.execPath, args: ["-e", "const fs=require('fs'); const x=JSON.parse(fs.readFileSync(process.env.LORA_CAPTION_INPUT,'utf8')); process.stdout.write(JSON.stringify({items:x.items.map(i=>({item_id:i.item_id,prompt:'ellen joe, standing',raw_tags:[]}))}));"] } } };
  await runLoraCaptioning(root, project, created.id, "missing", captioner);

  const next = structuredClone((await readLoraTrainingDataset(project, created.id)).dataset);
  next.items = next.items.filter((item) => item.id !== imported.items[1].id);
  await updateLoraTrainingDataset(project, created.id, next);

  const latestPath = path.join(datasetRoot(project, created.id), "captioning", "latest.json");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  assert.deepEqual(Object.keys(latest.items), [imported.items[0].id]);
});

test("打标器环境诊断校验命令与模型文件身份", async (context) => {
  const { root } = await fixture(context);
  const captionerId = "fixture-captioner";
  const modelRoot = path.join(root, "app", "data.local", "lora-training", "captioning", captionerId);
  const manifestRoot = path.join(root, "library", "lora-training", "captioners");
  await mkdir(modelRoot, { recursive: true });
  await mkdir(manifestRoot, { recursive: true });
  const model = "captioner-fixture-model";
  const labels = "name,category\nellen_joe,4\n1girl,0\n";
  const thresholds = "category,threshold\n0,0.39\n4,0.61\n";
  await writeFile(path.join(modelRoot, "model.onnx"), model);
  await writeFile(path.join(modelRoot, "selected_tags.csv"), labels);
  await writeFile(path.join(modelRoot, "thresholds.csv"), thresholds);
  const manifest = {
    version: 1,
    id: captionerId,
    name: "Fixture Captioner",
    files: {
      model: { relative_path: "model.onnx", sha256: createHash("sha256").update(model).digest("hex"), size_bytes: Buffer.byteLength(model) },
      labels: { relative_path: "selected_tags.csv", sha256: createHash("sha256").update(labels).digest("hex"), size_bytes: Buffer.byteLength(labels) },
      thresholds: { relative_path: "thresholds.csv", sha256: createHash("sha256").update(thresholds).digest("hex"), size_bytes: Buffer.byteLength(thresholds) },
    },
  };
  await writeFile(path.join(manifestRoot, `${captionerId}.json`), JSON.stringify(manifest));
  const baseConfig = {
    lora_training: {
      captioning: {
        id: captionerId,
        version: "test",
        command: process.execPath,
        check_args: ["-e", "process.stdout.write(JSON.stringify({ok:true,onnxruntime:'fixture'}))"],
      },
    },
  };
  const ready = await readLoraTrainingEnvironment(root, baseConfig);
  assert.equal(ready.captioning.configured, true);
  assert.equal(ready.captioning.ready, true);
  assert.equal(ready.captioning.message, "打标器可用");
  assert.equal(ready.captioning.files[0].matches, true);
  manifest.runtime = {
    required_providers: ["CUDAExecutionProvider"],
    forbidden_providers: ["CPUExecutionProvider"],
  };
  baseConfig.lora_training.captioning.args = ["--providers", "CUDAExecutionProvider"];
  await writeFile(path.join(manifestRoot, `${captionerId}.json`), JSON.stringify(manifest));
  const policyReady = await readLoraTrainingEnvironment(root, baseConfig);
  assert.equal(policyReady.captioning.ready, true);
  baseConfig.lora_training.captioning.args = ["--providers", "CPUExecutionProvider"];
  const policyBlocked = await readLoraTrainingEnvironment(root, baseConfig);
  assert.equal(policyBlocked.captioning.ready, false);
  assert.match(policyBlocked.captioning.message, /CPUExecutionProvider|Provider/);
  manifest.files.model.sha256 = "0".repeat(64);
  await writeFile(path.join(manifestRoot, `${captionerId}.json`), JSON.stringify(manifest));
  const unavailable = await readLoraTrainingEnvironment(root, baseConfig);
  assert.equal(unavailable.captioning.ready, false);
  assert.match(unavailable.captioning.message, /SHA-256/);
});

test("环境诊断缓存按依赖变化失效而不依赖时间", async (context) => {
  const { root } = await fixture(context);
  const captionerId = "fixture-cache-captioner";
  const modelRoot = path.join(root, "app", "data.local", "lora-training", "captioning", captionerId);
  const manifestRoot = path.join(root, "library", "lora-training", "captioners");
  await mkdir(modelRoot, { recursive: true });
  await mkdir(manifestRoot, { recursive: true });
  const model = "captioner-cache-model";
  await writeFile(path.join(modelRoot, "model.onnx"), model);
  const manifest = {
    version: 1,
    id: captionerId,
    name: "Fixture Cache Captioner",
    files: { model: { relative_path: "model.onnx", sha256: createHash("sha256").update(model).digest("hex"), size_bytes: Buffer.byteLength(model) } },
  };
  const manifestPath = path.join(manifestRoot, `${captionerId}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const config = { lora_training: { captioning: { id: captionerId, version: "test", command: process.execPath, check_args: ["-e", "process.stdout.write(JSON.stringify({ok:true,onnxruntime:'fixture'}))"] } } };
  const first = await readCachedLoraTrainingEnvironment(root, config);
  const second = await readCachedLoraTrainingEnvironment(root, config);
  assert.strictEqual(first, second);
  manifest.files.model.sha256 = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const changed = await readCachedLoraTrainingEnvironment(root, config);
  assert.notStrictEqual(changed, second);
  assert.equal(changed.captioning.ready, false);
});

test("数据集保存不需要确认，Caption 与图片后处理独立处理", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "道具" });
  const groupId = created.dataset.groups[0].id;
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: groupId, files: [{ filename: "prop.png", buffer: await imageBuffer(), caption: "prop", source: "https://example.com/artworks/1", asset_id: "reference-001" }] });
  const original = imported.items[0];
  await saveLoraTrainingCaption(project, created.id, original.id, "prop, daylight");
  const afterCaption = await readLoraTrainingDataset(project, created.id);
  afterCaption.dataset.groups[0].repeats = 4;
  const afterSettings = await updateLoraTrainingDataset(project, created.id, afterCaption.dataset);
  assert.equal(afterSettings.dataset.groups[0].repeats, 4);
  assert.equal(Object.hasOwn(afterSettings.dataset, "confirmation"), false);
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, { item_id: original.id, crop: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 }, upscale: false }, {});
  const cropped = await applyLoraTrainingPostprocess(root, project, created.id, { item_id: original.id, crop: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 }, upscale: false, preview_id: preview.preview_id });
  const detail = await readLoraTrainingDataset(project, created.id);
  assert.equal(Object.hasOwn(detail.dataset, "confirmation"), false);
  assert.equal(cropped.items[0].id, original.id);
  assert.match(detail.items[0].file, /\/processed-[a-f0-9]{64}\.png$/);
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].caption, "prop, daylight");
  await restoreLoraTrainingOriginal(project, created.id, original.id);
  assert.match((await readLoraTrainingDataset(project, created.id)).items[0].file, /\/original\.png$/);
});

test("数据集拒绝旧版分组图片数量字段", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "旧版分组" });
  const legacy = structuredClone(created.dataset);
  legacy.groups[0].target_count = 20;
  await assert.rejects(() => updateLoraTrainingDataset(project, created.id, legacy), (error) => error.code === "invalid_lora_training_dataset" && error.details.some((detail) => detail.includes("未支持字段")));
});

test("数据集不再接受图片项 crop 或父子关系", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "裁剪关系" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const invalid = structuredClone((await readLoraTrainingDataset(project, created.id)).dataset);
  invalid.items[0].crop = { source_item_id: imported.items[0].id, x: 0, y: 0, width: 0.5, height: 0.5 };
  await assert.rejects(() => updateLoraTrainingDataset(project, created.id, invalid), (error) => error.code === "invalid_lora_training_dataset" && error.status === 422 && error.details.some((detail) => detail.includes("不再保存 crop")));
});

test("方案统一保存全部参数，不从历史记录隐式覆盖，预检拒绝未保存参数", async (context) => {
  const { root, project } = await fixture(context);
  const dataset = await createLoraTrainingDataset(project, { name: "角色素材" });
  const task = await createLoraTrainingTask(root, project, { name: "角色训练", dataset_id: dataset.id });
  assert.equal(task.task.version, 4);
  assert.equal(task.task.training_recipe.overrides.effective_batch_size, 1);

  const settings = await readLoraTrainingRunSettings(root, project, task.id, {}, { skipEnvironment: true });
  assert.equal(settings.semantic_config.effective_batch_size, 1);
  assert.equal(settings.values.micro_batch_size, 1);
  assert.equal(settings.values.gradient_accumulation_steps, 1);
  assert.equal(settings.values.max_train_steps, 400);
  assert.equal(task.task.run_defaults.gradient_accumulation_steps, undefined);

  const runId = "run-777777777777";
  const runDirectory = generatedRunRoot(project, task.id, runId);
  await mkdir(runDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify({
      version: 4,
      id: runId,
      task_id: task.id,
      dataset_id: dataset.id,
      created_at: "2026-08-20T00:00:00.000Z",
      task_name: task.task.name,
      dataset_name: dataset.dataset.name,
      family: "anima",
      prompt_family: task.task.target.prompt_family,
      usage_defaults: task.task.target.usage_defaults,
      description: dataset.dataset.description,
      activation_terms: dataset.dataset.activation_terms,
      items: [],
      groups: [],
      models: [
        { kind: "dit", relative_path: "diffusion_models/anima.safetensors", sha256: "1".repeat(64), size_bytes: 1, source: null },
        { kind: "text_encoder", relative_path: "text_encoders/qwen.safetensors", sha256: "2".repeat(64), size_bytes: 1, source: null },
        { kind: "vae", relative_path: "vae/qwen.safetensors", sha256: "3".repeat(64), size_bytes: 1, source: null },
      ],
      trainer: { sd_scripts_commit: "test", python: "3.11", torch: "2.0", cuda: "12.8", accelerate: "1.10.0", gpu: "Test GPU", vram_bytes: 12 * 1024 ** 3 },
      recipe: { id: "anima-character-r32-v1", version: 1, sha256: "a".repeat(64), overrides: {} },
      semantic_config: { resolution: 1024, effective_batch_size: 1, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit" },
      experiment: { max_train_steps: 1800, save_every_n_steps: 300, seed: settings.values.seed },
      execution_config: { micro_batch_size: settings.values.micro_batch_size, gradient_accumulation_steps: settings.values.gradient_accumulation_steps, effective_batch_size: 1, max_data_loader_n_workers: settings.values.max_data_loader_n_workers, blocks_to_swap: settings.values.blocks_to_swap },
      run_settings: { ...settings.values, max_train_steps: 1800, save_every_n_steps: 300, note: "降低学习率对照" },
      config: { resolution: 1024, max_train_steps: 1800, train_batch_size: settings.values.micro_batch_size, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit", save_every_n_steps: 300, seed: settings.values.seed, gradient_accumulation_steps: settings.values.gradient_accumulation_steps, max_data_loader_n_workers: settings.values.max_data_loader_n_workers, blocks_to_swap: settings.values.blocks_to_swap },
      dataset_toml_sha256: "b".repeat(64),
      execution: { executable: "trainer.exe", argv: ["trainer.py"] },
      seed: settings.values.seed,

    })),
    writeFile(path.join(runDirectory, "result.json"), JSON.stringify({ version: 1, status: "completed", checkpoints: [] })),
  ]);
  const withLastRun = await readLoraTrainingRunSettings(root, project, task.id, {}, { skipEnvironment: true });
  assert.equal(withLastRun.values.max_train_steps, 400);
  assert.equal(withLastRun.last_run.config.max_train_steps, 1800);
  assert.equal(withLastRun.values.note, undefined);
  const otherTask = await createLoraTrainingTask(root, project, { name: "独立方案", dataset_id: dataset.id });
  const otherSettings = await readLoraTrainingRunSettings(root, project, otherTask.id, {}, { skipEnvironment: true });
  assert.equal(otherTask.id, task.id);
  assert.equal(otherSettings.last_run.id, runId);
  assert.equal((await listLoraTrainingTasks(project)).tasks[0].id, task.id);
  assert.equal(otherSettings.values.max_train_steps, 400);
  assert.equal((await readLoraTrainingTask(project, task.id)).runs[0].manifest.run_settings.note, "降低学习率对照");

  const mismatch = { ...settings.values, gradient_accumulation_steps: 2 };
  const preflight = await preflightLoraTraining(root, project, task.id, {}, { skipEnvironment: true, runSettings: mismatch });
  assert.ok(preflight.blockers.some((blocker) => blocker.code === "unsaved_lora_training_settings"));
  const edited = { ...task.task, run_defaults: { ...task.task.run_defaults, max_train_steps: 600, seed: 42 }, training_recipe: { ...task.task.training_recipe, overrides: { ...task.task.training_recipe.overrides, effective_batch_size: 4 } } };
  await updateLoraTrainingTask(root, project, task.id, edited);
  const reloaded = await readLoraTrainingRunSettings(root, project, task.id, {}, { skipEnvironment: true });
  assert.equal(reloaded.values.max_train_steps, 600);
  assert.equal(reloaded.values.seed, 42);
  assert.equal(reloaded.values.gradient_accumulation_steps, 4);
  assert.equal(reloaded.last_run.config.max_train_steps, 1800);
  await assert.rejects(updateLoraTrainingTask(root, project, task.id, { ...edited, run_defaults: { ...edited.run_defaults, micro_batch_size: 3 } }), { code: "invalid_lora_training_task" });
  await assert.rejects(updateLoraTrainingTask(root, project, task.id, { ...edited, run_defaults: { ...edited.run_defaults, note: "不应保存" } }), { code: "invalid_lora_training_task" });
  const invalidManifest = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"));
  delete invalidManifest.execution;
  await writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify(invalidManifest));
  await assert.rejects(() => readLoraTrainingTask(project, task.id), (error) => error.code === "invalid_lora_training_run_manifest");
});

test("服务恢复会把遗留的 Anima running run 终结为中断", async (context) => {
  const { root, project } = await fixture(context);
  const taskId = "lora-111111111111";
  const runId = "run-222222222222";
  const historyProject = path.join(root, "training-project");
  await mkdir(path.join(historyProject, "Training", taskId), { recursive: true });
  registerProject(root, { id: "dataset-333333333333", type: "training", path: historyProject });
  const runDirectory = runRoot(root, taskId, runId);
  const manifest = {
    version: 4, id: runId, task_id: taskId, dataset_id: "dataset-333333333333", created_at: "2026-08-20T00:00:00.000Z",
    task_name: "Anima 训练", dataset_name: "测试素材", family: "anima", prompt_family: "anima",
    usage_defaults: { clip_skip: null, sampler: "euler", scheduler: "simple", steps: 24, cfg: 4 }, description: "测试", activation_terms: [], items: [], groups: [],
    models: [
      { kind: "dit", relative_path: "diffusion_models/anima.safetensors", sha256: "1".repeat(64), size_bytes: 1, source: null },
      { kind: "text_encoder", relative_path: "text_encoders/qwen.safetensors", sha256: "2".repeat(64), size_bytes: 1, source: null },
      { kind: "vae", relative_path: "vae/qwen.safetensors", sha256: "3".repeat(64), size_bytes: 1, source: null },
    ],
    trainer: { sd_scripts_commit: "test", python: "3.11", torch: "2.0", cuda: "12.8", accelerate: "1.10.0", gpu: "Test GPU", vram_bytes: 12 * 1024 ** 3 },
    recipe: { id: "anima-character-r32-v1", version: 1, sha256: "4".repeat(64), overrides: {} },
    semantic_config: { resolution: 1024, effective_batch_size: 1, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit" },
    experiment: { max_train_steps: 1, save_every_n_steps: 1, seed: 7 },
    execution_config: { micro_batch_size: 1, gradient_accumulation_steps: 1, effective_batch_size: 1, max_data_loader_n_workers: 1, blocks_to_swap: 0 },
    run_settings: { max_train_steps: 1, save_every_n_steps: 1, seed: 7, micro_batch_size: 1, gradient_accumulation_steps: 1, max_data_loader_n_workers: 1, blocks_to_swap: 0 },
    config: { resolution: 1024, max_train_steps: 1, train_batch_size: 1, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit", save_every_n_steps: 1, seed: 7, gradient_accumulation_steps: 1, max_data_loader_n_workers: 1, blocks_to_swap: 0 },
    dataset_toml_sha256: "5".repeat(64), execution: { executable: "C:/python.exe", argv: ["C:/sd-scripts/anima_train_network.py", "--seed", "7"] }, seed: 7,

  };
  await mkdir(runDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify(manifest)),
    writeFile(path.join(runDirectory, "status.json"), JSON.stringify({ version: 1, status: "running", pid: null, checkpoints: [] })),
  ]);

  const recovered = await recoverLoraTrainingRuns(root);
  assert.deepEqual(recovered, [{ task_id: taskId, run_id: runId, verified: null, process_found: false }]);
  const status = JSON.parse(await readFile(path.join(runDirectory, "status.json"), "utf8"));
  assert.equal(status.status, "interrupted");
  assert.equal(status.recovery, "process_missing");
  const broken = runRoot(root, taskId, "run-aaaaaaaaaaaa");
  await mkdir(broken, { recursive: true });
  await writeFile(path.join(broken, "manifest.json"), "{broken");
  await writeFile(path.join(broken, "status.json"), JSON.stringify({ status: "running", pid: null }));
  const invalid = await recoverLoraTrainingRuns(root);
  assert.equal(invalid[0].invalid_manifest, true);
  assert.equal(JSON.parse(await readFile(path.join(broken, "status.json"), "utf8")).recovery, "invalid_manifest");
  assert.equal(await readFile(path.join(broken, "manifest.json"), "utf8"), "{broken");
});

test("保存接口拒绝旧的裁剪父子字段", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "旧裁剪结构" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const legacy = structuredClone((await readLoraTrainingDataset(project, created.id)).dataset);
  legacy.items[0].crop = { source_item_id: imported.items[0].id, x: 0, y: 0, width: 0.5, height: 0.5 };
  await assert.rejects(() => updateLoraTrainingDataset(project, created.id, legacy), (error) => error.code === "invalid_lora_training_dataset" && error.details.some((detail) => detail.includes("不再保存 crop")));
});

test("数据集与训练任务保存拒绝 schema 之外的字段", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "严格字段" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const invalidDataset = structuredClone((await readLoraTrainingDataset(project, created.id)).dataset);
  invalidDataset.items[0].unexpected = true;
  await assert.rejects(() => updateLoraTrainingDataset(project, created.id, invalidDataset), (error) => error.code === "invalid_lora_training_dataset" && error.details.some((detail) => detail.includes("包含未支持字段：unexpected")));
  const createdTask = await createLoraTrainingTask(root, project, { name: "严格任务", dataset_id: created.id });
  const optimizerOverride = structuredClone(createdTask.task);
  optimizerOverride.training_recipe.overrides.optimizer_type = "SGD";
  await assert.rejects(() => updateLoraTrainingTask(root, project, createdTask.id, optimizerOverride), (error) => error.code === "invalid_lora_training_task" && error.details.some((detail) => detail.includes("optimizer_type")));
  const unknownOverride = structuredClone(createdTask.task);
  unknownOverride.training_recipe.overrides.max_train_steps = 100;
  await assert.rejects(() => updateLoraTrainingTask(root, project, createdTask.id, unknownOverride), (error) => error.code === "invalid_lora_training_task" && error.details.some((detail) => detail.includes("max_train_steps")));
  const invalidTask = structuredClone(createdTask.task);
  invalidTask.reproduction = { agreement_id: "legacy" };
  await assert.rejects(() => updateLoraTrainingTask(root, project, createdTask.id, invalidTask), (error) => error.code === "invalid_lora_training_task" && error.details.some((detail) => detail.includes("plan.json 包含未支持字段：reproduction")));
  assert.equal(imported.items.length, 1);
});

test("图片后处理保留不可变原图并可恢复", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "角色" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const original = imported.items[0];
  const datasetDirectory = path.join(datasetRoot(project, created.id));
  const originalPath = path.join(datasetDirectory, ...original.file.split("/"));
  const originalHash = original.image_version;
  const request = { item_id: original.id, crop: { x: 0, y: 0, width: 0.5, height: 0.5 }, upscale: false, output_scale: null };
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, request, {});
  const processed = await applyLoraTrainingPostprocess(root, project, created.id, { ...request, preview_id: preview.preview_id }, {});
  assert.match(processed.items[0].file, /processed-[a-f0-9]{64}\.png$/);
  const storedDataset = JSON.parse(await readFile(path.join(datasetDirectory, "project.json"), "utf8"));
  assert.equal(Object.hasOwn(storedDataset.items[0], "file"), false);
  assert.equal(processed.items[0].original_image_version, originalHash);
  assert.equal((await sharp(originalPath).metadata()).width, 640);
  const captioningDirectory = path.join(datasetDirectory, "captioning");
  await mkdir(captioningDirectory, { recursive: true });
  await writeFile(path.join(captioningDirectory, "latest.json"), JSON.stringify({ version: 1, updated_at: new Date().toISOString(), tagger: { id: "old", version: "1" }, items: { [original.id]: { base_prompt: null, image_sha256: originalHash, caption_sha256: original.caption_sha256, raw_tags: [], confirmation: null } } }));
  const captioner = { lora_training: { captioning: { id: "fixture", version: "1", command: process.execPath, args: ["-e", "const fs=require('fs'); const x=JSON.parse(fs.readFileSync(process.env.LORA_CAPTION_INPUT,'utf8')); process.stdout.write(JSON.stringify({items:x.items.map(i=>({item_id:i.item_id,prompt:'fresh prompt',raw_tags:[]}))}));"] } } };
  const relabeled = await runLoraCaptioning(root, project, created.id, "single", captioner, { item_id: original.id, confirm_overwrite: true });
  assert.equal(relabeled.processed, 1);
  await restoreLoraTrainingOriginal(project, created.id, original.id);
  assert.equal((await readLoraTrainingDataset(project, created.id)).items[0].file, original.file);
  const rollbackPreview = await previewLoraTrainingPostprocess(root, project, created.id, request, {});
  await writeFile(path.join(captioningDirectory, "latest.json"), JSON.stringify({ version: 1, items: { [original.id]: {} }, tagger: null, updated_at: null }));
  const metaBeforeFailedApply = await readFile(path.join(datasetDirectory, "assets", original.asset_id, "meta.json"));
  await assert.rejects(
    () => applyLoraTrainingPostprocess(root, project, created.id, { ...request, preview_id: rollbackPreview.preview_id }, {}),
    (error) => error.code === "invalid_lora_captioning_latest",
  );
  assert.deepEqual(await readFile(path.join(datasetDirectory, "assets", original.asset_id, "meta.json")), metaBeforeFailedApply);
  assert.equal(JSON.parse(metaBeforeFailedApply.toString("utf8")).current.file, original.file.split("/").at(-1));
  await assert.rejects(readFile(path.join(datasetDirectory, "assets", original.asset_id, `processed-${rollbackPreview.preview_id}.png`)), { code: "ENOENT" });
});

test("图片后处理拒绝未裁剪且未超分的无操作请求", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "角色" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const item = imported.items[0];
  await assert.rejects(
    () => previewLoraTrainingPostprocess(root, project, created.id, { item_id: item.id, crop: { x: 0, y: 0, width: 1, height: 1 }, upscale: false, output_scale: null }, {}),
    (error) => error.code === "lora_postprocess_no_changes",
  );
});

test("Caption 独立审计只按有效图片哈希记录并保留离开集合的历史", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "审计快照" });
  const imported = await importLoraTrainingAssets(project, created.id, {
    group_id: created.dataset.groups[0].id,
    files: [
      { filename: "one.png", buffer: await imageBuffer(640, 768), caption: "ellen_joe, standing" },
      { filename: "two.png", buffer: await imageBuffer(768, 640), caption: "ellen_joe, sitting" },
    ],
  });
  const hashes = imported.items.map((item) => item.image_version);
  let audit = await readLoraCaptionAudit(project, created.id);
  assert.deepEqual(audit.summary, { total: 2, audited: 0, pending: 2, blocked: 0 });
  audit = await recordLoraCaptionAudit(project, created.id, { image_sha256: hashes, prompt_family: "anima" });
  assert.deepEqual(audit.summary, { total: 2, audited: 2, pending: 0, blocked: 0 });

  await saveLoraTrainingCaption(project, created.id, imported.items[0].id, "ellen_joe, standing, outdoors");
  audit = await readLoraCaptionAudit(project, created.id);
  assert.equal(audit.summary.audited, 2, "修改 Caption 不应使按图片哈希保存的审计失效");

  const nextDataset = structuredClone(imported.dataset);
  nextDataset.items[1].enabled = false;
  await updateLoraTrainingDataset(project, created.id, nextDataset);
  audit = await readLoraCaptionAudit(project, created.id);
  assert.deepEqual(audit.summary, { total: 1, audited: 1, pending: 0, blocked: 0 });
  assert.equal(Object.keys((await readCaptionAuditSnapshot(project, created.id)).images).length, 2, "禁用图片的历史哈希仍应保留");

  const request = { item_id: imported.items[0].id, crop: { x: 0, y: 0, width: 0.9, height: 1 }, upscale: false };
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, request, {});
  await applyLoraTrainingPostprocess(root, project, created.id, { ...request, preview_id: preview.preview_id }, {});
  audit = await readLoraCaptionAudit(project, created.id);
  assert.deepEqual(audit.summary, { total: 1, audited: 0, pending: 1, blocked: 0 }, "图片变化后新哈希应重新进入待审计");
  assert.equal(Object.keys((await readCaptionAuditSnapshot(project, created.id)).images).length, 2, "图片变化不删除旧审计哈希");
});

test("批量超分选择能越过 1024 的最小倍率并复用裁剪框", () => {
  assert.equal(chooseLoraUpscaleScale(512), 4);
  assert.equal(chooseLoraUpscaleScale(513), 2);
  const result = planLoraBulkUpscale([
    { id: "item-2x", asset_id: "asset-2x", image_width: 800, image_height: 1200, original_image_width: 1200, original_image_height: 1600, processing: null },
    { id: "item-4x", asset_id: "asset-4x", image_width: 512, image_height: 768, original_image_width: 1200, original_image_height: 1600, processing: null },
    { id: "item-cropped", asset_id: "asset-cropped", image_width: 600, image_height: 800, original_image_width: 1200, original_image_height: 1600, processing: { crop: { x: 100, y: 200, width: 600, height: 800 }, upscale: false } },
    { id: "item-done", asset_id: "asset-done", image_width: 600, image_height: 800, processing: { crop: { x: 0, y: 0, width: 600, height: 800 }, upscale: true } },
    { id: "item-large", asset_id: "asset-large", image_width: 1024, image_height: 1400, processing: null },
  ]);
  assert.deepEqual(result.planned.map((item) => [item.item_id, item.output_scale]), [["item-2x", 2], ["item-4x", 4], ["item-cropped", 2]]);
  assert.deepEqual(result.planned[2].crop, { x: 100 / 1200, y: 200 / 1600, width: 600 / 1200, height: 800 / 1600 });
  assert.deepEqual(result.skipped, { already_upscaled: 1, above_target: 1, invalid: 0 });
});

for (const transparent of [false, true]) test(`超分支持原尺寸与裁剪增强、缓存及恢复；透明输入：${transparent}`, async (context) => {
  const { root, project } = await fixture(context);
  const modelsRoot = path.join(root, "models");
  const manifestRoot = path.join(root, "library", "lora-training", "upscalers");
  await mkdir(modelsRoot, { recursive: true });
  await mkdir(manifestRoot, { recursive: true });
  const model = Buffer.from("test-upscaler");
  await writeFile(path.join(modelsRoot, "model.pth"), model);
  await writeFile(path.join(manifestRoot, "real-esrgan-x4plus-anime-6b.json"), JSON.stringify({
    file: { relative_path: "model.pth", sha256: createHash("sha256").update(model).digest("hex") },
  }));
  const config = { models_root: modelsRoot, comfyui_urls: ["http://127.0.0.1:8188"] };
  const created = await createLoraTrainingDataset(project, { name: "原尺寸增强" });
  const pixels = Buffer.alloc(81 * 63 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([255, 0, 0, 128], offset);
  pixels.set([0, 0, 0, 0], 0);
  const source = transparent ? await sharp(pixels, { raw: { width: 81, height: 63, channels: 4 } }).png().toBuffer() : await imageBuffer(81, 63);
  const imported = await importLoraTrainingAssets(project, created.id, {
    group_id: created.dataset.groups[0].id,
    files: [{ filename: "source.png", buffer: source, caption: "standing" }],
  });
  let input;
  let submissions = 0;
  context.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [] });
    if (target.endsWith("/upload/image")) {
      input = Buffer.from(await options.body.get("image").arrayBuffer());
      return Response.json({ name: "uploaded.png" });
    }
    if (target.endsWith("/prompt")) { submissions += 1; return Response.json({ prompt_id: "upscale" }); }
    if (target.endsWith("/history/upscale")) return Response.json({ upscale: { outputs: { output: { images: [{ filename: "result.png", type: "output" }] } } } });
    if (target.includes("/view?")) {
      const size = await sharp(input).metadata();
      return new Response(await sharp(input).negate().resize(size.width * 4, size.height * 4).png().toBuffer());
    }
    throw new Error(`unexpected request: ${target}`);
  });
  const request = { item_id: imported.items[0].id, crop: { x: 0, y: 0, width: 1, height: 1 }, upscale: true, output_scale: 1 };
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, request, config);
  assert.deepEqual([preview.width, preview.height], [81, 63]);
  if (transparent) {
    assert.equal((await sharp(input).metadata()).hasAlpha, false);
    const rgb = await sharp(input).raw().toBuffer();
    assert.deepEqual([...rgb.subarray(0, 3)], [255, 255, 255]);
    assert.deepEqual([...rgb.subarray(3, 6)], [255, 127, 127]);
    const cropOnly = await previewLoraTrainingPostprocess(root, project, created.id, { ...request, crop: { x: 0, y: 0, width: 40, height: 30 }, upscale: false, output_scale: null }, config);
    assert.equal((await sharp(path.join(datasetRoot(project, created.id), "Saved/cache/lora-postprocessing", `preview-${cropOnly.preview_id}.png`)).metadata()).hasAlpha, true);
  }
  assert.notEqual(preview.output_sha256, imported.items[0].original_sha256);
  assert.equal((await previewLoraTrainingPostprocess(root, project, created.id, request, config)).cached, true);
  assert.equal(submissions, 1);
  const double = await previewLoraTrainingPostprocess(root, project, created.id, { ...request, output_scale: 2 }, config);
  assert.deepEqual([double.width, double.height], [162, 126]);
  assert.notEqual(double.preview_id, preview.preview_id);
  await assert.rejects(applyLoraTrainingPostprocess(root, project, created.id, { ...request, output_scale: 2, preview_id: preview.preview_id }, config), { code: "lora_postprocess_preview_stale" });
  const saved = await applyLoraTrainingPostprocess(root, project, created.id, { ...request, preview_id: preview.preview_id }, config);
  assert.equal(saved.items[0].processing.output_scale, 1);
  const submissionsBeforePrepare = submissions;
  let scoreCalls = 0;
  const prepared = await prepareLoraTrainingDataset(root, project, created.id, config, {
    quality: { ready: true, sha256: "a".repeat(64) },
    createSession: () => ({ score: async () => ++scoreCalls === 1 ? 80 : 79, close() {} }),
  });
  assert.equal(prepared.dataset.items[0].preparation.decision, "enhanced", "手动超分即使高分且评分下降也不能被自动规则覆盖");
  assert.equal(prepared.dataset.items[0].preparation.after_score, 79);
  assert.equal(submissions, submissionsBeforePrepare, "复用已经应用的手动预览，不重复运行模型");

  assert.deepEqual([saved.items[0].image_width, saved.items[0].image_height], [81, 63]);
  const cropped = { ...request, crop: { x: 3, y: 4, width: 51, height: 37 } };
  const cropPreview = await previewLoraTrainingPostprocess(root, project, created.id, cropped, config);
  assert.deepEqual([cropPreview.width, cropPreview.height], [51, 37]);
  await applyLoraTrainingPostprocess(root, project, created.id, { ...cropped, preview_id: cropPreview.preview_id }, config);
  const restored = await restoreLoraTrainingOriginal(project, created.id, request.item_id);
  assert.equal(restored.items[0].processing, undefined);
  assert.equal(restored.items[0].image_version, createHash("sha256").update(source).digest("hex"));
  assert.deepEqual([restored.items[0].image_width, restored.items[0].image_height], [81, 63]);
});

test("ComfyUI已有队列任务时超分仍可提交并取得结果", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    requests.push({ target, method: options.method ?? "GET" });
    if (target.endsWith("/queue")) return Response.json({ queue_running: [[1, "external"]], queue_pending: [[2, "external"]] });
    if (target.endsWith("/upload/image")) return Response.json({ name: "uploaded.png" });
    if (target.endsWith("/prompt")) return Response.json({ prompt_id: "upscale-prompt" });
    if (target.endsWith("/history/upscale-prompt")) {
      return Response.json({
        "upscale-prompt": {
          outputs: { output: { images: [{ filename: "upscaled.png", subfolder: "", type: "output" }] } },
        },
      });
    }
    if (target.includes("/view?")) return new Response(Buffer.from("upscaled-image"));
    throw new Error(`unexpected request: ${target}`);
  };

  const result = await executeLoraUpscale(
    "repository",
    "project",
    "dataset",
    Buffer.from("source-image"),
    "a".repeat(64),
    { comfyui_urls: ["http://127.0.0.1:8188"] },
    { relative_path: "upscale_models/model.pth" },
  );

  assert.equal(result.toString(), "upscaled-image");
  assert.deepEqual(requests.map(({ target }) => new URL(target).pathname), [
    "/queue",
    "/upload/image",
    "/prompt",
    "/history/upscale-prompt",
    "/view",
  ]);
});

test("LoRA 图片超分拒绝远程 ComfyUI 且不会上传素材", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("不应访问远程 ComfyUI");
  };

  await assert.rejects(
    executeLoraUpscale(
      "repository",
      "project",
      "dataset",
      Buffer.from("source-image"),
      "a".repeat(64),
      { comfyui_urls: ["http://windows-gpu:8188"] },
      { relative_path: "upscale_models/model.pth" },
    ),
    (error) => error?.status === 422 && error?.code === "lora_upscale_remote_comfyui_unsupported",
  );
  assert.equal(requests, 0);
});

test("复制素材创建独立 asset，复制项可以单独裁剪", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "独立版本" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const source = imported.items[0];
  const copied = await copyLoraTrainingItem(project, created.id, { source_item_id: source.id });
  assert.equal(copied.items.length, 2);
  const copy = copied.items[1];
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.asset_id, source.asset_id);
  assert.equal(copy.caption, source.caption);
  assert.equal(copy.source, source.source);
  assert.notEqual(copy.file, source.file);

  assert.equal(copied.items[0].original_image_version, source.image_version);
  assert.equal(copied.items[1].original_image_version, source.image_version);
  assert.equal(copied.items.length, 2);
});

test("复制素材同时复制当前图片对应的基础 Prompt", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "复制打标结果" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe" }] });
  const source = imported.items[0];
  const captioningDirectory = path.join(datasetRoot(project, created.id), "captioning");
  await mkdir(captioningDirectory, { recursive: true });
  await writeFile(path.join(captioningDirectory, "latest.json"), JSON.stringify({ version: 1, updated_at: new Date().toISOString(), tagger: { id: "test", version: "1" }, items: { [source.id]: { base_prompt: "ellen joe", image_sha256: source.image_version, caption_sha256: source.caption_sha256, raw_tags: [{ name: "ellen_joe", score: 0.99 }], confirmation: null } } }));
  const copied = await copyLoraTrainingItem(project, created.id, { source_item_id: source.id });
  const duplicate = copied.items[1];
  const projection = await readLoraCaptioning(project, created.id);
  const duplicatePrompt = projection.items.find((item) => item.item_id === duplicate.id);
  assert.equal(duplicatePrompt.base_prompt, "ellen joe");
  assert.deepEqual(duplicatePrompt.raw_tags, [{ name: "ellen_joe", score: 0.99 }]);
});

test("数据集拒绝跨 asset 的 meta 指针", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "路径保护" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "ellen joe", asset_id: "safe-001" }] });
  const item = imported.items[0];
  const metaPath = path.join(datasetRoot(project, created.id), "assets", item.asset_id, "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.original.file = "../other-001/original.png";
  await writeFile(metaPath, JSON.stringify(meta));
  await assert.rejects(() => readLoraTrainingDataset(project, created.id), (error) => error.code === "invalid_lora_training_asset_meta");
});

test("数据集拒绝多个训练项共享同一 asset", async () => {
  const dataset = {
    version: 5,
    name: "唯一素材",
    description: "",
    activation_terms: [],
    groups: [{ id: "group-111111111111", name: "素材", enabled: true, repeats: 1 }],
    items: [
      { id: "item-111111111111", asset_id: "screenshot-001", group_id: "group-111111111111", enabled: true },
      { id: "item-222222222222", asset_id: "screenshot-001", group_id: "group-111111111111", enabled: true },
    ],
  };
  assert.ok(validateLoraTrainingDataset(dataset).some((message) => message.includes("asset_id 重复")));
});

test("EXIF 方向统一到浏览器可见像素坐标后再裁剪", async (context) => {
  const { root, project } = await fixture(context);
  const oriented = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 20, g: 40, b: 60 } } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const created = await createLoraTrainingDataset(project, { name: "方向图片" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "oriented.jpg", buffer: oriented, caption: "portrait" }] });
  const item = imported.items[0];
  assert.deepEqual([item.image_width, item.image_height], [40, 80]);
  const request = { item_id: item.id, crop: { x: 0, y: 0, width: 0.5, height: 1 }, upscale: false, output_scale: null };
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, request, {});
  assert.deepEqual([preview.width, preview.height], [20, 80]);
});

test("归一化裁剪按边界取整，不会让奇数尺寸的合法选区越界", async (context) => {
  const { root, project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "奇数尺寸" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "odd.png", buffer: await imageBuffer(641, 769), caption: "portrait" }] });
  const preview = await previewLoraTrainingPostprocess(root, project, created.id, { item_id: imported.items[0].id, crop: { x: 0.5, y: 0, width: 0.5, height: 1 }, upscale: false, output_scale: null }, {});
  assert.deepEqual([preview.width, preview.height], [320, 769]);
});

test("上传素材保留可选来源并拒绝非法编号，任务拒绝 Caption 第二事实来源", async (context) => {
  const { project } = await fixture(context);
  const created = await createLoraTrainingDataset(project, { name: "风格" });
  const imported = await importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "subject.png", buffer: await imageBuffer(), source: "游戏内自截：角色展示界面", asset_id: "screenshot-001" }] });
  assert.equal(imported.items[0].asset_id, "screenshot-001");
  assert.equal(imported.items[0].source, "游戏内自截：角色展示界面");
  const unsafeBuffer = await imageBuffer();
  await assert.rejects(() => importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "unsafe.png", buffer: unsafeBuffer, asset_id: "../unsafe-001" }] }), (error) => error.code === "invalid_lora_training_asset_id");
  await assert.rejects(() => importLoraTrainingAssets(project, created.id, { group_id: created.dataset.groups[0].id, files: [{ filename: "duplicate.png", buffer: unsafeBuffer, asset_id: "screenshot-001" }] }), (error) => error.code === "lora_training_asset_id_conflict" && error.status === 409);
  const invalid = structuredClone(created.dataset);
  invalid.items = [{ id: "item-000000000000", asset_id: "asset-001", file: "assets/asset-001/original.png", group_id: invalid.groups[0].id, enabled: true, caption: "不应存在" }];
  assert.ok(validateLoraTrainingDataset(invalid).some((message) => message.includes("Caption")));
});

test("训练预检不按分组图片数量产生警告", async (context) => {
  const { root, project } = await fixture(context);
  const modelsRoot = path.join(root, "models");
  const dataset = await createLoraTrainingDataset(project, { name: "分组预检" });
  await importLoraTrainingAssets(project, dataset.id, {
    group_id: dataset.dataset.groups[0].id,
    files: [{ filename: "subject.png", buffer: await imageBuffer(), caption: "subject", asset_id: "subject-001" }],
  });
  const task = await createLoraTrainingTask(root, project, { name: "分组预检任务", dataset_id: dataset.id });

  const preflight = await preflightLoraTraining(root, project, task.id, { models_root: modelsRoot }, { skipEnvironment: true });
  assert.equal(preflight.warnings.some((warning) => warning.code === "group_target_count_deviation"), false);
  assert.deepEqual(preflight.warnings.map(({ code }) => code), ["anima_low_vram", "anima_license"]);
});

test("CLI 参数只由结构化字段编译，Anima 使用官方入口参数并写入备份元数据", () => {
  const config = { max_train_steps: 10, train_batch_size: 1, gradient_accumulation_steps: 1, network_dim: 16, network_alpha: 8, learning_rate: 0.0001, optimizer_type: "AdamW8bit", seed: 1, save_every_n_steps: 5, max_data_loader_n_workers: 1, blocks_to_swap: 4 };
  const compiled = compileLoraTrainingArguments({ trainerRoot: "C:/trainer", python: "C:/python.exe", runDirectory: "D:/run-safe", models: { dit: { path: "D:/models/anima.safetensors" }, text_encoder: { path: "D:/models/qwen.safetensors" }, vae: { path: "D:/models/vae.safetensors" } }, config, datasetConfig: "D:/run-safe/config/dataset.toml", metadata: { title: "制服", description: "固定设计", tags: "test_uniform", trigger_phrase: "test_uniform", author: "StoryCanvas" } });
  assert.equal(compiled.executable, "C:/python.exe");
  assert.equal(compiled.argv[0], path.join("C:/trainer", "anima_train_network.py"));
  assert.deepEqual(compiled.argv.slice(compiled.argv.indexOf("--pretrained_model_name_or_path"), compiled.argv.indexOf("--pretrained_model_name_or_path") + 2), ["--pretrained_model_name_or_path", "D:/models/anima.safetensors"]);
  assert.ok(compiled.argv.includes("--qwen3"));
  assert.ok(compiled.argv.includes("networks.lora_anima"));
  assert.equal(compiled.argv.some(value => value.startsWith("--sample_")), false, "训练参数不再包含预览采样");
  assert.deepEqual(compiled.argv.slice(compiled.argv.indexOf("--save_every_n_steps"), compiled.argv.indexOf("--save_every_n_steps") + 2), ["--save_every_n_steps", "5"]);
  assert.deepEqual(compiled.argv.slice(compiled.argv.indexOf("--metadata_title"), compiled.argv.indexOf("--metadata_title") + 2), ["--metadata_title", "制服"]);
  assert.deepEqual(compiled.argv.slice(compiled.argv.indexOf("--metadata_tags"), compiled.argv.indexOf("--metadata_tags") + 2), ["--metadata_tags", "test_uniform"]);
  assert.deepEqual(compiled.argv.slice(compiled.argv.indexOf("--metadata_trigger_phrase"), compiled.argv.indexOf("--metadata_trigger_phrase") + 2), ["--metadata_trigger_phrase", "test_uniform"]);
  assert.equal(compiled.argv.some((value) => value.includes("&&") || value.includes(";")), false);
});

test("训练日志只把实际进度当作 step，不误读百分比", () => {
  assert.deepEqual(parseLoraTrainingLine("steps:  64%|██████▍   | 1/1 [00:05<00:00, 5.01s/it, avr_loss=0.114]"), { step: 1, loss: 0.114 });
  assert.deepEqual(parseLoraTrainingLine("global_step = 300 loss=0.042"), { step: 300, loss: 0.042 });
  assert.deepEqual(parseLoraTrainingLine("bucket 0: resolution (384, 640), count: 1"), { step: null, loss: null });
});

test("公开 LoRA 记录与本地训练记录统一读取，并保留预览来源和 NSFW 级别", async (t) => {
  const { root } = await fixture(t);
  const modelsRoot = path.join(root, "models");
  const weight = Buffer.from("tracked-lora-weight");
  const weightSha = createHash("sha256").update(weight).digest("hex");
  const resourceId = `lora-${weightSha.slice(0, 16)}`;
  const resourceDirectory = path.join(root, "library", "resources", "loras", resourceId);
  await mkdir(path.join(resourceDirectory, "previews"), { recursive: true });
  await mkdir(path.join(modelsRoot, "loras", "civitai"), { recursive: true });
  await writeFile(path.join(modelsRoot, "loras", "civitai", "tracked.safetensors"), weight);
  const resource = {
    $schema: "https://storyvisualizer.local/schemas/lora-resource.schema.json",
    version: 2,
    id: resourceId,
    name: "公开测试 LoRA",
    kind: "lora",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    file: { relative_path: "loras/civitai/tracked.safetensors", sha256: weightSha, size_bytes: weight.length },
    architecture: { family: "anima", prompt_family: "anima" },
    base_models: [{ kind: "base_model", name: "Anima", identity_status: "declared", relative_path: null, sha256: null, size_bytes: null, source: "https://civitai.com/models/1?modelVersionId=2" }],
    concept: { name: "公开测试 LoRA", description: "测试仓库资源" },
    activation: { trigger_words: ["test_style"], tags: ["style"] },
    recommended_generation: { weight: { default: 1, minimum: null, maximum: null, status: "untested" }, clip_skip: null, sampler: null, scheduler: null, steps: null, cfg: null, status: "untested" },
    training: null,
    description: "测试仓库资源",
    usage_notes: "保留发布页推荐信息。",
    license: null,
    source: { type: "civitai", url: "https://civitai.com/models/1?modelVersionId=2", civitai_model_id: 1, civitai_version_id: 2, version_name: "v1" },
    previews: [{ id: "preview-001", file: "previews/preview-001.png", alt: "公开测试 LoRA · 发布图", source: "https://civitai.com/images/3", nsfw_level: 16 }],
    examples: [],
    embedded_metadata: { role: "backup", values: { "civitai.preview_images": "[{\"id\":\"3\",\"nsfw_level\":16}]" } },
  };
  assert.deepEqual(validateLoraResource(resource), []);
  await writeFile(path.join(resourceDirectory, "resource.json"), `${JSON.stringify(resource)}\n`);
  await writeFile(path.join(resourceDirectory, "previews", "preview-001.png"), await imageBuffer(16, 16));

  const listed = await listLocalLoraResources(root, { models_root: modelsRoot });
  assert.equal(listed.errors.length, 0);
  assert.equal(listed.resources.length, 1);
  assert.equal(listed.resources[0].repository_record, true);
  assert.equal(listed.resources[0].storage, "repository");
  assert.equal(listed.resources[0].status, "available");
  assert.equal(listed.resources[0].resource.previews[0].nsfw_level, 16);

  await writeFile(path.join(resourceDirectory, "resource.json"), `${JSON.stringify({ ...resource, file: { ...resource.file, size_bytes: resource.file.size_bytes + 1 } })}\n`);
  const sizeMismatch = await readLocalLoraResource(root, { models_root: modelsRoot }, resourceId);
  assert.equal(sizeMismatch.status, "hash_mismatch");
  assert.equal(sizeMismatch.reason, "model_size_mismatch");
  await writeFile(path.join(resourceDirectory, "resource.json"), `${JSON.stringify(resource)}\n`);

  const replacement = Buffer.alloc(weight.length, 65);
  await writeFile(path.join(modelsRoot, "loras", "civitai", "tracked.safetensors"), replacement);
  const replaced = await readLocalLoraResource(root, { models_root: modelsRoot }, resourceId);
  assert.equal(replaced.status, "hash_mismatch", "替换为相同大小的文件也不能命中旧 hash cache");
  await writeFile(path.join(modelsRoot, "loras", "civitai", "tracked.safetensors"), weight);
  assert.equal((await readLocalLoraResource(root, { models_root: modelsRoot }, resourceId)).status, "available");

  const read = await readLocalLoraResource(root, { models_root: modelsRoot }, resourceId);
  assert.equal(read.repository_record, true);
  const media = await openLoraResourceMedia(root, resourceId, "previews/preview-001.png");
  assert.equal(media.info.size > 0, true);

  const localDirectory = path.join(root, "app", "data.local", "lora-resources", resourceId);
  await mkdir(path.join(localDirectory, "previews"), { recursive: true });
  await writeFile(path.join(localDirectory, "resource.json"), `${JSON.stringify(resource)}\n`);
  await writeFile(path.join(localDirectory, "previews", "preview-001.png"), await readFile(path.join(resourceDirectory, "previews", "preview-001.png")));
  await writeFile(path.join(resourceDirectory, "resource.json"), "{\n");
  const fallback = await listLocalLoraResources(root, { models_root: modelsRoot });
  assert.equal(fallback.resources.length, 1);
  assert.equal(fallback.resources[0].repository_record, false);
  assert.equal(fallback.errors[0].id, resourceId);
  assert.equal((await readLocalLoraResource(root, { models_root: modelsRoot }, resourceId)).repository_record, false);
  assert.equal((await openLoraResourceMedia(root, resourceId, "previews/preview-001.png")).info.size > 0, true);
});

test("训练冻结保留独立图片Caption副本，终态结果不依赖runtime或外部权重", async context => {
  const { root, project } = await fixture(context);
  const dataset = await createLoraTrainingDataset(project, { name: "冻结测试" });
  const task = await createLoraTrainingTask(root, project, { name: "冻结计划", dataset_id: dataset.id });
  const bytes = await imageBuffer();
  await importLoraTrainingAssets(project, dataset.id, { group_id: dataset.dataset.groups[0].id, files: [{ filename: "look.png", buffer: bytes, caption: "standing" }] });
  const settings = await readLoraTrainingRunSettings(root, project, task.id, {}, { skipEnvironment: true });
  const preflight = await preflightLoraTraining(root, project, task.id, {}, { skipEnvironment: true, runSettings: settings.values });
  preflight.environment = { trainer_root: root, python: "python", commit: "test", runtime: { python: "3.11", torch: "2.0", cuda: "12.8", accelerate: "1.0", gpu: "test", vram_bytes: 12 * 1024 ** 3 } };
  preflight.models = preflight.models.map(model => ({ ...model, sha256: model.identity.sha256, size: 1 }));
  const frozen = await snapshotRun(root, project, task.id, { models_root: path.join(root, "models") }, preflight);
  const archive = generatedRunRoot(project, task.id, frozen.runId);
  const item = frozen.manifest.items[0];
  const frozenCaption = await readFile(path.join(archive, item.caption_file));
  assert.deepEqual(await readFile(path.join(archive, item.image_file)), bytes);
  await writeFile(path.join(frozen.runDirectory, item.caption_file), "working copy changed");
  await writeFile(path.join(frozen.runDirectory, "dataset", "latent.npz"), "runtime cache");
  assert.deepEqual(await readFile(path.join(archive, item.caption_file)), frozenCaption);
  assert.equal(Object.hasOwn(frozen.manifest, "preview_prompts"), false);
  assert.equal((await readdir(path.join(frozen.runDirectory, "config"))).includes("sample-prompts.txt"), false);
  const terminal = await updateRunStatus(frozen.runDirectory, { status: "completed", completed_at: new Date().toISOString(), checkpoints: [{ id: "checkpoint-aaaaaaaaaaaa", file: "missing.safetensors", sha256: "a".repeat(64), size: 10, step: 2 }] });
  await rm(path.join(datasetRoot(project, dataset.id), "Saved"), { recursive: true });
  const result = await readLoraTrainingRun(project, task.id, frozen.runId);
  assert.equal(result.status.status, "completed");
  assert.equal(result.status.checkpoints[0].sha256, "a".repeat(64));
  assert.equal(result.status.checkpoints[0].available, false);
  assert.equal(result.manifest.items[0].caption_sha256, createHash("sha256").update(frozenCaption).digest("hex"));
  await assert.rejects(readFile(path.join(archive, "dataset", "latent.npz")), { code: "ENOENT" });
  assert.deepEqual(result.status, terminal);
});

test("同名同大小checkpoint被替换或删除只改变可用性，不覆盖历史身份", async context => {
  const { project } = await fixture(context);
  const weights = path.join(project, "external-weights"); await mkdir(weights);
  const file = path.join(weights, "lora-step1.safetensors");
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: "U8", shape: [1], data_offsets: [0, 1] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  await writeFile(file, Buffer.concat([prefix, header, Buffer.from([1])]));
  const original = await inventoryCheckpoints(project, { status: "completed", checkpoints: [] }, weights);
  assert.equal(original.length, 1);
  await writeFile(file, Buffer.concat([prefix, header, Buffer.from([2])]));
  const replaced = await inventoryCheckpoints(project, { status: "completed", checkpoints: original }, weights);
  assert.equal(replaced[0].sha256, original[0].sha256);
  assert.equal(replaced[0].available, false);
  await rm(file);
  const missing = await inventoryCheckpoints(project, { status: "completed", checkpoints: original }, weights);
  assert.deepEqual(missing[0], { ...original[0], available: false });
});
