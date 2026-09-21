import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";


const resourceIdPattern = /^lora-[a-f0-9]{16}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const imageExtensions = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const hashCache = new Map();

export class LoraResourceError extends Error {
  constructor(status, code, details) {
    super(code);
    this.name = "LoraResourceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function configuredPath(projectRoot, value) {
  return typeof value === "string" && value.trim() ? path.resolve(projectRoot, value) : null;
}

function resourcesRoot(projectRoot) {
  return path.join(projectRoot, "app", "data.local", "lora-resources");
}

function trackedResourcesRoot(projectRoot) {
  return path.join(projectRoot, "library", "resources", "loras");
}

function resourceDirectory(projectRoot, resourceId) {
  if (!resourceIdPattern.test(resourceId)) throw new LoraResourceError(400, "invalid_lora_resource_id");
  return path.join(resourcesRoot(projectRoot), resourceId);
}

function trackedResourceDirectory(projectRoot, resourceId) {
  if (!resourceIdPattern.test(resourceId)) throw new LoraResourceError(400, "invalid_lora_resource_id");
  return path.join(trackedResourcesRoot(projectRoot), resourceId);
}

async function safeResourceRoot(projectRoot, root) {
  const info = await lstat(root).catch(() => null);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LoraResourceError(422, "unsafe_lora_resource_storage");
  const rootReal = await realpath(root);
  if (!isWithin(projectRoot, rootReal)) throw new LoraResourceError(422, "unsafe_lora_resource_storage");
  return rootReal;
}

function resourceCandidates(projectRoot, resourceId) {
  if (!resourceIdPattern.test(resourceId)) throw new LoraResourceError(400, "invalid_lora_resource_id");
  return [
    { root: trackedResourcesRoot(projectRoot), directory: trackedResourceDirectory(projectRoot, resourceId), storage: "repository" },
    { root: resourcesRoot(projectRoot), directory: resourceDirectory(projectRoot, resourceId), storage: "local" },
  ];
}

async function readJson(target, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new LoraResourceError(422, "invalid_lora_resource_json", [target]);
    throw error;
  }
}

async function readResourceJson(directory) {
  const target = path.join(directory, "resource.json");
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new LoraResourceError(422, "unsafe_lora_resource_storage");
  return readJson(target);
}

async function validateResourceMediaFiles(directory, resource) {
  const directoryReal = await realpath(directory);
  const errors = [];
  for (const media of [...(resource.previews ?? []), ...(resource.examples ?? [])]) {
    const target = path.resolve(directory, media.file);
    if (!isWithin(directory, target)) {
      errors.push(`${media.file} 超出资源目录`);
      continue;
    }
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      errors.push(`${media.file} 不是存在的普通文件`);
      continue;
    }
    const targetReal = await realpath(target);
    if (!isWithin(directoryReal, targetReal)) errors.push(`${media.file} 指向资源目录外部`);
  }
  return errors;
}

async function sha256File(target) {
  const info = await stat(target);
  const cached = hashCache.get(target);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs
    && cached.ino === info.ino && cached.dev === info.dev) return cached.sha256;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const after = await stat(target);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.ino !== info.ino || after.dev !== info.dev) {
    throw new LoraResourceError(409, "lora_resource_weight_changed");
  }
  hashCache.set(target, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev, sha256 });
  return sha256;
}

function validateModelIdentity(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是模型身份对象`);
    return;
  }
  if (typeof value.kind !== "string" || !value.kind) errors.push(`${label}.kind 不能为空`);
  if (typeof value.name !== "string" || !value.name) errors.push(`${label}.name 不能为空`);
  if (!["exact", "declared", "unknown"].includes(value.identity_status)) errors.push(`${label}.identity_status 无效`);
  if (value.relative_path !== null && (typeof value.relative_path !== "string" || path.isAbsolute(value.relative_path) || value.relative_path.includes("..") || value.relative_path.includes("\\"))) errors.push(`${label}.relative_path 必须是 models_root 下的正斜杠相对路径或 null`);
  if (value.sha256 !== null && !sha256Pattern.test(value.sha256 ?? "")) errors.push(`${label}.sha256 必须是完整 SHA-256 或 null`);
  if (value.size_bytes !== null && (!Number.isInteger(value.size_bytes) || value.size_bytes < 0)) errors.push(`${label}.size_bytes 必须是非负整数或 null`);
  if (value.identity_status === "exact" && (!value.relative_path || !value.sha256 || value.size_bytes === null)) errors.push(`${label} 标记为 exact 时必须包含完整路径、SHA-256 和大小`);
  if (!Object.hasOwn(value, "source") || (value.source !== null && (typeof value.source !== "string" || !value.source))) errors.push(`${label}.source 必须是非空字符串或 null`);
}

function validateResourceMedia(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是媒体对象`);
    return;
  }
  if (Object.hasOwn(value, "source") && (typeof value.source !== "string" || !value.source)) errors.push(`${label}.source 必须是非空字符串`);
  if (Object.hasOwn(value, "nsfw_level") && value.nsfw_level !== null && (!Number.isInteger(value.nsfw_level) || value.nsfw_level < 0)) errors.push(`${label}.nsfw_level 必须是非负整数或 null`);
}

