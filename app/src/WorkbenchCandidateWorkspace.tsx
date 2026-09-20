import { floatingLayerHost } from "./floating-layer";
import { useFloatingLayer } from "./floating-layer";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useDismissableLayer } from "./use-dismissable-layer";
import { mediaVariantUrl } from "./media-variant";
import { RetryableImage } from "./RetryableImage";
import { useNavigationDrawer } from "./workbench-presentation";
import { canUseWorkbenchShortcut } from "./workbench-shortcuts";
import ZoomableImageLightbox, { type ImageOverlayTarget } from "./ImageLightbox";
import { Modal } from "./Modal";
import { GenerateSplitButton } from "./GenerateSplitButton";
import { UndoIcon } from "./WorkbenchPageEditor";
import { FinishedOutputButton } from "./FinishedOutputButton";
import type { FinishedJob } from "./finished-client";
import { PromptIssueList } from "./PromptIssueList";
import { useFeedback } from "./feedback";
import type { PromptIssue } from "./prompt-audit-display";
import type { Candidate, PageMedia } from "./project-workbench-client";
import { useLongPressContextMenu } from "./use-long-press-context-menu";

export type WorkbenchCandidate = Candidate & {
  created_at?: string | null;
  prompt_signature?: string | null;
};

export type CandidateDeleteRequest =
  | { candidate_ids: string[] }
  | { prompt_mismatch: true; expected_signature?: string };

export type CandidateWorkspaceDetail = {
  title?: ReactNode;
  body: ReactNode;
};

type ContextMenuTrigger = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };

export type WorkbenchCandidateWorkspaceProps = {
  finishedOutput?: { projectId: string; pageId: string; onOutput: (candidateId?: string) => Promise<FinishedJob | null> };
  pageIdentity: string;
  pageTitle: string;
  canvas?: string | null;
  onPreviewCanvasChange: (canvas: string) => void;
  ownerLabel?: string;
  media: PageMedia;
  mediaStatus?: "loading" | "ready" | "error";
  mediaError?: string;
  onReloadMedia?: () => void | Promise<unknown>;
  candidateWidth: number;
  factReady: boolean;
  currentPromptSignature?: string | null;
  mediaReady?: boolean;
  generationReady: boolean;
  busy?: boolean;
  busyReason?: string;
  generationDisabledReason?: string;
  generationProblems?: PromptIssue[];
  onLetteringTarget: (target: HTMLSpanElement | null) => void;
  onFullscreenLetteringTarget?: (target: ImageOverlayTarget | null) => void;
  onCandidateWidthChange: (value: number) => void;
  onGenerate: (request: { count: 1 | 3 }) => void | Promise<void>;
  onSaveAndGenerate?: (request: { count: 1 | 3 }) => void | Promise<void>;
  generationCount?: 1 | 3;
  onGenerationCountChange?: (count: 1 | 3) => void;
  pageDirty?: boolean;
  onSaveAll?: () => void | Promise<unknown>;
  onDiscardAll?: () => void;
  onDeleteCandidates: (request: CandidateDeleteRequest) => Promise<boolean>;
  onLoadCandidateDetail?: (candidate: WorkbenchCandidate) => CandidateWorkspaceDetail | Promise<CandidateWorkspaceDetail>;
};

type CandidateMenuState = { candidate: WorkbenchCandidate; x: number; y: number };

function candidateKey(candidate: WorkbenchCandidate) {
  return candidate.candidate_id || candidate.file;
}

function copyText(label: string, value: string) {
  if (!value) return;
  void navigator.clipboard.writeText(value).catch(() => { window.prompt(label, value); });
}

