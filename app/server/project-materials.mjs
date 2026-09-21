import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  emptyCreativeAgreement,
  emptyMaterialMetadata,
  normalizeMaterialPath,
  ProjectContractError,
  validateCreativeAgreement,
  validateMaterialMetadata,
} from "./project-contracts.mjs";

const textExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv"]);
const imageTypes = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"], [".gif", "image/gif"], [".svg", "image/svg+xml"],
]);
const maxMaterialBytes = 32 * 1024 * 1024;
const maxTextPreviewBytes = 2 * 1024 * 1024;

async function writeFileAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { flag: "wx" });
  await rename(temporary, target);
}

async function writeJsonAtomic(target, value) {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(target, fallback) {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return structuredClone(fallback); throw error; }
}

async function ensurePlainSourceRoot(projectDirectory) {
  const sourceRoot = path.join(projectDirectory, "materials");
  await mkdir(sourceRoot, { recursive: true });
  const info = await lstat(sourceRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectContractError(409, "unsafe_source_directory");
  return sourceRoot;
}

async function resolveMaterialTarget(projectDirectory, relativeFile, { allowMissing = false } = {}) {
  const file = normalizeMaterialPath(relativeFile);
  const sourceRoot = await ensurePlainSourceRoot(projectDirectory);
  const target = path.join(sourceRoot, file);
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) {
    if (!allowMissing) throw new ProjectContractError(404, "material_not_found");
  } else if (info.isSymbolicLink()) {
    throw new ProjectContractError(409, "unsafe_material_path");
  }
  return { sourceRoot, target, file };
}

function materialKind(file) {
  const extension = path.extname(file).toLowerCase();
  if (imageTypes.has(extension)) return "image";
  if (textExtensions.has(extension)) return "text";
  return "file";
}

