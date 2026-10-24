import type {LetteringLocale} from "./page-translations";
import { responseJson } from "./api-response";
import { readFacts, mutateDerived, mutateTargetFacts } from "./project-write-client";
import type { PageKey } from "./page-key";

export type FinishedJob = { id: string; page_id: string; locale?:LetteringLocale; status: string; error: string | null };
export type FinishedVariant = 'lettered' | 'clean';
export type FinishedEdition = LetteringLocale | 'clean';
export type FinishedExportMode = 'standard'|'pixiv'|'eh'|'preview';
export const finishedExportLabels = {standard:'高清',eh:'EH',pixiv:'Pixiv',preview:'网页'};
export type FinishedExportVolume = {folder:string;kind?:'static'|'animations'|'batch';first:number;last:number;pages:number;bytes:number;compressed:{page:number;max_width:number;target_fps:number;quality?:number;colors?:number}[]};
export type FinishedExportArtifact = {filename:string;download_url:string};
export type FinishedExportResult = FinishedExportArtifact & {artifacts?:FinishedExportArtifact[];warnings:string[];volumes?:FinishedExportVolume[];groups?:{label:string;volumes:FinishedExportVolume[]}[]};
export type FinishedLocalExportResult = {directory:string;artifacts:{filename:string;file:string;bytes:number;mode:FinishedExportMode;edition:FinishedEdition;warnings:string[];volumes:FinishedExportVolume[]}[]};
export const finishedEditionLabels = {zh:'中文',en:'英文',ja:'日文',clean:'无字'};
export type FinishedPage = {
  variant?:FinishedVariant;status_reasons?:string[];
  page_number?:number|null;locale?:LetteringLocale;translation_summary?:{total:number;missing:number;stale:number}|null;
  page_id: string; page_key: PageKey; title: string; chapter_id: string; chapter_title: string; sequence_title: string;
  status: "missing" | "files_missing" | "stale" | "ready"; job: FinishedJob | null;
  candidate_id: string | null; candidate_count: number | null; batch_skip_reason: string | null;
  record: { media_format?: "png" | "webp" | "mp4"; backup_missing?: boolean; warnings?: string[]; gif_bytes?: number | null; gif?: {width:number;height:number;encoding?:{tier:number;max_width:number;target_fps:number;colors:number;original_bytes:number}} | null; media_kind?: "image" | "video"; poster_url?: string; sha256: string; candidate_id: string | null; width: number; height: number; bytes: number | null; created_at: string; lettered_url: string | null; clean_url: string | null } | null;
};
const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/finished`;
export const deleteFinishedPage = async (id: string, page: FinishedPage) => responseJson(await mutateTargetFacts(base(id), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale:page.locale??'zh',page_key: page.page_key, expected_sha256: page.record!.sha256 }) }));
export const finishedBusy = (status?: string) => ["queued", "upscaling", "lettering", "processing", "publishing"].includes(status ?? "");
export const finishedJobLabel = (status?: string) => ({ queued: "等待输出", upscaling: "正在超分", lettering: "正在嵌字", processing: "正在后处理", publishing: "正在保存", completed: "成品已输出", failed: "输出失败" }[status ?? ""] ?? "");
export const loadFinishedPages = async (id: string, signal?: AbortSignal, pageId?: string,locale:LetteringLocale='zh',variant:FinishedVariant='lettered',mode:FinishedExportMode='standard') => responseJson<{ pages: FinishedPage[] }>(await readFacts(`${base(id)}?locale=${locale}&variant=${variant}&mode=${mode}${pageId ? `&page_id=${encodeURIComponent(pageId)}` : ""}`, { signal, cache: "no-store" }));
export const startFinishedPage = async (id: string, page_key: PageKey, candidate_id?: string,locale:LetteringLocale='zh') => responseJson<{ job: FinishedJob }>(await mutateDerived(`${base(id)}/output`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({locale, page_key, ...(candidate_id ? { candidate_id } : {}) }) }));
export const startFinishedBatch = async (id: string, chapter_id: string, force = false,locale:LetteringLocale='zh') => responseJson<{ queued: number; skipped: { page_id: string; title: string; reason: string }[] }>(await mutateDerived(`${base(id)}/output-batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({locale, chapter_id: chapter_id || null, force }) }));
export async function exportFinishedPages(id: string, modes:FinishedExportMode[],editions:FinishedEdition[],chapter_ids: string[]|undefined, beforeDownload: (result:FinishedExportResult)=>Promise<boolean>,onProgress:(message:string)=>void,signal:AbortSignal) {
  const response=await readFacts(`${base(id)}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({modes,editions,chapter_ids,prepare:true,progress:true }),signal });
  const result=await readExportResponse<FinishedExportResult>(response,onProgress);
  signal?.throwIfAborted();
  if (!await beforeDownload(result)) return null;
  signal?.throwIfAborted();
  for(const file of result.artifacts??[result])startFinishedDownload(file);
  return result;
}
export async function exportFinishedLocal(id:string,modes:FinishedExportMode[],editions:FinishedEdition[],chapter_ids:string[]|undefined,onProgress:(message:string)=>void,signal:AbortSignal) {
  const response=await mutateDerived(`${base(id)}/export-local`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({modes,editions,chapter_ids,progress:true}),signal});
  return readExportResponse<FinishedLocalExportResult>(response,onProgress);
}
async function readExportResponse<T>(response:Response,onProgress?:(message:string)=>void):Promise<T> {
  let result:T|undefined;
  if(response.ok&&response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='';
    try {while(true){const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;const event=JSON.parse(line);if(event.error)throw Error(event.error);if(event.progress)onProgress?.(event.progress.message);if(event.result)result=event.result;}if(done)break;}}
    finally {reader.releaseLock();}
    if(!result)throw Error('导出准备中断，请重试');
  } else result=await responseJson<T>(response);
  return result;
}
function startFinishedDownload(result:FinishedExportArtifact) {
  // 交给浏览器下载管理器直接落盘，页面不接收或拼接媒体字节。
  const link = document.createElement('a');
  link.href = result.download_url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
}