function CandidateContextMenu({ state, canDelete, canDeleteOthers, hasDetails, onClose, onDetails, onDelete, onDeleteOthers }: {
  state: CandidateMenuState | null;
  canDelete: boolean;
  canDeleteOthers: boolean;
  hasDetails: boolean;
  onClose: () => void;
  onDetails: () => void;
  onDelete: () => void;
  onDeleteOthers: () => void;
}) {
  const menu = useRef<HTMLDivElement | null>(null);
  useFloatingLayer(menu, state);

  useDismissableLayer({ open: Boolean(state), ref: menu, onClose, closeOnScroll: true });

  if (!state) return null;
  const candidate = state.candidate;
  const action = (callback: () => void) => { callback(); onClose(); };
  return createPortal(<div ref={menu} className="navigation-context-menu navigation-context-menu--elevated" role="menu" aria-label={`候选 ${candidate.seed ?? ""}`}>
    <button type="button" role="menuitem" disabled={!hasDetails} onClick={() => action(onDetails)}>生成详情</button>
    <button type="button" role="menuitem" disabled={!candidate.candidate_id} onClick={() => action(() => copyText("复制候选图 ID", candidate.candidate_id))}>复制候选图 ID</button>
    <button type="button" role="menuitem" disabled={!Number.isInteger(candidate.seed)} onClick={() => action(() => copyText("复制 Seed", String(candidate.seed ?? "")))}>复制 Seed</button>
    <button type="button" role="menuitem" className="is-danger" disabled={!canDelete} onClick={() => action(onDelete)}>删除候选</button>
    <button type="button" role="menuitem" className="is-danger" disabled={!canDeleteOthers} onClick={() => action(onDeleteOthers)}>删除其他候选</button>
  </div>, floatingLayerHost());
}

const CANDIDATE_IMAGE_CONCURRENCY = 3;
const candidateImageQueue: Array<() => void> = [];
let candidateImageActive = 0;

function pumpCandidateImageQueue() {
  while (candidateImageActive < CANDIDATE_IMAGE_CONCURRENCY && candidateImageQueue.length) candidateImageQueue.shift()?.();
}

function enqueueCandidateImage(grant: () => void): () => void {
  let done = false;
  const start = () => { if (done) return; done = true; candidateImageActive += 1; grant(); };
  candidateImageQueue.push(start);
  pumpCandidateImageQueue();
  return () => {
    if (done) return;
    done = true;
    const index = candidateImageQueue.indexOf(start);
    if (index >= 0) candidateImageQueue.splice(index, 1);
  };
}

function releaseCandidateImageSlot() {
  candidateImageActive = Math.max(0, candidateImageActive - 1);
  pumpCandidateImageQueue();
}

function QueuedCandidateImage({ url, alt }: { url: string; alt: string }) {
  const img = useRef<HTMLImageElement | null>(null);
  const slotHeld = useRef(false);
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    if (granted) return;
    const node = img.current;
    if (!node) return;
    let cancel: (() => void) | null = null;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (!cancel) cancel = enqueueCandidateImage(() => { slotHeld.current = true; setGranted(true); });
        } else if (cancel) {
          cancel();
          cancel = null;
        }
      }
    }, { rootMargin: "240px 0px" });
    observer.observe(node);
    return () => { observer.disconnect(); cancel?.(); };
  }, [granted]);

  useEffect(() => () => { if (slotHeld.current) { slotHeld.current = false; releaseCandidateImageSlot(); } }, []);

  function finish() {
    if (!slotHeld.current) return;
    slotHeld.current = false;
    releaseCandidateImageSlot();
  }

  return <RetryableImage ref={img} src={granted ? url : undefined} alt={alt} draggable={false} loading="lazy" decoding="async" fetchPriority="low" onLoad={finish} onError={finish} />;
}

