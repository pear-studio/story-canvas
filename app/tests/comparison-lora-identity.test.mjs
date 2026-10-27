import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { freezeComparisonLoraSources, normalizeFrozenComparisonLora, freezeComparisonInputLoras } from "../server/comparison-lora-identity.mjs";
import { checkComparisonLoraCompatibility } from '../server/comparison-model-compatibility.mjs';
import { readSafeTensorsMetadata } from "../server/safetensors-metadata.mjs";
import { registerProject } from "../server/project-registry.mjs";
import { planAssetTransfer, commitAssetTransfer } from "../server/project-assets.mjs";

async function temporaryProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-lora-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelsRoot = path.join(root, "models");
  await mkdir(path.join(modelsRoot, "loras"), { recursive: true });
  registerFixtureProjects(root); return { root, modelsRoot };
}

async function writeSafeTensors(modelsRoot, relativePath, metadata, payload = Buffer.alloc(4), tensorName = 'tensor') {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.from(JSON.stringify({ [tensorName]: { dtype: "F32", shape: [1], data_offsets: [0, payloadBuffer.length] }, __metadata__: metadata }), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  const bytes = Buffer.concat([length, header, payloadBuffer]);
  const target = path.join(modelsRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { target, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function writeFormalResource(root, modelsRoot) {
  const relativePath = "loras/formal/example.safetensors";
  const file = await writeSafeTensors(modelsRoot, relativePath, { format: "pt", source: "formal" });
  const resourceId = `lora-${file.sha256.slice(0, 16)}`;
  const directory = path.join(root, "library", "resources", "loras", resourceId);
  await mkdir(path.join(directory, "previews"), { recursive: true });
  await writeFile(path.join(directory, "previews", "preview-001.png"), Buffer.from("preview"));
  await writeFile(path.join(directory, "resource.json"), JSON.stringify({
    $schema: "https://storyvisualizer.local/schemas/lora-resource.schema.json",
    version: 2,
    id: resourceId,
    name: "Formal resource",
    kind: "lora",
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    file: { relative_path: relativePath, sha256: file.sha256, size_bytes: file.bytes.length },
    architecture: { family: "sdxl", prompt_family: "illustrious" },
    base_models: [{ kind: "base_model", name: "Base", identity_status: "declared", relative_path: null, sha256: null, size_bytes: null, source: null }],
    concept: { name: "Formal resource", description: "" },
    activation: { trigger_words: ["formal_trigger"], tags: ["style"] },
    recommended_generation: { weight: { default: 1, minimum: null, maximum: null, status: "untested" }, status: "untested" },
    training: null,
    source: { type: "test" },
    license: null,
    previews: [{ id: "preview-001", file: "previews/preview-001.png", alt: "预览" }],
    examples: [],
    embedded_metadata: { role: "backup", values: { format: "pt" } },
  }));
  return { resourceId, relativePath, file };
}

test("raw LoRA 冻结真实 SHA-256、大小和 SafeTensors metadata，并返回防御性 JSON", async (t) => {
  const { root, modelsRoot } = await temporaryProject(t);
  const relativePath = "loras/raw/example.safetensors";
  const file = await writeSafeTensors(modelsRoot, relativePath, { format: "pt", ss_tag: "example" });
  const [frozen] = await freezeComparisonLoraSources({
    repositoryRoot: root,
    config: { models_root: modelsRoot },
    sources: [{ id: "raw-example", kind: "raw", relative_path: relativePath }],
  });
  assert.deepEqual(frozen, {
    id: "raw-example",
    kind: "raw",
    relative_path: relativePath,
    sha256: file.sha256,
    size_bytes: file.bytes.length,
    metadata: { format: "pt", ss_tag: "example" },
  });
  frozen.metadata.format = "tampered";
  const [again] = await freezeComparisonLoraSources({
    repositoryRoot: root,
    config: { models_root: modelsRoot },
    sources: [{ id: "raw-example", kind: "raw", relative_path: relativePath }],
  });
  assert.equal(again.metadata.format, "pt");
});

test("正式 LoRA 通过真实 resource reader 后冻结 resource 身份并核对文件 hash/size", async (t) => {
  const { root, modelsRoot } = await temporaryProject(t);
  const fixture = await writeFormalResource(root, modelsRoot);
  const [frozen] = await freezeComparisonLoraSources({
    repositoryRoot: root,
    config: { models_root: modelsRoot },
    sources: [{ id: "formal-example", kind: "resource", resource_id: fixture.resourceId }],
  });
  assert.equal(frozen.kind, "resource");
  assert.equal(frozen.resource_id, fixture.resourceId);
  assert.equal(frozen.relative_path, fixture.relativePath);
  assert.equal(frozen.sha256, fixture.file.sha256);
  assert.equal(frozen.size_bytes, fixture.file.bytes.length);
  assert.deepEqual(frozen.architecture, { family: "sdxl", prompt_family: "illustrious" });
  assert.deepEqual(frozen.base_models[0], { kind: "base_model", name: "Base", identity_status: "declared", relative_path: null, sha256: null, size_bytes: null, source: null });
  assert.deepEqual(frozen.activation, { trigger_words: ["formal_trigger"], tags: ["style"] });
  assert.deepEqual(frozen.metadata, { format: "pt", source: "formal" });
  const [imported] = await freezeComparisonInputLoras({ repositoryRoot: root, config: { models_root: modelsRoot }, loras: [{
    filename: fixture.relativePath.slice('loras/'.length), sha256: fixture.file.sha256, kind: 'style', owner: 'project', weight: 1,
  }] });
  assert.equal(imported.source_identity.resource_id, fixture.resourceId);
  assert.equal(imported.source_identity.model_identity.declaration.source, 'resource');
  assert.deepEqual(imported.trigger_words, ['formal_trigger']);
});

test('导入已解析触发词和显式空值保持不变，资源分类 tags 从不作为触发词', async t => {
  const { root, modelsRoot } = await temporaryProject(t);
  const fixture = await writeFormalResource(root, modelsRoot);
  const base = { filename: fixture.relativePath.slice('loras/'.length), sha256: fixture.file.sha256, kind: 'character', owner: 'character-a', weight: 1 };
  const explicitSource = { id: 'selected', kind: 'resource', resource_id: fixture.resourceId,
    activation: { trigger_words: ['explicit_trigger'], tags: ['classification_only'] } };
  const inputs = [
    { ...base, trigger_words: ['page_trigger'] },
    { ...base, trigger_words: [] },
    { ...base, source_identity: explicitSource },
    { ...base, source_identity: explicitSource, trigger_words: ['resolved_trigger'] },
    { ...base, source_identity: explicitSource, trigger_words: [] },
  ];
  const original = structuredClone(inputs);
  const frozen = await freezeComparisonInputLoras({ repositoryRoot: root, config: { models_root: modelsRoot }, loras: inputs });
  assert.deepEqual(frozen.map(lora => lora.trigger_words), [['page_trigger'], [], ['explicit_trigger'], ['resolved_trigger'], []]);
  assert.deepEqual(frozen[0].source_identity.activation.tags, ['style']);
  assert.deepEqual(frozen[2].source_identity.activation.tags, ['classification_only']);
  assert.deepEqual(inputs, original);
});

test("项目持有的 LoRA 可按原资源 ID 冻结到独立实验，所属项目删除后冻结输入不变", async t => {
  const { root, modelsRoot } = await temporaryProject(t);
  const fixture = await writeFormalResource(root, modelsRoot);
  const owner = path.join(root, "owner");
  await mkdir(owner);
  await writeFile(path.join(owner, "project.json"), JSON.stringify({ title: "所属项目" }));
  registerProject(root, { id: "owner", type: "story", path: owner });
  const input = { kind: "lora", id: fixture.resourceId, source_storage: "repository", storage: "project", project_id: "owner" };
  const plan = await planAssetTransfer(root, input);
  await commitAssetTransfer(root, input, plan.fingerprint);
  const [frozen] = await freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ id: "owned", kind: "resource", resource_id: fixture.resourceId }] });
  await rm(owner, { recursive: true });
  assert.equal(frozen.sha256, fixture.file.sha256);
  assert.deepEqual(normalizeFrozenComparisonLora(frozen), frozen);
});

