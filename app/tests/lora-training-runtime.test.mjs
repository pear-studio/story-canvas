import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerProject } from "../server/project-registry.mjs";
import { executeLoraTrainingManifest, stopLoraTrainingRun, readLoraTrainingRun } from "../server/lora-training-runtime.mjs";
import { readJson } from "../server/lora-training-support.mjs";

// 假 runner：按 v:1 JSONL 事件协议驱动 cache/train 两阶段，不冒充 GPU 实测。
const fakeRunnerSource = `
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const argv = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(argv[argv.indexOf("--manifest") + 1], "utf8"));
const phase = argv[argv.indexOf("--phase") + 1];
const emit = (event) => fs.appendFileSync(manifest.paths.events_file, JSON.stringify({ v: 1, time: new Date().toISOString(), ...event }) + "\\n");
const safetensors = (payload) => {
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: "U8", shape: [payload.length], data_offsets: [0, payload.length] } }));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, payload]);
};
console.log("runner " + phase + " 开始");
emit({ event: "phase", phase, status: "begin" });
if (phase === "cache") {
  manifest.items.forEach((item, index) => emit({ event: "cache_progress", done: index + 1, total: manifest.items.length }));
  fs.mkdirSync(manifest.paths.cache_dir, { recursive: true });
  fs.writeFileSync(path.join(manifest.paths.cache_dir, "cache-manifest.json"), JSON.stringify({ items: manifest.items.length }));
  emit({ event: "phase", phase, status: "end" });
  process.exit(0);
}
const target = manifest.run.max_train_steps;
const start = manifest.resume?.start_step ?? 0;
let step = start;
const publish = (current) => {
  const file = "step-" + String(current).padStart(6, "0") + ".safetensors";
  const payload = safetensors(Buffer.from("lora-" + current));
  fs.mkdirSync(manifest.paths.checkpoints_dir, { recursive: true });
  fs.writeFileSync(path.join(manifest.paths.checkpoints_dir, file), payload);
  emit({ event: "checkpoint", step: current, file, sha256: createHash("sha256").update(payload).digest("hex"), size_bytes: payload.length });
  const snapshotId = "step-" + String(current).padStart(6, "0");
  const directory = path.join(manifest.paths.resume_dir, snapshotId);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json"]) fs.writeFileSync(path.join(directory, name), name);
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ step: current }));
  const pointer = { snapshot_id: snapshotId, step: current, sha256: createHash("sha256").update(fs.readFileSync(path.join(directory, "state.json"))).digest("hex") };
  fs.writeFileSync(path.join(manifest.paths.resume_dir, "latest.json"), JSON.stringify(pointer));
  emit({ event: "resume_saved", snapshot_id: snapshotId, step: current, sha256: pointer.sha256 });
};
const tick = () => {
  const stopped = fs.existsSync(path.join(manifest.paths.control_dir, "stop.json"));
  if (stopped) {
    if (step > start) publish(step);
    emit({ event: "end", status: "stopped" });
    process.exit(0);
  }
  step += 1;
  emit({ event: "optimizer_step", step, target, loss: 1 / step, lr: 0.0001, samples_seen: step, seconds: 0.01 });
  if (step % manifest.run.save_every_n_steps === 0 || step === target) publish(step);
  if (step >= target) {
    emit({ event: "phase", phase: "train", status: "end" });
    emit({ event: "end", status: "completed", performance: { torch_peak_bytes: 1024 } });
    process.exit(0);
  }
  setTimeout(tick, 5);
};
tick();
`;