export function validateLoraResource(value) {
  const errors = [];
  if (!isRecord(value)) return ["resource.json 必须是 JSON 对象"];
  for (const key of ["name_zh", "summary_zh"]) {
    if (Object.hasOwn(value, key) && (typeof value[key] !== "string" || !value[key].trim())) errors.push(`${key} 必须是非空字符串`);
  }
  if (Object.hasOwn(value, "purpose") && !["画风", "角色", "服装／道具", "场景", "外观调节", "动作／效果", "未分类"].includes(value.purpose)) errors.push("purpose 必须是支持的用途分类");
  if (value.version !== 2) errors.push("version 必须为 2");
  if (!resourceIdPattern.test(value.id ?? "")) errors.push("id 必须由 LoRA 权重 SHA-256 生成");
  if (value.kind !== "lora") errors.push("kind 必须为 lora");
  if (typeof value.name !== "string" || !value.name.trim()) errors.push("name 不能为空");
  if (Number.isNaN(Date.parse(value.created_at ?? "")) || Number.isNaN(Date.parse(value.updated_at ?? ""))) errors.push("created_at 和 updated_at 必须是有效时间");
  if (!isRecord(value.file) || typeof value.file.relative_path !== "string" || path.isAbsolute(value.file.relative_path) || value.file.relative_path.includes("..") || value.file.relative_path.includes("\\") || !sha256Pattern.test(value.file.sha256 ?? "") || !Number.isInteger(value.file.size_bytes) || value.file.size_bytes < 0) errors.push("file 必须包含 LoRA 权重的确切路径、SHA-256 和大小");
  if (typeof value.file?.relative_path === "string" && !value.file.relative_path.startsWith("loras/")) errors.push("file.relative_path 必须位于 models_root/loras 下");
  if (sha256Pattern.test(value.file?.sha256 ?? "") && value.id !== `lora-${value.file.sha256.slice(0, 16)}`) errors.push("id 必须与 LoRA 权重 SHA-256 一致");
  if (!isRecord(value.architecture) || !["sd15", "sdxl", "anima", "qwen-image-2-1", "sd3", "flux", "other"].includes(value.architecture.family)) errors.push("architecture.family 无效");
  if (typeof value.architecture?.prompt_family !== "string" || !value.architecture.prompt_family) errors.push("architecture.prompt_family 不能为空");
  if (!Array.isArray(value.base_models) || !value.base_models.length) errors.push("base_models 至少包含一项底座说明");
  else value.base_models.forEach((model, index) => validateModelIdentity(model, `base_models[${index}]`, errors));
  if (!isRecord(value.concept) || typeof value.concept.name !== "string" || !value.concept.name.trim() || typeof value.concept.description !== "string") errors.push("concept 无效");
  if (!isRecord(value.activation) || !Array.isArray(value.activation.trigger_words) || !Array.isArray(value.activation.tags)) errors.push("activation 无效");
  else {
    if (value.activation.trigger_words.some((entry) => typeof entry !== "string" || !entry.trim())) errors.push("activation.trigger_words 无效");
    if (value.activation.tags.some((tag) => typeof tag !== "string" || !tag)) errors.push("activation.tags 无效");
  }
  if (!isRecord(value.recommended_generation) || !isRecord(value.recommended_generation.weight) || !["untested", "tested"].includes(value.recommended_generation.status) || !["untested", "tested"].includes(value.recommended_generation.weight?.status)) errors.push("recommended_generation 无效");
  if (value.training !== null && !isRecord(value.training)) errors.push("training 必须是对象或 null");
  if (!isRecord(value.source) || typeof value.source.type !== "string" || !value.source.type) errors.push("source.type 不能为空");
  if (value.source?.version_name !== undefined && (typeof value.source.version_name !== "string" || !value.source.version_name.trim())) errors.push("source.version_name 必须是非空字符串");
  if (value.license !== null && !isRecord(value.license)) errors.push("license 必须是对象或 null");
  if (!Array.isArray(value.previews) || !Array.isArray(value.examples)) errors.push("previews 和 examples 必须是数组");
  else {
    if (!value.previews.length && !value.examples.length) errors.push("previews 或 examples 至少包含一张用于选择的预览图");
    if (value.previews.some((entry) => !isRecord(entry) || !/^previews\/preview-\d{3}\.(?:jpe?g|png|webp)$/.test(entry.file ?? "") || typeof entry.alt !== "string" || !entry.alt)) errors.push("previews 无效");
    value.previews.forEach((entry, index) => validateResourceMedia(entry, `previews[${index}]`, errors));
    if (value.examples.some((entry) => !isRecord(entry) || !/^examples\/example-\d{3}\.(?:jpe?g|png|webp)$/.test(entry.file ?? "") || typeof entry.prompt !== "string" || typeof entry.negative_prompt !== "string")) errors.push("examples 无效");
    value.examples.forEach((entry, index) => validateResourceMedia(entry, `examples[${index}]`, errors));
  }
  if (!isRecord(value.embedded_metadata) || value.embedded_metadata.role !== "backup" || !isRecord(value.embedded_metadata.values) || Object.values(value.embedded_metadata.values ?? {}).some((entry) => typeof entry !== "string")) errors.push("embedded_metadata 必须明确标记为 backup");
  return [...new Set(errors)];
}

