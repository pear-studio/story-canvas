import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { validateLoraTrainingRunManifest } from "../server/lora-training-run-manifest.mjs";

function completeManifest() {
  return {
    version: 5,
    id: "run-111111111111",
    task_id: "dataset-222222222222",
    dataset_id: "dataset-222222222222",
    created_at: "2026-09-22T00:00:00.000Z",
    task_name: "制服训练",
    dataset_name: "制服素材",
    family: "qwen-image-2-1",
    prompt_family: "qwen",
    usage_defaults: { clip_skip: null, sampler: "euler", scheduler: "simple", steps: 25, cfg: 1 },
    description: "保持制服轮廓和扣件",
    activation_terms: ["test_uniform"],
    items: [{
      item_id: "item-444444444444",
      asset_id: "reference-001",
      group_id: "group-555555555555",
      source_file: "assets/reference-001/original.png",
      image_file: "inputs/item-444444444444.png",
      caption_file: "inputs/item-444444444444.txt",
      image_sha256: "1".repeat(64),
      caption_sha256: "2".repeat(64),
    }],
    groups: [{ id: "group-555555555555", name: "主体", enabled: true, repeats: 2 }],
    models: [
      { kind: "dit", relative_path: "diffusion_models/qwen-image-2.1/diffusion_pytorch_model-00001-of-00002.safetensors", sha256: "3".repeat(64), size_bytes: 1234, source: "https://huggingface.co/Qwen/Qwen-Image-2.1" },
      { kind: "dit", relative_path: "diffusion_models/qwen-image-2.1/diffusion_pytorch_model-00002-of-00002.safetensors", sha256: "6".repeat(64), size_bytes: 1234, source: null },
      { kind: "text_encoder", relative_path: "text_encoders/qwen-image-2.1/model-00001-of-00004.safetensors", sha256: "4".repeat(64), size_bytes: 1234, source: null },
      { kind: "vae", relative_path: "vae/qwen-image-2.1/diffusion_pytorch_model.safetensors", sha256: "5".repeat(64), size_bytes: 1234, source: null },
      { kind: "processor", relative_path: "text_encoders/qwen-image-2.1/processor/tokenizer.json", sha256: "7".repeat(64), size_bytes: 1234, source: null },
    ],
    trainer: {
      diffsynth_commit: "7686e54d41d25c0e8ed5f1318acc23b6bb832654",
      python: "3.11.14",
      torch: "2.13.0+cu130",
      gpu: "Test GPU",
      vram_bytes: 24 * 1024 ** 3,
      runner: { name: "qwen-image21-lora-runner", version: 1, sha256: "8".repeat(64) },
    },
    recipe: { id: "qwen-image21-lora-v1", version: 1, sha256: "9".repeat(64), overrides: { network_dim: 32, learning_rate: 0.0001, gradient_accumulation_steps: 1 } },
    semantic_config: {
      max_pixels: 1048576,
      network_dim: 32,
      network_alpha: 32,
      learning_rate: 0.0001,
      gradient_accumulation_steps: 1,
      micro_batch_size: 1,
      optimizer: { type: "AdamW", betas: [0.9, 0.999], eps: 1e-8, weight_decay: 0.01 },
      scheduler: { type: "ConstantLR", factor: 0.3333333333333333, total_iters: 5 },
      precision: { base: "bf16", lora: "bf16", optimizer_state: "bf16" },
      gradient_checkpointing: true,
      lora_target_modules: ["transformer_blocks.0.attn.to_q", "transformer_blocks.0.img_mlp.proj"],
    },
    run: { max_train_steps: 2000, save_every_n_steps: 500, seed: 42 },
    sampling: { weights: [{ item_id: "item-444444444444", weight: 2 }] },
    resume: null,
    paths: {
      inputs_dir: path.resolve("D:/project/Training/dataset-222222222222/run-111111111111/inputs"),
      cache_dir: path.resolve("D:/project/Saved/Training/dataset-222222222222/run-111111111111/cache"),
      control_dir: path.resolve("D:/project/Saved/Training/dataset-222222222222/run-111111111111/control"),
      archive_dir: path.resolve("D:/project/Training/dataset-222222222222/run-111111111111"),
      resume_dir: path.resolve("D:/project/Training/dataset-222222222222/run-111111111111/resume"),
      events_file: path.resolve("D:/project/Saved/Training/dataset-222222222222/run-111111111111/events.jsonl"),
      log_file: path.resolve("D:/project/Saved/Training/dataset-222222222222/run-111111111111/console.log"),
      checkpoints_dir: path.resolve("D:/models/loras/training/dataset-222222222222/run-111111111111"),
      checkpoints_relative_path: "loras/training/dataset-222222222222/run-111111111111",
      models_root: path.resolve("D:/models"),
    },
    execution: { executable: "C:/python.exe", argv: ["C:/repo/app/python/qwen-image21-lora-runner.py", "--manifest", "D:/project/Training/dataset-222222222222/run-111111111111/manifest.json"] },
    seed: 42,
  };
}

