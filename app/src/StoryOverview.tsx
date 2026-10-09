import { useEffect, useId, useRef, useState } from "react";
import {
  loadPageMedia,
  runNavigationAction,
  saveStorySummary,
  startPageRender,
  type ProjectWorkbenchView,
  type StorySummaryResult,
  type StorySummaryTarget,
  type WorkbenchCharacter,
  type WorkbenchPage,
} from "./project-workbench-client";
import { mediaVariantUrl } from "./media-variant";
import { TextPageArtwork } from "./TextPageArtwork";
import type { LetteringStyle } from "./lettering";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { StoryCandidateRefresh } from "./StoryCandidateRefresh";
import ZoomableImageLightbox from "./ImageLightbox";
import { useFeedback } from "./feedback";

export type StoryOverviewTarget = ({ kind: "overview" } | { kind: "chapter" | "sequence"; id: string }) & { requestId?: number };

type SummaryEditorProps = {
  projectId: string;
  target: StorySummaryTarget;
  label: string;
  text: string;
  sha256: string;
  busy: boolean;
  onSaved: (result: StorySummaryResult) => void;
  onReload: () => Promise<void>;
};

function SummaryEditor({ projectId, target, label, text, sha256, busy, onSaved, onReload }: SummaryEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(text); setError(""); }, [text, sha256]);
  const dirty = draft !== text;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await saveStorySummary(projectId, target, draft, sha256);
      if (!mounted.current) return;
      onSaved(result);
      setEditing(false);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "保存失败");
      try { await onReload(); } catch { /* 后台同步会继续重试，保留当前错误。 */ }
    } finally { if (mounted.current) setSaving(false); }
  }

  return <section className={editing ? "story-summary-editor" : "story-summary-reader"} data-project-fact-dirty={dirty || saving ? "true" : undefined}>
    <header>{editing ? <label htmlFor={id}>{target.kind === "synopsis" ? "故事梗概" : "摘要"}</label> : target.kind === "synopsis" ? <h4>故事梗概</h4> : null}
      <div className="story-summary-actions">{editing ? <>
        <button type="button" className="button button--quiet" disabled={saving} onClick={() => { setDraft(text); setError(""); setEditing(false); }}>取消</button>
        <button type="button" className="button button--quiet" aria-label={`保存${label}`} disabled={busy || saving || !dirty || !draft.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
      </> : <button type="button" className="button button--quiet" aria-label={`编辑${label}`} disabled={busy} onClick={() => setEditing(true)}>编辑</button>}</div>
    </header>
    {editing ? <textarea id={id} aria-label={label} rows={3} autoFocus value={draft} disabled={saving || busy} onChange={(event) => setDraft(event.target.value)} /> : <p>{text || "暂无摘要"}</p>}
    {error && <p className="prompt-save-error" role="alert">{error}</p>}
  </section>;
}

function StoryTitleEditor({ projectId, kind, targetId, title, busy, onReload }: {
  projectId: string;
  kind: "chapter" | "sequence";
  targetId: string;
  title: string;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(title); setError(""); }, [title]);
  const label = kind === "chapter" ? "章节名称" : "情节单元名称";
  const Heading = kind === "chapter" ? "h3" : "h4";

  async function save() {
    setSaving(true);
    setError("");
    try {
      await runNavigationAction(projectId, `rename-${kind}`, { [`${kind}_id`]: targetId, title: draft.trim() });
      await onReload();
      if (mounted.current) setEditing(false);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "重命名失败");
      try { await onReload(); } catch { /* 保留错误，等待后台同步。 */ }
    } finally { if (mounted.current) setSaving(false); }
  }

  function cancel() { setEditing(false); setDraft(title); setError(""); }

  return <div className="story-overview-title" data-project-fact-dirty={editing && (draft !== title || saving) ? "true" : undefined}>
    {editing ? <form onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" && !saving && !event.nativeEvent.isComposing) { event.preventDefault(); cancel(); }
    }} onSubmit={(event) => { event.preventDefault(); if (!busy && !saving && draft.trim() && draft.trim() !== title) void save(); }}>
      <input aria-label={label} value={draft} autoFocus disabled={busy || saving} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!busy && !saving && draft.trim() && draft.trim() !== title) void save();
        }
      }} />
      <button type="submit" className="button button--quiet" aria-label={`保存${label}`} disabled={busy || saving || !draft.trim() || draft.trim() === title}>{saving ? "保存中…" : "保存"}</button>
      <button type="button" className="button button--quiet" disabled={saving} onClick={cancel}>取消</button>
      {error && <p className="prompt-save-error" role="alert">{error}</p>}
    </form> : <>
      <Heading>{title}</Heading><button type="button" className="button button--quiet story-overview-rename" aria-label={`重命名${kind === "chapter" ? "章节" : "情节单元"}：${title}`} disabled={busy} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(true); }}>重命名</button>
    </>}
  </div>;
}

