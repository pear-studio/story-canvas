import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { freezeComparisonLoraSources, normalizeFrozenComparisonLora } from "../server/comparison-lora-identity.mjs";
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

async function writeSafeTensors(modelsRoot, relativePath, metadata, payload = Buffer.alloc(4)) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: "F32", shape: [1], data_offsets: [0, payloadBuffer.length] }, __metadata__: metadata }), "utf8");
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
