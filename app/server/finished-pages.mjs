import {captureLayers,layerFingerprint,resolveLayerMedia} from './page-layers.mjs';
import {emptyLayers} from '../shared/image-layers.mjs';
import {composeImageLayers} from './image-layer-render.mjs';
import { requireLetteringLocale, readTranslationDocument, translationProjection, localizeLettering } from './page-translation-document.mjs';
import { defaultTextPageLayout } from "../shared/text-page-layout.mjs";
import {storyPageNumbers} from '../shared/story-page-numbers.mjs';
import {visibleCollageItems,collageSourceIds,collageSize,collageWithoutMaterials} from '../shared/collage-layout.mjs';
import {captureCollage,composeCollage,resolveCollageMedia,collageMediaFingerprint} from './collage-pages.mjs';
import {comicGeometry} from '../shared/comic-layout.mjs';
import {hasVideoPostprocess,normalizeVideoPostprocess,videoPostprocessTiming} from '../shared/video-postprocess.mjs';
import {prepareAnimationFiles} from './animation-output.mjs';
import {sharedFinishedCleanPath,writeSharedFinishedClean,cleanupFinishedMedia,finishedRecordMedia} from './finished-media.mjs';

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { replaceFileWithRetry } from "./file-replace.mjs";
import path from "node:path";
import sharp from "sharp";
import { candidateFileRelativePath, readCandidateResult, readCandidateGeneration, readGenerationCandidateRecords, uniqueCandidateSelection, requireCandidateId } from "./candidate-storage.mjs";
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
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n"); await replaceFileWithRetry(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
function pageId(key) { encodePageKey(key); return key.page_id; }
const localeSuffix=locale=>requireLetteringLocale(locale)==='zh'?'':`.${locale}`;
const recordPath = (directory, id, locale='zh') => path.join(directory, "finished", `${pageId({ page_id: id })}${localeSuffix(locale)}.json`);
const jobPath = (directory, id, locale='zh') => path.join(directory, "Saved", "finished", `${pageId({ page_id: id })}${localeSuffix(locale)}.json`);
export const readFinishedRecord = (directory, id, locale='zh') => optionalJson(recordPath(directory, id,locale));
export function orderedFinishedPages(view) {
  return view.outline.chapters.flatMap(chapter => chapter.sequences.flatMap(sequence => sequence.pages.map(page => ({ page, chapter_id: chapter.id, chapter_title: chapter.title, sequence_id:sequence.id, sequence_title: sequence.title }))));
}
function letteringSnapshot(view, page, canvas = page.render?.canvas ?? view.project.canvas) {
  if(page.page_kind==='collage')return {page_kind:'collage',canvas:page.collage.document.canvas};
  if(page.page_kind==='video')return {page_kind:'video',canvas};
  const settings = structuredClone(view.project.lettering_settings);
  if (page.page_kind === "text") return { page_kind: "text", display_title: page.display_title ?? "", body: page.body ?? "", text_layout: structuredClone(page.text_layout ?? defaultTextPageLayout), settings: { font_family: settings.font_family }, canvas };
  const speakers = new Set((page.dialogue ?? []).map(line => line.speaker).filter(Boolean));
  settings.character_colors = Object.fromEntries(Object.entries(settings.character_colors).filter(([id]) => speakers.has(id)));
  return { dialogue: page.dialogue ?? [], items: page.lettering?.items ?? [], settings, canvas };
}
async function localizedSnapshot(view,page,directory,locale,canvas,strict=false) {
  if(page.comic){
    const document=page.comic.document,geometry=comicGeometry(document);
    return {page_kind:'comic',canvas:document.canvas,panels:await Promise.all(document.order.map(async id=>{
      const panel=page.comic.panels.find(entry=>entry.page_id===id);
      if(!panel)fail('分镜事实缺失');
      const frame=geometry.frames[id],lettering=await localizeLettering(letteringSnapshot(view,panel,`${frame.w*geometry.width}:${frame.h*geometry.height}`),panel,await readTranslationDocument(directory,id),locale,{strict});
      return {page_id:id,frame,lettering};
    }))};
  }
  return localizeLettering(letteringSnapshot(view,page,canvas),page,await readTranslationDocument(directory,page.page_id),locale,{strict});
}
async function pageTranslationSummary(page,directory,locale){
  const panels=page.comic?page.comic.panels:[page],summary={total:0,missing:0,stale:0};
  for(const panel of panels){const value=translationProjection(panel,await readTranslationDocument(directory,panel.page_id),locale).summary;for(const key of Object.keys(summary))summary[key]+=value[key];}
  return summary;
}
export async function prepareTranslationInspection(repositoryRoot,projectId,directory,value) {
  const id=pageId(value.page_key),locale=requireLetteringLocale(value.locale),view=await readProjectWorkbenchView(repositoryRoot,projectId,{kind:'finished',page_id:id}),page=view.pages.find(page=>page.page_id===id);
  if(!page)fail('页面已不存在',404);if(['video','collage'].includes(page.page_kind))fail('此页面没有嵌字译文');
  let clean,canvas;
  if(page.comic){clean=await composeComicImage(page.comic.document,await readComicSources(directory,page.comic.document));canvas=page.comic.document.canvas;}
  else if(page.page_kind==='text') {const dimensions=(page.render_capabilities??view.render_capabilities).text_page?.dimensions;if(!dimensions)fail('文字页尺寸不可用');clean=await sharp({create:{...dimensions,channels:3,background:'#000'}}).png().toBuffer();}
  else if(value.candidate_id){requireCandidateId(value.candidate_id);const media=await resolveExistingProjectMedia(directory,candidateFileRelativePath(page.page_key,value.candidate_id));if(!media)fail('指定候选底图不可用');clean=await readFile(media.target);}
  else if(value.clean_locale){const record=await readFinishedRecord(directory,id,requireLetteringLocale(value.clean_locale));const media=record&&await resolveExistingProjectMedia(directory,record.outputs.clean);if(!media)fail('指定语言的成品底图不可用');clean=await readFile(media.target);canvas=record.lettering.canvas;}
  else fail('请显式指定 candidate_id 或 clean_locale 选择预览底图',400);
  if(!canvas){const {width,height}=await sharp(clean).metadata();canvas=`${width}:${height}`;}
  if(page.layers)clean=await composeImageLayers(clean,page.layers.document,await captureLayers(directory,page.layers.document,locale));
  const document=await readTranslationDocument(directory,id);
  return {clean,lettering:await localizedSnapshot(view,page,directory,locale,canvas),translation_summary:page.comic?await pageTranslationSummary(page,directory,locale):translationProjection(page,document,locale).summary};
}
export function requireFinishedVariant(variant='lettered') {
  if(!['lettered','clean'].includes(variant))fail('variant 只能是 lettered 或 clean',400);
  return variant;
}
function artworkStaleReasons(page,record,candidate,collageMedia,{clean=false}={}) {
  const reasons=[];
  if(!record)return reasons;
  const kind=page.comic?'comic':page.page_kind??'image';
  if(kind!==(record.page_kind??'image'))reasons.push('页面类型已变化');
  if(candidate!==null&&candidate!==record.candidate_id)reasons.push('当前唯一候选已变化');
  if(page.page_kind==='video'&&hashCanonicalJson(normalizeVideoPostprocess(page.video_postprocess))!==hashCanonicalJson(normalizeVideoPostprocess(record.video_postprocess)))reasons.push('动态裁剪或播放倍率已变化');
  if(page.comic&&hashCanonicalJson(page.comic.document)!==record.comic_sha256)reasons.push('分镜布局、选图或裁切已变化');
  if(page.collage){
    const document=clean?collageWithoutMaterials(page.collage.document):page.collage.document;
    const previous=clean&&record.collage?collageWithoutMaterials(record.collage):record.collage;
    if(hashCanonicalJson(document)!==hashCanonicalJson(previous))reasons.push('组图布局或来源已变化');
    const previousMedia=clean?(record.clean_collage_media_sha256??record.collage_media_sha256):record.collage_media_sha256;
    if(collageMediaFingerprint(document,collageMedia)!==previousMedia)reasons.push('组图来源图片已变化');
    if(clean&&!record.clean_collage_media_sha256&&record.collage&&collageSourceIds(record.collage).some(id=>record.collage.assets[id].file))reasons.push('旧组图无字文件含素材，需要重新制作');
  }
  return reasons;
}
// 无字版是已保存干净底图的只读投影；不迁移记录，也不触碰现有媒体。
async function cleanFinishedRecord(directory,page,candidate,collageMedia){
  const choices=[];
  for(const locale of ['zh','en','ja']){
    if(locale!=='zh'&&['video','collage'].includes(page.page_kind))continue;
    const record=await readFinishedRecord(directory,page.page_id,locale);
    if(!record)continue;
    const available=Boolean(await resolveExistingProjectMedia(directory,record.outputs.clean));
    const reasons=artworkStaleReasons(page,record,candidate,collageMedia,{clean:true});
    choices.push({record,locale,rank:available?(reasons.length?1:0):2});
  }
  choices.sort((a,b)=>a.rank-b.rank);
  return choices[0]??{record:null,locale:'zh'};
}
export async function readFinishedPages(repositoryRoot, projectId, directory, { page_id = null,locale='zh',variant='lettered',mode='standard' } = {}) {
  requireLetteringLocale(locale);
  requireFinishedVariant(variant);
  const clean=variant==='clean';
  const view = await readProjectWorkbenchView(repositoryRoot, projectId, {kind:'finished',page_id});
  const jobs = await listFinishedJobs(directory);
  const numbers=storyPageNumbers(view.outline.chapters);
  const pages = [];
  const entries = page_id ? view.pages.filter(page => page.page_id === page_id).map(page => ({ page })) : orderedFinishedPages(view);
  for (const { page, ...chapter } of entries) {
    if (page_id && page.page_id !== page_id) continue;
    if(clean&&page.page_kind==='text')continue;
    let mediaLocale=['video','collage'].includes(page.page_kind)?'zh':locale;
    let record = clean?null:await readFinishedRecord(directory, page.page_id,mediaLocale);
    const translation_summary=clean||locale==='zh'||['video','collage'].includes(page.page_kind)?null:await pageTranslationSummary(page,directory,locale);
    const candidates = ['text','collage'].includes(page.page_kind) || page.comic ? null : await readGenerationCandidateRecords(directory, { pageKey: page.page_key });
    const selection=candidates?uniqueCandidateSelection(candidates):null;
    const candidate=selection?.candidate?.candidate_id??null;
    const comicError=page.comic?(await inspectComicSources(directory,page.comic.document)).reason:null;
    const collageMedia=page.collage?await resolveCollageMedia(directory,page.collage.document):null;
    if(clean){const selected=await cleanFinishedRecord(directory,page,candidate,collageMedia);record=selected.record;mediaLocale=selected.locale;}
    const collageError=collageMedia?collageSourceIds(page.collage.document).map(id=>collageMedia[id]).find(a=>a.error)?.error:null;
    const outputKinds=clean?['clean']:['lettered'];
    const files = record ? await Promise.all(outputKinds.map(kind => {
      const relative=mode==='pixiv'&&record.page_kind==='video'&&path.extname(record.outputs[kind]??'')!=='.mp4'?record.outputs.gif:record.outputs[kind];
      return relative?resolveExistingProjectMedia(directory,relative):null;
    })) : [];
    const gifFile=record?.outputs.gif?await resolveExistingProjectMedia(directory,record.outputs.gif):null;
    const backupMissing=Boolean(record?.source_backup&&!await resolveExistingProjectMedia(directory,record.source_backup));
    const exportSourceMissing=record?.page_kind==='video'&&['eh','preview'].includes(mode)&&path.extname(record.outputs[outputKinds[0]]??'').toLowerCase()!=='.mp4'&&(!record.source_backup||backupMissing);
    const available = files.length === outputKinds.length && files.every(Boolean)&&!exportSourceMissing;
    const cleanAvailable=clean?available:record&&Boolean(await resolveExistingProjectMedia(directory,record.outputs.clean));
    const dimensions = page.collage ? collageSize(page.collage.document.canvas) : page.page_kind === 'text' ? (page.render_capabilities ?? view.render_capabilities).text_page?.dimensions : null;
    const dimensionsChanged = dimensions && record && (record.width !== dimensions.width || record.height !== dimensions.height);
    const layerDocument=clean?emptyLayers():page.layers?.document??emptyLayers(),layerMedia=await resolveLayerMedia(directory,layerDocument,mediaLocale);
    const layersStale=record&&layerFingerprint(layerDocument,layerMedia,mediaLocale)!==(record.layers_sha256??layerFingerprint(emptyLayers(),{}));
    const layerError=layerDocument.items.filter(i=>i.enabled).map(i=>layerMedia[i.asset_id]?.error).find(Boolean);
    const staleReasons=artworkStaleReasons(page,record,candidate,collageMedia,{clean});
    if(record){
      if(dimensionsChanged)staleReasons.push('输出画幅已变化');
      if(!clean){
        if(layersStale)staleReasons.push('素材或素材排版已变化');
        if(translation_summary?.missing||translation_summary?.stale)staleReasons.push('译文缺失或对应原文已变化');
        if(hashCanonicalJson(await localizedSnapshot(view,page,directory,mediaLocale,page.page_kind==='text'?undefined:record.lettering.canvas))!==hashCanonicalJson(record.lettering))staleReasons.push('文字内容、样式或排版已变化');
      }
    }
    const status=!record?'missing':!available?'files_missing':staleReasons.length?'stale':'ready';
    const status_reasons=!record?[clean?'尚未制作可用的无字底图':'本语言尚未制作']:!available?[exportSourceMissing?'缺少冻结原片，无法制作压缩版或离线视频':'成品文件缺失']:staleReasons;
    const url = kind => `/api/projects/${encodeURIComponent(projectId)}/media/${record.outputs[clean?'clean':kind]}`;
    pages.push({ ...chapter,page_number:numbers.get(page.page_id)??null,locale:mediaLocale,variant,status_reasons,translation_summary, page_id: page.page_id, page_key: page.page_key, title: page.title,
      ...(page.collage?{collage_sha256:page.collage.sha256}:{}),
      ...(page.comic?{comic_sha256:page.comic.sha256}:{}),
      candidate_id: candidate, candidate_count: candidates?.length ?? null,
      batch_skip_reason: layerError??collageError??comicError??(page.collage&&!visibleCollageItems(page.collage.document).length&&!page.collage.document.background?.enabled?'组图尚未选图':translation_summary?.missing||translation_summary?.stale ? `译文未就绪：缺译 ${translation_summary.missing} 条、原文变化 ${translation_summary.stale} 条` : selection?.reason??null),
      status,
      job: jobs.find(job => job.page_id === page.page_id&&(job.locale??'zh')===mediaLocale) ?? null,
      record: record ? { media_format:record.media_format??(record.page_kind==='video'?'mp4':'png'), backup_missing:backupMissing, warnings:record.warnings??[], gif:record.gif??null, gif_bytes:gifFile?(await stat(gifFile.target)).size:null, media_kind:record.page_kind==='video'?'video':'image', poster_url:record.poster ? `/api/projects/${encodeURIComponent(projectId)}/media/${record.poster}` : null, sha256: hashCanonicalJson(record), candidate_id: record.candidate_id ?? null, width: record.width, height: record.height, created_at: record.created_at,
        bytes: available ? (await stat(files[0].target)).size : null,
        lettered_url: available ? url("lettered") : null, clean_url: cleanAvailable ? url("clean") : null } : null });
  }
  return { pages, chapters:view.outline.chapters.map(({id,title})=>({id,title})) };
}

