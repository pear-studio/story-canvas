import type {LetteringLocale} from "./page-translations";
import { responseJson } from "./api-response";
import { readFacts, mutateDerived, mutateTargetFacts } from "./project-write-client";
import type { PageKey } from "./page-key";

export type FinishedJob = { id: string; page_id: string; locale?:LetteringLocale; status: string; error: string | null };
export type FinishedPage = {
  page_number?:number|null;locale?:LetteringLocale;translation_summary?:{total:number;missing:number;stale:number}|null;
  page_id: string; page_key: PageKey; title: string; chapter_id: string; chapter_title: string; sequence_title: string;
  status: "missing" | "files_missing" | "stale" | "ready"; job: FinishedJob | null;
  candidate_id: string | null; candidate_count: number | null; batch_skip_reason: string | null;
  record: { media_kind?: "image" | "video"; poster_url?: string; sha256: string; candidate_id: string | null; width: number; height: number; bytes: number | null; created_at: string; lettered_url: string | null; clean_url: string | null } | null;
};
const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/finished`;
export const deleteFinishedPage = async (id: string, page: FinishedPage) => responseJson(await mutateTargetFacts(base(id), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale:page.locale??'zh',page_key: page.page_key, expected_sha256: page.record!.sha256 }) }));
export const finishedBusy = (status?: string) => ["queued", "upscaling", "lettering", "publishing"].includes(status ?? "");
export const finishedJobLabel = (status?: string) => ({ queued: "等待输出", upscaling: "正在超分", lettering: "正在嵌字", publishing: "正在保存", completed: "成品已输出", failed: "输出失败" }[status ?? ""] ?? "");
export const loadFinishedPages = async (id: string, signal?: AbortSignal, pageId?: string,locale:LetteringLocale='zh') => responseJson<{ pages: FinishedPage[] }>(await readFacts(`${base(id)}?locale=${locale}${pageId ? `&page_id=${encodeURIComponent(pageId)}` : ""}`, { signal, cache: "no-store" }));
export const startFinishedPage = async (id: string, page_key: PageKey, candidate_id?: string,locale:LetteringLocale='zh') => responseJson<{ job: FinishedJob }>(await mutateDerived(`${base(id)}/output`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({locale, page_key, ...(candidate_id ? { candidate_id } : {}) }) }));
export const startFinishedBatch = async (id: string, chapter_id: string, force = false,locale:LetteringLocale='zh') => responseJson<{ queued: number; skipped: { page_id: string; title: string; reason: string }[] }>(await mutateDerived(`${base(id)}/output-batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({locale, chapter_id: chapter_id || null, force }) }));
export async function exportFinishedPages(id: string, variant: string, chapter_id: string, preview = false, onProgress?: (received: number, total: number) => void,locale:LetteringLocale='zh') {
  const response = await readFacts(`${base(id)}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({locale, variant, chapter_id, preview }) });
  if (!response.ok) await responseJson(response);
  const total = Number(response.headers.get("x-export-total") ?? 0);
  const reader = response.body!.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new Uint8Array(value)); received += value.length;
    onProgress?.(received, total);
  }
  const filename = preview ? `${id}-${locale}-预览.html` : `${id}-${locale}-成品.zip`;
  const url = URL.createObjectURL(new Blob(chunks));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { filename, bytes: received };
}
