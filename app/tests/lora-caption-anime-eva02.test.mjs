import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";


const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "..");
const captionerPath = path.join(appRoot, "scripts", "lora-caption-anime-eva02.py");
const manifestPath = path.join(repositoryRoot, "library", "lora-training", "captioners", "animetimm-eva02-db4-full.json");

function findPython() {
  for (const candidate of [
    { command: process.env.PYTHON, prefix: [] },
    { command: "python", prefix: [] },
    { command: "python3", prefix: [] },
    { command: "py", prefix: ["-3"] },
  ]) {
    if (!candidate.command) continue;
    const probe = spawnSync(candidate.command, [...candidate.prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = findPython();

function runPython(source) {
  const result = spawnSync(python.command, [...python.prefix, "-c", source], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, CAPTIONER_PATH: captionerPath },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("AnimeTimm 打标器清单固定模型身份和 Prompt 语义", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.id, "animetimm-eva02-db4-full");
  assert.equal(manifest.source.revision, "7f11ec9fdb54dfbfd7cd7fad2ecc452a25b57acb");
  assert.deepEqual(manifest.prompt.category_order, [4, 0]);
  assert.deepEqual(manifest.prompt.exclude_categories, [9]);
  assert.equal(manifest.prompt.preserve_underscores, true);
  assert.deepEqual(manifest.runtime.required_providers, ["CUDAExecutionProvider"]);
  assert.deepEqual(manifest.runtime.forbidden_providers, ["CPUExecutionProvider"]);
  assert.deepEqual(manifest.runtime.python_packages, ["numpy", "onnxruntime-gpu==1.21.1", "Pillow"]);
  assert.equal(manifest.files.model.relative_path, "model.onnx");
  assert.equal(manifest.files.model.sha256, "a9c51fd22bca855c3e890048b18b8e47d7ad6fb419b0e948c38b3c2478f97f25");
  assert.equal(manifest.files.labels.sha256, "56d941a9388c238f8e96961dca740c796908f4af4a85ef2270d01e135249cf82");
  assert.equal(manifest.files.thresholds.sha256, "f746771a64f9c06456402c3dc9e2aa3ec5c96836d820f50bc95f62d098c564c6");
});

test("AnimeTimm 打标器默认要求 CUDA，拒绝 CPU-only Provider", { skip: !python }, () => {
  const result = runPython(String.raw`
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("captioner", os.environ["CAPTIONER_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
defaults = module.parse_args(["--model", "model.onnx", "--labels", "labels.csv", "--thresholds", "thresholds.csv"])
print(json.dumps({
    "default": defaults.providers,
    "cpu_only": module.provider_policy_errors(["CPUExecutionProvider"]),
    "cuda": module.provider_policy_errors(["CUDAExecutionProvider"]),
    "cuda_cpu": module.provider_policy_errors(["CUDAExecutionProvider", "CPUExecutionProvider"]),
}))
`);
  assert.deepEqual(result.default, ["CUDAExecutionProvider"]);
  assert.equal(result.cpu_only.some((message) => message.includes("CUDAExecutionProvider")), true);
  assert.equal(result.cpu_only.some((message) => message.includes("CPUExecutionProvider")), true);
  assert.deepEqual(result.cuda, []);
  assert.equal(result.cuda_cpu.some((message) => message.includes("CPUExecutionProvider")), true);
});

test("AnimeTimm 打标器按角色优先顺序生成 Prompt，并只在审计结果保留 rating", { skip: !python }, () => {
  const result = runPython(String.raw`
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("captioner", os.environ["CAPTIONER_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
labels = [
    {"name": "solo", "category": 0},
    {"name": "sensitive", "category": 9},
    {"name": "ellen_joe", "category": 4},
    {"name": "maid", "category": 0},
    {"name": "other_character", "category": 4},
]
prompt, raw_tags = module.build_caption(
    [0.92, 0.95, 0.62, 0.75, 0.60],
    labels,
    {0: 0.39, 4: 0.61, 9: 0.38},
)
print(json.dumps({"prompt": prompt, "raw_tags": raw_tags}))
`);
  assert.equal(result.prompt, "ellen_joe, solo, maid");
  assert.deepEqual(result.raw_tags.map((tag) => tag.name), ["ellen_joe", "solo", "maid", "sensitive"]);
  assert.deepEqual(result.raw_tags.map((tag) => tag.category_name), ["character", "general", "general", "rating"]);
  assert.equal(result.raw_tags.at(-1).score, 0.95);
  assert.equal(result.raw_tags.at(-1).threshold, 0.38);
});

test("AnimeTimm 打标器拒绝缺失类别阈值和错位模型输出", { skip: !python }, () => {
  const result = runPython(String.raw`
import importlib.util, json, os, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("captioner", os.environ["CAPTIONER_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    thresholds = Path(directory) / "thresholds.csv"
    thresholds.write_text("category,threshold\n0,0.39\n4,0.61\n", encoding="utf-8")
    try:
        module.load_thresholds(thresholds)
    except module.CaptionerError as error:
        threshold_error = str(error)
try:
    module.build_caption([0.9], [{"name": "solo", "category": 0}, {"name": "maid", "category": 0}], {0: 0.39})
except module.CaptionerError as error:
    alignment_error = str(error)
print(json.dumps({"threshold_error": threshold_error, "alignment_error": alignment_error}))
`);
  assert.equal(result.threshold_error, "thresholds.csv 缺少类别：9");
  assert.equal(result.alignment_error, "模型输出 1 项，但标签表包含 2 项");
});

test("AnimeTimm 打标器检查模式无需输入清单即可返回结构化诊断", { skip: !python }, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "story-canvas-captioner-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const labels = path.join(directory, "selected_tags.csv");
  const thresholds = path.join(directory, "thresholds.csv");
  await writeFile(labels, "name,category\nsolo,0\nellen_joe,4\ngeneral,9\n", "utf8");
  await writeFile(thresholds, "category,threshold\n0,0.39\n4,0.61\n9,0.38\n", "utf8");
  const result = spawnSync(python.command, [
    ...python.prefix,
    captionerPath,
    "--model", path.join(directory, "model.onnx"),
    "--labels", labels,
    "--thresholds", thresholds,
    "--check",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.labels, 3);
  assert.equal(diagnostic.thresholds, 3);
  assert.equal(diagnostic.problems.some((problem) => problem.includes("ONNX 模型不存在")), true);
});