async function inspectResource(projectRoot, config, resource) {
  const modelsRoot = configuredPath(projectRoot, config?.models_root);
  if (!modelsRoot) return { resource, status: "not_configured", reason: "models_root_not_configured", actual_sha256: null, size_bytes: null };
  const rootInfo = await lstat(modelsRoot).catch(() => null);
  if (!rootInfo) return { resource, status: "missing", reason: "model_missing", actual_sha256: null, size_bytes: null };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { resource, status: "invalid", reason: "unsafe_models_root", actual_sha256: null, size_bytes: null };
  const target = path.resolve(modelsRoot, resource.file.relative_path);
  if (!isWithin(modelsRoot, target)) return { resource, status: "invalid", reason: "invalid_lora_resource_weight_path", actual_sha256: null, size_bytes: null };
  const rootReal = await realpath(modelsRoot).catch(() => null);
  const parentReal = await realpath(path.dirname(target)).catch(() => null);
  if (!rootReal || parentReal && !isWithin(rootReal, parentReal)) return { resource, status: "invalid", reason: "unsafe_lora_resource_weight_path", actual_sha256: null, size_bytes: null };
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return { resource, status: "missing", reason: "model_missing", actual_sha256: null, size_bytes: null };
  const actualSha256 = await sha256File(target);
  const identityMatches = actualSha256 === resource.file.sha256 && info.size === resource.file.size_bytes;
  return {
    resource,
    status: identityMatches ? "available" : "hash_mismatch",
    reason: identityMatches ? null : actualSha256 !== resource.file.sha256 ? "model_hash_mismatch" : "model_size_mismatch",
    actual_sha256: actualSha256,
    size_bytes: info.size,
  };
}

async function listRawLoras(projectRoot, config, registeredPaths) {
  const modelsRoot = configuredPath(projectRoot, config?.models_root);
  if (!modelsRoot) return [];
  const root = path.join(modelsRoot, "loras");
  const found = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(target, relativePath);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".safetensors" && !registeredPaths.has(relativePath)) {
        const info = await stat(target);
        found.push({ id: `raw-${createHash("sha1").update(relativePath).digest("hex").slice(0, 16)}`, name: path.basename(entry.name, path.extname(entry.name)), relative_path: relativePath, sha256: await sha256File(target), size_bytes: info.size, status: "available" });
      }
    }
  }
  await visit(root, "loras");
  return found;
}