function characterName(characters: WorkbenchCharacter[], id: string, variantId?: string) {
  const character = characters.find((entry) => entry.id === id);
  const variant = character?.visual.variants.find((entry) => entry.id === variantId);
  return `${character?.name ?? id}${variant ? ` · ${variant.name}` : ""}`;
}

function LatestCandidatePreview({ projectId, pageId, title }: { projectId: string; pageId: string; title: string }) {
  const root = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>();
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [originalVideo, setOriginalVideo] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision: string | undefined;
    // 只刷新屏幕内的卡片，每次等待读取结束后再安排下一次。
    const observer = new IntersectionObserver(([entry]) => {
      controller?.abort();
      clearTimeout(timer);
      if (!entry.isIntersecting) return;
      const request = new AbortController();
      controller = request;
      async function refresh() {
        try {
          const result = await loadPageMedia(projectId, { page_id: pageId }, request.signal, revision);
          if (request.signal.aborted) return;
          if (result) {
            revision = result.revision;
            const candidate=result.media.candidates[0];
            setUrl(candidate?.video_url ?? candidate?.url ?? null);
            setOriginalVideo(candidate?.media_kind==='video');
          }
          setFailed(false);
        } catch {
          if (!request.signal.aborted) setFailed(true);
        } finally {
          if (!request.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
        }
      }
      void refresh();
    });
    observer.observe(element);
    return () => { observer.disconnect(); controller?.abort(); clearTimeout(timer); };
  }, [projectId, pageId]);
  return <><button type="button" className="story-page-thumbnail" ref={root} aria-label={`查看图片：${title}`} disabled={!url || failed} onClick={() => { if (url) setLightboxUrl(url); }}>
    {url && !failed ? <img src={mediaVariantUrl(url, 320)} alt={`${title}最新候选图`} loading="lazy" onError={() => setFailed(true)} /> : <span>{failed ? "缩略图暂不可用" : url === undefined ? "加载缩略图…" : "暂无候选图"}</span>}
    </button>{lightboxUrl && <ZoomableImageLightbox src={lightboxUrl} originalVideo={originalVideo} alt={`${title}最新候选图`} footer={title} onClose={() => setLightboxUrl(null)} />}</>;
}

