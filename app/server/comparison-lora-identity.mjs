import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { readLocalLoraResource } from "./lora-resources.mjs";
import { readSafeTensorsMetadataFromHandle, SAFE_TENSORS_METADATA_LIMITS } from "./safetensors-metadata.mjs";

const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const resourceIdPattern = /^lora-[a-f0-9]{16}$/;
const allowedArchitectureFamilies = new Set(["sd15", "sdxl", "anima", "sd3", "flux", "other"]);
const modelIdentityStatuses = new Set(["exact", "declared", "unknown"]);

export class ComparisonLoraIdentityError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ComparisonLoraIdentityError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = []) {
  throw new ComparisonLoraIdentityError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value) {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function clone(value) {
  return structuredClone(value);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) fail("invalid_comparison_lora_identity", `${label} 必须是对象`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail("invalid_comparison_lora_identity", `${label} 包含未知字段：${unknown.join("、")}`);
}

function assertStableId(value, label) {
  if (typeof value !== "string" || !idPattern.test(value)) fail("invalid_comparison_lora_identity", `${label} 必须是稳定 ID`);
  return value;
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("loras/") || value.includes("\\") || value.includes("\0")
    || value.includes("//") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.endsWith("/")
    || path.extname(value) !== ".safetensors") {
    fail("invalid_comparison_lora_path", `${label} 必须是 models_root/loras 下的 .safetensors 正斜杠相对路径`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":") || part.includes("\0"))) {
    fail("invalid_comparison_lora_path", `${label} 包含不安全路径片段`);
  }
  return value;
}

function configuredModelsRoot(repositoryRoot, config) {
  const configured = config?.models_root;
  if (typeof configured !== "string" || !configured.trim()) fail("models_root_not_configured", "比较 LoRA 冻结要求 config.models_root");
  return path.isAbsolute(configured) || path.win32.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(repositoryRoot, configured);
}

async function safeModelsRoot(modelsRoot) {
  const info = await lstat(modelsRoot).catch(() => null);
  if (!info) fail("models_root_unavailable", "models_root 不存在");
  if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_models_root", "models_root 必须是非符号链接目录");
  const rootReal = await realpath(modelsRoot).catch(() => null);
  if (!rootReal) fail("models_root_unavailable", "models_root 无法解析");
  return rootReal;
}

/**
 * 逐段检查 models_root 下的 LoRA 路径。每个 parent 都经过 lstat 与 realpath，
 * 因而不会因中途 symlink/junction 把比较输入带出 models_root。
 */
async function resolveSafeLoraFile(modelsRoot, relativePath) {
  assertSafeRelativePath(relativePath, "LoRA.relative_path");
  const rootReal = await safeModelsRoot(modelsRoot);
  const parts = relativePath.split("/");
  let current = modelsRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) fail("comparison_lora_file_missing", `LoRA 文件不存在：${relativePath}`);
    if (info.isSymbolicLink()) fail("unsafe_comparison_lora_path", `LoRA 路径包含符号链接或 junction：${relativePath}`);
    const currentReal = await realpath(current).catch(() => null);
    if (!currentReal || !isWithin(rootReal, currentReal)) fail("unsafe_comparison_lora_path", `LoRA 路径超出 models_root：${relativePath}`);
    if (index < parts.length - 1 && !info.isDirectory()) fail("unsafe_comparison_lora_path", `LoRA 父路径不是目录：${relativePath}`);
    if (index === parts.length - 1 && !info.isFile()) fail("comparison_lora_file_missing", `LoRA 路径不是普通文件：${relativePath}`);
  }
  const info = await lstat(current);
  return { target: current, info, rootReal };
}

function sameFileSnapshot(left, right) {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (left.ino === undefined || right.ino === undefined || left.ino === right.ino)
    && (left.dev === undefined || right.dev === undefined || left.dev === right.dev);
}