test("完整 v5 manifest 通过全部内部契约校验", () => {
  assert.deepEqual(validateLoraTrainingRunManifest(completeManifest()), []);
});

test("v5 manifest 拒绝 v4 的冗余字段与旧家族", () => {
  const manifest = completeManifest();
  manifest.version = 4;
  manifest.family = "anima";
  manifest.config = { resolution: 1024 };
  manifest.dataset_toml_sha256 = "5".repeat(64);
  const errors = validateLoraTrainingRunManifest(manifest);
  assert.ok(errors.some((error) => error.includes("version 必须为 5")));
  assert.ok(errors.some((error) => error.includes("family 必须为 qwen-image-2-1")));
  assert.ok(errors.some((error) => error.includes("未支持字段：config")));
  assert.ok(errors.some((error) => error.includes("未支持字段：dataset_toml_sha256")));
});

test("v5 manifest 冻结 alpha 随 rank 与 micro batch 固定 1", () => {
  const manifest = completeManifest();
  manifest.semantic_config.network_alpha = 16;
  let errors = validateLoraTrainingRunManifest(manifest);
  assert.ok(errors.some((error) => error.includes("network_alpha 必须等于 network_dim")));
  const micro = completeManifest();
  micro.semantic_config.micro_batch_size = 2;
  errors = validateLoraTrainingRunManifest(micro);
  assert.ok(errors.some((error) => error.includes("micro_batch_size 固定为 1")));
});

test("v5 manifest 校验模型逐文件身份、采样权重与续训字段", () => {
  const missing = completeManifest();
  missing.models = missing.models.filter((model) => model.kind !== "processor");
  assert.ok(validateLoraTrainingRunManifest(missing).some((error) => error.includes("缺少 processor")));

  const duplicate = completeManifest();
  duplicate.models.push({ ...duplicate.models[0] });
  assert.ok(validateLoraTrainingRunManifest(duplicate).some((error) => error.includes("relative_path 重复")));

  const badWeight = completeManifest();
  badWeight.sampling.weights = [{ item_id: "item-999999999999", weight: 1 }];
  assert.ok(validateLoraTrainingRunManifest(badWeight).some((error) => error.includes("不在 items 快照中")));

  const resume = completeManifest();
  resume.resume = { parent_run_id: "run-aaaaaaaaaaaa", source_snapshot_id: "step-000500", source_sha256: "b".repeat(64), start_step: 500 };
  assert.deepEqual(validateLoraTrainingRunManifest(resume), []);
  resume.resume.start_step = 2000;
  assert.ok(validateLoraTrainingRunManifest(resume).some((error) => error.includes("start_step 必须小于")));
  resume.resume = { parent_run_id: "bad", source_snapshot_id: "500", source_sha256: "b".repeat(64), start_step: 500 };
  const errors = validateLoraTrainingRunManifest(resume);
  assert.ok(errors.some((error) => error.includes("resume.parent_run_id 无效")));
  assert.ok(errors.some((error) => error.includes("step-NNNNNN")));
});

test("frozen manifest 的 recipe override 不允许改变 optimizer 或注入未知字段", () => {
  const manifest = completeManifest();
  manifest.recipe.overrides = { optimizer_type: "SGD", max_train_steps: 10 };
  const errors = validateLoraTrainingRunManifest(manifest);
  assert.ok(errors.some((error) => error.includes("recipe.overrides 包含未支持字段：optimizer_type")));
  assert.ok(errors.some((error) => error.includes("recipe.overrides 包含未支持字段：max_train_steps")));
});

