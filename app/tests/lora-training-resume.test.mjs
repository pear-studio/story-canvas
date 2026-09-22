import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { createLoraTrainingOperations } from "../server/lora-training-operations.mjs";
import { handleLoraTrainingRequest } from "../server/lora-training-http.mjs";
import { readJsonBody, readOptionalJsonBody, sendJson } from "../server/http-support.mjs";
import { createLoraTrainingDataset, createLoraTrainingTask, importLoraTrainingAssets } from "../server/lora-training-facts.mjs";
import { preflightLoraTraining, snapshotRun, freezeLoraTrainingResumeRun, prepareLoraTrainingGpu } from "../server/lora-training-plan.mjs";
import { updateRunStatus } from "../server/lora-training-runtime.mjs";
import { readLoraTrainingRunSettings } from "../server/lora-training-plan.mjs";
import { generatedRunRoot } from "../server/lora-training-support.mjs";
import { registerFixtureProjects } from "./project-registry-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lora-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "app", "python"), { recursive: true });
  await writeFile(path.join(root, "app", "python", "qwen-image21-lora-runner.py"), "# 测试占位 runner\n");
  await cp(new URL("../../library/lora-training", import.meta.url), path.join(root, "library", "lora-training"), { recursive: true });
  registerFixtureProjects(root);
  return { root };
}