export async function deleteFinishedPage(directory, value) {
  const id = pageId(value?.page_key);
  const locale=requireLetteringLocale(value.locale);
  if ((await listFinishedJobs(directory)).some(job => job.page_id === id && busyStatuses.has(job.status))) fail("本页正在输出成品，请等待完成后再删除");
  const record = await readFinishedRecord(directory, id,locale);
  if (!record || hashCanonicalJson(record) !== value.expected_sha256) fail("本页成品已变化，请刷新后再删除");
  await unlink(recordPath(directory, id,locale));
  const cleanup=await cleanupFinishedMedia(directory,id,finishedRecordMedia(record));
  await unlink(jobPath(directory, id,locale)).catch(error => { if (error.code !== "ENOENT") throw error; });
  return { deleted: true, warnings:cleanup.warnings };
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
  const locale=['video','collage'].includes(page.page_kind)?'zh':requireLetteringLocale(value.locale);
  const old = await readFinishedRecord(directory, id,locale);
  const job = queuedJob ?? { id: `finished-${randomUUID()}`, locale,page_id: id, project_id: projectId, status: "queued", pid: process.pid, created_at: new Date().toISOString(), error: null };
  const storyIndex = orderedFinishedPages(view).findIndex(entry => entry.page.page_id === id);
  job.page_label = storyIndex >= 0 ? String(storyIndex + 1).padStart(3, "0") : page.title || id;
  if(page.collage){
    if(value.expected_collage_sha256&&value.expected_collage_sha256!==page.collage.sha256)fail('组图已变化，请重新排队输出');
    const document=page.collage.document;if(!visibleCollageItems(document).length&&!document.background?.enabled)fail('组图尚未选图');
    const collageBuffers=await captureCollage(directory,document),snapshot={page_key:page.page_key,page_kind:'collage',collage:document,collage_sha256:hashCanonicalJson(document),collage_media_sha256:collageBuffers.sha256,clean_collage_media_sha256:collageMediaFingerprint(collageWithoutMaterials(document),collageBuffers.media),lettering:letteringSnapshot(view,page)};
    await writeJson(jobPath(directory,id,locale),job);return {job,snapshot,collageBuffers,expected:hashCanonicalJson(old),old};
  }
  if(page.comic){
    if(value.expected_comic_sha256&&value.expected_comic_sha256!==page.comic.sha256)fail('分镜布局或选图已变化，请重新排队输出');
    const document=page.comic.document,sources=await readComicSources(directory,document);
    const snapshot={page_key:page.page_key,page_kind:'comic',comic:document,comic_sha256:hashCanonicalJson(document),comic_sources:sources.map(({buffer,...source})=>source),lettering:await localizedSnapshot(view,page,directory,locale,undefined,true)};
    await writeJson(jobPath(directory,id,locale),job);
    return {job,snapshot,comicSources:sources,expected:hashCanonicalJson(old),old};
  }
  if (page.page_kind === "text") {
    // 文字页没有候选底图：黑底按当前渲染配置候选出图尺寸的 2 倍直接渲染，与超分后的普通成品同尺寸。
    const textPage = (page.render_capabilities ?? view.render_capabilities).text_page;
    if (!textPage.dimensions) fail(textPage.error);
    const dimensions = textPage.dimensions;
    const snapshot = { page_key: page.page_key, page_kind: "text", lettering: await localizedSnapshot(view, page,directory,locale,undefined,true) };
    await writeJson(jobPath(directory, id,locale), job);
    return { job, snapshot, sourceBuffer: null, reuse: null, expected: hashCanonicalJson(old), old, textPage: dimensions };
  }
  try { requireCandidateId(value.candidate_id); }
  catch { throw Object.assign(new Error('插画页和动态页输出成品必须提供有效 candidate_id；先查询 candidate.list 取得候选 ID。'), {
    status:400, code:'invalid_candidate_id', details:{field:'candidate_id',page_kind:page.page_kind,page_key:page.page_key},
  }); }
  if (queuedJob) {
    const candidates = await readGenerationCandidateRecords(directory, { pageKey: page.page_key });
    if (candidates.length !== 1 || candidates[0].candidate_id !== value.candidate_id) fail("候选已变化，请只保留一张候选后重新制作");
  }
  const source = await resolveExistingProjectMedia(directory, candidateFileRelativePath(page.page_key, value.candidate_id));
  if(page.page_kind==='video') {
    if(!source)fail('候选封面缺失');
    const candidate=await readCandidateResult(directory,page.page_key,value.candidate_id);
    if(candidate?.media_kind!=='video')fail('请选择视频候选');
    const video=await resolveExistingProjectMedia(directory,candidate.video_file);if(!video)fail('视频文件缺失');
    const sourceBuffer=await readFile(video.target);if(sha(sourceBuffer)!==candidate.video_sha256)fail('视频文件已改变');
    const postprocess=normalizeVideoPostprocess(page.video_postprocess);
    if(hasVideoPostprocess(postprocess))videoPostprocessTiming(candidate.video,postprocess);
    const snapshot={page_key:page.page_key,page_kind:'video',candidate_id:value.candidate_id,source_sha256:candidate.video_sha256,video:candidate.video,video_postprocess:postprocess,lettering:letteringSnapshot(view,page)};
    await writeJson(jobPath(directory,id),job);
    return {job,snapshot,sourceBuffer,posterBuffer:await readFile(source.target),video:true,expected:hashCanonicalJson(old),old};
  }
  const sourceBuffer = source ? await readFile(source.target) : null;
  let base=old,reuse=null;
  for(const language of [locale,...['zh','en','ja'].filter(language=>language!==locale)]) {
    const record=language===locale?old:await readFinishedRecord(directory,id,language);
    if(record?.candidate_id!==value.candidate_id||record?.upscale?.name!==finishedModel.name||record.upscale.sha256!==finishedModel.sha256||(sourceBuffer&&sha(sourceBuffer)!==record.source_sha256))continue;
    const media=await resolveExistingProjectMedia(directory,record.outputs.clean);
    if(media){reuse=media;base=record;break;}
  }
  if (!source && !reuse) fail("候选底图已不存在；请根据成品记录重新生成候选，再输出成品");
  const dimensions = await sharp(sourceBuffer ?? await readFile(reuse.target)).metadata();
  const generation = source ? await readCandidateGeneration(directory, page.page_key, value.candidate_id) : base.generation;
  const layers=page.layers?.document??emptyLayers(),layerCapture=await captureLayers(directory,layers,locale);
  const snapshot = { layers,layers_sha256:layerCapture.sha256,page_key: page.page_key, candidate_id: value.candidate_id,
    source_sha256: sourceBuffer ? sha(sourceBuffer) : base.source_sha256,
    generation: Object.fromEntries(["seed", "execution_seed", "prompt", "models", "loras", "recipe", "canvas", "render_profile", "render_route"].map(key => [key, generation[key] ?? null])),
    lettering: await localizedSnapshot(view, page,directory,locale,sourceBuffer ? `${dimensions.width}:${dimensions.height}` : base.lettering.canvas,true), upscale: finishedModel };
  await writeJson(jobPath(directory, id,locale), job);
  return { job, snapshot, layerCapture,sourceBuffer, reuse: reuse?.target??null, expected: hashCanonicalJson(old), old };
}

