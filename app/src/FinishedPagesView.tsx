import {LetteringLocaleSelect,type LetteringLocale} from "./page-translations";
import { useEffect, useRef, useState } from "react";
import { deleteFinishedPage, exportFinishedPages, finishedBusy, finishedJobLabel, loadFinishedPages, startFinishedBatch, type FinishedPage } from "./finished-client";
import { NavigationContextMenu } from "./NavigationContextMenu";
import { useLongPressContextMenu } from "./use-long-press-context-menu";
import ZoomableImageLightbox from "./ImageLightbox";
import type { PageKey } from "./page-key";
import { useFeedback } from "./feedback";
import { mediaVariantUrl } from "./media-variant";
import { Modal } from "./Modal";
import { FinishedReader } from "./FinishedReader";
import type { ReaderPage } from "../shared/finished-reader.mjs";
import "./FinishedPagesView.css";

const bytesLabel = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function FinishedPagesView({locale="zh",onLocaleChange, projectId, onOpenPage }: {locale?:LetteringLocale;onLocaleChange?:(locale:LetteringLocale)=>void; projectId: string; onOpenPage: (key: PageKey) => void }) {
  const [pages, setPages] = useState<FinishedPage[]>([]);
  const [error, setError] = useState("");
  const [chapter, setChapter] = useState("");
  const [variant, setVariant] = useState("lettered");
  const [exportProgress, setExportProgress] = useState<{ received: number; total: number } | "packing" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{ id: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);
  const [force, setForce] = useState(false);
  const [light, setLight] = useState(false);
  const [panel, setPanel] = useState<"export" | "batch" | "help" | null>(null);
  const [readerPages, setReaderPages] = useState<ReaderPage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const manualRefresh = useRef(false);
  const { notify, confirm } = useFeedback();
  useEffect(() => { if (error) notify({ kind: "error", title: "读取成品失败", message: error }); }, [error, notify]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const result = await loadFinishedPages(projectId, controller.signal,undefined,locale); if (!controller.signal.aborted) { setPages(result.pages); setError(""); if (manualRefresh.current) { manualRefresh.current = false; notify("成品状态已刷新"); } } }
      catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(load, 3000); } }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, refresh, notify,locale]);
  const filtered = pages.filter(page => !chapter || page.chapter_id === chapter);
  const chapters = [...new Map(pages.map(page => [page.chapter_id, page.chapter_title])).entries()];
  const missing = filtered.filter(page => page.status === "missing").length;
  const filesMissing = filtered.filter(page => page.status === "files_missing").length;
  const stale = filtered.filter(page => page.status === "stale").length;
  const images = filtered.filter(page => page.record?.lettered_url);
  const pendingPages = filtered.filter(page => (force || ["missing", "stale", "files_missing"].includes(page.status)) && !finishedBusy(page.job?.status));
  const busyCount = pages.filter(page => finishedBusy(page.job?.status)).length;
  const anyBusy = busyCount > 0;
  const targets = pendingPages.filter(page => !page.batch_skip_reason);
  const skipped = pendingPages.filter(page => page.batch_skip_reason);
  const previewIndex = images.findIndex(page => page.page_id === preview?.id);
  const current = images[previewIndex];
  const pageNumber=(page:FinishedPage)=>page.page_number??pages.indexOf(page)+1;
  const number = (page: FinishedPage) => String(pageNumber(page)).padStart(3, "0");
  async function remove(page: FinishedPage) {
    if (!await confirm({ title: `删除成品 ${number(page)}`, message: "删除本页的嵌字版、无字版和制作记录。页面与候选图会保留。", confirmLabel: "删除成品", danger: true })) return;
    setDeleting(page.page_id);
    try {
      await deleteFinishedPage(projectId, page);
      setPages(items => items.map(item => item.page_id === page.page_id ? { ...item, record: null, job: null, status: "missing" } : item));
      setPreview(value => value?.id === page.page_id ? null : value);
    } catch (reason) { notify({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setDeleting(null); setRefresh(value => value + 1); }
  }
  async function download() {
    setPanel(null);
    setExportProgress("packing");
    try {
      const result = await exportFinishedPages(projectId, variant, chapter, light, (received, total) => setExportProgress({ received, total }),locale);
      notify({ kind: "success", title: "导出完成", message: `${result.filename}（${bytesLabel(result.bytes)}）已开始下载` });
    }
    catch (reason) { notify({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setExportProgress(null); }
  }
  async function batchOutput() {
    setBatching(true);
    try {
      const result = await startFinishedBatch(projectId, chapter, force,locale);
      setPanel(null);
      if (result.queued && !result.skipped.length) notify({ kind: "success", message: `已提交 ${result.queued} 页成品制作` });
      if (result.skipped.length) notify({ kind: "info", title: "部分页面已跳过", message: result.skipped.map(page => `${page.title || page.page_id}：${page.reason}`).join("\n") });
      if (!result.queued && !result.skipped.length) notify("当前范围没有需要生成的页面。");
    } catch (reason) { notify({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setBatching(false); setRefresh(value => value + 1); }
  }
  return <section className="utility-page finished-view">
    <header className="finished-heading">
      <div className="finished-title"><h2>成品</h2>{onLocaleChange&&<LetteringLocaleSelect value={locale} onChange={onLocaleChange}/>}<span aria-label="可查看成品与总页数">{loading && !pages.length ? "— / —" : `${images.length} / ${filtered.length}`} 页</span></div>
      <div className="finished-scope"><label>范围 <select aria-label="成品范围" value={chapter} onChange={event => setChapter(event.target.value)}><option value="">全项目</option>{chapters.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
        <button className="button finished-icon-button" aria-label="刷新成品状态" title="刷新成品状态" disabled={loading} onClick={() => { manualRefresh.current = true; setLoading(true); setRefresh(value => value + 1); }}><FinishedIcon kind="refresh" /></button>
      </div>
    </header>
    <div className="finished-summary" aria-label="成品状态">
      <span>尚未制作 <b className={missing ? "has-count" : ""}>{missing}</b></span><span>内容过时 <b className={stale ? "has-count" : ""}>{stale}</b></span><span>成品文件缺失 <b className={filesMissing ? "has-count" : ""}>{filesMissing}</b></span>
      <button className="finished-help" aria-label="成品状态说明" title="成品状态说明" onClick={() => setPanel("help")}>ⓘ</button>
    </div>
    <div className="finished-toolbar">
      <div className="finished-browse-actions"><button className="button" disabled={!images.length} onClick={() => setReaderPages(filtered.map(page => ({ src:page.record?.lettered_url?new URL(mediaVariantUrl(page.record.lettered_url, 1024), window.location.origin).href:'', ...(page.record?.media_kind==='video'&&page.record.lettered_url ? {original_src:new URL(page.record.lettered_url, window.location.origin).href} : {}), number:pageNumber(page), width:page.record?.width??768, height:page.record?.height??1024, media_kind:page.record?.media_kind,message:page.status==='files_missing'?'成品文件缺失':'本语言尚未制作',stale:page.status==='stale' })))}><FinishedIcon kind="read" />阅读预览</button>
        <button className="button button--primary finished-export-button" disabled={exportProgress !== null || !images.length} onClick={() => setPanel("export")}><FinishedIcon kind="export" />{exportProgress === "packing" ? "打包中…" : exportProgress ? `导出 ${exportProgress.total ? `${Math.min(99, Math.floor(exportProgress.received / exportProgress.total * 100))}%` : "…"}` : "导出"}</button>
      </div>
      <button className="button finished-batch-button" disabled={batching || anyBusy || !filtered.length} onClick={() => { setForce(false); setPanel("batch"); }}><FinishedIcon kind="make" />{batching ? "正在提交…" : anyBusy ? `制作中 · ${busyCount} 页` : "批量制作"}</button>
    </div>
    {!pages.length && !error && <p>{loading ? "正在读取成品…" : "暂无剧情页面。"}</p>}
    <div className="finished-grid">{filtered.map((page) => <FinishedCard key={page.page_id} page={page} index={pageNumber(page)-1} deleting={deleting === page.page_id} onPreview={() => setPreview({ id: page.page_id })} onDelete={() => void remove(page)} onOpen={() => onOpenPage(page.page_key)} />)}</div>
    {current?.record?.media_kind === "video" && preview && <ZoomableImageLightbox src={current.record.lettered_url!} originalVideo alt={`${number(current)} · 动态成品`} footer={`${number(current)} · 动态成品`} onPrevious={previewIndex > 0 ? () => setPreview({id:images[previewIndex-1].page_id}) : undefined} onNext={previewIndex+1 < images.length ? () => setPreview({id:images[previewIndex+1].page_id}) : undefined} onClose={() => setPreview(null)} />}
    {current?.record && current.record.media_kind !== "video" && preview && <ZoomableImageLightbox src={current.record.lettered_url!} alt={`${number(current)} 嵌字版`}
      footer={<span>{number(current)} · 嵌字版 · {current.record.width} × {current.record.height}{current.record.bytes !== null && ` · ${bytesLabel(current.record.bytes)}`}</span>}
      hint="查看当前范围成品 · 滚轮缩放 · 拖动查看细节"
      onPrevious={previewIndex > 0 ? () => setPreview({ ...preview, id: images[previewIndex - 1].page_id }) : undefined}
      onNext={previewIndex < images.length - 1 ? () => setPreview({ ...preview, id: images[previewIndex + 1].page_id }) : undefined}
      onClose={() => setPreview(null)} />}
    {readerPages && <FinishedReader locale={locale} pages={readerPages} onClose={() => setReaderPages(null)} />}
    {panel === "help" && <Modal title="成品状态说明" onClose={() => setPanel(null)}><dl className="finished-definitions">
      <dt>页数</dt><dd>当前可查看的成品 / 当前范围的剧情页数，包含内容过时的旧版成品。</dd>
      <dt>尚未制作</dt><dd>没有成品制作记录，需要首次输出。</dd><dt>内容过时</dt><dd>当前唯一候选、文案或排版与成品不一致，需重新制作。导出前未更新时仍使用旧版成品。</dd>
      <dt>成品文件缺失</dt><dd>有制作记录，但当前设备缺少对应成品文件。该状态优先于内容过时显示。</dd>
    </dl></Modal>}
    {panel === "export" && <Modal title="导出成品" subtitle={chapter ? chapters.find(([id]) => id === chapter)?.[1] : "全项目"} onClose={() => setPanel(null)} footer={<button className="button button--primary" disabled={!images.length} onClick={() => void download()}>{light ? "导出预览 HTML" : "导出媒体 ZIP"}</button>}>
      <div className="finished-options"><fieldset><legend>文件格式</legend><label><input type="radio" name="finished-format" checked={!light} onChange={() => setLight(false)} />媒体 ZIP</label><label><input type="radio" name="finished-format" checked={light} onChange={() => setLight(true)} />轻量 HTML</label></fieldset>
        {images.some(page => page.record?.media_kind !== 'video') && <label>图片版本<select value={variant} onChange={event => setVariant(event.target.value)}><option value="lettered">嵌字版</option><option value="clean">无字版</option><option value="both">两个版本</option></select></label>}
        <p>{images.length} 页 · {light ? "静态图和动态 WebP，最大宽度 1024px，支持混合阅读" : "静态 PNG 原尺寸 · 动态 WebP 最大宽度 1024px"}</p>
        {images.some(page => page.record?.media_kind === 'video') && <p>动态页不嵌字，只导出一份 WebP，不放大画面。</p>}
        {(missing + filesMissing > 0 || stale > 0) && <p>{missing + filesMissing} 页缺少成品文件，ZIP 中列出缺页说明，HTML 中保留占位；{stale} 页内容过时，将导出旧版。</p>}
      </div>
    </Modal>}
    {panel === "batch" && <Modal title="批量制作" subtitle={chapter ? chapters.find(([id]) => id === chapter)?.[1] : "全项目"} busy={batching} onClose={() => setPanel(null)} footer={<button className="button button--primary" disabled={batching || anyBusy || !targets.length} onClick={() => void batchOutput()}>{batching ? "正在提交…" : `开始制作 · ${targets.length} 页`}</button>}>
      <div className="finished-options"><fieldset className="finished-batch-options"><legend>制作方式</legend><label><input type="radio" name="finished-batch" checked={!force} onChange={() => setForce(false)} />仅制作尚未制作、内容过时或文件缺失的页面</label><label><input type="radio" name="finished-batch" checked={force} onChange={() => setForce(true)} />重新制作全部</label></fieldset>
        <p>采用每页当前唯一候选；零张或多张候选的插画／动态页跳过，文字页直接制作。动态页原尺寸输出，无音频、无超分；插画候选未变时复用超分底图。</p>
        <ul className="finished-batch-list">{targets.map(page => <li key={page.page_id}><span>{number(page)} · {page.title}</span><small>{page.status === "missing" ? "尚未制作" : page.status === "stale" ? "内容过时" : page.status === "files_missing" ? "成品文件缺失" : "重新制作"}</small></li>)}</ul>
        {!pendingPages.length && <p>当前范围无需更新。可以选择重新制作全部。</p>}
        {skipped.length > 0 && <><b>以下 {skipped.length} 页将跳过</b><ul className="finished-batch-list">{skipped.map(page => <li key={page.page_id}><button className="finished-page-link" onClick={() => { setPanel(null); onOpenPage(page.page_key); }}>{number(page)} · {page.title}</button><small>{page.batch_skip_reason}</small></li>)}</ul></>}
      </div>
    </Modal>}
  </section>;
}
function FinishedCard({ page, index, deleting, onPreview, onDelete, onOpen }: { page: FinishedPage; index: number; deleting: boolean; onPreview: () => void; onDelete: () => void; onOpen: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPressContextMenu();
  const record = page.record;
  const url = record?.lettered_url;
  const label = String(index + 1).padStart(3, "0");
  const description = [page.chapter_title, page.sequence_title, page.title].filter(Boolean).join(" / ");
  const status = deleting ? "正在删除…" : finishedBusy(page.job?.status) ? finishedJobLabel(page.job?.status) : page.status === "stale" ? "内容过时" : "";
  const openMenu = (point: { clientX: number; clientY: number }) => { if (record) setMenu({ x: point.clientX, y: point.clientY }); };
  return <article className="finished-card" {...longPress.captureProps}>
    <div data-long-press-context-menu onPointerDown={event => longPress.start(event, openMenu)} onContextMenu={event => { event.preventDefault(); openMenu(event); }}>
      {url ? <button onClick={onPreview} className="finished-image"><img src={mediaVariantUrl(record?.media_kind==='video' ? url : (record?.poster_url ?? url), 320)} loading="lazy" alt={`${label} ${record?.media_kind === 'video' ? '动态成品' : '嵌字版'}`} /></button> : <div className="finished-image finished-placeholder">{record ? "成品文件缺失" : "尚未制作"}</div>}
    </div>
    <div className="finished-card-body">
      <h3><button className="finished-page-link" title={description} onClick={onOpen}>{label}</button></h3>
      {record && <p>{record.width} × {record.height}{record.bytes !== null && ` · ${bytesLabel(record.bytes)}`}</p>}
      {page.translation_summary&&<small className="finished-card-status">缺译 {page.translation_summary.missing} · 原文变化 {page.translation_summary.stale}</small>}
      {status && <small className="finished-card-status">{status}</small>}
      {page.job?.error && <p role="alert">{page.job.error}</p>}
    </div>
    {menu && <NavigationContextMenu request={{ ...menu, label: `成品 ${label}`, items: [{ id: "delete", label: "删除成品", danger: true, disabled: deleting || finishedBusy(page.job?.status), onSelect: onDelete }] }} onClose={() => setMenu(null)} />}
  </article>;
}

function FinishedIcon({ kind }: { kind: "read" | "export" | "make" | "refresh" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "refresh" ? <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /> : kind === "export" ? <path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" /> : kind === "read" ? <path d="M12 5v16M3 4h5l4 2 4-2h5v15h-5l-4 2-4-2H3z" /> : <><rect x="3" y="4" width="16" height="16" rx="2" /><path d="m5 17 5-6 4 4 3-3M18 2v6m-3-3h6" /></>}
  </svg>;
}