async function hashStableHandle(handle, size) {
  const hash = createHash("sha256");
  const chunkSize = 1024 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunk.length, size - offset);
    let result;
    try {
      result = await handle.read(chunk, 0, length, offset);
    } catch (error) {
      fail("comparison_lora_read_failed", `读取 LoRA 文件失败：${error.message}`);
    }
    if (!result.bytesRead) fail("comparison_lora_read_failed", "读取 LoRA 文件时提前结束");
    hash.update(chunk.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  return hash.digest("hex");
}

async function freezeFile({ modelsRoot, relativePath }) {
  const resolved = await resolveSafeLoraFile(modelsRoot, relativePath);
  const before = resolved.info;
  const handle = await open(resolved.target, "r");
  let metadata;
  let sha256;
  let handleAfter;
  try {
    const handleBefore = await handle.stat();
    if (!sameFileSnapshot(before, handleBefore)) fail("comparison_lora_file_changed", "LoRA 文件在打开期间发生变化");
    metadata = await readSafeTensorsMetadataFromHandle(handle, { strict: true, fileInfo: handleBefore });
    sha256 = await hashStableHandle(handle, handleBefore.size);
    handleAfter = await handle.stat();
    if (!sameFileSnapshot(handleBefore, handleAfter)) fail("comparison_lora_file_changed", "LoRA 文件在冻结读取期间发生变化");
  } finally {
    await handle.close().catch(() => undefined);
  }
  const after = await lstat(resolved.target).catch(() => null);
  if (!after?.isFile() || after.isSymbolicLink() || !sameFileSnapshot(before, after)) {
    fail("comparison_lora_file_changed", "LoRA 文件在冻结读取期间发生变化");
  }
  // Hash 之后再次走逐段 resolver，避免读取期间发生替换后又被恢复为可疑路径。
  const checked = await resolveSafeLoraFile(modelsRoot, relativePath);
  if (!sameFileSnapshot(before, checked.info) || handleAfter.size !== checked.info.size) {
    fail("comparison_lora_file_changed", "LoRA 文件在冻结读取期间发生变化");
  }
  return { relative_path: relativePath, sha256, size_bytes: checked.info.size, metadata };
}

function assertMetadata(value, label) {
  if (!isPlainRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    fail("invalid_comparison_lora_metadata", `${label} 必须是 SafeTensors 字符串 metadata`);
  }
  if (Object.keys(value).length > SAFE_TENSORS_METADATA_LIMITS.max_entries) {
    fail("invalid_comparison_lora_metadata", `${label} 字段数量超出安全范围`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > SAFE_TENSORS_METADATA_LIMITS.max_key_length || entry.length > SAFE_TENSORS_METADATA_LIMITS.max_value_length) fail("invalid_comparison_lora_metadata", `${label} 包含不合理字段`);
  }
  return clone(value);
}

function normalizeBaseModels(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !isPlainRecord(entry))) {
    fail("invalid_comparison_lora_identity", `${label} 必须是非空模型身份数组`);
  }
  return value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    assertExactKeys(entry, ["kind", "name", "identity_status", "relative_path", "sha256", "size_bytes", "source"], entryLabel);
    if (typeof entry.kind !== "string" || !entry.kind.trim() || typeof entry.name !== "string" || !entry.name.trim()
      || !modelIdentityStatuses.has(entry.identity_status)) {
      fail("invalid_comparison_lora_identity", `${entryLabel} 的 kind/name/identity_status 无效`);
    }
    if (entry.relative_path !== null && (typeof entry.relative_path !== "string" || !entry.relative_path.trim())) {
      fail("invalid_comparison_lora_identity", `${entryLabel}.relative_path 必须是字符串或 null`);
    }
    if (entry.sha256 !== null && (typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256))) {
      fail("invalid_comparison_lora_identity", `${entryLabel}.sha256 必须是完整 SHA-256 或 null`);
    }
    if (entry.size_bytes !== null && (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0)) {
      fail("invalid_comparison_lora_identity", `${entryLabel}.size_bytes 必须是非负安全整数或 null`);
    }
    if (entry.source !== null && (typeof entry.source !== "string" || !entry.source.trim())) {
      fail("invalid_comparison_lora_identity", `${entryLabel}.source 必须是字符串或 null`);
    }
    return {
      kind: entry.kind,
      name: entry.name,
      identity_status: entry.identity_status,
      relative_path: entry.relative_path,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
      source: entry.source,
    };
  });
}

