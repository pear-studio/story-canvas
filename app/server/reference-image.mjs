import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { normalizeMaterialPath } from "./project-contracts.mjs";
import { openMaterialFile } from "./project-materials.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function isReferenceImageFile(file) {
  try { return normalizeMaterialPath(file) === file && /\.(png|jpe?g|webp)$/i.test(file); }
  catch { return false; }
}

export function referenceImageFilename(identity) {
  if (!identity || !/^[a-f0-9]{64}$/.test(identity.sha256) || !isReferenceImageFile(identity.material_file)
    || !/^[a-f0-9]{64}$/.test(identity.source_sha256)) throw new Error("参考图冻结身份无效");
  return `StoryCanvas/references/${identity.sha256}.png`;
}

export async function readReferenceImage(projectDirectory, file) {
  if (!isReferenceImageFile(file)) throw new Error("参考图必须是项目材料中的 PNG、JPEG 或 WebP");
  const { target } = await openMaterialFile(projectDirectory, file);
  const source = await readFile(target);
  const metadata = await sharp(source).metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error("参考图必须是单张 PNG、JPEG 或 WebP");
  const { data: bytes, info } = await sharp(source).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  return { identity: { material_file: file, source_sha256: hash(source), sha256: hash(bytes), width: info.width, height: info.height }, bytes };
}

export async function persistReferenceImage(directory, items, images = []) {
  const references = items.flatMap(item => item.reference_images ?? []);
  if (!references.length) return;
  await mkdir(path.join(directory, "inputs"), { recursive: true });
  const saved = new Set();
  for (const reference of references) {
    referenceImageFilename(reference);
    const bytes = images.find(image => image.identity.sha256 === reference.sha256)?.bytes;
    if (!bytes || hash(bytes) !== reference.sha256) throw new Error("参考图内容与冻结身份不一致");
    if (saved.has(reference.sha256)) continue;
    await writeFile(path.join(directory, "inputs", reference.sha256 + '.png'), bytes, { flag: "wx" });
    saved.add(reference.sha256);
  }
}

export async function uploadFrozenReferenceImage(apiUrl, taskDirectory, identity) {
  referenceImageFilename(identity);
  const bytes = await readFile(path.join(taskDirectory, "inputs", `${identity.sha256}.png`));
  if (hash(bytes) !== identity.sha256) throw new Error("冻结参考图校验失败，请重新创建任务");
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), `${identity.sha256}.png`);
  form.append("subfolder", "StoryCanvas/references");
  form.append("type", "input");
  form.append("overwrite", "true");
  const response = await fetch(`${apiUrl}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`参考图上传失败：HTTP ${response.status}`);
  const uploaded = await response.json();
  if (!uploaded.name) throw new Error("ComfyUI 未返回参考图文件名");
  return [uploaded.subfolder, uploaded.name].filter(Boolean).join("/");
}
