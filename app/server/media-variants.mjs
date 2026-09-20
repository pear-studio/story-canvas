import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

export const MEDIA_VARIANT_WIDTHS = [320, 1024];

const inflight = new Map();

export function resolveMediaVariantWidth(value) {
  if (value === null || value === undefined || value === "") return null;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  for (const width of MEDIA_VARIANT_WIDTHS) {
    if (requested <= width) return width;
  }
  return null;
}

async function generateVariant(projectDirectory, media, relativePath, width, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const buffer = await sharp(media.target)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const staging = path.join(path.dirname(target), `.${path.basename(target, ".webp")}.${process.pid}.tmp`);
  await writeFile(staging, buffer);
  await rename(staging, target);
  return { target, info: await stat(target), contentType: "image/webp" };
}

export async function ensureMediaVariant(projectDirectory, media, relativePath, width) {
  const key = createHash("sha1")
    .update(`${relativePath}:${media.info.size}:${media.info.mtimeMs}:${media.info.ctimeMs}:${width}`)
    .digest("hex");
  const target = path.join(projectDirectory, "Saved", "media-cache", `${key}.webp`);
  try {
    const info = await stat(target);
    if (info.isFile()) return { target, info, contentType: "image/webp" };
  } catch {
    // 缓存未命中，按需生成
  }
  if (inflight.has(key)) return inflight.get(key);
  const task = generateVariant(projectDirectory, media, relativePath, width, target)
    .finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

// 图片入库时后台预热全部档位，首次访问直接命中磁盘缓存。
// 失败不影响发布，首次访问仍会按需生成。
export function warmMediaVariants(projectDirectory, relativePath) {
  return (async () => {
    const target = path.join(projectDirectory, ...relativePath.split("/"));
    const media = { target, info: await stat(target) };
    for (const width of MEDIA_VARIANT_WIDTHS) {
      await ensureMediaVariant(projectDirectory, media, relativePath, width);
    }
  })().catch(() => {});
}
