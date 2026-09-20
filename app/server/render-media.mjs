import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { candidateFileRelativePath, isCandidateId } from "./candidate-storage.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";

const renderOutputDescriptorFields = new Set(["strategy", "storage", "kind", "candidate_id", "file", "promotion"]);
const frozenOutputFields = new Set(["node_id", "image_index", "item_id"]);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function descriptorValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value;
}

function assertDescriptorFields(value, label) {
  const unknown = Object.keys(value).filter((field) => !renderOutputDescriptorFields.has(field) && !frozenOutputFields.has(field));
  if (unknown.length) throw new Error(`${label}包含未知字段：${unknown.join("、")}`);
}

function sameCanonicalValue(left, right) {
  try {
    return hashCanonicalJson(left) === hashCanonicalJson(right);
  } catch {
    return false;
  }
}

function normalizeProjectRelativeFile(relativeFile, label = "项目媒体路径") {
  if (typeof relativeFile !== "string" || !relativeFile || relativeFile.includes("\0")) {
    throw new Error(`${label}无效：${String(relativeFile)}`);
  }
  const normalizedFile = relativeFile.replaceAll("\\", "/");
  if (path.isAbsolute(relativeFile) || path.win32.isAbsolute(relativeFile)
    || normalizedFile !== path.posix.normalize(normalizedFile)
    || normalizedFile === ".." || normalizedFile.startsWith("../") || normalizedFile.startsWith("/")) {
    throw new Error(`${label}无效：${relativeFile}`);
  }
  return normalizedFile;
}

function expectedDescriptor(purpose, item) {
  if (purpose !== "candidate") {
    throw new Error(`不支持的渲染输出策略：${String(purpose)}`);
  }
  const candidateId = item?.candidate_id;
  if (!isCandidateId(candidateId)) throw new Error(`${item?.id ?? "渲染条目"} 缺少有效 candidate_id`);
  const expectedFile = candidateFileRelativePath(item.page_key, candidateId);
  if (typeof item.file !== "string" || item.file.replaceAll("\\", "/") !== expectedFile) {
    throw new Error(`${item?.id ?? candidateId} 输出路径必须匹配 candidate_id`);
  }
  const promotion = { kind: "none", destination: null, state: null };
  return {
    strategy: purpose,
    storage: "Outputs",
    kind: purpose,
    candidate_id: candidateId,
    file: expectedFile,
    promotion,
  };
}

/**
 * 当前候选生成的输出边界。
 */
export function createRenderOutputAdapter(purpose) {
  if (purpose !== "candidate") {
    throw new Error(`不支持的渲染输出策略：${String(purpose)}`);
  }
  return {
    purpose,
    describe(item) {
      return expectedDescriptor(purpose, item);
    },
    provenance(item, { imageIndex, effectiveSeed = item.seed } = {}) {
      if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) throw new Error("PNG provenance 的 image_index 无效");
      const descriptor = this.describe(item);
      return {
        image_index: imageIndex,
        item_id: item.id,
        candidate_id: item.candidate_id,
        page_key: structuredClone(item.page_key),
        declared_seed: item.seed,
        effective_seed: effectiveSeed,
        output: descriptor,
      };
    },
    validate(descriptor, item) {
      const value = descriptorValue(descriptor, "冻结输出 descriptor");
      assertDescriptorFields(value, "冻结输出 descriptor");
      const expected = this.describe(item);
      for (const field of renderOutputDescriptorFields) {
        if (!sameCanonicalValue(value[field], expected[field])) {
          throw new Error(`冻结输出 descriptor.${field} 无效`);
        }
      }
      return expected;
    },
    async resolve(projectRoot, descriptor, { item, createParent = false } = {}) {
      const expected = this.validate(descriptor, item);
      return resolveProjectMediaTarget(projectRoot, expected.file, { createParent });
    },

  };
}

export function createRenderOutputDescriptor({ purpose, item }) {
  return createRenderOutputAdapter(purpose).describe(item);
}

export function validateRenderOutputDescriptor(descriptor, { purpose, item } = {}) {
  return createRenderOutputAdapter(purpose).validate(descriptor, item);
}

export function resolveRenderOutputTarget(projectRoot, descriptor, { purpose, item, createParent = false } = {}) {
  const strategy = purpose ?? descriptor?.strategy;
  return createRenderOutputAdapter(strategy).resolve(projectRoot, descriptor, { item, createParent });
}

export function isCompletePng(value) {
  if (!Buffer.isBuffer(value) || value.length < 20) return false;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return value.subarray(0, 8).equals(signature) && value.subarray(-8, -4).toString("ascii") === "IEND";
}

export async function resolveProjectMediaTarget(projectRoot, relativeFile, { createParent = false } = {}) {
  const normalizedFile = normalizeProjectRelativeFile(relativeFile);
  const resolvedProject = path.resolve(projectRoot);
  const projectReal = await realpath(resolvedProject);
  const target = path.resolve(resolvedProject, ...normalizedFile.split("/"));
  if (!isWithin(resolvedProject, target) || !isWithin(projectReal, await realpath(resolvedProject))) {
    throw new Error(`项目媒体路径越界：${relativeFile}`);
  }
  const segments = path.relative(resolvedProject, target).split(path.sep).filter(Boolean);
  let cursor = resolvedProject;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const final = index === segments.length - 1;
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (final || !createParent) return { file: normalizedFile, target, exists: false };
      await mkdir(cursor, { recursive: false });
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink()) throw new Error(`项目媒体路径不能是链接：${relativeFile}`);
    if ((!final && !info.isDirectory()) || (final && !info.isFile())) {
      throw new Error(`项目媒体路径类型无效：${relativeFile}`);
    }
    const actual = await realpath(cursor);
    if (!isWithin(projectReal, actual)) throw new Error(`项目媒体路径越界：${relativeFile}`);
  }
  return { file: normalizedFile, target, exists: true };
}

export async function resolveExistingProjectMedia(projectRoot, relativeFile) {
  const resolved = await resolveProjectMediaTarget(projectRoot, relativeFile);
  return resolved.exists ? { file: resolved.file, target: resolved.target } : null;
}
