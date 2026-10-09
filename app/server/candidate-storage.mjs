import { inspectVideoBytes } from './video-media.mjs';
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

import { encodePageKey, pageKeyPathSegments } from "./page-key.mjs";
import { warmMediaVariants } from "./media-variants.mjs";
import { taskGenerationSignature } from "./generation-signature.mjs";
import { isCompletePng, resolveExistingProjectMedia, resolveProjectMediaTarget } from "./render-media.mjs";
import { candidateGenerationDetail } from "./candidate-generation.mjs";

export const candidateIdPattern = /^candidate-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class CandidateStorageError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isCandidateId(value) {
  return typeof value === "string" && candidateIdPattern.test(value);
}

export function requireCandidateId(value) {
  if (!isCandidateId(value)) throw new TypeError("candidate_id 必须是 candidate-<uuid> 格式");
  return value;
}

export function candidateFileRelativePath(pageKey, candidateId) {
  encodePageKey(pageKey);
  return path.posix.join("Outputs", ...pageKeyPathSegments(pageKey), requireCandidateId(candidateId), "image.png");
}

function projectRelativePath(projectDirectory, relativePath) {
  if (typeof projectDirectory !== "string" || !path.isAbsolute(projectDirectory)) throw new TypeError("项目目录必须是绝对路径");
  const projectRoot = path.resolve(projectDirectory);
  const target = path.resolve(projectRoot, ...relativePath.split("/"));
  if (!isWithin(projectRoot, target)) throw new TypeError("候选路径越出项目范围");
  return target;
}

export function candidateFilePath(projectDirectory, pageKey, candidateId) {
  return projectRelativePath(projectDirectory, candidateFileRelativePath(pageKey, candidateId));
}

export function createCandidateStorageIdentity(pageKey, uuidFactory = randomUUID) {
  const uuid = uuidFactory();
  const candidateId = uuid.startsWith("candidate-") ? uuid : `candidate-${uuid}`;
  requireCandidateId(candidateId);
  return { candidate_id: candidateId, file: candidateFileRelativePath(pageKey, candidateId) };
}


async function directories(target) {
  return (await readdir(target, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name);
}

export async function readCandidateGeneration(projectDirectory, pageKey, candidateId) {
  const file = candidateFileRelativePath(pageKey, candidateId).replace(/image\.png$/, "generation.json");
  const resolved = await resolveExistingProjectMedia(projectDirectory, file);
  if (!resolved) throw new Error("候选生成详情缺失");
  return JSON.parse(await readFile(resolved.target, "utf8"));
}

export async function readCandidateResult(projectDirectory, pageKey, candidateId) {
  const file = candidateFileRelativePath(pageKey, candidateId);
  const resolved = await resolveExistingProjectMedia(projectDirectory, file.replace(/image\.png$/, "result.json"));
  if (!resolved) return null;
  const result = JSON.parse(await readFile(resolved.target, "utf8"));
  if (result.version !== 1 || result.candidate_id !== candidateId || result.file !== file
    || encodePageKey(result.page_key) !== encodePageKey(pageKey) || result.status !== "available") throw new Error("候选成果契约无效");
  return result;
}

// 列表仅读取小型 result.json；生成详情只在用户打开详情时读取。
export async function readGenerationCandidateRecords(projectDirectory, { pageKey = null } = {}) {
  const keys = pageKey ? [pageKey] : [];
  if (!pageKey) {
    for (const pageId of await directories(path.join(projectDirectory, "Outputs", "pages"))) keys.push({ page_id: pageId });
  }
  const targets = [];
  for (const key of keys) {
    const directory = path.join(projectDirectory, "Outputs", ...pageKeyPathSegments(key));
    for (const id of await directories(directory)) {
      if (isCandidateId(id)) targets.push([key, id]);
    }
  }
  // 限流并发读取（与 counts 投影同一模式），避免整项目重扫串行等待每个文件的校验链。
  const records = new Array(targets.length).fill(null);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const [key, id] = targets[index];
      try { records[index] = await readCandidateResult(projectDirectory, key, id); }
      catch { /* 单个损坏成果不影响其他候选；详情读取仍报错。 */ }
    }
  }));
  return records.filter(Boolean);
}

// 三个文件准备完才发布整个目录。重复收集只接受已发布的同一任务成果，不覆盖图片。
// 批量搬移（如存储迁移的临时副本）传 warm: false：预热目标路径随后会被改名，写入即浪费。
export async function publishCandidateResult(projectDirectory, task, item, image, { submission = null, evidence = null, warm = true } = {}) {
  const video = item.video_settings ? await inspectVideoBytes(image,projectDirectory,item.video_settings) : null;
  if(video)image=video.poster;
  if (!isCompletePng(image)) throw new Error("候选输出不是完整 PNG");
  const existing = await readCandidateResult(projectDirectory, item.page_key, item.candidate_id);
  if (existing) {
    if (existing.task_id !== task.id) throw new Error("候选 ID 已被其他任务占用");
    await readCandidateGeneration(projectDirectory, item.page_key, item.candidate_id);
    if (!await resolveExistingProjectMedia(projectDirectory, existing.file)) throw new Error("已发布候选图片缺失");
    return existing;
  }
  const file = candidateFileRelativePath(item.page_key, item.candidate_id);
  const result = { version: 1, candidate_id: item.candidate_id, page_key: structuredClone(item.page_key), file,
    status: "available", task_id: task.id, item_id: item.id, seed: item.seed ?? null,
    generated_at: item.generated_at ?? task.completed_at ?? new Date().toISOString(),
    generation_signature: taskGenerationSignature(task, item) };
  const detail = { ...candidateGenerationDetail(task, { ...item, generated_at: result.generated_at }),
    submission: submission ?? { availability: "unavailable", reason: "历史任务未记录实际提交请求" }, evidence: evidence ?? { task_snapshot: structuredClone(task) } };
  const staging = path.join(projectDirectory, "Saved", "staging", "candidate-" + randomUUID());
  const destination = path.dirname(candidateFilePath(projectDirectory, item.page_key, item.candidate_id));
  // 使用已有媒体边界校验所有父目录，拒绝符号链接。
  // 不创建最终候选目录，避免暴露未完成成果。
  await resolveProjectMediaTarget(projectDirectory, path.posix.dirname(path.posix.dirname(file)) + "/.publish-check", { createParent: true });
  await resolveProjectMediaTarget(projectDirectory, path.relative(projectDirectory, staging).replaceAll("\\", "/") + "/image.png", { createParent: true });
  try {
    const generationText = JSON.stringify(detail, null, 2) + "\n";
    if(video){
      result.media_kind='video';result.video={...video.metadata,...item.video_settings};result.video_file=file.replace(/image\.png$/,'video.mp4');result.review_file=file.replace(/image\.png$/,'review.jpg');result.video_sha256=createHash('sha256').update(video.bytes).digest('hex');
      await writeFile(path.join(staging,'video.mp4'),video.bytes,{flag:'wx'});await writeFile(path.join(staging,'review.jpg'),video.review,{flag:'wx'});
    }
    result.image_sha256 = createHash("sha256").update(image).digest("hex");
    result.generation_sha256 = createHash("sha256").update(generationText).digest("hex");
    await writeFile(path.join(staging, "image.png"), image, { flag: "wx" });
    await writeFile(path.join(staging, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    await writeFile(path.join(staging, "generation.json"), generationText, { flag: "wx" });
    await rename(staging, destination);
    if (warm) {
      warmMediaVariants(projectDirectory, file);
      if (video) warmMediaVariants(projectDirectory, result.video_file);
    }
    return result;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