async function imageBuffer() {
  return sharp({ create: { width: 640, height: 768, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
}

test("训练启动只释放空闲 ComfyUI 模型，有排队任务时拒绝卸载", async t => {
  let busy = true, releases = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/queue') res.end(JSON.stringify({queue_running: busy ? [[1]] : [], queue_pending: []}));
    else if (req.url === '/free') { releases++; res.end('{}'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = {comfyui_urls: [`http://127.0.0.1:${server.address().port}`]};
  await assert.rejects(prepareLoraTrainingGpu(config), {code:'comfyui_busy'});
  assert.equal(releases, 0);
  busy = false;
  await prepareLoraTrainingGpu(config);
  assert.equal(releases, 1);
});

// 完成一次冻结，并把父 run 标记为已完成且带有 step-000500 完整恢复包。
async function completedParentRun(root, { steps = 2000 } = {}) {
  const modelsRoot = path.join(root, "models");
  const dataset = await createLoraTrainingDataset(root, { name: "续训素材" });
  const task = await createLoraTrainingTask(root, root, { name: "续训任务", dataset_id: dataset.id });
  await importLoraTrainingAssets(root, dataset.id, { group_id: dataset.dataset.groups[0].id, files: [{ filename: "look.png", buffer: await imageBuffer(), caption: "standing" }] });
  const settings = await readLoraTrainingRunSettings(root, root, task.id, {}, { skipEnvironment: true });
  const preflight = await preflightLoraTraining(root, root, task.id, {}, { skipEnvironment: true, runSettings: settings.values });
  preflight.environment = { trainer_root: root, python: "python", commit: "c".repeat(40), runtime: { python: "3.11.14", torch: "2.13.0", gpu: "test", vram_bytes: 24 * 1024 ** 3 } };
  const modelFiles = [];
  for (const kind of ["dit", "text_encoder", "vae", "processor"]) {
    const content = Buffer.from(`model-${kind}`);
    const relative = `models/${kind}.safetensors`;
    await mkdir(path.join(modelsRoot, "models"), { recursive: true });
    await writeFile(path.join(modelsRoot, relative), content);
    modelFiles.push({ kind, relative_path: relative, content });
  }
  preflight.models = modelFiles.map((file) => ({ kind: file.kind, label: file.kind, identity: { relative_path: file.relative_path, source: null }, path: path.join(modelsRoot, file.relative_path), exists: true, sha256: createHash("sha256").update(file.content).digest("hex"), size: file.content.length, matches: true }));
  const frozen = await snapshotRun(root, root, task.id, { models_root: modelsRoot }, preflight);
  const archive = generatedRunRoot(root, task.id, frozen.runId);
  const snapshotDirectory = path.join(archive, "resume", "step-000500");
  await mkdir(snapshotDirectory, { recursive: true });
  for (const name of ["lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json"]) await writeFile(path.join(snapshotDirectory, name), name);
  const state = JSON.stringify({ step: 500, files: Object.fromEntries(["lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json"].map(name => [name, createHash("sha256").update(name).digest("hex")])) });
  await writeFile(path.join(snapshotDirectory, "state.json"), state);
  const pointer = { snapshot_id: "step-000500", step: 500, sha256: createHash("sha256").update(state).digest("hex") };
  await writeFile(path.join(archive, "resume", "latest.json"), JSON.stringify(pointer));
  await updateRunStatus(frozen.runDirectory, { status: "completed", completed_at: new Date().toISOString() });
  return { task, parent: frozen, pointer, modelsRoot };
}

function fakeEnvironment(parentManifest) {
  return {
    available: true,
    commit: parentManifest.trainer.diffsynth_commit,
    python: "python",
    runtime: { python: "3.11.14", torch: "2.13.0", gpu: "test", vram_bytes: 24 * 1024 ** 3 },
    runner: { sha256: parentManifest.trainer.runner.sha256 },
  };
}

test("Node 冻结 → 真实 Python toy runner → Node 续训冻结 → Python 恢复", async (t) => {
  const local = JSON.parse(await readFile(new URL("../../Config/local.json", import.meta.url), "utf8").catch(() => "{}"));
  const python = local.lora_training?.diffsynth?.python ?? "python";
  if (spawnSync(python, ["-c", "import torch, safetensors"], { windowsHide: true }).status !== 0) return t.skip("缺少测试 Python");
  const { root } = await fixture(t);
  const { task, parent, modelsRoot } = await completedParentRun(root);
  const manifest = parent.manifest;
  const runner = new URL("../python/qwen-image21-lora-runner.py", import.meta.url);
  const runnerPath = (await import("node:url")).fileURLToPath(runner);
  manifest.trainer.runner.sha256 = createHash("sha256").update(await readFile(runner)).digest("hex");
  manifest.run.max_train_steps = 2;
  manifest.run.save_every_n_steps = 2;
  manifest.semantic_config.gradient_accumulation_steps = 4;
  await writeFile(path.join(manifest.paths.archive_dir, "manifest.json"), JSON.stringify(manifest));
  const execute = (value) => {
    for (const phase of ["cache", "train"]) {
      const result = spawnSync(python, [runnerPath, "--manifest", path.join(value.paths.archive_dir, "manifest.json"), "--phase", phase, "--backend", "toy"], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, 0, result.stderr);
    }
  };
  execute(manifest);
  const pointer = JSON.parse(await readFile(path.join(manifest.paths.resume_dir, "latest.json"), "utf8"));
  const resumed = await freezeLoraTrainingResumeRun(root, root, task.id, parent.runId, { models_root: modelsRoot }, { max_train_steps: 4, source_snapshot_id: pointer.snapshot_id, source_sha256: pointer.sha256 }, { environment: fakeEnvironment(manifest) });
  execute(resumed.manifest);
  const events = (await readFile(resumed.manifest.paths.events_file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter(e => e.event === "optimizer_step").map(e => [e.step, e.samples_seen]), [[3, 12], [4, 16]]);
});

test("续训冻结沿用父 run 全部冻结语义并归档自身输入", async (t) => {
  const { root } = await fixture(t);
  const { task, parent, pointer, modelsRoot } = await completedParentRun(root);
  const resumed = await freezeLoraTrainingResumeRun(root, root, task.id, parent.runId, { models_root: modelsRoot }, {
    max_train_steps: 1000,
    note: "追加 500 次更新",
    source_snapshot_id: pointer.snapshot_id,
    source_sha256: pointer.sha256,
  }, { environment: fakeEnvironment(parent.manifest) });
  const manifest = resumed.manifest;
  assert.equal(manifest.version, 5);
  assert.notEqual(manifest.id, parent.runId);
  assert.deepEqual(manifest.resume, { parent_run_id: parent.runId, source_snapshot_id: "step-000500", source_sha256: pointer.sha256, start_step: 500 });
  assert.equal(manifest.run.max_train_steps, 1000);
  assert.equal(manifest.run.save_every_n_steps, parent.manifest.run.save_every_n_steps);
  assert.equal(manifest.run.seed, parent.manifest.run.seed);
  assert.equal(manifest.run.note, "追加 500 次更新");
  assert.deepEqual(manifest.semantic_config, parent.manifest.semantic_config);
  assert.deepEqual(manifest.sampling, parent.manifest.sampling);
  assert.deepEqual(manifest.items, parent.manifest.items);
  assert.deepEqual(manifest.models, parent.manifest.models);
  const parentItem = parent.manifest.items[0];
  assert.ok(await readFile(path.join(manifest.paths.inputs_dir, parentItem.image_file)), "新 run 归档自己的输入副本");
  assert.ok(await readFile(path.join(manifest.paths.resume_dir, pointer.snapshot_id, "optimizer.pt")), "新 run 自包含恢复包");
  const parentManifestAfter = JSON.parse(await readFile(path.join(generatedRunRoot(root, task.id, parent.runId), "manifest.json"), "utf8"));
  assert.equal(parentManifestAfter.run.max_train_steps, parent.manifest.run.max_train_steps, "不改写父 run manifest");
});

test("续训拒绝陈旧来源、不更大目标与 v4 历史 run", async (t) => {
  const { root } = await fixture(t);
  const { task, parent, pointer, modelsRoot } = await completedParentRun(root);
  const environment = fakeEnvironment(parent.manifest);
  await assert.rejects(
    freezeLoraTrainingResumeRun(root, root, task.id, parent.runId, { models_root: modelsRoot }, { max_train_steps: 1000, source_snapshot_id: pointer.snapshot_id, source_sha256: "0".repeat(64) }, { environment }),
    (error) => error.status === 409 && error.code === "lora_training_resume_source_stale",
  );
  await assert.rejects(
    freezeLoraTrainingResumeRun(root, root, task.id, parent.runId, { models_root: modelsRoot }, { max_train_steps: 500, source_snapshot_id: pointer.snapshot_id, source_sha256: pointer.sha256 }, { environment }),
    (error) => error.status === 422 && error.code === "lora_training_resume_target_not_advanced",
  );
  // 指针被更新后旧快照立即陈旧。
  await writeFile(path.join(generatedRunRoot(root, task.id, parent.runId), "resume", "latest.json"), JSON.stringify({ snapshot_id: "step-001000", step: 1000, sha256: "1".repeat(64) }));
  await assert.rejects(
    freezeLoraTrainingResumeRun(root, root, task.id, parent.runId, { models_root: modelsRoot }, { max_train_steps: 1000, source_snapshot_id: pointer.snapshot_id, source_sha256: pointer.sha256 }, { environment }),
    (error) => error.code === "lora_training_resume_source_stale",
  );

  const v4Archive = generatedRunRoot(root, task.id, "run-aaaaaaaaaaaa");
  await mkdir(v4Archive, { recursive: true });
  await writeFile(path.join(v4Archive, "manifest.json"), JSON.stringify({ version: 4, id: "run-aaaaaaaaaaaa", task_id: task.id, family: "anima" }));
  await assert.rejects(
    freezeLoraTrainingResumeRun(root, root, task.id, "run-aaaaaaaaaaaa", { models_root: modelsRoot }, { max_train_steps: 1000, source_snapshot_id: "step-000500", source_sha256: "2".repeat(64) }, { environment }),
    (error) => error.status === 409 && error.code === "lora_training_resume_unsupported",
  );
});

test("续训端点在串行队列内校验来源，陈旧来源返回 409", async (t) => {
  const { root } = await fixture(t);
  const { task, parent, pointer } = await completedParentRun(root);
  const operations = createLoraTrainingOperations(root);
  const server = createServer(async (request, response) => {
    try {
      if (!await handleLoraTrainingRequest({ request, response, decodedPath: new URL(request.url, "http://localhost").pathname, resolvedProjectRoot: root, config: {}, trainingOperations: operations, readJsonBody, readOptionalJsonBody })) sendJson(response, 404, { error: "not_found" });
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.code ?? error.message }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const current = await fetch(`${origin}/api/lora-training/tasks/${task.id}`);
  const revision = current.headers.get("etag");
  const resume = (body) => fetch(`${origin}/api/lora-training/tasks/${task.id}/runs/${parent.runId}/resume`, { method: "POST", headers: { "content-type": "application/json", "if-match": revision }, body: JSON.stringify(body) });

  const stale = await resume({ max_train_steps: 1000, source_snapshot_id: pointer.snapshot_id, source_sha256: "0".repeat(64) });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "lora_training_resume_source_stale" });

  const notAdvanced = await resume({ max_train_steps: 500, source_snapshot_id: pointer.snapshot_id, source_sha256: pointer.sha256 });
  assert.equal(notAdvanced.status, 422);
  assert.deepEqual(await notAdvanced.json(), { error: "lora_training_resume_target_not_advanced" });

  // 无活动 run 且来源新鲜时进入环境校验；测试环境无 DiffSynth，明确阻断而不是默默启动。
  const blocked = await resume({ max_train_steps: 1000, source_snapshot_id: pointer.snapshot_id, source_sha256: pointer.sha256 });
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "training_environment_unavailable" });
});