function StoryPageCard({ projectId, page, number, busy, letteringStyle, canvasAspect, onOpen }: {
  projectId: string; page: WorkbenchPage; number?: number; busy: boolean;
  letteringStyle: LetteringStyle | null; canvasAspect?: string; onOpen: (page: WorkbenchPage) => void;
}) {
  const { notify } = useFeedback();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function generate() {
    if (pending.current || busy) return;
    pending.current = true;
    setSubmitting(true);
    try {
      await startPageRender(projectId, page.page_key, { operation: "candidates", count: 1 });
      if (mounted.current) notify({ kind: "success", message: `已提交“${page.title}”的单张生成任务` });
    } catch (error) {
      if (mounted.current) notify({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  return <article className="story-overview-page">
    {page.page_kind === "text"
      ? <span className="story-page-thumbnail story-page-thumbnail--text" style={canvasAspect ? { aspectRatio: canvasAspect } : undefined} aria-label={`文字页：${page.title}`}>{letteringStyle ? <TextPageArtwork title={page.display_title ?? ""} body={page.body ?? ""} layout={page.text_layout} style={letteringStyle} /> : <span>{page.title}</span>}</span>
      : <LatestCandidatePreview projectId={projectId} pageId={page.page_id} title={page.title} />}
    <div className="story-page-card-title">
      <button type="button" className="story-page-open" aria-label={`打开页面：${page.title}`} onClick={() => onOpen(page)}>
        <span className="story-overview-page-number">{String(number).padStart(2, "0")}</span><strong>{page.title}</strong>
      </button>
      {page.page_kind !== "text" && <button type="button" className="story-page-generate" aria-label={`为“${page.title}”生成一张候选`} title="生成一张候选" disabled={busy || submitting} aria-busy={submitting} onClick={() => void generate()}>{submitting ? "…" : "+"}</button>}
    </div>
    <p className="story-page-excerpt">{page.page_kind === "text" ? (page.body?.trim().split("\n")[0] || "文字页 · 无正文") : page.scene_description?.trim() || "尚未填写画面内容"}</p>
  </article>;
}

function StoryPageStrip({ projectId, title, pages, pageOrder, busy, letteringStyle, canvasAspect, onOpen }: {
  projectId: string;
  title: string;
  pages: WorkbenchPage[];
  pageOrder: Map<string, number>;
  busy: boolean;
  letteringStyle: LetteringStyle | null;
  canvasAspect?: string;
  onOpen: (page: WorkbenchPage) => void;
}) {
  return <div className="story-page-strip">
    <div className="story-overview-pages" role="region" aria-label={`${title}的分页`} tabIndex={0}>
      {pages.map((page) => <StoryPageCard key={`${projectId}:${page.page_id}`} projectId={projectId} page={page} number={pageOrder.get(page.page_id)} busy={busy} letteringStyle={letteringStyle} canvasAspect={canvasAspect} onOpen={onOpen} />)}
    </div>
  </div>;
}

function StorySequenceDialogue({ pages, pageOrder, characters, onOpen }: {
  pages: WorkbenchPage[];
  pageOrder: Map<string, number>;
  characters: WorkbenchCharacter[];
  onOpen: (page: WorkbenchPage) => void;
}) {
  const withDialogue = pages.filter((page) => page.dialogue?.length);
  if (!withDialogue.length) return null;
  return <section className="story-sequence-dialogue" aria-label="分页文案">
    {withDialogue.map((page) => {
      const hearts = page.dialogue!.filter((line) => line.mode === "heart");
      return <div className="story-dialogue-row" key={page.page_id}>
        <button type="button" className="story-dialogue-page" aria-label={`查看第 ${pageOrder.get(page.page_id)} 页文案：${page.title}`} onClick={() => onOpen(page)}>{String(pageOrder.get(page.page_id)).padStart(2, "0")} · {page.title}</button>
        <ul>
          {page.dialogue!.filter((line) => line.mode !== "heart").map((line) => <li key={line.id}>
            <span>{line.mode === "narration" ? "旁白" : `${line.speaker === "npc" ? "NPC" : characterName(characters, line.speaker ?? "")}${line.mode === "thought" ? " · 心声" : ""}`}</span>
            <p>{line.text}</p>
          </li>)}
          {hearts.length > 0 && <li className="story-dialogue-hearts">
            <span>爱心 ×{hearts.length}</span>
            <p>{hearts.map((line) => <span className="story-heart-chip" key={line.id}>{line.text}</span>)}</p>
          </li>}
        </ul>
      </div>;
    })}
  </section>;
}

export default function StoryOverview({ projectId, view, focusTarget, busy, onSaved, onReload, onOpenPage, onSelectTarget }: {
  projectId: string;
  view: ProjectWorkbenchView;
  focusTarget?: StoryOverviewTarget | null;
  busy: boolean;
  onSaved: (result: StorySummaryResult) => void;
  onReload: () => Promise<void>;
  onOpenPage: (page: WorkbenchPage) => void;
  onSelectTarget: (target: StoryOverviewTarget) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const chapters = view.outline.chapters;
  const sequences = chapters.flatMap((chapter) => chapter.sequences);
  const pages = sequences.flatMap((sequence) => sequence.pages);
  const pageOrder = new Map(pages.map((page, index) => [page.page_id, index + 1]));
  const letteringStyle = view.project.lettering_settings;
  const canvasAspect = view.project.canvas?.includes(":") ? view.project.canvas.replace(":", " / ") : undefined;
  const editorProps = { projectId, busy, onSaved, onReload };
  const [showActions, setShowActions] = useState(false);
  const kind = focusTarget?.kind ?? "overview";
  const targetId = focusTarget && focusTarget.kind !== "overview" ? focusTarget.id : "";
  const requestId = focusTarget?.requestId;
  const selectedChapter = chapters.find(item => kind === "chapter" ? item.id === targetId : item.sequences.some(seq => seq.id === targetId));
  const selectedSequence = kind === "sequence" ? selectedChapter?.sequences.find(item => item.id === targetId) : undefined;
  const scope = selectedChapter ? kind : "overview";
  const scopePages = scope === "overview" ? pages : selectedSequence ? selectedSequence.pages : selectedChapter!.sequences.flatMap(item => item.pages);
  const scopeLabel = scope === "overview" ? "全文" : selectedSequence ? selectedChapter!.title + " / " + selectedSequence.title : selectedChapter!.title;
  const peers = scope === "chapter" ? chapters : scope === "sequence" ? sequences : [];
  const peerIndex = peers.findIndex(item => item.id === targetId);

  // 窄屏由文档滚动，桌面由内容栏滚动；吸顶偏移跟随实际顶栏高度。
  useEffect(() => {
    const element = root.current;
    const main = element?.closest<HTMLElement>(".project-main");
    const topbar = document.querySelector<HTMLElement>(".topbar");
    if (!element || !main || !topbar) return;
    const update = () => element.style.setProperty("--story-sticky-offset", getComputedStyle(main).overflowY === "visible" ? `${topbar.getBoundingClientRect().height}px` : "0px");
    const observer = new ResizeObserver(update);
    observer.observe(topbar);
    observer.observe(main);
    update();
    return () => observer.disconnect();
  }, []);

  // 导航是一次性请求；后台刷新创建的新对象不能再次抢走阅读位置。
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => root.current?.querySelector(".story-overview-layout")?.scrollIntoView({ block: "start" }));
    setShowActions(false);
    return () => window.cancelAnimationFrame(frame);
  }, [kind, targetId, requestId]);

  return <div className="story-overview" ref={root}>
    <WorkspaceHeader title="剧情总览" meta={chapters.length + " 章 · " + sequences.length + " 情节单元 · " + pages.length + " 页"} />
    <div className="story-overview-layout">
      <nav className="story-overview-directory" aria-label="剧情阅读目录">
        <strong>阅读目录</strong>
        <button type="button" aria-current={scope === "overview" ? "location" : undefined} onClick={() => onSelectTarget({ kind: "overview" })}>全文</button>
        <ol>{chapters.map((item, index) => <li key={item.id}>
          <button type="button" aria-current={scope === "chapter" && targetId === item.id ? "location" : undefined} onClick={() => onSelectTarget({ kind: "chapter", id: item.id })}>{index + 1}. {item.title}</button>
          <ol>{item.sequences.map((seq, seqIndex) => <li key={seq.id}>
            <button type="button" aria-current={scope === "sequence" && targetId === seq.id ? "location" : undefined} onClick={() => onSelectTarget({ kind: "sequence", id: seq.id })}>{index + 1}.{seqIndex + 1} {seq.title}<small>{seq.pages.length} 页</small></button>
          </li>)}</ol>
        </li>)}</ol>
      </nav>
      <div className="story-overview-reader">
        <div className="story-reading-toolbar">
          <span className="story-reading-location">{scopeLabel}<small>{scopePages.length} 页</small></span>
          <div className="story-reading-controls">
            {scope !== "overview" && <>
              <button type="button" className="button button--quiet" aria-label={scope === "chapter" ? "上一章" : "上一个情节单元"} disabled={peerIndex <= 0} onClick={() => onSelectTarget({ kind: scope, id: peers[peerIndex - 1].id })}>←</button>
              <button type="button" className="button button--quiet" aria-label={scope === "chapter" ? "下一章" : "下一个情节单元"} disabled={peerIndex < 0 || peerIndex >= peers.length - 1} onClick={() => onSelectTarget({ kind: scope, id: peers[peerIndex + 1].id })}>→</button>
            </>}
            <button type="button" className="button button--quiet" aria-expanded={showActions} onClick={() => setShowActions(value => !value)}>更多</button>
          </div>
          <div className="story-reading-actions" hidden={!showActions}>
            <span>当前范围：{scopeLabel}</span>
            <StoryCandidateRefresh key={projectId + ":" + scope + ":" + targetId} projectId={projectId} pages={scopePages} busy={busy} scopeLabel={scopeLabel} pageOrder={pageOrder} />
          </div>
        </div>
    {scope === "overview" && <div id="story-overview-synopsis" className="story-overview-synopsis">
    <SummaryEditor {...editorProps} target={{ kind: "synopsis" }} label="故事梗概" text={view.outline.synopsis} sha256={view.outline.synopsis_sha256} />
    </div>}
    {chapters.length === 0 && <p className="story-overview-empty">还没有章节。</p>}
    {chapters.map((chapter, chapterIndex) => (scope === "overview" || chapter.id === selectedChapter?.id) && <section id={`story-chapter-${chapter.id}`} className="story-overview-chapter" data-story-overview-kind="chapter" data-story-overview-id={chapter.id} key={chapter.id}>
      <header className="story-section-heading"><span className="story-section-number">Chapter {chapterIndex + 1}</span><StoryTitleEditor projectId={projectId} kind="chapter" targetId={chapter.id} title={chapter.title} busy={busy} onReload={onReload} /></header>
      <SummaryEditor {...editorProps} target={{ kind: "chapter", id: chapter.id }} label={`章节摘要：${chapter.title}`} text={chapter.summary} sha256={chapter.summary_sha256} />
      <div className="story-overview-sequences">{chapter.sequences.map((sequence, sequenceIndex) => (scope !== "sequence" || sequence.id === targetId) && <section id={`story-sequence-${sequence.id}`} className="story-overview-sequence" data-story-overview-kind="sequence" data-story-overview-id={sequence.id} key={sequence.id}>
        <header className="story-section-heading"><span className="story-section-number">Sequence {sequenceIndex + 1}</span><StoryTitleEditor projectId={projectId} kind="sequence" targetId={sequence.id} title={sequence.title} busy={busy} onReload={onReload} /></header>
        <SummaryEditor {...editorProps} target={{ kind: "sequence", id: sequence.id }} label={`情节单元摘要：${sequence.title}`} text={sequence.summary} sha256={sequence.summary_sha256} />
        {sequence.pages.length === 0 ? <p className="story-overview-empty">尚未分页。</p> : <>
          <StoryPageStrip projectId={projectId} title={sequence.title} pages={sequence.pages} pageOrder={pageOrder} busy={busy} letteringStyle={letteringStyle} canvasAspect={canvasAspect} onOpen={onOpenPage} />
          <StorySequenceDialogue pages={sequence.pages} pageOrder={pageOrder} characters={view.characters} onOpen={onOpenPage} />
        </>}
      </section>)}</div>
    </section>)}
      </div>
    </div>
  </div>;
}
