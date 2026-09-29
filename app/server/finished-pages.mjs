import { defaultTextPageLayout } from "../shared/text-page-layout.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { candidateFileRelativePath, readCandidateGeneration, readGenerationCandidateRecords, requireCandidateId } from "./candidate-storage.mjs";
import { readProjectWorkbenchView } from "./project-workbench.mjs";
import { encodePageKey } from "./page-key.mjs";
import { resolveExistingProjectMedia } from "./render-media.mjs";
import { warmMediaVariants } from "./media-variants.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { listFinishedJobs, finishedBusyStatuses as busyStatuses } from "./finished-jobs.mjs";
export { listFinishedJobs } from "./finished-jobs.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";
import { resolveLocalComfyTarget } from "./comfy-runtime.mjs";
import { uploadComfyImage, compileLoraUpscaleWorkflow } from "./lora-training-media.mjs";
import { waitComfyHistory, historyImages } from "./lora-training-runtime.mjs";
import resourceCatalog from "../../library/resources/catalog.json" with { type: "json" };

const modelResource = resourceCatalog.models.find(model => model.id === "animesharp-v4-2x");
export const finishedModel = { name: modelResource.filename, sha256: modelResource.sha256, scale: 2, source: modelResource.source };
const sha = buffer => createHash("sha256").update(buffer).digest("hex");
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: "finished_page_error" }); }
async function optionalJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n"); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
function pageId(key) { encodePageKey(key); return key.page_id; }
const recordPath = (directory, id) => path.join(directory, "finished", `${pageId({ page_id: id })}.json`);
const jobPath = (directory, id) => path.join(directory, "Saved", "finished", `${pageId({ page_id: id })}.json`);
export const readFinishedRecord = (directory, id) => optionalJson(recordPath(directory, id));
export function orderedFinishedPages(view) {
  return view.outline.chapters.flatMap(chapter => chapter.sequences.flatMap(sequence => sequence.pages.map(page => ({ page, chapter_id: chapter.id, chapter_title: chapter.title, sequence_title: sequence.title }))));
}
function letteringSnapshot(view, page, canvas = page.render?.canvas ?? view.project.canvas) {
  const settings = structuredClone(view.project.lettering_settings);
  if (page.page_kind === "text") return { page_kind: "text", display_title: page.display_title ?? "", body: page.body ?? "", text_layout: structuredClone(page.text_layout ?? defaultTextPageLayout), settings: { font_family: settings.font_family }, canvas };
  const speakers = new Set((page.dialogue ?? []).map(line => line.speaker).filter(Boolean));
  settings.character_colors = Object.fromEntries(Object.entries(settings.character_colors).filter(([id]) => speakers.has(id)));
  return { dialogue: page.dialogue ?? [], items: page.lettering?.items ?? [], settings, canvas };
}
export async function readFinishedPages(repositoryRoot, projectId, directory, { page_id = null } = {}) {
  const view = await readProjectWorkbenchView(repositoryRoot, projectId, {kind:'finished',page_id});
  const jobs = await listFinishedJobs(directory);
  const pages = [];
  const entries = page_id ? view.pages.filter(page => page.page_id === page_id).map(page => ({ page })) : orderedFinishedPages(view);
  for (const { page, ...chapter } of entries) {
    if (page_id && page.page_id !== page_id) continue;
    const record = await readFinishedRecord(directory, page.page_id);
    const candidates = page.page_kind === "text" ? null : await readGenerationCandidateRecords(directory, { pageKey: page.page_key });
    const candidate = candidates?.length === 1 ? candidates[0].candidate_id : null;
    const files = record ? await Promise.all(["lettered", "clean"].map(kind => resolveExistingProjectMedia(directory, record.outputs[kind]))) : [];
    const available = files.length === 2 && files.every(Boolean);
    const dimensions = page.page_kind === 'text' ? (page.render_capabilities ?? view.render_capabilities).text_page?.dimensions : null;
    const dimensionsChanged = dimensions && record && (record.width !== dimensions.width || record.height !== dimensions.height);
    const stale = record ? Boolean(dimensionsChanged) || (candidate !== null && candidate !== record.candidate_id) || hashCanonicalJson(letteringSnapshot(view, page, page.page_kind === "text" ? undefined : record.lettering.canvas)) !== hashCanonicalJson(record.lettering) : false;
    const url = kind => `/api/projects/${encodeURIComponent(projectId)}/media/${record.outputs[kind]}`;
    pages.push({ ...chapter, page_id: page.page_id, page_key: page.page_key, title: page.title,
      candidate_id: candidate, candidate_count: candidates?.length ?? null,
      batch_skip_reason: candidates?.length === 0 ? "没有候选图" : candidates && candidates.length > 1 ? `有 ${candidates.length} 张候选，请只保留一张` : null,
      status: !record ? "missing" : !available ? "files_missing" : stale ? "stale" : "ready",
      job: jobs.find(job => job.page_id === page.page_id) ?? null,
      record: record ? { sha256: hashCanonicalJson(record), candidate_id: record.candidate_id ?? null, width: record.width, height: record.height, created_at: record.created_at,
        bytes: available ? (await stat(files[0].target)).size : null,
        lettered_url: available ? url("lettered") : null, clean_url: available ? url("clean") : null } : null });
  }
  return { pages };
}