test("正式 resource 的 architecture unknown、非 plain identity 和 size mismatch 都被拒绝", async (t) => {
  const { root, modelsRoot } = await temporaryProject(t);
  const fixture = await writeFormalResource(root, modelsRoot);
  const resourcePath = path.join(root, "library", "resources", "loras", fixture.resourceId, "resource.json");
  const resource = JSON.parse(await readFile(resourcePath, "utf8"));
  resource.architecture.unknown = true;
  await writeFile(resourcePath, JSON.stringify(resource));
  await assert.rejects(
    freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ id: "formal", kind: "resource", resource_id: fixture.resourceId }] }),
    /architecture|invalid/,
  );
  assert.throws(() => normalizeFrozenComparisonLora({
    id: "formal", kind: "resource", resource_id: fixture.resourceId, name: "Formal",
    architecture: { family: "sdxl", prompt_family: "illustrious" },
    base_models: [new Date()], activation: { trigger_words: [], tags: [] }, relative_path: fixture.relativePath,
    sha256: fixture.file.sha256, size_bytes: fixture.file.bytes.length, metadata: {},
  }), /base_models/);
  resource.architecture = { family: "sdxl", prompt_family: "illustrious" };
  resource.file.size_bytes += 1;
  await writeFile(resourcePath, JSON.stringify(resource));
  await assert.rejects(
    freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ id: "formal", kind: "resource", resource_id: fixture.resourceId }] }),
    /不可用|identity/,
  );
});