test("frozen manifest Schema 与 runtime validator 保持 Qwen 契约一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../../library/schemas/lora-training-run-manifest.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", true);
  const validateSchema = ajv.compile(schema);
  const assertManifest = (manifest, expected, label) => {
    const schemaAccepted = validateSchema(manifest);
    const runtimeAccepted = validateLoraTrainingRunManifest(manifest).length === 0;
    assert.equal(schemaAccepted, expected, `${label} 的 JSON Schema 结果不符预期：${JSON.stringify(validateSchema.errors)}`);
    assert.equal(runtimeAccepted, expected, `${label} 的 runtime 结果不符预期`);
  };
  const required = [
    "version", "id", "task_id", "dataset_id", "created_at", "family", "prompt_family",
    "task_name", "dataset_name", "usage_defaults", "description", "activation_terms", "items", "groups", "models",
    "trainer", "recipe", "semantic_config", "run", "sampling", "resume", "paths", "execution", "seed",
  ];
  assert.deepEqual(schema.required, required);
  assert.equal(schema.additionalProperties, false);
  for (const definition of ["trainer", "recipe", "semantic_config", "run", "sampling", "paths", "execution"]) {
    assert.equal(schema.$defs[definition].additionalProperties, false, `${definition} 必须拒绝未知字段`);
  }
  assert.deepEqual(Object.keys(schema.$defs.recipe_overrides.properties).sort(), ["gradient_accumulation_steps", "learning_rate", "network_dim"]);
  assert.equal(schema.$defs.recipe_overrides.additionalProperties, false);
  assert.deepEqual(schema.$defs.model.properties.kind.enum, ["dit", "text_encoder", "vae", "processor"]);
  assert.equal(schema.properties.family.const, "qwen-image-2-1");
  assertManifest(completeManifest(), true, "合法 Qwen manifest");
  const withNote = completeManifest();
  withNote.run.note = "追加到 4000\n与上一轮对比";
  assertManifest(withNote, true, "训练备注字符串");
  withNote.run.note = 123;
  assertManifest(withNote, false, "拒绝非字符串训练备注");
  const relativePaths = completeManifest();
  relativePaths.paths.inputs_dir = "relative/inputs";
  assertManifest(relativePaths, false, "paths 必须是绝对路径");
  const malformed = completeManifest();
  malformed.semantic_config = {};
  malformed.recipe.overrides = { optimizer_type: "SGD" };
  const errors = validateLoraTrainingRunManifest(malformed);
  assert.ok(errors.some((error) => error.includes("semantic_config.max_pixels")));
  assert.ok(errors.some((error) => error.includes("recipe.overrides 包含未支持字段：optimizer_type")));
  assert.equal(Object.hasOwn(schema.$defs.recipe_overrides.properties, "optimizer_type"), false);
  assert.equal(validateSchema(malformed), false, "空 semantic_config 和未知 override 必须被 JSON Schema 拒绝");
});

test("仓库 Qwen 方案自身是合法的语义配置来源", async () => {
  const recipe = JSON.parse(await readFile(new URL("../../library/lora-training/recipes/qwen-image21-lora-v1.json", import.meta.url), "utf8"));
  assert.equal(recipe.id, "qwen-image21-lora-v1");
  assert.equal(recipe.family, "qwen-image-2-1");
  assert.equal(recipe.semantic_config.lora_target_modules.length, 224);
  assert.equal(new Set(recipe.semantic_config.lora_target_modules).size, 224);
  assert.ok(recipe.semantic_config.lora_target_modules.includes("transformer_blocks.31.img_mlp.gate_layer"));
  const settingsSchema = JSON.parse(await readFile(new URL("../../library/schemas/lora-training-settings.schema.json", import.meta.url), "utf8"));
  assert.equal(settingsSchema.properties.version.const, 5);
  assert.equal(settingsSchema.properties.target.properties.family.const, "qwen-image-2-1");
  assert.deepEqual(settingsSchema.properties.run_defaults.required, ["max_train_steps", "save_every_n_steps", "seed"]);
});