export async function deleteFinishedPage(directory, value) {
  const id = pageId(value?.page_key);
  if ((await listFinishedJobs(directory)).some(job => job.page_id === id && busyStatuses.has(job.status))) fail("本页正在输出成品，请等待完成后再删除");
  const record = await readFinishedRecord(directory, id);
  if (!record || hashCanonicalJson(record) !== value.expected_sha256) fail("本页成品已变化，请刷新后再删除");
  await unlink(recordPath(directory, id));
  for (const relative of Object.values(record.outputs)) {
    if (!relative.startsWith(`Outputs/finished/${id}/`)) continue;
    const media = await resolveExistingProjectMedia(directory, relative);
    if (media) { await unlink(media.target); await rmdir(path.dirname(media.target)).catch(() => {}); }
  }
  await unlink(jobPath(directory, id)).catch(error => { if (error.code !== "ENOENT") throw error; });
  return { deleted: true };
}

export async function upscaleFinishedImage(source, config, token) {
  const apiUrl = primaryComfyUiUrl(config);
  if (!apiUrl) fail("请先连接 ComfyUI");
  if (config.models_root && resolveLocalComfyTarget(apiUrl, null).reason !== "remote_instance") {
    const model = await readFile(path.join(config.models_root, "upscale_models", finishedModel.name)).catch(() => null);
    if (!model || sha(model) !== finishedModel.sha256) fail(`超分模型缺失或校验值不匹配：${finishedModel.name}`);
  }
  const info = await fetch(`${apiUrl}/object_info/UpscaleModelLoader`, { signal: AbortSignal.timeout(15_000) });
  const nodes = await info.json();
  const input = nodes.UpscaleModelLoader?.input?.required?.model_name;
  const names = input?.[0] === "COMBO" ? input[1]?.options : input?.[0];
  if (!Array.isArray(names) || !names.includes(finishedModel.name)) fail(`ComfyUI 缺少超分模型：${finishedModel.name}`);
  const image = await uploadComfyImage(apiUrl, source, `finished-${token}.png`);
  const workflow = compileLoraUpscaleWorkflow({ image, modelName: finishedModel.name, filenamePrefix: `story-canvas/finished/${token}` });
  const response = await fetch(`${apiUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow }), signal: AbortSignal.timeout(30_000) });
  const submitted = await response.json();
  if (!response.ok || !submitted.prompt_id) fail(`超分提交失败：${JSON.stringify(submitted.error ?? submitted)}`);
  const history = await waitComfyHistory(apiUrl, submitted.prompt_id);
  const output = historyImages(history)[0];
  if (!output) fail(`超分未返回图片：${JSON.stringify(history.status?.messages ?? [])}`);
  const media = await fetch(`${apiUrl}/view?${new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? "", type: output.type ?? "output" })}`, { signal: AbortSignal.timeout(60_000) });
  if (!media.ok) fail("读取超分图片失败");
  return Buffer.from(await media.arrayBuffer());
}

// 保存领域入口由 ProjectOperations 包裹；耗时计算在项目锁外执行。
// queuedJob 是批量输出预先写入的排队占位任务，匹配时直接沿用，保持队列里任务身份稳定。
export async function prepareFinishedPage(repositoryRoot, projectId, directory, value, { queuedJob = null } = {}) {
  const id = pageId(value?.page_key);
  const jobs = await listFinishedJobs(directory);
  const busy = jobs.find(job => job.page_id === id && busyStatuses.has(job.status));
  if (busy && busy.id !== queuedJob?.id) fail("本页正在输出成品");
  const view = await readProjectWorkbenchView(repositoryRoot, projectId, {kind:'finished',page_id:id});
  const page = view.pages.find(page => page.page_id === id);
  if (!page) fail("页面已经删除", 404);
  const old = await readFinishedRecord(directory, id);
  const job = queuedJob ?? { id: `finished-${randomUUID()}`, page_id: id, project_id: projectId, status: "queued", pid: process.pid, created_at: new Date().toISOString(), error: null };
  const storyIndex = orderedFinishedPages(view).findIndex(entry => entry.page.page_id === id);
  job.page_label = storyIndex >= 0 ? String(storyIndex + 1).padStart(3, "0") : page.title || id;
  if (page.page_kind === "text") {
    // 文字页没有候选底图：黑底按当前渲染配置候选出图尺寸的 2 倍直接渲染，与超分后的普通成品同尺寸。
    const textPage = (page.render_capabilities ?? view.render_capabilities).text_page;
    if (!textPage.dimensions) fail(textPage.error);
    const dimensions = textPage.dimensions;
    const snapshot = { page_key: page.page_key, page_kind: "text", lettering: letteringSnapshot(view, page) };
    await writeJson(jobPath(directory, id), job);
    return { job, snapshot, sourceBuffer: null, reuse: null, expected: hashCanonicalJson(old), old, textPage: dimensions };
  }
  requireCandidateId(value.candidate_id);
  if (queuedJob) {
    const candidates = await readGenerationCandidateRecords(directory, { pageKey: page.page_key });
    if (candidates.length !== 1 || candidates[0].candidate_id !== value.candidate_id) fail("候选已变化，请只保留一张候选后重新制作");
  }
  const source = await resolveExistingProjectMedia(directory, candidateFileRelativePath(page.page_key, value.candidate_id));
  const reuse = old?.candidate_id === value.candidate_id && old.upscale.name === finishedModel.name
    && old.upscale.sha256 === finishedModel.sha256 ? await resolveExistingProjectMedia(directory, old.outputs.clean) : null;
  if (!source && !reuse) fail("候选底图已不存在；请根据成品记录重新生成候选，再输出成品");
  const sourceBuffer = source ? await readFile(source.target) : null;
  const dimensions = await sharp(sourceBuffer ?? await readFile(reuse.target)).metadata();
  const generation = source ? await readCandidateGeneration(directory, page.page_key, value.candidate_id) : old.generation;
  const snapshot = { page_key: page.page_key, candidate_id: value.candidate_id,
    source_sha256: sourceBuffer ? sha(sourceBuffer) : old.source_sha256,
    generation: Object.fromEntries(["seed", "execution_seed", "prompt", "models", "loras", "recipe", "canvas", "render_profile", "render_route"].map(key => [key, generation[key] ?? null])),
    lettering: letteringSnapshot(view, page, sourceBuffer ? `${dimensions.width}:${dimensions.height}` : old.lettering.canvas), upscale: finishedModel };
  const reuseValid = reuse && (!sourceBuffer || snapshot.source_sha256 === old.source_sha256);
  await writeJson(jobPath(directory, id), job);
  return { job, snapshot, sourceBuffer, reuse: reuseValid ? reuse.target : null, expected: hashCanonicalJson(old), old };
}

export async function publishFinishedPage(repositoryRoot, projectId, directory, prepared, record) {
  const { page_id: id } = prepared.job;
  if (hashCanonicalJson(await readFinishedRecord(directory, id)) !== prepared.expected) fail("本页成品已被其他操作更新，请重新读取");
  const view = await readProjectWorkbenchView(repositoryRoot, projectId, {kind:'directory'});
  const pages = [...view.outline.chapters.flatMap(chapter=>chapter.sequences.flatMap(sequence=>sequence.pages)), ...view.characters.flatMap(setting=>setting.pages), ...view.scenes.scenes.flatMap(setting=>setting.pages), ...view.orphan_pages];
  if (!pages.some(page => page.page_id === id)) fail("页面已删除，本次输出不再发布");
  await writeJson(recordPath(directory, id), record);
}

export async function runFinishedPage({ repositoryRoot, projectId, directory, prepared, config, origin, mutateTargetFacts,
  upscale = upscaleFinishedImage, render = (...args) => import("./finished-render.mjs").then(module => module.renderFinishedImage(...args)) }) {
  const { job, snapshot } = prepared;
  let outputs = null;
  let published = false;
  const update = async (status, error = null) => { job.status = status; job.error = error; const now = new Date().toISOString(); job.started_at ??= now; if (status === "completed") job.completed_at = now; if (status === "failed") job.failed_at = now; await writeJson(jobPath(directory, job.page_id), job); };
  try {
    await update(prepared.reuse || prepared.textPage ? "lettering" : "upscaling");
    const cleanBuffer = prepared.textPage
      ? await sharp({ create: { width: prepared.textPage.width, height: prepared.textPage.height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
      : prepared.reuse ? await readFile(prepared.reuse) : await upscale(prepared.sourceBuffer, { ...config, ...(config.models_root ? { models_root: path.resolve(repositoryRoot, config.models_root) } : {}) }, job.id);
    // 分享图片不附带 ComfyUI 写入的工作流等 PNG 文本块。
    const clean = await sharp(cleanBuffer).png().toBuffer();
    const { width, height } = await sharp(clean).metadata();
    if (!prepared.reuse && !prepared.textPage) {
      const original = await sharp(prepared.sourceBuffer).metadata();
      if (width !== original.width * 2 || height !== original.height * 2) fail("超分输出尺寸不是原图的 2 倍");
    }
    await update("lettering");
    const lettered = await render(clean, snapshot.lettering, origin);
    const dimensions = await sharp(lettered).metadata();
    if (dimensions.width !== width || dimensions.height !== height) fail("嵌字输出尺寸不匹配");
    const prefix = `Outputs/finished/${job.page_id}/${job.id}`;
    outputs = { clean: `${prefix}/clean.png`, lettered: `${prefix}/lettered.png` };
    await mkdir(path.join(directory, prefix), { recursive: true });
    await writeFile(path.join(directory, outputs.clean), clean);
    await writeFile(path.join(directory, outputs.lettered), lettered);
    await update("publishing");
    const record = { $schema: "https://storyvisualizer.local/schemas/finished-page.schema.json", ...snapshot, created_at: new Date().toISOString(), width, height, outputs };
    await mutateTargetFacts(projectId, () => publishFinishedPage(repositoryRoot, projectId, directory, prepared, record));
    published = true;
    for (const relative of Object.values(outputs)) warmMediaVariants(directory, relative);
    await update("completed");
  } catch (error) { await update("failed", error.message); }
  // 只清理本次失败产物或已被成功替换的两个文件，不递归清理生成目录。
  const obsolete = published ? prepared.old?.outputs : outputs;
  for (const relative of Object.values(obsolete ?? {})) {
    if (!relative.startsWith(`Outputs/finished/${job.page_id}/`)) continue;
    const media = await resolveExistingProjectMedia(directory, relative).catch(() => null);
    if (media) { await unlink(media.target).catch(() => {}); await rmdir(path.dirname(media.target)).catch(() => {}); }
  }
  return job;
}

// 批量输出只采用当前唯一候选；零张或多张候选跳过，文字页无需候选。
// force 时连已就绪页面一起排队，用于样式代码变化后的整批重新嵌字（候选未变会复用超分底图）。
export async function planFinishedBatch(repositoryRoot, projectId, directory, { chapter_id = null, force = false } = {}) {
  const { pages } = await readFinishedPages(repositoryRoot, projectId, directory);
  const statuses = force ? ["missing", "stale", "files_missing", "ready"] : ["missing", "stale", "files_missing"];
  const targets = [];
  const skipped = [];
  for (const [index, page] of pages.entries()) {
    if (chapter_id && page.chapter_id !== chapter_id) continue;
    if (!statuses.includes(page.status)) continue;
    if (page.job && busyStatuses.has(page.job.status)) continue;
    const page_label = String(index + 1).padStart(3, "0");
    if (page.batch_skip_reason) { skipped.push({ page_id: page.page_id, title: page.title, reason: page.batch_skip_reason }); continue; }
    targets.push({ page_key: page.page_key, ...(page.candidate_id ? { candidate_id: page.candidate_id } : {}), page_label });
  }
  return { targets, skipped };
}

// 与单页输出同一路径串行执行；单页失败或计划在锁外过期只影响本页，不中断后续页面。
// 提交时先为全部目标写入排队占位任务，再逐页准备执行，全局任务列表和浏览器标题才能反映真实剩余数量。
export async function runFinishedBatch({ repositoryRoot, projectId, directory, targets, config, origin, mutateDerived, mutateTargetFacts, upscale, render }) {
  const results = { completed: 0, failed: 0 };
  const placeholders = new Map();
  const busy = new Set((await listFinishedJobs(directory)).filter(job => busyStatuses.has(job.status)).map(job => job.page_id));
  for (const target of targets) {
    const id = pageId(target.page_key);
    if (busy.has(id)) continue;
    const job = { id: `finished-${randomUUID()}`, page_id: id, page_label: target.page_label ?? id, project_id: projectId, status: "queued", pid: process.pid, created_at: new Date().toISOString(), error: null };
    await writeJson(jobPath(directory, id), job);
    placeholders.set(id, job);
  }
  const pending = new Set(placeholders.keys());
  // 批量共享一个渲染浏览器，避免每页重复启动 Chromium 和加载字体。
  let renderer = null;
  const sharedRender = render ?? (async (clean, lettering) => {
    renderer ??= (await import("./finished-render.mjs")).createFinishedRenderer(origin);
    return renderer.render(clean, lettering);
  });
  try {
    for (const target of targets) {
      const id = pageId(target.page_key);
      let prepared = null;
      try {
        prepared = (await mutateDerived(projectId, ({ projectDirectory }) => prepareFinishedPage(repositoryRoot, projectId, projectDirectory, target, { queuedJob: placeholders.get(id) ?? null }))).value;
      } catch (error) {
        const now = new Date().toISOString();
        const placeholder = placeholders.get(id);
        await writeJson(jobPath(directory, id), { id: placeholder?.id ?? `finished-${randomUUID()}`, page_id: id, page_label: placeholder?.page_label ?? id, project_id: projectId, status: "failed", pid: process.pid, created_at: placeholder?.created_at ?? now, failed_at: now, error: error.message });
        results.failed += 1;
        pending.delete(id);
        continue;
      }
      const job = await runFinishedPage({ repositoryRoot, projectId, directory, prepared, config, origin, mutateTargetFacts, upscale, render: sharedRender });
      results[job.status === "completed" ? "completed" : "failed"] += 1;
      pending.delete(id);
    }
  } finally {
    if (renderer) await renderer.close();
    for (const id of pending) {
      await writeJson(jobPath(directory, id), { ...placeholders.get(id), status: "failed", failed_at: new Date().toISOString(), error: "批量输出中断，请重新输出" }).catch(() => {});
    }
  }
  return results;
}
