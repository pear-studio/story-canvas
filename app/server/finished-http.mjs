import path from 'node:path';
import {requireLetteringLocale} from './page-translations.mjs';
import yazl from "yazl";
import { readFile, stat } from "node:fs/promises";
import { ApiError, readJsonBody } from "./http-support.mjs";
import { ensureMediaVariant } from "./media-variants.mjs";
import { resolveExistingProjectMedia } from "./render-media.mjs";
import { finishedReaderHead, finishedReaderFigure, finishedReaderTail } from "../shared/finished-reader.mjs";
import { deleteFinishedPage, listFinishedJobs, planFinishedBatch, prepareFinishedPage, readFinishedPages, readFinishedRecord, runFinishedBatch, runFinishedPage } from "./finished-pages.mjs";

const activeBatches = new Set();

export async function handleFinishedRequest({ request, response, decodedPath, projectRoot, config, readFacts, mutateDerived, mutateTargetFacts, sendOperation }) {
  const match = /^\/api\/projects\/([^/]+)\/finished(?:\/(output-batch|output|export|jobs))?\/?$/.exec(decodedPath);
  if (!match) return false;
  const projectId = match[1];
  if (request.method === "DELETE" && !match[2]) {
    const value = await readJsonBody(request);
    sendOperation(200, await mutateTargetFacts(projectId, ({ projectDirectory }) => deleteFinishedPage(projectDirectory, value)));
    return true;
  }
  if (request.method === "GET" && match[2] === "jobs") {
    sendOperation(200, await mutateDerived(projectId, async ({ projectDirectory }) => ({ jobs: await listFinishedJobs(projectDirectory) })));
    return true;
  }
  if (request.method === "GET" && !match[2]) {
    const params = new URL(request.url, "http://local").searchParams,page_id=params.get('page_id'),locale=requireLetteringLocale(params.get('locale')??'zh');
    sendOperation(200, await readFacts(projectId, ({ projectDirectory }) => readFinishedPages(projectRoot, projectId, projectDirectory, { page_id,locale })));
    return true;
  }
  if (request.method === "POST" && match[2] === "output-batch") {
    const value = await readJsonBody(request);
    if (activeBatches.has(projectId)) throw new ApiError(409, "finished_batch_running");
    const planned = await mutateDerived(projectId, async ({ projectDirectory }) => ({ directory: projectDirectory, plan: await planFinishedBatch(projectRoot, projectId, projectDirectory, { chapter_id: value?.chapter_id || null, force: value?.force === true,locale:requireLetteringLocale(value?.locale) }) }));
    const { directory, plan } = planned.value;
    if (!plan.targets.length) {
      sendOperation(200, planned, { queued: 0, skipped: plan.skipped });
      return true;
    }
    activeBatches.add(projectId);
    // 使用实际监听端口，避免 Host 头或代理地址成为后台浏览器的目标。
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    void runFinishedBatch({ repositoryRoot: projectRoot, projectId, directory, targets: plan.targets, config, origin, mutateDerived, mutateTargetFacts })
      .catch(error => console.error("[story-canvas] 成品批量输出失败", error))
      .finally(() => activeBatches.delete(projectId));
    sendOperation(202, planned, { queued: plan.targets.length, skipped: plan.skipped });
    return true;
  }
  if (request.method === "POST" && match[2] === "output") {
    const value = await readJsonBody(request);
    const result = await mutateDerived(projectId, async ({ projectDirectory }) => ({ directory: projectDirectory, prepared: await prepareFinishedPage(projectRoot, projectId, projectDirectory, value) }));
    const { directory, prepared } = result.value;
    // 使用实际监听端口，避免 Host 头或代理地址成为后台浏览器的目标。
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    void runFinishedPage({ repositoryRoot: projectRoot, projectId, directory, prepared, config, origin, mutateTargetFacts })
      .catch(error => console.error("[story-canvas] 成品输出失败", error));
    sendOperation(202, result, { job: prepared.job });
    return true;
  }
  if (request.method === "POST" && match[2] === "export") {
    const value = await readJsonBody(request);
    if (!["lettered", "clean", "both"].includes(value?.variant)) throw new ApiError(400, "invalid_finished_export");
    const preview = value?.preview === true;
    const kinds = value.variant === "both" ? ["lettered", "clean"] : [value.variant];
    const result = await readFacts(projectId, async ({ projectDirectory }) => {
      const listing = await readFinishedPages(projectRoot, projectId, projectDirectory,{locale:requireLetteringLocale(value?.locale)});
      const pages = listing.pages.filter(page => !value.chapter_id || page.chapter_id === value.chapter_id);
      if (!pages.length) throw new ApiError(409, "finished_export_empty");
      const entries = [];
      const missing=[];
      for (const [offset, page] of pages.entries()) {
        const index=(page.page_number??offset+1)-1;
        if (!page.record?.lettered_url) {missing.push(`第 ${index+1} 页 · ${page.title} · ${page.status==='files_missing'?'成品文件缺失':'本语言尚未制作'}`);if(preview)for(const kind of kinds)entries.push({index,kind,message:missing.at(-1),width:768,height:1024});continue;}
        const record = await readFinishedRecord(projectDirectory, page.page_id,page.locale);
        const video = record.page_kind === 'video';
        // 动态页没有嵌字／无字两个版本，混合导出只收录一次。
        for (const kind of video ? [kinds[0]] : kinds) entries.push({ index, kind,stale:page.status==='stale', relative: record.outputs[kind], width: record.width, height: record.height, media_kind: video ? 'video' : 'image' });
      }
      if (!entries.length) throw new ApiError(409, "finished_export_empty");
      return { projectDirectory, entries,missing };
    });
    const { projectDirectory, entries,missing } = result.value;
    if (preview && kinds.length > 1) entries.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.index - b.index);
    // 逐张解析并统计大小，随后边读边流式写出，不在内存里攒整包。
    const files = [];
    for (const entry of entries) {
      if(!entry.relative){files.push({...entry,size:0,target:null});continue;}
      const media = await resolveExistingProjectMedia(projectDirectory, entry.relative);
      if (!media) throw new ApiError(409, "finished_export_file_missing");
      const exported = preview || entry.media_kind === 'video'
        ? await ensureMediaVariant(projectDirectory, { target: media.target, info: await stat(media.target) }, entry.relative, 1024)
        : media;
      const folder = entry.media_kind === 'video' ? '动态页' : entry.kind === 'lettered' ? '嵌字版' : '无字版';
      files.push({ ...entry,name: `${folder}/${String(entry.index + 1).padStart(3, "0")}${path.extname(exported.target)}`, target: exported.target, size: (await stat(exported.target)).size, width: entry.width, height: entry.height });
    }
    if (preview) {
      const head = finishedReaderHead(`${projectId}-${requireLetteringLocale(value.locale)}-预览`,requireLetteringLocale(value.locale));
      const figure = (file, index, base64 = "") => finishedReaderFigure(file.target?`data:image/webp;base64,${base64}`:'', file.index + 1, file.width, file.height,'image',undefined,file.message,file.stale);
      const total = Buffer.byteLength(head) + Buffer.byteLength(finishedReaderTail) + files.reduce((sum, file, index) => sum + Buffer.byteLength(figure(file, index)) + 4 * Math.ceil(file.size / 3), 0);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${projectId}-preview.html"`, "cache-control": "no-store", "x-export-total": String(total) });
      response.write(head);
      for (const [index, file] of files.entries()) {
        if (response.destroyed) return true;
        response.write(figure(file, index, file.target?(await readFile(file.target)).toString("base64"):''));
      }
      response.end(finishedReaderTail);
      return true;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const zip = new yazl.ZipFile();
    response.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${projectId}-finished.zip"`, "cache-control": "no-store", "x-export-total": String(total) });
    zip.outputStream.on("error", error => response.destroy(error));
    zip.outputStream.pipe(response);
    for (const file of files) zip.addFile(file.target, file.name, { compress: false });
    if(missing.length)zip.addBuffer(Buffer.from(`${requireLetteringLocale(value.locale)} 版缺页说明\n${missing.join('\n')}\n`),'缺页说明.txt');
    zip.end();
    return true;
  }
  return false;
}