function buildRun(root, projectPath, taskId, runId, { steps = 3, saveEvery = 1, resume = null } = {}) {
  const archive = path.join(projectPath, "Training", taskId, runId);
  const runtime = path.join(projectPath, "Saved", "Training", taskId, runId);
  const modelsRoot = path.join(root, "models");
  const manifest = {
    version: 5,
    id: runId,
    task_id: taskId,
    dataset_id: taskId,
    created_at: new Date().toISOString(),
    task_name: "运行时测试",
    dataset_name: "运行时素材",
    family: "qwen-image-2-1",
    prompt_family: "qwen",
    usage_defaults: { clip_skip: null, sampler: "euler", scheduler: "simple", steps: 25, cfg: 1 },
    description: "",
    activation_terms: [],
    items: [{
      item_id: "item-444444444444",
      asset_id: "asset-444444444444",
      group_id: "group-555555555555",
      source_file: "assets/asset-444444444444/original.png",
      image_file: "inputs/item-444444444444.png",
      caption_file: "inputs/item-444444444444.txt",
      image_sha256: "1".repeat(64),
      caption_sha256: "2".repeat(64),
    }],
    groups: [{ id: "group-555555555555", name: "主体", enabled: true, repeats: 1 }],
    models: [
      { kind: "dit", relative_path: "diffusion_models/qwen-image-2.1/dit.safetensors", sha256: "3".repeat(64), size_bytes: 1, source: null },
      { kind: "text_encoder", relative_path: "text_encoders/qwen-image-2.1/te.safetensors", sha256: "4".repeat(64), size_bytes: 1, source: null },
      { kind: "vae", relative_path: "vae/qwen-image-2.1/vae.safetensors", sha256: "5".repeat(64), size_bytes: 1, source: null },
      { kind: "processor", relative_path: "text_encoders/qwen-image-2.1/processor/tokenizer.json", sha256: "6".repeat(64), size_bytes: 1, source: null },
    ],
    trainer: { diffsynth_commit: "c".repeat(40), python: "3.11.14", torch: "2.13.0", gpu: null, vram_bytes: 0, runner: { name: "qwen-image21-lora-runner", version: 1, sha256: "7".repeat(64) } },
    recipe: { id: "qwen-image21-lora-v1", version: 1, sha256: "8".repeat(64), overrides: { network_dim: 32, learning_rate: 0.0001, gradient_accumulation_steps: 1 } },
    semantic_config: {
      max_pixels: 1048576, network_dim: 32, network_alpha: 32, learning_rate: 0.0001, gradient_accumulation_steps: 1, micro_batch_size: 1,
      optimizer: { type: "AdamW", betas: [0.9, 0.999], eps: 1e-8, weight_decay: 0.01 },
      scheduler: { type: "ConstantLR", factor: 0.3333333333333333, total_iters: 5 },
      precision: { base: "bf16", lora: "bf16", optimizer_state: "bf16" },
      gradient_checkpointing: true,
      lora_target_modules: ["transformer_blocks.0.attn.to_q"],
    },
    run: { max_train_steps: steps, save_every_n_steps: saveEvery, seed: 42 },
    sampling: { weights: [{ item_id: "item-444444444444", weight: 1 }] },
    resume,
    paths: {
      inputs_dir: path.join(archive, "inputs"),
      cache_dir: path.join(runtime, "cache"),
      control_dir: path.join(runtime, "control"),
      archive_dir: archive,
      resume_dir: path.join(archive, "resume"),
      events_file: path.join(runtime, "events.jsonl"),
      log_file: path.join(runtime, "console.log"),
      checkpoints_dir: path.join(modelsRoot, "loras", "training", taskId, runId),
      checkpoints_relative_path: path.posix.join("loras", "training", taskId, runId),
      models_root: modelsRoot,
    },
    execution: { executable: process.execPath, argv: [path.join(root, "fake-qwen-runner.mjs"), "--manifest", path.join(archive, "manifest.json")] },
    seed: 42,
  };
  return { manifest, archive, runtime, modelsRoot };
}

