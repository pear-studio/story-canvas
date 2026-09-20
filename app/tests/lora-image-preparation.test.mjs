import { datasetRoot } from "../server/lora-training-support.mjs";
import { createLoraTrainingDataset } from "./training-project-fixture.mjs";
import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { preparationDecision, trainingImageTarget } from "../server/lora-image-preparation-contract.mjs";
import { prepareTrainingImage } from "../server/lora-image-preparation.mjs";
import { prepareLoraTrainingDataset, restoreLoraTrainingOriginal, previewLoraTrainingPostprocess, applyLoraTrainingPostprocess } from "../server/lora-training-media.mjs";
import {  importLoraTrainingAssets, updateLoraTrainingDataset, readLoraTrainingDataset, createLoraTrainingTask } from "../server/lora-training-facts.mjs";
import { preflightLoraTraining, createLoraTrainingDatasetToml } from "../server/lora-training-plan.mjs";

const png = (width, height, color = "#4678ab") => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const model = { ready: true, sha256: "b".repeat(64) };
function scorer(values) {
  let calls = 0;
  let closed = 0;
  return { quality: model, upscaler: model,
    createSession: () => ({ score: async () => values[calls++], close: () => closed++ }),
    upscale: async buffer => sharp(buffer).negate().png().toBuffer(),
    get calls() { return calls; }, get closed() { return closed; },
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lora-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await createLoraTrainingDataset(root, { name: "准备训练图" });
  const imported = await importLoraTrainingAssets(root, created.id, { group_id: created.dataset.groups[0].id,
    files: [{ filename: "large.png", buffer: await png(1800, 1200), caption: "standing" },
      { filename: "small.png", buffer: await png(300, 400, "#884466"), caption: "sitting" }] });
  registerFixtureProjects(root); return { root, id: created.id, imported };
}

test("固定 1024 桶保持横竖比例，尺寸均为 64 倍数", () => {
  assert.deepEqual(trainingImageTarget(3840, 2160), { width: 1024, height: 576 });
  assert.deepEqual(trainingImageTarget(600, 800), { width: 768, height: 1024 });
  assert.deepEqual(trainingImageTarget(2273, 2160), { width: 1024, height: 960 });
  for (const [w, h] of [[1024, 576], [768, 1024], [1024, 1024]]) assert.deepEqual(trainingImageTarget(w, h), { width: w, height: h });
  assert.equal(preparationDecision(60, null), "already_good");
  assert.equal(preparationDecision(59, 61), "enhanced");
  assert.equal(preparationDecision(59, 60.99), "no_gain");
  assert.equal(preparationDecision(59, 42), "no_gain");
  assert.throws(() => preparationDecision(59, null));
});

test("高分图不调用超分；大小图顺序不同，前后评分尺寸相同", async () => {
  const high = await prepareTrainingImage(await png(2000, 1500), { score: async () => 60,
    upscale: () => assert.fail("高分应跳过超分") });
  assert.equal(high.enhanced, null);
  assert.equal(high.decision, "already_good");
  for (const [w, h, expectedInput] of [[2000, 1500, [1024, 768]], [300, 400, [300, 400]]]) {
    const seen = [];
    const result = await prepareTrainingImage(await png(w, h), {
      score: async buffer => { const info = await sharp(buffer).metadata(); seen.push([info.width, info.height]); return seen.length === 1 ? 50 : 53; },
      upscale: async buffer => {
        const info = await sharp(buffer).metadata();
        assert.deepEqual([info.width, info.height], expectedInput);
        return sharp(buffer).resize(info.width * 4, info.height * 4).png().toBuffer();
      },
    });
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(result.decision, "enhanced");
  }
});

test("批量准备保存两次评分，复用不重复推理，恢复和裁剪清除准备状态", async t => {
  const { root, id, imported } = await fixture(t);
  const dependencies = scorer([70, 40, 41]);
  const result = await prepareLoraTrainingDataset(root, root, id, {}, dependencies);
  assert.equal(result.prepared, 2);
  assert.equal(result.already_good, 1);
  assert.equal(result.no_gain, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(dependencies.closed, 1);
  const small = result.dataset.items[1];
  assert.equal(small.preparation.after_score, 41);
  assert.equal(path.basename(small.file), small.preparation.baseline_file);
  assert.equal(small.image_width, 768);
  assert.equal(small.image_height, 1024);
  const current = path.join(datasetRoot(root, id), small.file);
  assert.equal((await sharp(await readFile(current)).stats()).channels[0].mean, 136);
  const second = await prepareLoraTrainingDataset(root, root, id, {}, dependencies);
  assert.equal(second.reused, 2);
  assert.equal(dependencies.calls, 3);
  const restored = await restoreLoraTrainingOriginal(root, id, small.id);
  assert.equal(restored.items[1].preparation, undefined);
  assert.equal(restored.items[1].image_version, imported.items[1].image_version);
  const request = { item_id: result.dataset.items[0].id, crop: { x: 0, y: 0, width: 0.5, height: 1 }, upscale: false };
  const preview = await previewLoraTrainingPostprocess(root, root, id, request, {});
  const changed = await applyLoraTrainingPostprocess(root, root, id, { ...request, preview_id: preview.preview_id });
  assert.equal(changed.items[0].preparation, undefined);
  const repeated = await prepareLoraTrainingDataset(root, root, id, {}, scorer([70, 70]));
  assert.deepEqual(repeated.dataset.items[0].preparation.target, { width: 768, height: 1024 });
});

test("采用增强结果；禁用项跳过；失败项保留素材及 Caption", async t => {
  const { root, id, imported } = await fixture(t);
  const saved = structuredClone(imported.dataset);
  saved.items[1].enabled = false;
  await updateLoraTrainingDataset(root, id, saved);
  const result = await prepareLoraTrainingDataset(root, root, id, {}, scorer([40, 50]));
  assert.equal(result.total, 1);
  assert.equal(result.enhanced, 1);
  assert.equal(path.basename(result.dataset.items[0].file), result.dataset.items[0].preparation.enhanced_file);
  assert.equal(result.dataset.items[1].preparation, undefined);
  await restoreLoraTrainingOriginal(root, id, result.dataset.items[0].id);
  const failed = await prepareLoraTrainingDataset(root, root, id, {}, { ...scorer([40]), upscale: async () => { throw new Error("测试超分失败"); } });
  assert.equal(failed.failed.length, 1);
  const current = await readLoraTrainingDataset(root, id);
  assert.equal(current.items[0].image_version, imported.items[0].image_version);
  assert.equal(current.items[0].caption, "standing");
  assert.equal(current.items[0].preparation, undefined);
  assert.equal(current.items[0].preparation_error, "测试超分失败");
  const retried = await prepareLoraTrainingDataset(root, root, id, {}, { ...scorer([70, 70]), itemIds: current.items.map(item => item.id) });
  assert.equal(retried.prepared, 2, "导入及重试指定项时包含禁用素材");
  assert.equal(retried.dataset.items[0].preparation_error, undefined);
  saved.groups[0].enabled = false;
  await updateLoraTrainingDataset(root, id, saved);
  const skipped = await prepareLoraTrainingDataset(root, root, id, {}, { ...scorer([]), createSession: () => assert.fail("禁用分组不评分") });
  assert.equal(skipped.total, 0);
});

test("训练预检要求准备完成，训练桶禁止二次放大", async t => {
  const { root, id } = await fixture(t);
  const recipeDir = path.join(root, "library/lora-training/recipes");
  await mkdir(recipeDir, { recursive: true });
  await copyFile(new URL("../../library/lora-training/recipes/anima-character-r32-v1.json", import.meta.url), path.join(recipeDir, "anima-character-r32-v1.json"));
  const task = await createLoraTrainingTask(root, root, { name: "准备检查", dataset_id: id });
  const before = await preflightLoraTraining(root, root, task.id, {}, { skipEnvironment: true });
  assert.equal(before.blockers.filter(b => b.code === "training_image_unprepared").length, 2);
  await prepareLoraTrainingDataset(root, root, id, {}, scorer([70, 70]));
  const after = await preflightLoraTraining(root, root, task.id, {}, { skipEnvironment: true });
  assert.equal(after.blockers.some(b => b.code === "training_image_unprepared"), false);
  const toml = createLoraTrainingDatasetToml(root, [], [], { resolution: 1024, train_batch_size: 1 });
  assert.match(toml, /bucket_no_upscale = true/);
  assert.match(toml, /bucket_reso_steps = 64/);
});