function normalizeActivation(value, label) {
  if (!isPlainRecord(value)) fail("invalid_comparison_lora_identity", `${label} 必须是普通对象`);
  assertExactKeys(value, ["trigger_words", "tags"], label);
  const validTerms = (entries) => Array.isArray(entries) && entries.every((entry) => typeof entry === "string" && entry.trim() && entry.length <= 1_024);
  if (!validTerms(value.trigger_words) || !validTerms(value.tags)) {
    fail("invalid_comparison_lora_identity", `${label} 必须包含字符串 trigger_words/tags`);
  }
  return { trigger_words: [...value.trigger_words], tags: [...value.tags] };
}

function normalizeArchitecture(value, label) {
  if (!isPlainRecord(value)) fail("invalid_comparison_lora_identity", `${label} 必须是普通对象`);
  assertExactKeys(value, ["family", "prompt_family"], label);
  if (!allowedArchitectureFamilies.has(value.family) || typeof value.prompt_family !== "string" || !value.prompt_family.trim() || value.prompt_family.length > 1_024) {
    fail("invalid_comparison_lora_identity", `${label} 的 family/prompt_family 无效`);
  }
  return { family: value.family, prompt_family: value.prompt_family };
}

/**
 * 校验/规范 manifest 中的 loras registry 条目。该函数也用于 validator，
 * 因而不会保留调用方传入的可变对象引用。
 */
export function normalizeFrozenComparisonLora(value, label = "registries.loras 条目") {
  if (!isRecord(value)) fail("invalid_comparison_lora_identity", `${label} 必须是对象`);
  if (value.kind === "raw") {
    assertExactKeys(value, ["id", "kind", "relative_path", "sha256", "size_bytes", "metadata"], label);
    return {
      id: assertStableId(value.id, `${label}.id`),
      kind: "raw",
      relative_path: assertSafeRelativePath(value.relative_path, `${label}.relative_path`),
      sha256: typeof value.sha256 === "string" && sha256Pattern.test(value.sha256) ? value.sha256 : (() => { fail("invalid_comparison_lora_identity", `${label}.sha256 无效`); })(),
      size_bytes: Number.isSafeInteger(value.size_bytes) && value.size_bytes >= 0 ? value.size_bytes : (() => { fail("invalid_comparison_lora_identity", `${label}.size_bytes 无效`); })(),
      metadata: assertMetadata(value.metadata, `${label}.metadata`),
    };
  }
  if (value.kind === "resource") {
    assertExactKeys(value, ["id", "kind", "resource_id", "name", "architecture", "base_models", "activation", "relative_path", "sha256", "size_bytes", "metadata"], label);
    if (typeof value.resource_id !== "string" || !resourceIdPattern.test(value.resource_id)) fail("invalid_comparison_lora_identity", `${label}.resource_id 无效`);
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 10_000) fail("invalid_comparison_lora_identity", `${label}.name 无效`);
    return {
      id: assertStableId(value.id, `${label}.id`),
      kind: "resource",
      resource_id: value.resource_id,
      name: value.name,
      architecture: normalizeArchitecture(value.architecture, `${label}.architecture`),
      base_models: normalizeBaseModels(value.base_models, `${label}.base_models`),
      activation: normalizeActivation(value.activation, `${label}.activation`),
      relative_path: assertSafeRelativePath(value.relative_path, `${label}.relative_path`),
      sha256: typeof value.sha256 === "string" && sha256Pattern.test(value.sha256) ? value.sha256 : (() => { fail("invalid_comparison_lora_identity", `${label}.sha256 无效`); })(),
      size_bytes: Number.isSafeInteger(value.size_bytes) && value.size_bytes >= 0 ? value.size_bytes : (() => { fail("invalid_comparison_lora_identity", `${label}.size_bytes 无效`); })(),
      metadata: assertMetadata(value.metadata, `${label}.metadata`),
    };
  }
  fail("invalid_comparison_lora_identity", `${label}.kind 必须是 raw 或 resource`);
}