test("严格 SafeTensors reader 明确拒绝非法扩展名、header 和非字符串 metadata", async (t) => {
  const { modelsRoot } = await temporaryProject(t);
  const malformed = path.join(modelsRoot, "loras", "malformed.safetensors");
  await writeFile(malformed, Buffer.from("not-a-header"));
  await assert.rejects(readSafeTensorsMetadata(malformed, { strict: true }), /header/);
  const invalidMetadata = await writeSafeTensors(modelsRoot, "loras/invalid.safetensors", { format: ["pt"] });
  await assert.rejects(readSafeTensorsMetadata(invalidMetadata.target, { strict: true }), /metadata/);
  const wrongExtension = path.join(modelsRoot, "loras", "wrong.bin");
  await writeFile(wrongExtension, Buffer.alloc(8));
  await assert.rejects(readSafeTensorsMetadata(wrongExtension, { strict: true }), /扩展名/);
  assert.deepEqual(await readSafeTensorsMetadata(malformed), {});
});

test("冻结 LoRA identity 拒绝超过共享上限的 metadata", () => {
  const metadata = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`key-${index}`, "value"]));
  assert.throws(() => normalizeFrozenComparisonLora({
    id: "raw",
    kind: "raw",
    relative_path: "loras/raw.safetensors",
    sha256: "a".repeat(64),
    size_bytes: 1,
    metadata,
  }), /字段数量/);
});

test("严格 SafeTensors reader 拒绝空 tensor、截断 payload 和多余 payload", async (t) => {
  const { modelsRoot } = await temporaryProject(t);
  const writeHeader = async (name, header, payload) => {
    const encoded = Buffer.from(JSON.stringify(header), "utf8");
    const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(encoded.length));
    const target = path.join(modelsRoot, "loras", name);
    await writeFile(target, Buffer.concat([length, encoded, payload]));
    return target;
  };
  const empty = await writeHeader("empty.safetensors", { __metadata__: { format: "pt" } }, Buffer.alloc(0));
  await assert.rejects(readSafeTensorsMetadata(empty, { strict: true }), /tensor/);
  const truncated = await writeHeader("truncated.safetensors", { tensor: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }, Buffer.alloc(3));
  await assert.rejects(readSafeTensorsMetadata(truncated, { strict: true }), /payload/);
  const extra = await writeHeader("extra.safetensors", { tensor: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }, Buffer.alloc(5));
  await assert.rejects(readSafeTensorsMetadata(extra, { strict: true }), /payload/);
});

test("raw LoRA 只允许 models_root/loras 下的安全 .safetensors 路径", async (t) => {
  const { root, modelsRoot } = await temporaryProject(t);
  for (const relativePath of ["../outside.safetensors", "loras/../outside.safetensors", "loras/file.bin", "C:/outside.safetensors", "loras\\file.safetensors"]) {
    await assert.rejects(
      freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ id: "raw", kind: "raw", relative_path: relativePath }] }),
      /路径/,
    );
  }
});

test("LoRA parent symlink/junction 越界时不允许冻结", async (t) => {
  const { root, modelsRoot } = await temporaryProject(t);
  const outside = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeSafeTensors(outside, "loras/outside.safetensors", { format: "pt" });
  const parent = path.join(modelsRoot, "loras", "linked");
  try {
    await symlink(path.join(outside, "loras"), parent, "junction");
  } catch (error) {
    t.skip(`当前 Windows 环境不允许创建 junction：${error.code ?? error.message}`);
    return;
  }
  await assert.rejects(
    freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ id: "raw", kind: "raw", relative_path: "loras/linked/outside.safetensors" }] }),
    /符号链接|越界/,
  );
});

