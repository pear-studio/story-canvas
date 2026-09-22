// qwen-image21-lora-runner 冒烟：toy backend 两阶段真实子进程，断言事件序列与产物。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");
const runnerPath = path.join(appRoot, "python", "qwen-image21-lora-runner.py");
const testRoot = path.join(repoRoot, "Saved", "Tests", "lora-training-runner");

function findPython() {
  const candidates = [];
  try {
    const local = JSON.parse(readFileSync(path.join(repoRoot, "Config", "local.json"), "utf8"));
    if (local.lora_training?.diffsynth?.python) candidates.push(local.lora_training.diffsynth.python);
  } catch { /* 无本机配置时回退 PATH */ }
  candidates.push("python");
  for (const command of candidates) {
    const probe = spawnSync(command, ["-c", "import torch"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0) return command;
  }
  return null;
}

const python = findPython();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function buildManifest(root) {
  const inputs = path.join(root, "inputs");
  mkdirSync(inputs, { recursive: true });
  const weights = { "item-a": 2, "item-b": 1, "item-c": 2, "item-d": 1 };
  const items = Object.keys(weights).map((itemId, index) => {
    const image = Buffer.from(`fake-image-bytes-${itemId}`);
    const caption = `caption of ${itemId}, 中文标签`;
    writeFileSync(path.join(inputs, `${itemId}.png`), image);
    writeFileSync(path.join(inputs, `${itemId}.txt`), caption, "utf8");
    return {
      item_id: itemId, asset_id: `asset-${index}`, group_id: "g1",
      source_file: `assets/${itemId}.png`, image_file: `${itemId}.png`, caption_file: `${itemId}.txt`,
      image_sha256: sha256(image), caption_sha256: sha256(Buffer.from(caption, "utf8")),
    };
  });
  return {
    version: 5, id: "run-smoke", task_id: "task-smoke", dataset_id: "ds-smoke",
    created_at: "2026-01-01T00:00:00Z", task_name: "t", dataset_name: "d",
    family: "qwen-image-2-1", items, groups: [], models: [],
    trainer: { diffsynth_commit: "toy-commit", python: "", torch: "",
               runner: { name: "qwen-image21-lora-runner", version: 1, sha256: "" } },
    recipe: { id: "qwen-image21-lora-v1", version: 1, sha256: "", overrides: {} },
    semantic_config: {
      max_pixels: 1048576, network_dim: 32, learning_rate: 1e-4, gradient_accumulation_steps: 2,
      optimizer: { type: "AdamW", betas: [0.9, 0.999], eps: 1e-8, weight_decay: 0.01 },
      scheduler: { type: "ConstantLR", factor: 1 / 3, total_iters: 5 },
      precision: { base: "bf16", lora: "bf16", optimizer_state: "bf16" },
      gradient_checkpointing: true, network_alpha: 32,
      lora_target_modules: ["transformer_blocks.0.attn.to_q"],
    },
    run: { max_train_steps: 6, save_every_n_steps: 2, seed: 42, note: "" },
    sampling: { weights: Object.entries(weights).map(([item_id, weight]) => ({ item_id, weight })) },
    resume: null,
    paths: {
      inputs_dir: inputs, cache_dir: path.join(root, "cache"), control_dir: path.join(root, "control"),
      archive_dir: root, resume_dir: path.join(root, "resume"), events_file: path.join(root, "events.jsonl"),
      log_file: path.join(root, "log.txt"), checkpoints_dir: path.join(root, "checkpoints"),
      checkpoints_relative_path: "checkpoints",
    },
    seed: 42,
  };
}

test("toy backend 两阶段冒烟：事件序列、checkpoint、resume 指针", { skip: !python && "未找到可用 python（Config/local.json lora_training.diffsynth.python 或 PATH，且需可 import torch）" }, (t) => {
  const root = path.join(testRoot, `smoke-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = buildManifest(root);
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  for (const phase of ["cache", "train"]) {
    const result = spawnSync(python, [runnerPath, "--manifest", manifestPath, "--phase", phase, "--backend", "toy"],
      { encoding: "utf8", windowsHide: true, timeout: 120000 });
    assert.equal(result.status, 0, `${phase} 阶段退出码非 0：${result.stderr || result.stdout}`);
  }

  const events = readFileSync(path.join(root, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  for (const event of events) assert.equal(event.v, 1);
  assert.deepEqual(events[0], { ...events[0], v: 1, event: "phase", phase: "cache", status: "begin", total: 4 });
  const progress = events.filter((e) => e.event === "cache_progress");
  assert.equal(progress.length, 4);
  assert.deepEqual(progress.map((e) => e.done), [1, 2, 3, 4]);
  assert.equal(progress.reduce((n, e) => n + (e.skipped ? 1 : 0), 0), 0);
  const steps = events.filter((e) => e.event === "optimizer_step");
  assert.deepEqual(steps.map((e) => e.step), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(steps.map((e) => e.samples_seen), [2, 4, 6, 8, 10, 12]);
  for (const e of steps) {
    assert.equal(e.target, 6);
    assert.ok(Number.isFinite(e.loss) && Number.isFinite(e.lr) && e.seconds >= 0);
  }
  assert.deepEqual(events.filter((e) => e.event === "checkpoint").map((e) => e.step), [2, 4, 6]);
  assert.deepEqual(events.filter((e) => e.event === "resume_saved").map((e) => e.step), [2, 4, 6]);
  const end = events.at(-1);
  assert.equal(end.event, "end");
  assert.equal(end.status, "completed");
  assert.equal(end.phase, "train");
  assert.ok(end.seconds >= 0);
  assert.ok(events.some((e) => e.event === "phase" && e.phase === "train" && e.status === "begin"));

  for (const step of [2, 4, 6]) {
    const file = path.join(root, "checkpoints", `step-${String(step).padStart(6, "0")}.safetensors`);
    assert.ok(existsSync(file), file);
  }
  const snapshot = path.join(root, "resume", "step-000006");
  for (const name of ["lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json", "state.json"]) {
    assert.ok(existsSync(path.join(snapshot, name)), name);
  }
  const pointer = JSON.parse(readFileSync(path.join(root, "resume", "latest.json"), "utf8"));
  assert.equal(pointer.snapshot_id, "step-000006");
  assert.equal(pointer.step, 6);
});
