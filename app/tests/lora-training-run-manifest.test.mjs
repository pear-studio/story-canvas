import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { validateLoraTrainingRunManifest } from "../server/lora-training-run-manifest.mjs";

function completeManifest() {
  return {
    version: 4,
    id: "run-111111111111",
    task_id: "lora-222222222222",
    dataset_id: "dataset-333333333333",
    created_at: "2026-08-20T00:00:00.000Z",
    task_name: "制服训练",
    dataset_name: "制服素材",
    family: "anima",
    prompt_family: "anima",
    usage_defaults: { clip_skip: null, sampler: "euler", scheduler: "simple", steps: 24, cfg: 4 },
    description: "保持制服轮廓和扣件",
    activation_terms: ["test_uniform"],
    items: [{
      item_id: "item-444444444444",
      asset_id: "reference-001",
      group_id: "group-555555555555",
      source_file: "assets/reference-001/original.png",
      image_file: "dataset/group-555555555555/item-444444444444.png",
      caption_file: "dataset/group-555555555555/item-444444444444.txt",
      image_sha256: "1".repeat(64),
      caption_sha256: "2".repeat(64),
    }],
    groups: [{ id: "group-555555555555", name: "主体", enabled: true, repeats: 1 }],
    models: [
      { kind: "dit", relative_path: "diffusion_models/anima.safetensors", sha256: "3".repeat(64), size_bytes: 1234, source: null },
      { kind: "text_encoder", relative_path: "text_encoders/qwen.safetensors", sha256: "4".repeat(64), size_bytes: 1234, source: null },
      { kind: "vae", relative_path: "vae/qwen.safetensors", sha256: "5".repeat(64), size_bytes: 1234, source: null },
    ],
    trainer: { sd_scripts_commit: "abc123", python: "C:/python.exe", torch: "2.7.0", cuda: "12.8", accelerate: "1.10.0", gpu: "Test GPU", vram_bytes: 12 * 1024 ** 3 },
    recipe: { id: "anima-character-r32-v1", version: 1, sha256: "4".repeat(64), overrides: {} },
    semantic_config: { resolution: 1024, effective_batch_size: 2, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit" },
    experiment: { max_train_steps: 1200, save_every_n_steps: 300, seed: 7 },
    execution_config: { micro_batch_size: 1, gradient_accumulation_steps: 2, effective_batch_size: 2, max_data_loader_n_workers: 2, blocks_to_swap: 4 },
    run_settings: { max_train_steps: 1200, save_every_n_steps: 300, seed: 7, micro_batch_size: 1, gradient_accumulation_steps: 2, max_data_loader_n_workers: 2, blocks_to_swap: 4 },
    config: { resolution: 1024, max_train_steps: 1200, train_batch_size: 1, network_dim: 32, network_alpha: 16, learning_rate: 0.0001, optimizer_type: "AdamW8bit", save_every_n_steps: 300, seed: 7, gradient_accumulation_steps: 2, max_data_loader_n_workers: 2, blocks_to_swap: 4 },
    dataset_toml_sha256: "5".repeat(64),
    execution: { executable: "C:/python.exe", argv: ["C:/sd-scripts/anima_train_network.py", "--seed", "7"] },
    seed: 7,

  };
}

function animaManifest() {
  return structuredClone(completeManifest());
}

test("frozen manifest 拒绝空 config", () => {
  const manifest = completeManifest();
  manifest.config = {};
  const errors = validateLoraTrainingRunManifest(manifest);
  assert.ok(errors.some((error) => error.includes("config.resolution")));
  assert.ok(errors.some((error) => error.includes("config.max_train_steps")));
});

test("frozen manifest 拒绝 usage_defaults 的内部字段错误", () => {
  const manifest = completeManifest();
  manifest.usage_defaults.steps = "24";
  const errors = validateLoraTrainingRunManifest(manifest);
  assert.ok(errors.some((error) => error.includes("usage_defaults.steps")));
});

test("完整 frozen manifest 通过全部内部契约校验", () => {
  assert.deepEqual(validateLoraTrainingRunManifest(completeManifest()), []);
});

test("frozen manifest 的 recipe override 不允许改变 optimizer 或注入未知字段", () => {
  const manifest = completeManifest();
  manifest.recipe.overrides = { optimizer_type: "SGD", max_train_steps: 10 };
  const errors = validateLoraTrainingRunManifest(manifest);
  assert.ok(errors.some((error) => error.includes("recipe.overrides 包含未支持字段：optimizer_type")));
  assert.ok(errors.some((error) => error.includes("recipe.overrides 包含未支持字段：max_train_steps")));
});

test("frozen manifest Schema 与 runtime validator 保持 Anima 契约一致", async () => {
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
    "trainer", "recipe", "semantic_config", "experiment", "execution_config", "run_settings",
    "config", "dataset_toml_sha256", "execution", "seed",
  ];
  assert.deepEqual(schema.required, required);
  assert.equal(schema.additionalProperties, false);
  for (const definition of ["trainer", "recipe", "semantic_config", "experiment", "execution_config", "run_settings", "config", "execution"]) {
    assert.equal(schema.$defs[definition].additionalProperties, false, `${definition} 必须拒绝未知字段`);
  }
  assert.deepEqual(Object.keys(schema.$defs.recipe_overrides.properties).sort(), ["effective_batch_size", "learning_rate", "network_alpha", "network_dim", "resolution"]);
  assert.equal(schema.$defs.recipe_overrides.additionalProperties, false);
  assert.deepEqual(schema.$defs.config.required, ["resolution", "max_train_steps", "train_batch_size", "network_dim", "network_alpha", "learning_rate", "optimizer_type", "save_every_n_steps", "seed", "gradient_accumulation_steps", "max_data_loader_n_workers"]);
  assert.equal(schema.properties.family.const, "anima");
  assertManifest(completeManifest(), true, "合法 Anima manifest");
  const withNote = completeManifest();
  withNote.run_settings.note = "降低学习率\n与上一轮对比";
  assertManifest(withNote, true, "训练备注字符串");
  withNote.run_settings.note = 123;
  assertManifest(withNote, false, "拒绝非字符串训练备注");
  const animaWithLlmAdapter = animaManifest();
  animaWithLlmAdapter.models.push({ kind: "llm_adapter", relative_path: "text_encoders/llm.safetensors", sha256: "6".repeat(64), size_bytes: 1234, source: null });
  assertManifest(animaWithLlmAdapter, true, "合法 Anima manifest（含 llm_adapter）");
  assert.deepEqual(schema.$defs.model.properties.kind.enum, ["dit", "text_encoder", "vae", "llm_adapter"]);
  const animaWithDuplicateKind = animaManifest();
  animaWithDuplicateKind.models.push({ ...animaWithDuplicateKind.models[0], relative_path: "diffusion_models/anima-copy.safetensors" });
  assertManifest(animaWithDuplicateKind, false, "非法 Anima 重复模型类型 manifest");

  const malformed = completeManifest();
  malformed.config = {};
  malformed.recipe.overrides = { optimizer_type: "SGD" };
  const errors = validateLoraTrainingRunManifest(malformed);
  assert.ok(errors.some((error) => error.includes("config.resolution")));
  assert.ok(errors.some((error) => error.includes("recipe.overrides 包含未支持字段：optimizer_type")));
  assert.ok(schema.$defs.config.required.includes("resolution"));
  assert.equal(Object.hasOwn(schema.$defs.recipe_overrides.properties, "optimizer_type"), false);
  assert.equal(validateSchema(malformed), false, "空 config 和未知 override 必须被 JSON Schema 拒绝");
});