function CandidateGrid({ candidates, selectedIds, previewFile, disabled, layout, selectionAnchor, onSelectionChange, onPreview, onChoose, onContextMenu }: {
  candidates: WorkbenchCandidate[];
  selectedIds: Set<string>;
  previewFile?: string;
  disabled: boolean;
  layout: "rail" | "history";
  selectionAnchor: { current: string };
  onSelectionChange: (value: Set<string>) => void;
  onPreview: (candidate: WorkbenchCandidate) => void;
  onChoose: (candidate: WorkbenchCandidate) => void | Promise<void>;
  onContextMenu: (event: ContextMenuTrigger, candidate: WorkbenchCandidate) => void;
}) {
  const navigationDrawer = useNavigationDrawer();
  // 紧凑层（抽屉导航）没有常驻大预览，候选条点按即打开大图。
  const browse = navigationDrawer;
  const host = useRef<HTMLDivElement | null>(null);
  const longPress = useLongPressContextMenu();
  const items = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ pointerId: number; x: number; y: number; additive: boolean; base: Set<string>; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const ids = candidates.map((candidate) => candidate.candidate_id).filter(Boolean);

  // 候选按最新在前排列；新候选占据首位时把滚动位置拉回起点，让生成中的新图直接进入视野。
  const seenKeys = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (layout !== "rail") { seenKeys.current = null; return; }
    const previous = seenKeys.current;
    seenKeys.current = new Set(candidates.map(candidateKey));
    const first = candidates[0];
    if (!previous || !first || previous.has(candidateKey(first)) || !host.current) return;
    host.current.scrollTop = 0;
    host.current.scrollLeft = 0;
  }, [candidates, layout]);

  useEffect(() => {
    if (!previewFile) return;
    const candidate = candidates.find((item) => item.file === previewFile);
    const item = candidate ? items.current.get(candidateKey(candidate)) : null;
    const scroller = host.current;
    if (!item || !scroller) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    const left = item.offsetLeft;
    const right = left + item.offsetWidth;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
  }, [previewFile]);

  function orderedSelection(values: Set<string>) {
    return new Set(ids.filter((id) => values.has(id)));
  }

  function selectCandidate(event: ReactMouseEvent<HTMLButtonElement>, candidate: WorkbenchCandidate) {
    if (suppressClick.current) { event.preventDefault(); return; }
    if (navigationDrawer) { onPreview(candidate); void onChoose(candidate); return; }
    const id = candidate.candidate_id;
    if (event.shiftKey && id) {
      const anchorIndex = Math.max(0, ids.indexOf(selectionAnchor.current));
      const candidateIndex = ids.indexOf(id);
      const [start, end] = anchorIndex <= candidateIndex ? [anchorIndex, candidateIndex] : [candidateIndex, anchorIndex];
      const next = event.ctrlKey || event.metaKey ? new Set(selectedIds) : new Set<string>();
      for (const item of ids.slice(start, end + 1)) next.add(item);
      onSelectionChange(orderedSelection(next));
    } else if ((event.ctrlKey || event.metaKey) && id) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      onSelectionChange(orderedSelection(next));
      selectionAnchor.current = id;
    } else {
      onSelectionChange(id ? new Set([id]) : new Set());
      selectionAnchor.current = id;
    }
    onPreview(candidate);
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.pointerType === "touch" || disabled || browse) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, additive: event.ctrlKey || event.metaKey, base: new Set(selectedIds), dragging: false };
  }

  function updateDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || !host.current || start.pointerId !== event.pointerId) return;
    if (!start.dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    if (!start.dragging) {
      start.dragging = true;
      suppressClick.current = true;
      host.current.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const left = Math.min(start.x, event.clientX); const right = Math.max(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY); const bottom = Math.max(start.y, event.clientY);
    const bounds = host.current.getBoundingClientRect();
    setSelectionBox({ left: left - bounds.left + host.current.scrollLeft, top: top - bounds.top + host.current.scrollTop, width: right - left, height: bottom - top });
    const next = start.additive ? new Set(start.base) : new Set<string>();
    for (const [id, item] of items.current) {
      const rect = item.getBoundingClientRect();
      if (rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top) next.add(id);
    }
    onSelectionChange(orderedSelection(next));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (start.dragging && host.current?.hasPointerCapture(event.pointerId)) host.current.releasePointerCapture(event.pointerId);
    drag.current = null;
    setSelectionBox(null);
    if (start.dragging) window.requestAnimationFrame(() => { suppressClick.current = false; });
  }

  function selectAll(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (browse || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    onSelectionChange(new Set(ids));
  }

  return <div ref={host} className={`candidate-grid ${layout === "history" ? "candidate-grid--history" : ""}`.trim()} tabIndex={0} role="listbox" aria-label={layout === "history" ? "历史候选列表" : "候选列表"} aria-multiselectable={!browse} onKeyDown={selectAll} onPointerDown={beginDrag} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag} {...longPress.captureProps}>
    {candidates.map((candidate, index) => {
      const selected = browse ? previewFile === candidate.file : selectedIds.has(candidate.candidate_id);
      const separated = layout === "rail" && index > 0 && candidates[index - 1].prompt_signature !== candidate.prompt_signature;
      return <div className="candidate-entry" data-long-press-context-menu key={candidateKey(candidate)} onPointerDown={(event) => longPress.start(event, (point) => onContextMenu(point, candidate))} onContextMenu={(event) => onContextMenu(event, candidate)}>
        {separated && <div className="candidate-separator" title="Prompt 变化"><span>Prompt 变化</span></div>}
        <div ref={(node) => { const key = candidateKey(candidate); if (node) items.current.set(key, node); else items.current.delete(key); }} className={`candidate-item ${selected ? "is-selected" : ""} ${previewFile === candidate.file ? "is-preview" : ""}`.trim()}>
          <button type="button" role="option" className="candidate-select" disabled={disabled} aria-selected={selected} aria-label={`候选 Seed ${candidate.seed ?? "未知"}`} onClick={(event) => selectCandidate(event, candidate)} onDoubleClick={(event) => { if (!(event.ctrlKey || event.metaKey || event.shiftKey)) void onChoose(candidate); }}>
            <QueuedCandidateImage url={mediaVariantUrl(candidate.url, 320)} alt={`候选 ${candidate.seed ?? "未知"}`} />
            <span className="candidate-seed">{candidate.seed ?? "—"}</span>
          </button>
        </div>
      </div>;
    })}
    {!candidates.length && layout === "history" && <div className="candidate-grid-empty"><b>还没有历史候选</b><span>生成候选后会按最新在前排列在这里。</span></div>}
    {selectionBox && <i className="candidate-selection-box" style={selectionBox} aria-hidden="true" />}
  </div>;
}