function materialContentType(file) {
  const extension = path.extname(file).toLowerCase();
  return imageTypes.get(extension) ?? (textExtensions.has(extension) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

async function discoverMaterialFiles(projectDirectory) {
  const sourceRoot = await ensurePlainSourceRoot(projectDirectory);
  const files = [];
  for (const entry of (await readdir(sourceRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    if (entry.isFile() && entry.name !== "index.json") files.push(entry.name);
  }
  return files;
}

async function describeMaterial(projectDirectory, projectId, file, title = null) {
  const { target } = await resolveMaterialTarget(projectDirectory, file, { allowMissing: true });
  let info;
  try { info = await stat(target); } catch (error) {
    if (error?.code === "ENOENT") return { file, title: title ?? path.basename(file), available: false, kind: materialKind(file), size_bytes: null, modified_at: null, text: null, url: null };
    throw error;
  }
  if (!info.isFile()) throw new ProjectContractError(409, "material_not_file");
  const kind = materialKind(file);
  const text = kind === "text" && info.size <= maxTextPreviewBytes ? await readFile(target, "utf8") : null;
  return {
    file,
    title: title ?? path.basename(file),
    available: true,
    kind,
    size_bytes: info.size,
    modified_at: info.mtime.toISOString(),
    text,
    url: `/api/projects/${encodeURIComponent(projectId)}/materials/file?file=${encodeURIComponent(file)}`,
  };
}

export async function readProjectMaterials(projectDirectory, projectId) {
  const [metadata, agreement, discovered] = await Promise.all([
    readJson(path.join(projectDirectory, "materials", "index.json"), emptyMaterialMetadata()),
    readJson(path.join(projectDirectory, "creative-agreement.json"), emptyCreativeAgreement()),
    discoverMaterialFiles(projectDirectory),
  ]);
  const metadataErrors = validateMaterialMetadata(metadata);
  if (metadataErrors.length) throw new ProjectContractError(422, "invalid_material_metadata", metadataErrors);
  const agreementErrors = validateCreativeAgreement(agreement);
  if (agreementErrors.length) throw new ProjectContractError(422, "invalid_creative_agreement", agreementErrors);
  const titles = new Map(metadata.items.map((item) => [normalizeMaterialPath(item.file), item.title]));
  const materials = await Promise.all(discovered.map((file) => describeMaterial(projectDirectory, projectId, file, titles.get(file))));
  return { agreement, materials };
}

export async function saveMaterialMetadata(projectDirectory, value) {
  const errors = validateMaterialMetadata(value);
  if (errors.length) throw new ProjectContractError(422, "invalid_material_metadata", errors);
  const metadata = {
    ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
    items: value.items.map((item) => ({ title: item.title.trim(), file: normalizeMaterialPath(item.file) })),
  };
  await writeJsonAtomic(path.join(await ensurePlainSourceRoot(projectDirectory), "index.json"), metadata);
  return metadata;
}

export async function saveCreativeAgreement(projectDirectory, value) {
  const errors = validateCreativeAgreement(value);
  if (errors.length) throw new ProjectContractError(422, "invalid_creative_agreement", errors);
  const agreement = structuredClone(value);
  await writeJsonAtomic(path.join(projectDirectory, "creative-agreement.json"), agreement);
  return agreement;
}

function validateMaterialTitle(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new ProjectContractError(422, "invalid_material_title");
  return value.trim();
}

function materialContent(value) {
  if (value.encoding === "base64" && typeof value.content === "string") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content)) throw new ProjectContractError(422, "invalid_material_content");
    return Buffer.from(value.content, "base64");
  }
  if ((value.encoding === undefined || value.encoding === "utf8") && typeof value.content === "string") return Buffer.from(value.content, "utf8");
  throw new ProjectContractError(422, "invalid_material_content");
}

export async function saveMaterial(projectDirectory, projectId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectContractError(422, "invalid_material_file");
  const unknown = Object.keys(value).filter((key) => !new Set(["file", "title", "encoding", "content"]).has(key));
  if (unknown.length) throw new ProjectContractError(422, "invalid_material_file", unknown.map((key) => `未知字段：${key}`));
  const title = validateMaterialTitle(value.title);
  const metadata = await readJson(path.join(projectDirectory, "materials", "index.json"), emptyMaterialMetadata());
  const metadataErrors = validateMaterialMetadata(metadata);
  if (metadataErrors.length) throw new ProjectContractError(422, "invalid_material_metadata", metadataErrors);
  const hasContent = Object.hasOwn(value, "content") || Object.hasOwn(value, "encoding");
  const { target, file } = await resolveMaterialTarget(projectDirectory, value.file, { allowMissing: hasContent });
  if (hasContent) {
    const content = materialContent(value);
    if (content.length > maxMaterialBytes) throw new ProjectContractError(413, "material_too_large");
    await writeFileAtomic(target, content);
  } else {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new ProjectContractError(409, "material_not_file");
  }
  const items = metadata.items.some((item) => item.file === file)
    ? metadata.items.map((item) => item.file === file ? { file, title } : item)
    : [...metadata.items, { file, title }];
  await saveMaterialMetadata(projectDirectory, { items });
  return describeMaterial(projectDirectory, projectId, file, title);
}

export async function deleteMaterial(projectDirectory, relativeFile, { allowMissing = false } = {}) {
  const { target, file } = await resolveMaterialTarget(projectDirectory, relativeFile, { allowMissing });
  const info = await lstat(target).catch(error => { if (allowMissing && error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new ProjectContractError(409, "material_not_file");
  if (info) await unlink(target);
  const metadata = await readJson(path.join(projectDirectory, "materials", "index.json"), emptyMaterialMetadata());
  const next = { ...metadata, items: (metadata.items ?? []).filter((item) => item.file !== file) };
  if (validateMaterialMetadata(next).length === 0) await saveMaterialMetadata(projectDirectory, next);
  return { deleted: true, file };
}

export async function openMaterialFile(projectDirectory, relativeFile) {
  const { target, file } = await resolveMaterialTarget(projectDirectory, relativeFile);
  const info = await stat(target);
  if (!info.isFile() || info.size > maxMaterialBytes) throw new ProjectContractError(info.size > maxMaterialBytes ? 413 : 409, info.size > maxMaterialBytes ? "material_too_large" : "material_not_file");
  return { target, file, info, contentType: materialContentType(file) };
}