export async function publishFinishedPage(repositoryRoot, projectId, directory, prepared, record, {cleanBuffer}={}) {
  const { page_id: id } = prepared.job;
  if (hashCanonicalJson(await readFinishedRecord(directory, id,prepared.job.locale)) !== prepared.expected) fail("本页成品已被其他操作更新，请重新读取");
  const view = await readProjectWorkbenchView(repositoryRoot, projectId, {kind:'directory'});
  const pages = [...view.outline.chapters.flatMap(chapter=>chapter.sequences.flatMap(sequence=>sequence.pages)), ...view.characters.flatMap(setting=>setting.pages), ...view.scenes.scenes.flatMap(setting=>setting.pages), ...view.orphan_pages];
  if (!pages.some(page => page.page_id === id)) fail("页面已删除，本次输出不再发布");
  if(cleanBuffer){
    if(record.outputs.clean!==sharedFinishedCleanPath(id,cleanBuffer))fail('共享底图引用与内容不匹配');
    await writeSharedFinishedClean(directory,id,cleanBuffer);
  }
  await writeJson(recordPath(directory, id,prepared.job.locale), record);
  if(prepared.old)await cleanupFinishedMedia(directory,id,finishedRecordMedia(prepared.old));
}

async function inspectComicSources(directory,document){
  if(document.order.some(id=>!document.panels[id].candidate_id))return {sources:[],reason:'部分分镜尚未选图'};
  const sources=await Promise.all(document.order.map(async page_id=>{
    const candidate_id=document.panels[page_id].candidate_id;
    return {page_id,candidate_id,source:await resolveExistingProjectMedia(directory,candidateFileRelativePath({page_id},candidate_id))};
  }));
  return {sources,reason:sources.some(item=>!item.source)?'部分分镜选图已不存在，请重新选图':null};
}
async function readComicSources(directory,document){
  const geometry=comicGeometry(document),sources=[];
  const inspected=await inspectComicSources(directory,document);
  if(inspected.reason)fail(inspected.reason);
  for(const {page_id:pageId,candidate_id,source} of inspected.sources){
    const choice=document.panels[pageId];
    const buffer=await readFile(source.target);
    sources.push({page_id:pageId,candidate_id,source_sha256:sha(buffer),frame:geometry.frames[pageId],crop:choice.crop,buffer});
  }
  return sources;
}
export async function composeComicImage(document,sources) {
  const geometry=comicGeometry(document),width=2048,height=Math.round(geometry.height*2),layers=[];
  for(const source of sources){
    const box=source.frame,left=Math.round(box.x*width),top=Math.round(box.y*height),w=Math.max(1,Math.round((box.x+box.w)*width)-left),h=Math.max(1,Math.round((box.y+box.h)*height)-top);
    const metadata=await sharp(source.buffer).metadata(),scale=Math.max(w/metadata.width,h/metadata.height)*source.crop.zoom;
    const rw=Math.max(w,Math.round(metadata.width*scale)),rh=Math.max(h,Math.round(metadata.height*scale));
    const input=await sharp(source.buffer).resize(rw,rh).extract({left:Math.round((rw-w)*source.crop.x),top:Math.round((rh-h)*source.crop.y),width:w,height:h}).png().toBuffer();
    layers.push({input,left,top});
  }
  return sharp({create:{width,height,channels:3,background:'#ffffff'}}).composite(layers).png().toBuffer();
}
export async function runFinishedPage({ repositoryRoot, projectId, directory, prepared, config, origin, mutateTargetFacts,
  processVideo = prepareAnimationFiles, upscale = upscaleFinishedImage, render = (...args) => import("./finished-render.mjs").then(module => module.renderFinishedImage(...args)) }) {
  const { job, snapshot } = prepared;
  let outputs = null;
  let newPoster = null;
  let newBackup = null;
  let published = false;
  const update = async (status, error = null) => { job.status = status; job.error = error; const now = new Date().toISOString(); job.started_at ??= now; if (status === "completed") job.completed_at = now; if (status === "failed") job.failed_at = now; await writeJson(jobPath(directory, job.page_id,job.locale), job); };
  try {
    if(prepared.video) {
      await update('processing');
      const processed=await processVideo(prepared.sourceBuffer,directory,snapshot.video_postprocess);
      const {gif,warnings,...videoMetadata}=processed.metadata;
      await update('publishing');const prefix=`Outputs/finished/${job.page_id}/${job.id}`;
      outputs={clean:prefix+'/animation.webp',lettered:prefix+'/animation.webp',gif:prefix+'/animation.gif'};
      newBackup=prefix+'/source.mp4';
      const poster=prefix+'/poster.png';newPoster=poster;await mkdir(path.join(directory,prefix),{recursive:true});
      await writeFile(path.join(directory,outputs.clean),processed.webp);await writeFile(path.join(directory,outputs.gif),processed.gif);
      await writeFile(path.join(directory,newBackup),prepared.sourceBuffer);await writeFile(path.join(directory,poster),processed.poster);
      const record={$schema:'https://storyvisualizer.local/schemas/finished-page.schema.json',...snapshot,source_video:snapshot.video,source_backup:newBackup,media_format:'webp',video:videoMetadata,gif,warnings,width:videoMetadata.width,height:videoMetadata.height,created_at:new Date().toISOString(),outputs,poster};
      await mutateTargetFacts(projectId,()=>publishFinishedPage(repositoryRoot,projectId,directory,prepared,record));published=true;await update('completed');
      warmMediaVariants(directory, outputs.clean);
    } else {
    await update(prepared.reuse || prepared.textPage || prepared.comicSources || prepared.collageBuffers ? "lettering" : "upscaling");
    const cleanBuffer = prepared.collageBuffers ? await composeCollage(collageWithoutMaterials(snapshot.collage),prepared.collageBuffers) : prepared.comicSources ? await composeComicImage(prepared.snapshot.comic,prepared.comicSources)
      : prepared.textPage
      ? await sharp({ create: { width: prepared.textPage.width, height: prepared.textPage.height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
      : prepared.reuse ? await readFile(prepared.reuse) : await upscale(prepared.sourceBuffer, { ...config, ...(config.models_root ? { models_root: path.resolve(repositoryRoot, config.models_root) } : {}) }, job.id);
    // 分享图片不附带 ComfyUI 写入的工作流等 PNG 文本块。
    const clean = await sharp(cleanBuffer).png().toBuffer();
    const { width, height } = await sharp(clean).metadata();
    if (!prepared.reuse && !prepared.textPage && !prepared.comicSources && !prepared.collageBuffers) {
      const original = await sharp(prepared.sourceBuffer).metadata();
      if (width !== original.width * 2 || height !== original.height * 2) fail("超分输出尺寸不是原图的 2 倍");
    }
    await update("lettering");
    const artwork=prepared.layerCapture?await composeImageLayers(clean,snapshot.layers,prepared.layerCapture):clean;
    const lettered = prepared.collageBuffers ? await composeCollage(snapshot.collage,prepared.collageBuffers) : await render(artwork, snapshot.lettering, origin);
    const dimensions = await sharp(lettered).metadata();
    if (dimensions.width !== width || dimensions.height !== height) fail("嵌字输出尺寸不匹配");
    const prefix = `Outputs/finished/${job.page_id}/${job.locale??'zh'}/${job.id}`;
    outputs = { clean: sharedFinishedCleanPath(job.page_id,clean), lettered: `${prefix}/lettered.png` };
    await mkdir(path.join(directory, prefix), { recursive: true });
    await writeFile(path.join(directory, outputs.lettered), lettered);
    await update("publishing");
    const record = { $schema: "https://storyvisualizer.local/schemas/finished-page.schema.json", ...snapshot, created_at: new Date().toISOString(), width, height, outputs };
    await mutateTargetFacts(projectId, () => publishFinishedPage(repositoryRoot, projectId, directory, prepared, record,{cleanBuffer:clean}));
    published = true;
    for (const relative of Object.values(outputs)) warmMediaVariants(directory, relative);
    await update("completed");
    }
  } catch (error) { await update("failed", error.message); }
  if(!published&&outputs)await mutateTargetFacts(projectId,()=>cleanupFinishedMedia(directory,job.page_id,[...Object.values(outputs),newPoster,newBackup])).catch(error=>console.warn('[story-canvas] 失败成品清理未完成',error.message));
  return job;
}

// 批量输出只采用当前唯一候选；零张或多张候选跳过，文字页无需候选。
// force 时连已就绪页面一起排队，用于样式代码变化后的整批重新嵌字（候选未变会复用超分底图）。
export async function planFinishedBatch(repositoryRoot, projectId, directory, { chapter_id = null, force = false,locale='zh' } = {}) {
  const { pages } = await readFinishedPages(repositoryRoot, projectId, directory,{locale});
  const statuses = force ? ["missing", "stale", "files_missing", "ready"] : ["missing", "stale", "files_missing"];
  const targets = [];
  const skipped = [];
  for (const [index, page] of pages.entries()) {
    if (chapter_id && page.chapter_id !== chapter_id) continue;
    if (!statuses.includes(page.status)) continue;
    if (page.job && busyStatuses.has(page.job.status)) continue;
    const page_label = String(index + 1).padStart(3, "0");
    if (page.batch_skip_reason) { skipped.push({ page_id: page.page_id, title: page.title, reason: page.batch_skip_reason }); continue; }
    targets.push({locale:page.locale, page_key: page.page_key, ...(page.collage_sha256?{expected_collage_sha256:page.collage_sha256}:{}), ...(page.comic_sha256?{expected_comic_sha256:page.comic_sha256}:{}), ...(page.candidate_id ? { candidate_id: page.candidate_id } : {}), page_label });
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
    const job = { id: `finished-${randomUUID()}`,locale:target.locale??'zh', page_id: id, page_label: target.page_label ?? id, project_id: projectId, status: "queued", pid: process.pid, created_at: new Date().toISOString(), error: null };
    await writeJson(jobPath(directory, id,job.locale), job);
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
        await writeJson(jobPath(directory, id,target.locale), { id: placeholder?.id ?? `finished-${randomUUID()}`,locale:target.locale??'zh', page_id: id, page_label: placeholder?.page_label ?? id, project_id: projectId, status: "failed", pid: process.pid, created_at: placeholder?.created_at ?? now, failed_at: now, error: error.message });
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
      await writeJson(jobPath(directory, id,placeholders.get(id).locale), { ...placeholders.get(id), status: "failed", failed_at: new Date().toISOString(), error: "批量输出中断，请重新输出" }).catch(() => {});
    }
  }
  return results;
}