function CandidatePaneResizeHandle({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const drag = useRef<{ pointerId: number; x: number; value: number } | null>(null);
  const clamp = (next: number) => Math.max(132, Math.min(280, next));
  function finish(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    document.body.classList.remove("is-pane-resizing");
  }
  return <div className="pane-resizer pane-resizer--candidates" role="separator" aria-label="调整候选图区域宽度" aria-orientation="vertical" aria-valuemin={132} aria-valuemax={280} aria-valuenow={value} tabIndex={0} title="拖动调整宽度；双击恢复默认"
    onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, value }; document.body.classList.add("is-pane-resizing"); }}
    onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) onChange(Math.round(clamp(drag.current.value - event.clientX + drag.current.x))); }}
    onPointerUp={finish} onPointerCancel={finish} onDoubleClick={() => onChange(160)}
    onKeyDown={(event) => { if (event.key === "Home") { event.preventDefault(); onChange(160); } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onChange(clamp(value + (event.key === "ArrowLeft" ? 12 : -12))); } }} />;
}

export function WorkbenchCandidateWorkspace({
  finishedOutput,
  pageIdentity, pageTitle, canvas, onPreviewCanvasChange, ownerLabel, media, mediaStatus = "ready", mediaError, onReloadMedia, candidateWidth, factReady, currentPromptSignature = null, mediaReady = true, generationReady, busy = false, busyReason, generationDisabledReason, generationProblems = [], onLetteringTarget, onFullscreenLetteringTarget, onCandidateWidthChange, onGenerate, onSaveAndGenerate, generationCount = 3, onGenerationCountChange, pageDirty = false, onSaveAll, onDiscardAll, onDeleteCandidates, onLoadCandidateDetail }: WorkbenchCandidateWorkspaceProps) {
  const { confirm } = useFeedback();
  const candidates = media.candidates as WorkbenchCandidate[];
  const [previewCandidate, setPreviewCandidate] = useState<WorkbenchCandidate | null>(null);
  const [fullscreen, setFullscreen] = useState<WorkbenchCandidate | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<CandidateMenuState | null>(null);
  const [detail, setDetail] = useState<{ candidate: WorkbenchCandidate; value: CandidateWorkspaceDetail | null; loading: boolean; error: string } | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [generationProblemsOpen, setGenerationProblemsOpen] = useState(false);
  const selectionAnchor = useRef("");
  const detailRequest = useRef(0);
  const operationBusy = busy || mutationBusy;
  const candidateOperationBusy = operationBusy || !mediaReady;
  const visibleCandidate = candidates.find((candidate) => candidate.candidate_id === previewCandidate?.candidate_id) ?? candidates[0] ?? null;
  const ids = candidates.map((candidate) => candidate.candidate_id).filter(Boolean);
  const commonDisabledReason = busyReason || (!factReady && !onSaveAndGenerate ? "有未保存修改，请先保存后生成" : "");
  const mismatchedCount = currentPromptSignature ? candidates.filter((candidate) => candidate.prompt_signature !== currentPromptSignature).length : 0;
  const generationReason = commonDisabledReason || generationDisabledReason || (!generationReady ? "当前页面尚未满足生成条件" : "");
  const generationDisabled = operationBusy || !generationReady || (!factReady && !onSaveAndGenerate);
  const [canvasWidth, canvasHeight] = (canvas ?? "2:3").split(":").map(Number);
  const aspectRatio = canvasWidth / canvasHeight || 2 / 3;

  useEffect(() => {
    setPreviewCandidate(null);
    setFullscreen(null);
    setHistoryOpen(false);
    setSelectedIds(new Set());
    setMenu(null);
    setDetail(null);
    setGenerationProblemsOpen(false);
    detailRequest.current += 1;
    selectionAnchor.current = "";
  }, [pageIdentity]);

  useEffect(() => {
    const available = new Set(ids);
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
    setPreviewCandidate((current) => candidates.find((candidate) => candidate.candidate_id === current?.candidate_id) ?? candidates[0] ?? null);
    setFullscreen((current) => current && candidates.find((candidate) => candidate.candidate_id === current.candidate_id) || null);
  }, [candidates, ids.join("\n")]);

  useEffect(() => {
    const active = fullscreen instanceof Object ? fullscreen.file : previewCandidate?.file;
    if (!active || detail || menu || fullscreen) return;
    const turn = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!canUseWorkbenchShortcut(event)) return;
      event.preventDefault();
      turnCandidate(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", turn);
    return () => window.removeEventListener("keydown", turn);
  }, [candidates, detail, fullscreen, menu, previewCandidate?.file]);

  async function guarded(action: () => void | Promise<void>) {
    if (operationBusy) return;
    setMutationBusy(true);
    try { await action(); } finally { setMutationBusy(false); }
  }

  function submitGeneration() {
    void guarded(() => (!factReady && onSaveAndGenerate ? onSaveAndGenerate({ count: generationCount }) : onGenerate({ count: generationCount })));
  }

  function openMenu(event: ContextMenuTrigger, candidate: WorkbenchCandidate) {
    event.preventDefault?.();
    event.stopPropagation?.();
    if (!selectedIds.has(candidate.candidate_id)) setSelectedIds(new Set([candidate.candidate_id]));
    setPreviewCandidate(candidate);
    setMenu({ candidate, x: event.clientX, y: event.clientY });
  }

  function contextIds(candidate: WorkbenchCandidate) {
    const selected = selectedIds.has(candidate.candidate_id) ? selectedIds : new Set([candidate.candidate_id]);
    return ids.filter((id) => selected.has(id));
  }

  function removableIds(values: string[]) {
    return values.filter((id) => ids.includes(id));
  }

  async function removeIds(removable: string[]) {
    await guarded(async () => {
      if (await onDeleteCandidates({ candidate_ids: removable })) {
        setSelectedIds((current) => new Set([...current].filter((id) => !removable.includes(id))));
        if (previewCandidate && removable.includes(previewCandidate.candidate_id)) setPreviewCandidate(null);
      }
    });
  }

  async function deleteIds(values: string[]) {
    const removable = removableIds(values);
    if (!removable.length || candidateOperationBusy) return;
    const question = removable.length === 1 ? `删除候选 Seed ${candidates.find((item) => item.candidate_id === removable[0])?.seed ?? "—"}？` : `删除选中的 ${removable.length} 张候选？`;
    if (!await confirm({ kind: "warning", title: "删除候选", message: `${question}\n图片会被删除，保留最小任务历史，此操作无法撤销。`, danger: true })) return;
    await removeIds(removable);
  }

  async function keepOnly(candidate: WorkbenchCandidate) {
    const kept = contextIds(candidate);
    const removable = removableIds(ids.filter((id) => !kept.includes(id)));
    if (!removable.length || candidateOperationBusy) return;
    const question = kept.length === 1
      ? `仅保留候选 Seed ${candidates.find((item) => item.candidate_id === kept[0])?.seed ?? "—"}，删除其他 ${removable.length} 张？`
      : `仅保留选中的 ${kept.length} 张，删除其他 ${removable.length} 张？`;
    if (!await confirm({ kind: "warning", title: "删除其他候选", message: `${question}\n图片会被删除，保留最小任务历史，此操作无法撤销。`, danger: true })) return;
    await removeIds(removable);
  }

  async function clearMismatched() {
    if (!currentPromptSignature || candidateOperationBusy) return;
    const removable = candidates.filter((candidate) => candidate.prompt_signature !== currentPromptSignature).map((candidate) => candidate.candidate_id).filter(Boolean);
    if (!removable.length) return;
    if (!await confirm({ kind: "warning", title: "清理候选", message: `清理与当前 Prompt 不符的候选？\n将删除 ${removable.length} 张，保留 ${candidates.length - removable.length} 张。此操作无法撤销。`, danger: true })) return;
    await guarded(async () => {
      if (await onDeleteCandidates({ prompt_mismatch: true, expected_signature: currentPromptSignature })) {
        setSelectedIds((current) => new Set([...current].filter((id) => !removable.includes(id))));
        if (previewCandidate && removable.includes(previewCandidate.candidate_id)) setPreviewCandidate(null);
      }
    });
  }

  async function openDetails(candidate: WorkbenchCandidate) {
    if (!onLoadCandidateDetail) return;
    const request = ++detailRequest.current;
    setDetail({ candidate, value: null, loading: true, error: "" });
    try {
      const value = await onLoadCandidateDetail(candidate);
      if (detailRequest.current === request) setDetail({ candidate, value, loading: false, error: "" });
    } catch (error) {
      if (detailRequest.current === request) setDetail({ candidate, value: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function turnCandidate(offset: number) {
    const index = candidates.findIndex((candidate) => candidate.candidate_id === (fullscreen ?? visibleCandidate)?.candidate_id);
    const next = candidates[(index + offset + candidates.length) % candidates.length];
    if (next) {
      setPreviewCandidate(next);
      if (fullscreen) setFullscreen(next);
      setSelectedIds(new Set([next.candidate_id])); selectionAnchor.current = next.candidate_id;
    }
  }

  const menuIds = menu ? contextIds(menu.candidate) : [];
  const menuCanDelete = removableIds(menuIds).length > 0;
  const menuCanDeleteOthers = removableIds(ids.filter((id) => !menuIds.includes(id))).length > 0;
  const generationProblemsButton = generationProblems.length > 0
    ? <button type="button" className="issue-indicator issue-indicator--error" aria-label={`查看 ${generationProblems.length} 个生成问题`} title="查看生成问题" onClick={() => setGenerationProblemsOpen(true)}>!</button>
    : null;

  return <>
    <aside className="page-images" style={{ "--candidate-width": `${candidateWidth}px` } as React.CSSProperties}>
    <div className="current-media-stack">
      {mediaStatus === "loading" && <div className="candidate-media-state">正在读取当前页面媒体…</div>}
      {mediaStatus === "error" && <div className="candidate-media-state candidate-media-state--error"><span>{mediaError || "读取当前页面媒体失败"}</span>{onReloadMedia && <button type="button" className="button button--quiet" onClick={() => void onReloadMedia()}>重试</button>}</div>}
      {visibleCandidate
        ? <div className="current-image current-image--lettering" style={{ "--preview-aspect": aspectRatio } as React.CSSProperties}>
          <span className="current-image__media">
            <RetryableImage src={mediaVariantUrl(visibleCandidate.url, 1024)} alt={`${pageTitle} 候选图预览`} title="点击放大查看" decoding="async" fetchPriority="high" onLoad={(event) => { const img = event.currentTarget; onPreviewCanvasChange(`${img.naturalWidth}:${img.naturalHeight}`); }} onClick={() => setFullscreen(visibleCandidate)} />
            <span className="current-image__lettering-target" ref={onLetteringTarget} />
          </span>
        </div>
        : <div className="current-image"><div><span>{mediaStatus === "loading" ? "正在读取候选…" : "暂无候选图"}</span></div></div>}
    {finishedOutput && <FinishedOutputButton key={pageIdentity} {...finishedOutput} candidateId={visibleCandidate?.candidate_id} dirty={pageDirty} disabled={mutationBusy || !visibleCandidate} />}
    </div>
    <CandidatePaneResizeHandle value={candidateWidth} onChange={onCandidateWidthChange} />
    <div className="candidate-rail">
      <div className="candidate-heading">
        <button type="button" className="candidate-history-trigger" onClick={() => setHistoryOpen(true)} aria-haspopup="dialog" aria-label={`打开历史候选，共 ${candidates.length} 张`}><b>候选</b><small>{candidates.length}</small></button>
        {<span className="candidate-heading-actions">{onReloadMedia && <button type="button" className="candidate-refresh-button" disabled={mediaStatus === "loading" || mutationBusy} aria-label="刷新当前页候选" aria-busy={mediaStatus === "loading"} title="重新读取当前页候选和数量" onClick={() => void onReloadMedia()}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .2 5M16 3v4h-4" /></svg></button>}<button type="button" className="candidate-clear-button" disabled={candidateOperationBusy || !mismatchedCount} aria-label="清理与当前 Prompt 不符的候选" title="清理与当前 Prompt 不符的候选" onClick={() => void clearMismatched()}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M8 3.5h4M6 5.5l.7 11h6.6l.7-11M8.2 8v5.7M11.8 8v5.7" /></svg></button></span>}
      </div>
      <CandidateGrid candidates={candidates} selectedIds={selectedIds} previewFile={visibleCandidate?.file} disabled={mutationBusy} layout="rail" selectionAnchor={selectionAnchor} onSelectionChange={setSelectedIds} onPreview={setPreviewCandidate} onChoose={setFullscreen} onContextMenu={openMenu} />
    </div>

    {historyOpen && <Modal size="workspace" title="历史候选" subtitle={<>{ownerLabel ? `${ownerLabel} · ` : ""}{pageTitle} · {candidates.length} 张</>} onClose={() => setHistoryOpen(false)} dismissible={!fullscreen && !menu && !detail} className="candidate-history-modal" ariaLabel="历史候选">
      {<div className="candidate-history-toolbar">
        <p>{selectedIds.size ? `已选择 ${selectedIds.size} 张` : "拖动框选；Ctrl 加选，Shift 连选，双击查看大图"}</p>
        <div>
          <button type="button" className="button button--quiet" disabled={!ids.length || selectedIds.size === ids.length} onClick={() => setSelectedIds(new Set(ids))}>全选</button>
          <button type="button" className="button button--quiet" disabled={!selectedIds.size} onClick={() => { setSelectedIds(new Set()); selectionAnchor.current = ""; }}>取消选择</button>
          <button type="button" className="button button--danger" disabled={candidateOperationBusy || !removableIds(ids.filter((id) => selectedIds.has(id))).length} onClick={() => void deleteIds(ids.filter((id) => selectedIds.has(id)))}>删除所选</button>
          <button type="button" className="button button--quiet" disabled={candidateOperationBusy || !mismatchedCount} title="清理与当前 Prompt 不符的候选" onClick={() => void clearMismatched()}>清理不符候选</button>
        </div>
      </div>}
      <CandidateGrid candidates={candidates} selectedIds={selectedIds} previewFile={visibleCandidate?.file} disabled={mutationBusy} layout="history" selectionAnchor={selectionAnchor} onSelectionChange={setSelectedIds} onPreview={setPreviewCandidate} onChoose={(candidate) => setFullscreen(candidate)} onContextMenu={openMenu} />
    </Modal>}

    {fullscreen && <ZoomableImageLightbox onOverlayTarget={onFullscreenLetteringTarget} src={fullscreen.url} alt={`${pageTitle} 候选图`} footer={<span>{ownerLabel ? `${ownerLabel} · ` : ""}{pageTitle}{fullscreen.seed === null ? "" : ` · Seed ${fullscreen.seed}`}</span>} onPrevious={() => turnCandidate(-1)} onNext={() => turnCandidate(1)} onClose={() => setFullscreen(null)} />}
    <CandidateContextMenu state={menu} canDelete={menuCanDelete} canDeleteOthers={menuCanDeleteOthers} hasDetails={Boolean(onLoadCandidateDetail)} onClose={() => setMenu(null)} onDetails={() => { if (menu) void openDetails(menu.candidate); }} onDelete={() => { if (menu) void deleteIds(contextIds(menu.candidate)); }} onDeleteOthers={() => { if (menu) void keepOnly(menu.candidate); }} />
    {detail && <Modal title={detail.value?.title ?? "候选生成详情"} subtitle={detail.candidate.candidate_id || detail.candidate.file} onClose={() => { detailRequest.current += 1; setDetail(null); }} className="candidate-detail-dialog" ariaLabel="候选生成详情">
      <div className="candidate-detail-body">
        {detail.loading && <div className="candidate-detail-state">正在读取生成参数…</div>}
        {detail.error && <div className="candidate-detail-state candidate-detail-state--error">{detail.error}</div>}
        {detail.value?.body}
      </div>
    </Modal>}
    {generationProblemsOpen && <Modal title="无法生成" subtitle={`${generationProblems.length} 个问题`} onClose={() => setGenerationProblemsOpen(false)} ariaLabel="生成问题"><div className="issue-dialog-body"><PromptIssueList issues={generationProblems} /></div></Modal>}
    </aside>
    <div className="mobile-generate-bar" aria-label="页面操作">
      {onDiscardAll && <button type="button" className="icon-button" aria-label="放弃本页全部修改" title="放弃本页全部修改" disabled={operationBusy || !pageDirty} onClick={() => onDiscardAll()}><UndoIcon /></button>}
      {onSaveAll && <button type="button" className="button button--quiet" disabled={operationBusy || !pageDirty} onClick={() => void onSaveAll()}>保存</button>}
      <GenerateSplitButton dirty={!factReady} count={generationCount} disabled={generationDisabled} reason={generationReason} onSubmit={submitGeneration} onCountChange={onGenerationCountChange} />
      {generationProblemsButton}
    </div>
  </>;
}