test("models_root 自身是链接时不允许冻结", async (t) => {
  const { root, modelsRoot } = await temporaryProject(t);
  const linkedRoot = path.join(root, "linked-models");
  try {
    await symlink(modelsRoot, linkedRoot, "junction");
  } catch (error) {
    t.skip(`当前 Windows 环境不允许创建 models_root junction：${error.code ?? error.message}`);
    return;
  }
  await assert.rejects(
    freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: linkedRoot }, sources: [] }),
    /models_root|符号链接/,
  );
});

const mossSha = 'f96738d8116d78b7316b57c663d8c98591ddafab7488f48e3099b7655e34ab6f';
const mossInput = { render: { profile: { architecture_family: 'moss-image', models: { dit: {
  sha256: 'b4d1475bc7eeffd7b809e82ea13a1fba1fb85c4e18365af3813722faa5c0fe4f', size_bytes: 5413698958,
} } } } };
test('MOSS runner metadata 明确冻结为来源声明，raw 与导入 LoRA 使用同一兼容检查', async t => {
  const { root, modelsRoot } = await temporaryProject(t);
  const relativePath = 'loras/moss.safetensors';
  const metadata = { family: 'moss-image', base_models: JSON.stringify([{ relative_path: 'diffusion_models/sft.safetensors', sha256: mossSha }]) };
  const file = await writeSafeTensors(modelsRoot, relativePath, metadata, Buffer.alloc(4), 'diffusion_model.layers.0.proj.q.lora_A.weight');
  const [frozen] = await freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ id: 'moss', kind: 'raw', relative_path: relativePath }] });
  assert.equal(frozen.model_identity.declaration.source, 'metadata');
  assert.equal(frozen.model_identity.declaration.status, 'declared');
  assert.equal(frozen.model_identity.target_audit.component, 'dit');
  assert.equal(frozen.activation, undefined);
  assert.equal(checkComparisonLoraCompatibility(frozen, mossInput).matches[0].method, 'declared_conversion');
  const [inputLora] = await freezeComparisonInputLoras({ repositoryRoot: root, config: { models_root: modelsRoot }, loras: [{ filename: 'moss.safetensors', sha256: file.sha256, kind: 'character', owner: 'character-a', weight: 0.7 }] });
  assert.equal(inputLora.kind, 'character'); assert.equal(inputLora.owner, 'character-a');
  assert.equal(inputLora.source_identity.model_identity.declaration.source, 'metadata');
  assert.equal(checkComparisonLoraCompatibility(inputLora, mossInput).matches[0].method, 'declared_conversion');
  await assert.rejects(freezeComparisonInputLoras({ repositoryRoot: root, config: { models_root: modelsRoot }, loras: [{ ...inputLora, sha256: 'f'.repeat(64) }] }), /实际文件身份/);
  assert.throws(() => normalizeFrozenComparisonLora(frozen, 'legacy', { legacy: true }), /未知字段/);
});
test('显式 identity/activation 可补未知来源，但不能提交兼容关系或用 metadata 伪装未知目标', async t => {
  const { root, modelsRoot } = await temporaryProject(t);
  const relativePath = 'loras/explicit.safetensors';
  await writeSafeTensors(modelsRoot, relativePath, {}, Buffer.alloc(4), 'diffusion_model.layers.0.proj.q.lora_A.weight');
  const identity = { architecture_family: 'moss-image', adapted_components: ['dit'], base_models: [{ kind: 'dit', name: 'SFT', identity_status: 'declared', relative_path: null, sha256: mossSha, size_bytes: null, source: null }] };
  const source = { id: 'explicit', kind: 'raw', relative_path: relativePath, identity, activation: { trigger_words: [], tags: [] } };
  const [frozen] = await freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [source] });
  assert.deepEqual(frozen.activation, { trigger_words: [], tags: [] });
  assert.equal(frozen.model_identity.declaration.source, 'explicit');
  assert.equal(checkComparisonLoraCompatibility(frozen, mossInput).matches[0].method, 'declared_conversion');
  await assert.rejects(freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [{ ...source, compatibility: 'any' }] }), /未知字段/);
  await writeSafeTensors(modelsRoot, relativePath, {}, Buffer.alloc(4), 'diffusion_model.text_encoder.lora_A.weight');
  const [unknown] = await freezeComparisonLoraSources({ repositoryRoot: root, config: { models_root: modelsRoot }, sources: [source] });
  assert.equal(unknown.model_identity.target_audit.component, 'unknown');
  assert.throws(() => checkComparisonLoraCompatibility(unknown, mossInput), /适配目标/);
});