export async function listLocalLoraResources(projectRoot, config = {}) {
  const roots = [
    { root: trackedResourcesRoot(projectRoot), storage: "repository" },
    { root: resourcesRoot(projectRoot), storage: "local" },
  ];
  const resources = [];
  const errors = [];
  const seen = new Set();
  for (const { root, storage } of roots) {
    const rootReal = await safeResourceRoot(projectRoot, root);
    if (!rootReal) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !resourceIdPattern.test(entry.name) || seen.has(entry.name)) continue;
      try {
        const directory = path.join(root, entry.name);
        if (!isWithin(rootReal, await realpath(directory))) throw new LoraResourceError(422, "unsafe_lora_resource_storage");
        const resource = await readResourceJson(directory);
        const validation = validateLoraResource(resource);
        if (resource.id !== entry.name) validation.push("目录名与资源 ID 不一致");
        if (validation.length) throw new LoraResourceError(422, "invalid_lora_resource", validation);
        const mediaErrors = await validateResourceMediaFiles(directory, resource);
        if (mediaErrors.length) throw new LoraResourceError(422, "invalid_lora_resource_media", mediaErrors);
        resources.push({ ...(await inspectResource(projectRoot, config, resource)), storage, repository_record: storage === "repository" });
        seen.add(entry.name);
      } catch (error) {
        errors.push({ id: entry.name, code: error.code ?? "invalid_lora_resource", details: error.details ?? [error.message] });
      }
    }
  }
  const registeredPaths = new Set(resources.map(({ resource }) => resource.file.relative_path));
  const raw = await listRawLoras(projectRoot, config, registeredPaths);
  return { resources, raw, errors };
}

export async function readLocalLoraResource(projectRoot, config, resourceId) {
  let repositoryError = null;
  for (const candidate of resourceCandidates(projectRoot, resourceId)) {
    const rootReal = await safeResourceRoot(projectRoot, candidate.root);
    if (!rootReal) continue;
    const info = await lstat(candidate.directory).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(rootReal, await realpath(candidate.directory))) throw new LoraResourceError(422, "unsafe_lora_resource_storage");
    try {
      const resource = await readResourceJson(candidate.directory);
      const errors = validateLoraResource(resource);
      if (!errors.length) errors.push(...await validateResourceMediaFiles(candidate.directory, resource));
      if (isRecord(resource) && resource.id !== resourceId) errors.push("目录名与资源 ID 不一致");
      if (errors.length) throw new LoraResourceError(422, "invalid_lora_resource", errors);
      return { ...(await inspectResource(projectRoot, config, resource)), storage: candidate.storage, repository_record: candidate.storage === "repository" };
    } catch (error) {
      if (candidate.storage === "repository" && ["invalid_lora_resource_json", "invalid_lora_resource", "invalid_lora_resource_media"].includes(error.code)) {
        repositoryError = error;
        continue;
      }
      throw error;
    }
  }
  if (repositoryError) throw repositoryError;
  throw new LoraResourceError(404, "lora_resource_not_found");
}

export async function openLoraResourceMedia(projectRoot, resourceId, relativePath) {
  const resolved = await readLocalLoraResource(projectRoot, {}, resourceId);
  const directory = resolved.storage === "repository" ? trackedResourceDirectory(projectRoot, resourceId) : resourceDirectory(projectRoot, resourceId);
  if (typeof relativePath !== "string" || relativePath.includes("..") || path.isAbsolute(relativePath) || !/^(?:previews|examples)\//.test(relativePath) || !imageExtensions.has(path.extname(relativePath).toLowerCase())) throw new LoraResourceError(400, "invalid_lora_resource_media_path");
  const target = path.resolve(directory, relativePath);
  if (!isWithin(directory, target)) throw new LoraResourceError(400, "invalid_lora_resource_media_path");
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new LoraResourceError(404, "lora_resource_media_not_found");
  const [directoryReal, targetReal] = await Promise.all([realpath(directory), realpath(target)]);
  if (!isWithin(directoryReal, targetReal)) throw new LoraResourceError(422, "unsafe_lora_resource_storage");
  return { target, info };
}

export const loraResourceIdPattern = resourceIdPattern;