function freezeRawSource(source, modelsRoot) {
  assertExactKeys(source, ["id", "kind", "relative_path"], "comparison.sources 条目");
  const id = assertStableId(source.id, "comparison.sources.id");
  const relativePath = assertSafeRelativePath(source.relative_path, "comparison.sources.relative_path");
  return freezeFile({ modelsRoot, relativePath }).then((file) => ({ id, kind: "raw", ...file }));
}

async function freezeResourceSource(source, repositoryRoot, config, modelsRoot) {
  assertExactKeys(source, ["id", "kind", "resource_id"], "comparison.sources 条目");
  const id = assertStableId(source.id, "comparison.sources.id");
  if (typeof source.resource_id !== "string" || !resourceIdPattern.test(source.resource_id)) fail("invalid_comparison_lora_identity", "comparison.sources.resource_id 无效");
  let resolved;
  try {
    resolved = await readLocalLoraResource(repositoryRoot, config, source.resource_id);
  } catch (error) {
    fail(error.code === "lora_resource_not_found" ? "comparison_lora_resource_not_found" : "comparison_lora_resource_unavailable", `正式 LoRA 资源不可用：${source.resource_id}`);
  }
  if (resolved.status !== "available") fail("comparison_lora_resource_unavailable", `正式 LoRA 资源不可用：${source.resource_id}`);
  const resource = resolved.resource;
  const relativePath = assertSafeRelativePath(resource.file.relative_path, `resource ${source.resource_id}.file.relative_path`);
  const file = await freezeFile({ modelsRoot, relativePath });
  if (file.sha256 !== resource.file.sha256 || file.size_bytes !== resource.file.size_bytes) {
    fail("comparison_lora_resource_identity_mismatch", `正式 LoRA 资源文件身份与 resource.json 不一致：${source.resource_id}`);
  }
  return {
    id,
    kind: "resource",
    resource_id: resource.id,
    name: resource.name,
    architecture: normalizeArchitecture(resource.architecture, `resource ${source.resource_id}.architecture`),
    base_models: normalizeBaseModels(resource.base_models, `resource ${source.resource_id}.base_models`),
    activation: normalizeActivation(resource.activation, `resource ${source.resource_id}.activation`),
    ...file,
  };
}

/**
 * 冻结比较实验使用的正式或未登记 LoRA 文件身份。raw 只保存实际文件信息，
 * 不根据文件名或 metadata 推断 architecture/base model；resource 才保存 resource.json
 * 声明的语义身份。该函数不创建目录、不登记 raw 资源，也不使用模型哈希缓存。
 */
export async function freezeComparisonLoraSources({ repositoryRoot, config, localConfig, sources = [] } = {}) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) fail("invalid_comparison_input", "repositoryRoot 必须是字符串");
  if (!Array.isArray(sources)) fail("invalid_comparison_input", "sources 必须是数组");
  const root = path.resolve(repositoryRoot);
  const effectiveConfig = config ?? localConfig ?? {};
  const modelsRoot = configuredModelsRoot(root, effectiveConfig);
  await safeModelsRoot(modelsRoot);
  const ids = new Set();
  const frozen = [];
  for (const source of sources) {
    if (!isRecord(source)) fail("invalid_comparison_lora_identity", "comparison.sources 条目必须是对象");
    if (typeof source.id !== "string" || !idPattern.test(source.id)) fail("invalid_comparison_lora_identity", "comparison.sources.id 必须是稳定 ID");
    if (ids.has(source.id)) fail("duplicate_comparison_lora_identity", `comparison.sources.id 重复：${source.id}`);
    ids.add(source.id);
    frozen.push(source.kind === "raw"
      ? await freezeRawSource(source, modelsRoot)
      : source.kind === "resource"
        ? await freezeResourceSource(source, root, effectiveConfig, modelsRoot)
        : fail("invalid_comparison_lora_identity", "comparison.sources.kind 必须是 raw 或 resource"));
  }
  return clone(frozen);
}