async function setupRun(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lora-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "dataset-111111111111";
  const runId = "run-999999999999";
  const projectPath = path.join(root, "training-project");
  await mkdir(projectPath, { recursive: true });
  registerProject(root, { id: taskId, type: "training", path: projectPath });
  await writeFile(path.join(root, "fake-qwen-runner.mjs"), fakeRunnerSource);
  const { manifest, archive, runtime, modelsRoot } = buildRun(root, projectPath, taskId, runId, options);
  manifest.trainer.runner.sha256 = createHash("sha256").update(fakeRunnerSource).digest("hex");
  await mkdir(path.join(archive, "inputs"), { recursive: true });
  await mkdir(path.join(archive, "resume"), { recursive: true });
  await mkdir(path.join(runtime, "cache"), { recursive: true });
  await mkdir(path.join(runtime, "control"), { recursive: true });
  await mkdir(manifest.paths.checkpoints_dir, { recursive: true });
  await writeFile(path.join(archive, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(runtime, "manifest.json"), JSON.stringify(manifest));
  const status = { version: 1, status: "starting", phase: null, step: 0, loss: null, lr: null, samples_seen: 0, eta_seconds: null, pid: null, process_started_at: null, exit_code: null, error: null, checkpoints: [], updated_at: new Date().toISOString() };
  await writeFile(path.join(runtime, "status.json"), JSON.stringify(status));
  await writeFile(path.join(archive, "result.json"), JSON.stringify(status));
  return { root, taskId, runId, manifest, archive, runtime, modelsRoot };
}

async function waitTerminal(runtime, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const status = await readJson(path.join(runtime, "status.json"));
    if (["completed", "interrupted", "failed"].includes(status.status)) return status;
    if (Date.now() - started > timeoutMs) assert.fail(`run 未在 ${timeoutMs}ms 内到达终态`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("假 runner 两阶段完成：事件进度、checkpoint 盘点、恢复包清理与终态归档", async (t) => {
  const { root, taskId, runId, manifest, archive, runtime, modelsRoot } = await setupRun(t, { steps: 3, saveEvery: 1 });
  // 同 run 的旧恢复包与续训父 run 的来源包都应在新包发布后被清理。
  const staleSameRun = path.join(archive, "resume", "step-000000");
  await mkdir(staleSameRun, { recursive: true });
  await writeFile(path.join(staleSameRun, "state.json"), JSON.stringify({ step: 0 }));
  const parentArchive = path.join(path.dirname(archive), "run-000000000000");
  const parentSnapshot = path.join(parentArchive, "resume", "step-000001");
  await mkdir(parentSnapshot, { recursive: true });
  await writeFile(path.join(parentSnapshot, "state.json"), JSON.stringify({ step: 1 }));
  manifest.resume = { parent_run_id: "run-000000000000", source_snapshot_id: "step-000001", source_sha256: "f".repeat(64), start_step: 0 };
  await writeFile(path.join(parentArchive, "resume", "latest.json"), JSON.stringify({ snapshot_id: "step-000001", step: 1, sha256: "f".repeat(64) }));
  await writeFile(path.join(archive, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(runtime, "manifest.json"), JSON.stringify(manifest));

  const started = await executeLoraTrainingManifest(root, manifest);
  assert.equal(started.status, "running");
  const status = await waitTerminal(runtime);
  assert.equal(status.status, "completed");
  assert.equal(status.phase, "train");
  assert.equal(status.step, 3);
  assert.equal(status.samples_seen, 3);
  assert.ok(Math.abs(status.loss - 1 / 3) < 1e-9);
  assert.deepEqual(status.loss_history, [{ step: 1, loss: 1 }, { step: 2, loss: 0.5 }, { step: 3, loss: 1 / 3 }]);
  assert.equal(status.checkpoints.length, 3);
  assert.deepEqual(status.checkpoints.map(c => c.step), [1, 2, 3]);
  assert.equal(status.checkpoints[2].file, "step-000003.safetensors");
  assert.ok(status.checkpoints[2].relative_path.startsWith("loras/training/"));
  assert.ok(status.performance.wall_seconds >= 0);
  assert.equal(status.performance.runner.torch_peak_bytes, 1024);
  assert.match(await readFile(path.join(runtime, "console.log"), "utf8"), /runner cache 开始/);
  assert.match(await readFile(path.join(runtime, "console.log"), "utf8"), /runner train 开始/);
  // 旧恢复包已清理，最新包保留。
  assert.deepEqual((await readJson(path.join(archive, "resume", "latest.json"))).snapshot_id, "step-000003");
  assert.ok(await readFile(path.join(archive, "resume", "step-000003", "state.json")), "批量读取旧事件不能删掉最新恢复包");
  await assert.rejects(readFile(path.join(staleSameRun, "state.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(parentSnapshot, "state.json")), { code: "ENOENT" });
  const archived = await readJson(path.join(archive, "result.json"));
  assert.equal(archived.status, "completed");
  assert.equal(archived.step, 3);
  const detail = await readLoraTrainingRun(root, taskId, runId);
  assert.equal(detail.status.status, "completed");
  assert.equal(detail.legacy, undefined);
  assert.ok(await readFile(path.join(modelsRoot, "loras", "training", taskId, runId, "step-000003.safetensors")));
});

test("停止写控制文件，runner 在更新边界保存后退出，run 标记为中断", async (t) => {
  const { root, taskId, runId, manifest, archive, runtime } = await setupRun(t, { steps: 1000, saveEvery: 100 });
  await executeLoraTrainingManifest(root, manifest);
  for (let i = 0; i < 200; i++) {
    const status = await readJson(path.join(runtime, "status.json"));
    if (status.step >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stop = await stopLoraTrainingRun(root, taskId, runId, { gracefulTimeoutMs: 5000 });
  assert.equal(stop.stopping, true);
  const status = await waitTerminal(runtime);
  assert.equal(status.status, "interrupted");
  assert.ok(status.step >= 1);
  assert.ok(status.resume, "停止边界保存了新的恢复点");
  assert.equal((await readJson(path.join(archive, "resume", "latest.json"))).snapshot_id, status.resume.snapshot_id);
});
