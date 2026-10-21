import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { writeVideoPreview,logVideoProcessing } from './video-media.mjs';
import {hasVideoPostprocess,normalizeVideoPostprocess} from '../shared/video-postprocess.mjs';
import {randomUUID} from 'node:crypto';
import {createMediaVariantTasks} from './media-variant-tasks.mjs';
import {retimeWebp} from './webp-timing.mjs';
import {trimWebp} from './webp-trim.mjs';

export const MEDIA_VARIANT_WIDTHS = [320, 1024];

const joinVariant = createMediaVariantTasks();

export function resolveMediaVariantWidth(value) {
  if (value === null || value === undefined || value === "") return null;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  for (const width of MEDIA_VARIANT_WIDTHS) {
    if (requested <= width) return width;
  }
  return null;
}

async function generateVariant(projectDirectory, media, relativePath, width, target, postprocess, signal) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(target), { recursive: true });
  const staging = path.join(path.dirname(target), `.${path.basename(target, ".webp")}.${randomUUID()}.tmp`);
  if (path.extname(media.target).toLowerCase() === '.mp4') {
    const started=performance.now();
    const trimmed=postprocess.trim_start_seconds!==0||postprocess.trim_end_seconds!==0;
    let retimeStarted,status='completed',failure,rebuiltFrames;
    try {
      if(postprocess.speed!==1) {
        // 不同倍率共用同一裁剪范围的原速派生物。
        const base=await ensureMediaVariant(projectDirectory,media,relativePath,width,{...postprocess,speed:1},signal);
        retimeStarted=performance.now();
        const source=await readFile(base.target,{signal});
        signal?.throwIfAborted();
        await writeFile(staging,retimeWebp(source,postprocess.speed),{signal});
      } else if(trimmed) {
        // 不同裁剪范围共用完整原速 WebP，边界以外的压缩帧直接复用。
        const base=await ensureMediaVariant(projectDirectory,media,relativePath,width,undefined,signal);
        retimeStarted=performance.now();
        const source=await readFile(base.target,{signal});
        const result=await trimWebp(source,postprocess,signal);
        rebuiltFrames=result.rebuiltFrames;
        await writeFile(staging,result.bytes,{signal});
      } else {
        await writeVideoPreview(media.target, staging, width, postprocess, signal);
      }
      signal?.throwIfAborted();
      await rename(staging, target);
      return { target, info: await stat(target), contentType: 'image/webp' };
    } catch(error) {
      status=signal?.aborted?'cancelled':'failed';failure=status==='failed'?error.message:undefined;throw error;
    } finally {
      await rm(staging, {force:true});
      if(postprocess.speed!==1)logVideoProcessing({event:'video_preview_retime',status,source:relativePath,width,settings:postprocess,
        elapsed_ms:Math.round(performance.now()-started),base_wait_ms:Math.round((retimeStarted??performance.now())-started),
        retime_ms:retimeStarted===undefined?null:Math.round(performance.now()-retimeStarted),error:failure});
      else if(trimmed)logVideoProcessing({event:'video_preview_trim',status,source:relativePath,width,settings:postprocess,
        elapsed_ms:Math.round(performance.now()-started),base_wait_ms:Math.round((retimeStarted??performance.now())-started),
        trim_ms:retimeStarted===undefined?null:Math.round(performance.now()-retimeStarted),rebuilt_frames:rebuiltFrames,error:failure});
    }
  }
  // Buffer 输入避免 libvips 缓存持有原图句柄，阻止 Windows 删除候选目录。
  const buffer = await sharp(await readFile(media.target), { animated: true })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  await writeFile(staging, buffer);
  await rename(staging, target);
  return { target, info: await stat(target), contentType: "image/webp" };
}

export async function ensureMediaVariant(projectDirectory, media, relativePath, width, postprocess, signal) {
  signal?.throwIfAborted();
  const started=performance.now();
  const edit=normalizeVideoPostprocess(postprocess),edited=hasVideoPostprocess(edit);
  if(edited&&path.extname(media.target).toLowerCase()!=='.mp4')throw new Error('后处理只支持 MP4 视频');
  const animation = /\.mp4$/i.test(relativePath) ? 'animation-v2:' : /\.webp$/i.test(relativePath) ? 'animation-v1:' : '';
  const key = createHash("sha1")
    .update(`${animation}${relativePath}:${media.info.size}:${media.info.mtimeMs}:${media.info.ctimeMs}:${width}${edited?':edit-v1:'+JSON.stringify(edit):''}`)
    .digest("hex");
  const target = path.join(projectDirectory, "Saved", "media-cache", `${key}.webp`);
  try {
    const info = await stat(target);
    if (info.isFile()) {
      if(path.extname(media.target).toLowerCase()==='.mp4')logVideoProcessing({event:'video_preview_cache',key,status:'hit',elapsed_ms:Math.round(performance.now()-started),source:relativePath,width,settings:edit});
      return { target, info, contentType: "image/webp" };
    }
  } catch {
    // 缓存未命中，按需生成
  }
  return joinVariant(target,signal=>generateVariant(projectDirectory, media, relativePath, width, target, edit,signal),signal);
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
