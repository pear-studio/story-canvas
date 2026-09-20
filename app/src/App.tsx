import { ProjectDirectoryDialog, type RegisteredProject } from "./ProjectDirectoryDialog";
import { ProjectListEntry } from "./ProjectListEntry";
import { useTooltips } from "./use-tooltips";
import { NavigationSearch } from "./NavigationSearch";
import { ProjectMenu, type ProjectAction } from "./ProjectMenu";
import { navigationIdentity, navigationSection, rememberNavigation, type NavigationSection, type NavigationHistory } from "./navigation-history";
import { InheritedPromptEditor } from './InheritedPromptEditor';
import { PageMoveDialog } from './PageMoveDialog';
import { SettingView } from './SettingView';
import { InheritanceConfirmationRequired } from './api-response';
import type { InheritedAdjustments, Scene } from './project-workbench-client';
import { PromptOverview } from "./PromptOverview";
import type { ImageOverlayTarget } from "./ImageLightbox";
import { FinishedPagesView } from "./FinishedPagesView";
import { startFinishedPage } from "./finished-client";
import { promptIssueSummary, type PromptIssue } from "./prompt-audit-display";
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useNavigationDrawer } from "./workbench-presentation";
import { Popover } from "./Popover";
import { WorkbenchNavigation } from "./WorkbenchNavigation";
import { canUseWorkbenchShortcut, isWorkbenchModalOpen } from "./workbench-shortcuts";
import { responseJson } from "./api-response";
import ComparisonExperimentsView from "./ComparisonExperimentsView";
import { GenerationDetailsPanel } from "./GenerationDetailsPanel";
import GlobalModelsView, { type GlobalResources } from "./GlobalModelsView";
import LoraTrainingView, { type LoraDatasetSummary } from "./LoraTrainingView";
import { NamedEntityCreateDialog } from "./NamedEntityCreateDialog";
import { NavigationContextMenu, type NavigationMenuItem, type NavigationMenuRequest } from "./NavigationContextMenu";
import { syncNavigationUrl } from "./navigation-restoration";
import { initialWorkbenchNavigation, projectNavigation, openNavigationPage, openNavigationCharacter, openNavigationScene, openNavigationTab, reconcileNavigation, type ActiveTab, type NavigationState } from "./workbench-navigation";
import { characterRevealBranchKeys, sceneRevealBranchKeys, chooseInitialProjectId, navigationCollapsedStorageKey, readCollapsedBranchKeys, readLastProjectId, storyRevealBranchKeys, writeCollapsedBranchKeys, writeLastProjectId } from "./navigation-collapse";
import { navigationDropBeforeId } from "./navigation-drop";
import ProjectGenerationSettingsView from "./ProjectGenerationSettingsView";
import StoryOverview, { type StoryOverviewTarget } from "./StoryOverview";
import { PromptFragmentEditor, ReadonlyLoraTrigger, type PromptFragment as DisplayPromptFragment } from "./PromptFragmentEditor";
import { createPromptDraftFragment, displayPromptDraft, persistPromptDraft } from "./prompt-fragment-draft";
import { createProjectRequestGuard } from "./project-request-guard";
import { createWorkbenchSnapshotSync } from "./workbench-snapshot-sync";
import { createPageMediaRequestGuard } from "./page-media-request";
import { ProjectLetteringSettingsView, ProjectMaterialsView, ProjectSettingsView } from "./ProjectUtilityViews";
import { ResourceDetailsButton, ResourcePicker, ResourcePreview, loraResourceCatalogItem, rawLoraCatalogItem, resourceStatusLabel, type LoraResourceDefinition, type ResourceCatalogItem } from "./ResourceCatalog";
import { Modal } from "./Modal";
import { rawLoraResourceDefinition, useProjectLoraResources, type LoraResourceList } from "./use-lora-resources";
import RuntimeStatusBar, { type TaskControlResult } from "./RuntimeStatusBar";
import { TaskDetailDialog, TaskHistory, TaskResultViewer, type TaskPreview } from "./TaskViews";
import type { GlobalTask } from "./runtime-status";
import { stabilizeComfyRuntimeProbe } from "./comfy-runtime-status";
import { areTrackedTasksTerminal, createSerialPoller, type BackendHealth, type HardwareStatus, type RuntimePageKey, type TaskCollection } from "./runtime-status";
import { VisualPageTemplateDialog } from "./VisualPageTemplateDialog";
import WorkbenchPageEditor, { type WorkbenchPageContentDraft } from "./WorkbenchPageEditor";
import { WorkbenchCandidateWorkspace, type CandidateWorkspaceDetail } from "./WorkbenchCandidateWorkspace";
import { TextPageWorkspace } from "./TextPageWorkspace";
import { InlineTitleEditor, SectionHeader, WorkspaceHeader } from "./WorkspaceHeader";
import { useFeedback } from "./feedback";
import { applyImagePrivacy, persistImagePrivacy } from "./image-privacy.mjs";
import { useLongPressContextMenu } from "./use-long-press-context-menu";
import {
  mutateFacts,
  getProjectWriteRevision,
  isProjectRefreshRequired,
  isProjectWritePending,
} from "./project-write-client";
import {
  loadCandidateCounts,
  deleteCandidates,
  inspectPageRender,
  loadCandidateDetail,
  loadPageMedia,
  loadProjectRevision,
  promptCategories,
  runNavigationAction,
  saveWholePage,
  savePageLettering,
  saveCharacterProfile,
  saveCharacterPrompt,
  saveCharacterVisual,
  saveLetteringSettings,
  renameCharacterVariant,
  savePagePrompt,
  startPageRender,
  type CharacterLora,
  type CharacterPromptDocument,
  type CharacterPromptSetting,
  type CharacterProfileDraft,
  type CharacterVisualDraft,
  type CandidateDetail,
  type PageRenderInspection,
  type PageMedia,
  type PagePrompt,
  type ProjectWorkbenchView,
  type WorkbenchCharacter,
  type WorkbenchPage,
} from "./project-workbench-client";
import { pageKeyId, samePageKey } from "./page-key";
import { replaceWorkbenchPage } from "./workbench-page-patch";
import { type LetteringItem, type LetteringSettings } from "./lettering";
import type { VisualPageTemplate, VisualPageTemplateSubject, VisualPageTemplateTarget } from "./visual-page-templates";

type ProjectSummary = { id: string; title: string; pages: number };
type ProjectCollection = { projects: ProjectSummary[] };
type NamedCreateTarget = { kind: "character" | "scene" } | { kind: "variant"; entityKind?: "character" | "scene"; characterId: string; characterName: string; afterVariantId?: string };
const paneLayoutStorageKey = "story-canvas:pane-layout:v1";
const generationCountStorageKey = "story-canvas:generation-count:v2";
const imagePrivacyHoldDelayMs = 350;
const unsavedFactsSelector = '[data-project-fact-dirty="true"], [data-page-content-dirty="true"], [data-page-prompt-dirty="true"], [data-lettering-dirty="true"]';
type PageLocation = {
  page: WorkbenchPage;
  key: string;
  breadcrumb: string[];
};

const promptLabels: Record<(typeof promptCategories)[number], string> = { subject: "主体", person: "人物",  setting: "场景", camera: "镜头", avoid: "避免" };

function pageKey(page: WorkbenchPage) {
  return pageKeyId(page.page_key);
}

/** 子设定 ID 规则：小写字母、数字与连字符（与服务端 storyIdPattern 一致）。 */
const characterVariantIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function pageCandidateStatus(page: WorkbenchPage, counts: Record<string, number> | null) {
  const count = counts === null ? null : counts[pageKeyId(page.page_key)] ?? 0;
  return { className: count ? "page-status--prompt" : "", label: count === null ? "—" : `${count} 张`, title: count === null ? "候选数量尚未读取" : `${count} 张可用候选图` };
}

const emptyPageMedia: PageMedia = { candidates: [] };

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;

/** 导航宽度的自动估值，与 styles.css 中 --sidebar-track 的 clamp(200px, min(26vw, 340px), min(400px, 34vw)) 保持一致。 */
function autoSidebarWidth() {
  return clamp(Math.round(window.innerWidth * 0.26), SIDEBAR_MIN, Math.min(340, Math.round(window.innerWidth * 0.34)));
}

function loadPaneLayout() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(paneLayoutStorageKey) ?? "{}") as { editor?: number; candidates?: number };
    return {
      editor: Number.isFinite(stored.editor) ? clamp(Number(stored.editor), 32, 64) : 44,
      candidates: Number.isFinite(stored.candidates) ? clamp(Number(stored.candidates), 132, 280) : 160,
    };
  } catch {
    return { editor: 44, candidates: 160 };
  }
}

function PaneResizeHandle({ className, label, value, defaultValue, min, max, unit = "px", direction = 1, onChange, onReset }: {
  className: string;
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  unit?: "px" | "%";
  direction?: 1 | -1;
  onChange: (value: number) => void;
  /** 提供时双击与 Home 键恢复自动默认（onReset），而不是写成固定 defaultValue。 */
  onReset?: () => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; trackWidth: number } | null>(null);
  useEffect(() => () => document.body.classList.remove("is-pane-resizing"), []);

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    document.body.classList.remove("is-pane-resizing");
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const scale = unit === "%" ? 100 / current.trackWidth : 1;
    const next = clamp(current.startValue + (event.clientX - current.startX) * scale * direction, min, max);
    onChange(unit === "%" ? Math.round(next * 10) / 10 : Math.round(next));
  }

  function resetToDefault() {
    if (onReset) onReset();
    else onChange(defaultValue);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Home") {
      event.preventDefault();
      resetToDefault();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    onChange(clamp(value + delta * direction * (unit === "%" ? 1 : 12), min, max));
  }

  return <div className={`pane-resizer ${className}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)}${unit}`} tabIndex={0} title="拖动调整宽度；双击恢复默认"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, trackWidth: Math.max(1, event.currentTarget.parentElement?.getBoundingClientRect().width ?? 1) };
      document.body.classList.add("is-pane-resizing");
    }} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} onDoubleClick={resetToDefault} onKeyDown={resizeWithKeyboard} />;
}

function allPages(view: ProjectWorkbenchView | null): PageLocation[] {
  if (!view) return [];
  return [
    ...view.outline.chapters.flatMap((chapter) => chapter.sequences.flatMap((sequence) => sequence.pages.map((page) => ({
      page,
      key: pageKey(page),
      breadcrumb: ["系列", chapter.title, sequence.title, page.title],
    })))),
    ...[...view.characters, ...(view.scenes?.scenes ?? [])].flatMap((character) => character.pages.map((page) => ({
      page,
      key: pageKey(page),
      breadcrumb: [page.kind === "scene" ? "场景" : "角色", character.name, page.title],
    }))),
    ...(view.orphan_pages ?? []).map(page => ({page, key: pageKey(page), breadcrumb: ["待整理页面", page.title]})),
  ];
}


type StoryChapter = ProjectWorkbenchView["outline"]["chapters"][number];
type StorySequence = StoryChapter["sequences"][number];
type ContextMenuTrigger = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };

function NavigationChevron({ expanded }: { expanded: boolean }) {
  return <svg className={`navigation-chevron ${expanded ? "is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>;
}

function NavigationDisclosureButton({ expanded, label, onClick, className = "" }: { expanded: boolean; label: string; onClick: () => void; className?: string }) {
  return <button type="button" className={`navigation-disclosure ${className}`.trim()} aria-label={`${expanded ? "收起" : "展开"}${label}`} aria-expanded={expanded} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); onClick(); }}><NavigationChevron expanded={expanded} /></button>;
}

/** 导航分区展开状态：按当前标签推导展开的分区，初始进入与切换项目时共用。 */
function utilitySectionsForTab(tab: ActiveTab) {
  return {
    project: (tab.startsWith("project-") && tab !== "project-story"),
    characters: true,
    scenes: true,
    story: tab === "story" || tab === "project-story" || tab === "prompt-overview",
  };
}

/** 导航树分支收起状态：按项目持久化，选中项所在分支自动展开（reveal）。 */
function useNavigationCollapse(projectId: string, section: "story" | "characters" | "scenes", revealKeys: readonly string[], initialKeys: string[], revealRequest: number) {
  const read = (key: string) => { try { return window.localStorage.getItem(key) === null ? new Set(initialKeys) : readCollapsedBranchKeys(window.localStorage, key); } catch { return new Set(initialKeys); } };
  const storageKey = projectId ? navigationCollapsedStorageKey(projectId, section) : "";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => storageKey ? read(storageKey) : new Set<string>());
  useEffect(() => {
    setCollapsed(storageKey ? read(storageKey) : new Set<string>());
  }, [storageKey]);
  useEffect(() => {
    if (storageKey) writeCollapsedBranchKeys(window.localStorage, storageKey, collapsed);
  }, [storageKey, collapsed]);
  const revealSignature = revealKeys.join("\n");
  useEffect(() => {
    if (!revealKeys.length) return;
    setCollapsed((current) => {
      if (!revealKeys.some((key) => current.has(key))) return current;
      const next = new Set(current);
      for (const key of revealKeys) next.delete(key);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revealKeys 内容变化必然伴随签名变化
  }, [revealSignature, revealRequest]);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}


type NavigationDragKind = "chapter" | "sequence" | "story-page" | "character-variant" | "character-page" | "scene-variant" | "scene-page";

type NavigationDrop = {
  owner?: string | null;
  kind: NavigationDragKind;
  id: string;
  sourceGroup: string | null;
  targetGroup: string | null;
  targetId: string | null;
  placement: "before" | "after";
};

type NavigationReorderSource = { kind: NavigationDragKind; id: string; group: string | null; owner?: string; title: string };

type NavigationReorderPreview = {
  x: number;
  y: number;
  title: string;
  sourceKind: NavigationDragKind;
  sourceId: string;
  targetKind: NavigationDragKind | null;
  targetId: string | null;
  placement: "before" | "after";
};

const navigationGroupHeadingKind: Partial<Record<NavigationDragKind, NavigationDragKind>> = {
  sequence: "chapter",
  "story-page": "sequence",
  "character-page": "character-variant",
  "scene-page": "scene-variant",
};

type NavigationReorderDrag = NavigationDrop & {
  pointerId: number;
  startX: number;
  startY: number;
  title: string;
  owner: string | null;
  dragging: boolean;
  visualKind: NavigationDragKind | null;
  visualId: string | null;
};

function useNavigationReorder(onDrop: (drop: NavigationDrop) => void) {
  const drag = useRef<NavigationReorderDrag | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<NavigationReorderPreview | null>(null);

  function begin(event: ReactPointerEvent<HTMLButtonElement>, source: NavigationReorderSource) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, kind: source.kind, id: source.id, sourceGroup: source.group, targetGroup: null, targetId: null, placement: "before", startX: event.clientX, startY: event.clientY, title: source.title, owner: source.owner ?? null, dragging: false, visualKind: null, visualId: null };
  }

  function update(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
      current.dragging = true;
      suppressClick.current = true;
    }
    event.preventDefault();
    current.targetGroup = null;
    current.targetId = null;
    current.visualKind = null;
    current.visualId = null;
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-nav-kind]");
    if (element) {
      const kind = element.dataset.navKind as NavigationDragKind | undefined;
      const id = element.dataset.navId ?? "";
      const group = element.dataset.navGroup ?? null;
      const owner = element.dataset.navOwner ?? null;
      if (kind && id && (!current.owner || !owner || owner === current.owner)) {
        if (kind === current.kind) {
          const bounds = element.getBoundingClientRect();
          current.placement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
          current.targetGroup = group;
          current.targetId = id;
          current.visualKind = kind;
          current.visualId = id;
        } else if (navigationGroupHeadingKind[current.kind] === kind) {
          current.placement = "after";
          current.targetGroup = id;
          current.visualKind = kind;
          current.visualId = id;
        }
      }
    }
    setPreview({ x: event.clientX, y: event.clientY, title: current.title, sourceKind: current.kind, sourceId: current.id, targetKind: current.visualKind, targetId: current.visualId, placement: current.placement });
  }

  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setPreview(null);
    if (!current.dragging) return;
    window.requestAnimationFrame(() => { suppressClick.current = false; });
    if (current.visualKind) onDrop({ owner: current.owner, kind: current.kind, id: current.id, sourceGroup: current.sourceGroup, targetGroup: current.targetGroup, targetId: current.targetId, placement: current.placement });
  }

  function cancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setPreview(null);
    if (current.dragging) window.requestAnimationFrame(() => { suppressClick.current = false; });
  }

  return { begin, update, finish, cancel, suppressClick, preview };
}

type NavigationReorder = ReturnType<typeof useNavigationReorder>;

function NavigationReorderHandle({ label, source, reorder }: { label: string; source: NavigationReorderSource; reorder: NavigationReorder }) {
  return <button type="button" className="page-reorder-handle" aria-label={`拖动排序：${label}`} title="拖动排序" onPointerDown={(event) => reorder.begin(event, source)} onPointerMove={reorder.update} onPointerUp={reorder.finish} onPointerCancel={reorder.cancel} onClick={(event) => { event.stopPropagation(); if (reorder.suppressClick.current) event.preventDefault(); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}><svg viewBox="0 0 12 18" aria-hidden="true">{[4, 9, 14].flatMap(y => [3, 8].map(x => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.2" />))}</svg></button>;
}

function navigationDropClass(reorder: NavigationReorder, kind: NavigationDragKind, id: string) {
  const preview = reorder.preview;
  if (!preview || preview.targetKind !== kind || preview.targetId !== id) return "";
  return preview.placement === "before" ? "is-drop-before" : "is-drop-after";
}

function navigationSourceClass(reorder: NavigationReorder, kind: NavigationDragKind, id: string) {
  const preview = reorder.preview;
  return preview && preview.sourceKind === kind && preview.sourceId === id ? "is-reorder-source" : "";
}

function NavigationReorderPreviewOverlay({ reorder }: { reorder: NavigationReorder }) {
  const preview = reorder.preview;
  if (!preview) return null;
  return <div className="page-reorder-preview" style={{ left: preview.x + 12, top: preview.y + 12 }} aria-hidden="true"><i>⋮</i><span>{preview.title}</span></div>;
}

function StoryNavigation({ view, candidateCounts, selectedKey, revealKeys, revealRequest, overviewTarget, onSelect, onOpenOverview, onRequestMenu, onDrop, chapterMenuItems, sequenceMenuItems, pageMenuItems }: {
  view: ProjectWorkbenchView;
  candidateCounts: Record<string, number> | null;
  selectedKey: string | null;
  revealKeys: readonly string[];
  revealRequest: number;
  overviewTarget?: StoryOverviewTarget | null;
  onSelect: (page: WorkbenchPage) => void;
  onOpenOverview: (target: StoryOverviewTarget) => void;
  onRequestMenu: (event: ContextMenuTrigger, label: string, items: NavigationMenuItem[]) => void;
  onDrop: (drop: NavigationDrop) => void;
  chapterMenuItems: (chapter: StoryChapter) => NavigationMenuItem[];
  sequenceMenuItems: (sequence: StorySequence) => NavigationMenuItem[];
  pageMenuItems: (page: WorkbenchPage) => NavigationMenuItem[];
}) {
  const { collapsed, toggle } = useNavigationCollapse(view.project.id, "story", revealKeys, view.outline.chapters.flatMap(chapter => [`chapter:${chapter.id}`, ...chapter.sequences.map(sequence => `sequence:${sequence.id}`)]), revealRequest);
  const longPress = useLongPressContextMenu();
  const reorder = useNavigationReorder(onDrop);
  const pageNumbers = new Map(view.outline.chapters.flatMap(c => c.sequences.flatMap(s => s.pages)).map((page, index) => [page.page_id, index + 1]));
  return <div className="hierarchy-navigation" aria-label="系列章节与页面" {...longPress.captureProps}>
    {view.outline.chapters.map((chapter) => { const chapterKey = `chapter:${chapter.id}`; const chapterOpen = !collapsed.has(chapterKey); return <section className="tree-group" key={chapter.id}>
      <div className={["tree-group-heading", navigationDropClass(reorder, "chapter", chapter.id)].filter(Boolean).join(" ")} data-nav-kind="chapter" data-nav-id={chapter.id} data-long-press-context-menu onPointerDown={(event) => longPress.start(event, (point) => onRequestMenu(point, `章节 · ${chapter.title}`, chapterMenuItems(chapter)))} onContextMenu={(event) => onRequestMenu(event, `章节 · ${chapter.title}`, chapterMenuItems(chapter))}><NavigationReorderHandle label={chapter.title} source={{ kind: "chapter", id: chapter.id, group: null, title: chapter.title }} reorder={reorder} />{chapter.sequences.length > 0 && <NavigationDisclosureButton expanded={chapterOpen} label={`章节“${chapter.title}”`} onClick={() => toggle(chapterKey)} />}<button type="button" aria-selected={overviewTarget?.kind === "chapter" && overviewTarget.id === chapter.id} className={`tree-toggle ${overviewTarget?.kind === "chapter" && overviewTarget.id === chapter.id ? "is-active" : ""}`} onClick={() => onOpenOverview({ kind: "chapter", id: chapter.id })}><small className="navigation-kind">章节</small><span>{chapter.title}</span></button><small className="navigation-child-count">{chapter.sequences.length} 情节单元</small></div>
      {chapterOpen && <div className="tree-children">{chapter.sequences.map((sequence) => { const sequenceKey = `sequence:${sequence.id}`; const sequenceOpen = !collapsed.has(sequenceKey); return <div className="tree-subgroup" key={sequence.id}>
        <div className={["tree-subgroup-heading", navigationDropClass(reorder, "sequence", sequence.id)].filter(Boolean).join(" ")} data-nav-kind="sequence" data-nav-id={sequence.id} data-nav-group={chapter.id} data-long-press-context-menu onPointerDown={(event) => longPress.start(event, (point) => onRequestMenu(point, `情节单元 · ${sequence.title}`, sequenceMenuItems(sequence)))} onContextMenu={(event) => onRequestMenu(event, `情节单元 · ${sequence.title}`, sequenceMenuItems(sequence))}><NavigationReorderHandle label={sequence.title} source={{ kind: "sequence", id: sequence.id, group: chapter.id, title: sequence.title }} reorder={reorder} />{sequence.pages.length > 0 && <NavigationDisclosureButton expanded={sequenceOpen} label={`情节单元“${sequence.title}”`} onClick={() => toggle(sequenceKey)} />}<button type="button" aria-selected={overviewTarget?.kind === "sequence" && overviewTarget.id === sequence.id} className={`tree-subgroup-toggle ${overviewTarget?.kind === "sequence" && overviewTarget.id === sequence.id ? "is-active" : ""}`} onClick={() => onOpenOverview({ kind: "sequence", id: sequence.id })}><small className="navigation-kind">单元</small><span>{sequence.title}</span></button><small className="navigation-child-count">{sequence.pages.length} 剧情页</small></div>
        {sequenceOpen && <div className="tree-subgroup-children">{sequence.pages.map((page) => { const status = pageCandidateStatus(page, candidateCounts); return <div className={["tree-page-row", navigationSourceClass(reorder, "story-page", page.page_id), navigationDropClass(reorder, "story-page", page.page_id)].filter(Boolean).join(" ")} key={page.page_id} data-nav-kind="story-page" data-nav-id={page.page_id} data-nav-group={sequence.id}>
          <NavigationReorderHandle label={page.title} source={{ kind: "story-page", id: page.page_id, group: sequence.id, title: page.title }} reorder={reorder} />
          <button type="button" data-long-press-context-menu aria-selected={selectedKey === pageKey(page)} className={`tree-page tree-page--compact ${selectedKey === pageKey(page) ? "is-active" : ""} ${selectedKey === pageKey(page) ? "is-selected" : ""}`} onClick={() => onSelect(page)} onPointerDown={(event) => longPress.start(event, (point) => onRequestMenu(point, `剧情页 · ${page.title}`, pageMenuItems(page)))} onContextMenu={(event) => onRequestMenu(event, `剧情页 · ${page.title}`, pageMenuItems(page))}>
            <span><i className="navigation-page-number">{String(pageNumbers.get(page.page_id)).padStart(2, "0")}</i>{page.title}</span><small className={`page-status ${status.className}`} title={status.title}>{status.label}</small>
          </button>
        </div>; })}</div>}
      </div>})}</div>}
    </section>; })}
    <NavigationReorderPreviewOverlay reorder={reorder} />
  </div>;
}

function SettingNavigation({ kind = "character", view, candidateCounts, selectedKey, revealKeys, revealRequest, activeCharacterId, activeCharacterSettingId, onCharacter, onPage, onRequestMenu, onDrop, characterMenuItems, settingMenuItems, pageMenuItems }: {
  kind?: "character" | "scene";
  view: ProjectWorkbenchView;
  candidateCounts: Record<string, number> | null;
  selectedKey: string | null;
  revealKeys: readonly string[];
  revealRequest: number;
  activeCharacterId: string | null;
  activeCharacterSettingId: string;
  onCharacter: (character: WorkbenchCharacter, settingId?: string) => void;
  onPage: (page: WorkbenchPage) => void;
  onRequestMenu: (event: ContextMenuTrigger, label: string, items: NavigationMenuItem[]) => void;
  onDrop: (drop: NavigationDrop) => void;
  characterMenuItems: (character: WorkbenchCharacter) => NavigationMenuItem[];
  settingMenuItems: (character: WorkbenchCharacter, variant: WorkbenchCharacter["visual"]["variants"][number]) => NavigationMenuItem[];
  pageMenuItems: (character: WorkbenchCharacter, page: WorkbenchPage) => NavigationMenuItem[];
}) {
  const { collapsed, toggle } = useNavigationCollapse(view.project.id, kind === "scene" ? "scenes" : "characters", revealKeys, view.characters.flatMap(character => [`${kind}:${character.id}`, ...character.visual.variants.map(variant => `variant:${character.id}:${variant.id}`)]), revealRequest);
  const longPress = useLongPressContextMenu();
  const reorder = useNavigationReorder(onDrop);
  return <div className="hierarchy-navigation" aria-label="角色与视觉页" {...longPress.captureProps}>
    {(kind === "scene" ? view.scenes?.scenes ?? [] : view.characters).map((character) => { const characterKey = `${kind}:${character.id}`; const open = !collapsed.has(characterKey); const characterActive = activeCharacterId === character.id && activeCharacterSettingId === "profile" && !selectedKey; return <section className="tree-group" key={character.id}>
      <div className="tree-group-heading" data-long-press-context-menu onPointerDown={(event) => longPress.start(event, (point) => onRequestMenu(point, `${kind === "scene" ? "场景" : "角色"} · ${character.name}`, characterMenuItems(character)))} onContextMenu={(event) => onRequestMenu(event, `${kind === "scene" ? "场景" : "角色"} · ${character.name}`, characterMenuItems(character))}>{character.visual.variants.length > 0 && <NavigationDisclosureButton expanded={open} label={`${kind === "scene" ? "场景" : "角色"}“${character.name}”`} onClick={() => toggle(characterKey)} />}<button type="button" aria-selected={characterActive} className={`tree-toggle ${characterActive ? "is-active" : ""}`} onClick={() => onCharacter(character, "profile")}><span>{character.name}</span></button><small className="navigation-child-count">{character.visual.variants.length} 子设定</small></div>
      {open && <div className="tree-children">
        {character.visual.variants.map((variant) => {
        const pages = character.pages.filter((page) => page.variant_id === variant.id);
        const active = activeCharacterId === character.id && activeCharacterSettingId === variant.id && !selectedKey;
        const variantKey = `variant:${character.id}:${variant.id}`;
        const variantOpen = !collapsed.has(variantKey);
        return <div className="tree-subgroup" key={variant.id}>
          <div className={["tree-subgroup-heading", navigationDropClass(reorder, (kind === "scene" ? "scene-variant" : "character-variant"), variant.id)].filter(Boolean).join(" ")} data-nav-kind={kind === "scene" ? "scene-variant" : "character-variant"} data-nav-id={variant.id} data-nav-group={character.id} data-nav-owner={character.id} data-long-press-context-menu onPointerDown={(event) => longPress.start(event, (point) => onRequestMenu(point, `子设定 · ${character.name} · ${variant.name}`, settingMenuItems(character, variant)))} onContextMenu={(event) => onRequestMenu(event, `子设定 · ${character.name} · ${variant.name}`, settingMenuItems(character, variant))}><NavigationReorderHandle label={variant.name} source={{ kind: (kind === "scene" ? "scene-variant" : "character-variant"), id: variant.id, group: character.id, owner: character.id, title: variant.name }} reorder={reorder} />{pages.length > 0 && <NavigationDisclosureButton expanded={variantOpen} label={`子设定“${variant.name}”的视觉页`} onClick={() => toggle(variantKey)} />}<button type="button" aria-selected={active} aria-label={variant.name} className={`tree-subgroup-toggle ${active ? "is-active" : ""}`} onClick={() => onCharacter(character, variant.id)}><small className="navigation-kind">设定</small><span>{variant.name}</span></button><small className="navigation-child-count">{pages.length} 视觉页</small></div>
          {variantOpen && <div className="tree-subgroup-children">{pages.map((page) => { const status = pageCandidateStatus(page, candidateCounts); return <div className={["tree-page-row", navigationSourceClass(reorder, (kind === "scene" ? "scene-page" : "character-page"), page.page_id), navigationDropClass(reorder, (kind === "scene" ? "scene-page" : "character-page"), page.page_id)].filter(Boolean).join(" ")} key={page.page_id} data-nav-kind={kind === "scene" ? "scene-page" : "character-page"} data-nav-id={page.page_id} data-nav-group={variant.id} data-nav-owner={character.id}>
            <NavigationReorderHandle label={page.title} source={{ kind: (kind === "scene" ? "scene-page" : "character-page"), id: page.page_id, group: variant.id, owner: character.id, title: page.title }} reorder={reorder} />
            <button type="button" data-long-press-context-menu aria-selected={selectedKey === pageKey(page)} className={`tree-page tree-page--compact ${selectedKey === pageKey(page) ? "is-active" : ""} ${selectedKey === pageKey(page) ? "is-selected" : ""}`} onClick={() => onPage(page)} onPointerDown={(event) => longPress.start(event, (point) => onRequestMenu(point, `${kind === "scene" ? "场景" : "角色"}视觉页 · ${page.title}`, pageMenuItems(character, page)))} onContextMenu={(event) => onRequestMenu(event, `${kind === "scene" ? "场景" : "角色"}视觉页 · ${page.title}`, pageMenuItems(character, page))}><span><i className="navigation-page-number">{String(pages.indexOf(page) + 1).padStart(2, "0")}</i>{page.title}</span><small className={`page-status ${status.className}`} title={status.title}>{status.label}</small></button>
          </div>; })}</div>}
        </div>;
      })}</div>}
    </section>; })}
    <NavigationReorderPreviewOverlay reorder={reorder} />
  </div>;
}

function candidateGeneratedAt(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function candidateDetailWorkspace(detail: CandidateDetail): CandidateWorkspaceDetail {
  return {
    title: "候选生成详情",
    body: <><p className="candidate-detail-summary-line">Seed {detail.seed ?? "—"} · {candidateGeneratedAt(detail.completed_at ?? detail.created_at)}</p><GenerationDetailsPanel details={detail.generation} /></>,
  };
}

function LetteringCanvasProbe({ canvas, onWidthChange }: { canvas: string; onWidthChange: (width: number) => void }) {
  const target = useRef<HTMLSpanElement>(null);
  const [canvasWidth, canvasHeight] = canvas.split(":").map(Number);
  const aspectRatio = canvasWidth / canvasHeight || 2 / 3;
  useLayoutEffect(() => {
    if (!target.current) return;
    const element = target.current;
    const reportWidth = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) onWidthChange(width);
    };
    reportWidth();
    const observer = new ResizeObserver(reportWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas, onWidthChange]);
  return <div className="lettering-canvas-probe" aria-hidden="true">
    <div className="story-layout">
      <span /><span />
      <aside className="page-images">
        <div className="current-media-stack">
          <div className="current-image current-image--lettering"><span className="current-image__media" style={{ "--preview-aspect": aspectRatio } as CSSProperties}><span ref={target} className="current-image__lettering-target" /></span></div>
        </div>
        <span />
        <div className="candidate-rail" />
      </aside>
    </div>
  </div>;
}

function PageWorkspace({ editorTab, onEditorTabChange, onOpenLetteringSettings, pageOrder, onOpenPromptOverview, projectId, location, ownerPages, characters, scenes, renderCapabilities, defaultRenderProfile, canvas, letteringStyle, taskCollection, busy, editorWidth, candidateWidth, onEditorWidthChange, onCandidateWidthChange, onPageChanged, onReload, onTrackedTasksChange }: {
  projectId: string;
  location: PageLocation;
  onOpenPromptOverview: () => void;
  onOpenLetteringSettings: () => void;
  editorTab?: "visual" | "lettering" | "flow";
  onEditorTabChange: (tab: "visual" | "lettering" | "flow") => void;
  pageOrder: number;
  ownerPages: PageLocation[];
  characters: WorkbenchCharacter[];
  scenes: Scene[];
  renderCapabilities: ProjectWorkbenchView["render_capabilities"];
  defaultRenderProfile: string | null;
  canvas: string | null;
  letteringStyle: ProjectWorkbenchView["project"]["lettering_settings"];
  taskCollection: TaskCollection;
  busy: boolean;
  editorWidth: number;
  candidateWidth: number;
  onEditorWidthChange: (value: number) => void;
  onCandidateWidthChange: (value: number) => void;
  onPageChanged: (target: WorkbenchPage, patch: Partial<WorkbenchPage>) => void;
  onReload: () => Promise<void>;
  onTrackedTasksChange: (projectId: string, taskIds: string[]) => void;
}) {
  const { notify, confirm } = useFeedback();
  const { page } = location;
  const latestPage = useRef(page);
  const incomingPage = useRef(page);
  if (incomingPage.current !== page) { incomingPage.current = page; latestPage.current = page; }
  async function confirmPropagation<T>(operation: (token?: string) => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof InheritanceConfirmationRequired)) throw error;
      if (!await confirm({ kind: 'warning', title: '确认连带修改', message: error.changes.join('\n'), confirmLabel: '确认并保存' })) throw new Error('已取消保存，草稿保留');
      return operation(error.confirmation);
    }
  }
  const [pageDirty, setPageDirty] = useState(false);
  const [promptDraft, setPromptDraft] = useState<PagePrompt>(() => structuredClone(page.prompt));
  const [renderInspection, setRenderInspection] = useState<PageRenderInspection | null>(null);
  const [renderInspectionKey, setRenderInspectionKey] = useState("");
  const [inspectionBaseKey, setInspectionBaseKey] = useState("");
  const [inspectionNonce, setInspectionNonce] = useState(0);
  const [renderInspectionError, setRenderInspectionError] = useState("");
  const [previewCanvas, setPreviewCanvas] = useState(canvas ?? "2:3");
  const textDimensions = renderCapabilities.text_page?.dimensions;
  const artworkCanvas = page.page_kind === "text" && textDimensions ? `${textDimensions.width}:${textDimensions.height}` : previewCanvas;
  const [fullscreenLetteringTarget, setFullscreenLetteringTarget] = useState<ImageOverlayTarget | null>(null);
  const [letteringTarget, setLetteringTarget] = useState<HTMLSpanElement | null>(null);
  const [trackedTaskIds, setTrackedTaskIds] = useState<string[]>([]);
  const [generationCount, setGenerationCount] = useState<1 | 3>(() => window.localStorage.getItem(generationCountStorageKey) === "1" ? 1 : 3);
  const editorSaveAll = useRef<(() => Promise<boolean>) | null>(null);
  const editorDiscardAll = useRef<(() => void) | null>(null);
  const mediaRevision = useRef("");
  const workspaceIdentity = `${projectId}:${location.key}`;
  const pageWorkspaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const workspace = pageWorkspaceRef.current;
    const image = workspace?.querySelector<HTMLElement>(".current-image");
    if (!workspace || !image) return;
    const [width, height] = artworkCanvas.split(":").map(Number);
    const aspect = width > 0 && height > 0 ? width / height : 2 / 3;
    const fitPreview = () => {
      // 图片受高度限制时，把无效横向留白交还编辑栏；含候选栏、分隔条和面板内边距。
      workspace.style.setProperty("--preview-fit-width", `${Math.ceil(image.clientHeight * aspect + candidateWidth + 29)}px`);
    };
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitPreview); });
    observer.observe(image);
    fitPreview();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); workspace.style.removeProperty("--preview-fit-width"); };
  }, [artworkCanvas, candidateWidth, letteringTarget]);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    pageWorkspaceRef.current?.closest(".project-main")?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    pageWorkspaceRef.current?.querySelectorAll(".document-editor, .candidate-grid").forEach((element) => {
      element.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
  }, [workspaceIdentity]);
  const workspaceIdentityRef = useRef(workspaceIdentity);
  workspaceIdentityRef.current = workspaceIdentity;
  const mediaRequestGuard = useRef(createPageMediaRequestGuard());
  const mediaInFlight = useRef<ReturnType<typeof mediaRequestGuard.current.begin> | null>(null);
  const mediaMutationPending = useRef(0);
  // 已读页面的会话级快照：切回时立即展示（stale-while-revalidate），后台按 revision 校验更新。
  const mediaSnapshots = useRef(new Map<string, { revision: string; media: PageMedia }>());
  const mediaPageKey = useMemo(() => structuredClone(page.page_key), [workspaceIdentity]);
  const [mediaState, setMediaState] = useState<{
    identity: string;
    status: "loading" | "ready" | "error";
    media: PageMedia;
    error: string;
  }>(() => ({ identity: workspaceIdentity, status: "loading", media: emptyPageMedia, error: "" }));
  const mediaSnapshot = mediaState.identity === workspaceIdentity ? null : mediaSnapshots.current.get(workspaceIdentity) ?? null;
  const media = mediaState.identity === workspaceIdentity ? mediaState.media : (mediaSnapshot?.media ?? emptyPageMedia);
  const mediaStatus = mediaState.identity === workspaceIdentity ? mediaState.status : (mediaSnapshot ? "ready" : "loading");
  const mediaError = mediaState.identity === workspaceIdentity ? mediaState.error : "";
  const characterFactsSignature = characters.map((character) => `${character.id}:${character.prompt_sha256}`).join("|");
  const isCurrentWorkspace = () => workspaceIdentityRef.current === workspaceIdentity;
  const factReady = !busy && !pageDirty;
  const sceneFactsSignature = JSON.stringify(scenes);
  const inspectionDepsKey = JSON.stringify([location.key, page.content_sha256, characterFactsSignature, sceneFactsSignature, defaultRenderProfile, promptDraft]);
  const currentBaseKey = JSON.stringify([location.key, page.content_sha256, characterFactsSignature, sceneFactsSignature, defaultRenderProfile, promptDraft.scene_id, promptDraft.scene_variant_id, promptDraft.inheritance, promptCategories.map(category => promptDraft[category])]);

  useEffect(() => {
    onTrackedTasksChange(projectId, trackedTaskIds);
  }, [onTrackedTasksChange, projectId, trackedTaskIds]);

  useEffect(() => () => onTrackedTasksChange(projectId, []), [onTrackedTasksChange, projectId]);

  const refreshPageMedia = useCallback(async (background = false, fresh = false) => {
    if (background && (mediaMutationPending.current || mediaInFlight.current?.identity === workspaceIdentity)) return false;
    const request = mediaRequestGuard.current.begin(workspaceIdentity);
    mediaInFlight.current = request;
    setMediaState((current) => background && current.identity === workspaceIdentity && current.status === "ready" ? current : ({
      identity: workspaceIdentity,
      status: "loading",
      media: current.identity === workspaceIdentity ? current.media : emptyPageMedia,
      error: "",
    }));
    try {
      const result = await loadPageMedia(projectId, mediaPageKey, request.signal, background ? mediaRevision.current : undefined, fresh);
      if (!mediaRequestGuard.current.isCurrent(request)) return false;
      if (!result) return true;
      mediaRevision.current = result.revision;
      mediaSnapshots.current.set(workspaceIdentity, { revision: result.revision, media: result.media });
      setMediaState({ identity: workspaceIdentity, status: "ready", media: result.media, error: "" });
      return true;
    } catch (error) {
      if (!mediaRequestGuard.current.isCurrent(request)) return false;
      mediaRevision.current = "";
      setMediaState((current) => background && current.identity === workspaceIdentity && current.status === "ready" ? current : ({
        identity: workspaceIdentity,
        status: "error",
        media: emptyPageMedia,
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    } finally {
      if (mediaInFlight.current === request) mediaInFlight.current = null;
    }
  }, [mediaPageKey, projectId, workspaceIdentity]);

  useEffect(() => {
    setPageDirty(false);
    setPreviewCanvas(canvas ?? "2:3");
    setPromptDraft(structuredClone(page.prompt));
    setRenderInspection(null);
    setRenderInspectionKey("");
    setRenderInspectionError("");
    setTrackedTaskIds([]);
    const snapshot = mediaSnapshots.current.get(workspaceIdentity);
    mediaRevision.current = snapshot?.revision ?? "";
    if (snapshot) {
      setMediaState({ identity: workspaceIdentity, status: "ready", media: snapshot.media, error: "" });
      void refreshPageMedia(true);
    } else {
      void refreshPageMedia();
    }
    return () => mediaRequestGuard.current.cancel();
  }, [refreshPageMedia, workspaceIdentity]);

  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void inspectPageRender(projectId, page.page_key, promptDraft).then(({ inspection }) => {
        if (!disposed) { setRenderInspection(inspection); setInspectionBaseKey(currentBaseKey); setRenderInspectionKey(inspectionDepsKey); setRenderInspectionError(""); }
      }).catch((error) => {
        if (!disposed) { setRenderInspection(null); setRenderInspectionError(error instanceof Error ? error.message : String(error)); }
      });
    }, 260);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [characterFactsSignature, defaultRenderProfile, location.key, page.content_sha256, projectId, JSON.stringify(promptDraft), inspectionDepsKey, inspectionNonce]);


  useEffect(() => {
    if (!trackedTaskIds.length) return;
    if (!areTrackedTasksTerminal(taskCollection, trackedTaskIds) || !isCurrentWorkspace()) return;
    setTrackedTaskIds([]);
  }, [refreshPageMedia, taskCollection, trackedTaskIds]);

  useEffect(() => {
    const poller = createSerialPoller({ intervalMs: 2500, poll: async () => {
      if (!document.hidden) await refreshPageMedia(true);
    } });
    poller.start();
    return () => { poller.stop(); mediaRequestGuard.current.cancel(); };
  }, [refreshPageMedia]);

  async function saveWhole(draft: WorkbenchPageContentDraft, prompt: PagePrompt, items: LetteringItem[], baseline: WorkbenchPage) {
    const content = { title: draft.title, scene_description: draft.scene_description, characters: draft.characters ?? [], dialogue: draft.dialogue ?? [],
      ...(draft.page_kind === 'text' ? { page_kind: 'text' as const, body: draft.body ?? '', display_title: draft.display_title ?? '', text_layout: draft.text_layout } : {}) };
    const result = await confirmPropagation(token => saveWholePage(projectId, baseline, content, prompt, items, token));
    latestPage.current = { ...latestPage.current, ...result.content, content_sha256: result.content_sha256, prompt: result.prompt, prompt_sha256: result.prompt_sha256,
      prompt_context_sha256: result.prompt_context_sha256, lettering: result.lettering, layout_sha256: result.layout_sha256 };
    if (isCurrentWorkspace()) onPageChanged(page, latestPage.current);
    return { page: latestPage.current, content: { ...draft, ...result.content }, prompt: result.prompt, items: result.lettering?.items ?? [] };
  }

  async function startCurrentPage(request: { count: 1 | 3 }) {
    try {
      const result = await startPageRender(projectId, page.page_key, { operation: "candidates", count: request.count });
      if (!isCurrentWorkspace()) return;
      setTrackedTaskIds(current => [...new Set([...current, result.task.task_id])]);
      notify({ kind: "success", message: "已启动当前页面任务" });
    } catch (error) {
      if (isCurrentWorkspace()) notify({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function changeGenerationCount(count: 1 | 3) {
    setGenerationCount(count);
    window.localStorage.setItem(generationCountStorageKey, String(count));
  }

  const saveAndGenerateInFlight = useRef(false);
  async function saveAndGenerate(request: { count: 1 | 3 }) {
    if (saveAndGenerateInFlight.current || busy || trackedTaskIds.length || !renderInspection?.ready) return;
    saveAndGenerateInFlight.current = true;
    try {
      if (pageDirty) {
        const saved = await editorSaveAll.current?.();
        if (!saved) {
          if (isCurrentWorkspace()) notify({ kind: "error", message: "保存未完成，已取消生成" });
          return;
        }
      }
      await startCurrentPage(request);
    } finally {
      saveAndGenerateInFlight.current = false;
    }
  }

  const saveAndGenerateRef = useRef(saveAndGenerate);
  saveAndGenerateRef.current = saveAndGenerate;
  const pageDirtyRef = useRef(pageDirty);
  pageDirtyRef.current = pageDirty;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      const isGenerate = event.key === "g" || event.key === "G";
      const isSave = event.key === "s" || event.key === "S";
      if (!isGenerate && !isSave) return;
      // 先拦下浏览器默认行为（保存网页/查找），再按弹窗状态决定是否执行工作台动作。
      event.preventDefault();
      if (isWorkbenchModalOpen()) return;
      // 延迟到本次按键分发完成后执行：编辑控件（如 Prompt 词条）在冒泡阶段把未提交草稿提交进状态。
      window.setTimeout(() => {
        if (isGenerate) void saveAndGenerateRef.current({ count: generationCount });
        else if (pageDirtyRef.current) void editorSaveAll.current?.();
      }, 0);
    };
    // 捕获阶段监听：编辑控件内部 stopPropagation 也不会漏掉快捷键。
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [generationCount]);

  const capabilityBlocker = renderCapabilities.candidates.blocker
    ? `当前生成配置不可用：${renderCapabilities.candidates.blocker}`
    : undefined;
  const generationProblems: PromptIssue[] = renderInspection
    ? [...renderInspection.blockers]
    : renderInspectionError ? [{ code: "generation_inspection_failed", message: renderInspectionError }] : [];
  if (capabilityBlocker && !generationProblems.some((issue) => promptIssueSummary(issue) === capabilityBlocker)) {
    generationProblems.push({ code: "generation_capability_unavailable", message: capabilityBlocker });
  }
  const generationDisabled = busy || trackedTaskIds.length > 0 || !renderInspection?.ready;
  const generateReason = (trackedTaskIds.length ? "已启动任务，等待本轮完成" : "")
    || (renderInspection ? renderInspection.blockers.map(promptIssueSummary).join("；") || capabilityBlocker : renderInspectionError || "正在编译当前 Prompt")
    || (!renderInspection?.ready ? "当前页面尚未满足生成条件" : "");
  const isTextPage = page.kind === "story" && page.page_kind === "text";
  return <div ref={pageWorkspaceRef} className="story-layout current-workbench-page">
    {<WorkbenchPageEditor editorTab={editorTab} onEditorTabChange={onEditorTabChange} onOpenLetteringSettings={onOpenLetteringSettings} onOpenPromptOverview={onOpenPromptOverview} projectId={projectId} page={page} characters={characters} scenes={scenes} breadcrumb={location.breadcrumb} pageOrder={pageOrder} busy={busy} canvas={artworkCanvas} letteringStyle={letteringStyle} letteringItems={page.lettering?.items ?? []} letteringTarget={letteringTarget} fullscreenLetteringTarget={fullscreenLetteringTarget} flowPreview={isTextPage ? null : inspectionBaseKey === currentBaseKey ? renderInspection : null} flowPreviewError={renderInspectionError} onSavePage={saveWhole} onReloadContent={onReload} onReloadPrompt={onReload} onPageSaved={() => { if (isCurrentWorkspace()) notify({ kind: "success", message: page.kind === "story" ? "文案与布局已保存" : "页面内容已保存" }); }} onPromptDraftChange={setPromptDraft} onDirtyChange={setPageDirty} saveAllRef={editorSaveAll} discardAllRef={editorDiscardAll} onGenerate={isTextPage ? undefined : saveAndGenerate} generationCount={generationCount} onGenerationCountChange={changeGenerationCount} generationDisabled={generationDisabled} generationDisabledReason={generateReason} generationProblems={isTextPage ? [] : generationProblems} />}
    <PaneResizeHandle className="pane-resizer--editor" label="调整页面事实栏宽度" value={editorWidth} defaultValue={44} min={32} max={64} unit="%" onChange={onEditorWidthChange} />
    {isTextPage
      ? <TextPageWorkspace projectId={projectId} pageId={page.page_id} canvas={artworkCanvas} dimensionError={renderCapabilities.text_page?.error ?? (!textDimensions ? "无法确定成品尺寸，请检查生成设置。" : null)} dirty={pageDirty} disabled={busy || trackedTaskIds.length > 0} onLetteringTarget={setLetteringTarget} onOutput={async () => { if (!await editorSaveAll.current?.()) return null; if (!isCurrentWorkspace()) return null; return (await startFinishedPage(projectId, page.page_key)).job; }} />
      : <WorkbenchCandidateWorkspace finishedOutput={{ projectId, pageId: page.page_id, onOutput: async (candidateId) => { if (!await editorSaveAll.current?.()) return null; if (!isCurrentWorkspace()) return null; return (await startFinishedPage(projectId, page.page_key, candidateId)).job; } }} pageIdentity={workspaceIdentity} pageTitle={page.title} canvas={previewCanvas} onPreviewCanvasChange={setPreviewCanvas} ownerLabel={location.breadcrumb.at(-2)} media={media} mediaStatus={mediaStatus} mediaError={mediaError} onReloadMedia={() => refreshPageMedia(false, true)} candidateWidth={candidateWidth} factReady={factReady} currentPromptSignature={!pageDirty && renderInspection && renderInspectionKey === inspectionDepsKey ? renderInspection.prompt.signature : null} mediaReady={mediaStatus === "ready"} generationReady={Boolean(renderInspection?.ready)} busy={busy || trackedTaskIds.length > 0} busyReason={trackedTaskIds.length ? "已启动任务，等待本轮完成" : undefined} generationDisabledReason={renderInspection ? renderInspection.blockers.map(promptIssueSummary).join("；") || capabilityBlocker : renderInspectionError || "正在编译当前 Prompt"} generationProblems={generationProblems} onLetteringTarget={setLetteringTarget} onFullscreenLetteringTarget={setFullscreenLetteringTarget} onCandidateWidthChange={onCandidateWidthChange} onGenerate={(request) => startCurrentPage(request)} generationCount={generationCount} onGenerationCountChange={changeGenerationCount} onSaveAndGenerate={saveAndGenerate} pageDirty={pageDirty} onSaveAll={async () => { await editorSaveAll.current?.(); }} onDiscardAll={() => editorDiscardAll.current?.()} onDeleteCandidates={async (request) => { mediaMutationPending.current += 1; mediaRequestGuard.current.cancel(); try { await deleteCandidates(projectId, page.page_key, request); if (!isCurrentWorkspace()) return false; await refreshPageMedia(false, true); return true; } catch (error) { if (isCurrentWorkspace()) { setInspectionNonce((value) => value + 1); notify({ kind: "error", message: error instanceof Error ? error.message : String(error) }); } return false; } finally { mediaMutationPending.current -= 1; } }} onLoadCandidateDetail={async (candidate) => candidateDetailWorkspace((await loadCandidateDetail(projectId, page.page_key, candidate.candidate_id)).detail)} />}
  </div>;
}


export default function StoryWorkbench({ initialImagesHidden, imagePrivacyStorage }: { initialImagesHidden: boolean; imagePrivacyStorage: Storage | null }) {
  useTooltips();
  const { confirm, notify } = useFeedback();
  const navigationDrawer = useNavigationDrawer();
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => {
    setNavigationOpen(false);
    setNavigationMenu(null);
    setNamedCreateTarget(null);
    setVisualTemplateTarget(null);
  }, [navigationDrawer]);
  const [navigation, setNavigation] = useState(() => initialWorkbenchNavigation(window.location.search));
  const navigationRef = useRef(navigation);
  const historyRef = useRef<NavigationHistory>({ entries: [], index: -1 });
  const [revealRequest, setRevealRequest] = useState(0);
  const [directorySection, setDirectorySection] = useState<NavigationSection>(() => navigationSection(navigation.activeTab) ?? "story");
  const directoryScroll = useRef<Record<string, number>>({});
  const directorySectionRef = useRef(directorySection); directorySectionRef.current = directorySection;
  const directoryRef = useRef<HTMLDivElement>(null);
  const sectionLongPress = useLongPressContextMenu();
  const { projectId, activeTab, activeCharacterId, activeCharacterSettingId } = navigation;
  const globalArea = activeTab === "comparison" || activeTab.startsWith("lora-") || activeTab.startsWith("resource-");
  const projectLocation = useRef<NavigationState | null>(null);
  const selectedKey = navigation.activePageKey ? pageKeyId(navigation.activePageKey) : null;
  const [directoryDialog, setDirectoryDialog] = useState<"add" | RegisteredProject | null>(null);
  const [registeredProjects, setRegisteredProjects] = useState<RegisteredProject[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [libraryVersion, setLibraryVersion] = useState(0);
  async function refreshLibrary() {
    try {
      const result = await responseJson<{ projects: RegisteredProject[] }>(await fetch("/api/project-library"));
      setRegisteredProjects(result.projects); setLibraryError(""); return result.projects;
    } catch (cause) { setLibraryError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  useEffect(() => { void refreshLibrary().catch(() => undefined); }, []);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const projectRequestGuard = useRef(createProjectRequestGuard(projectId));
  const [view, setView] = useState<ProjectWorkbenchView | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const navigate = useCallback((next: NavigationState, replace = false) => {
    const current = navigationRef.current;
    if (current.activeTab.startsWith("lora-") && !next.activeTab.startsWith("lora-")) setLoraCreateDatasetRequest(0);
    if (current.activeTab !== "comparison" && !current.activeTab.startsWith("lora-") && !current.activeTab.startsWith("resource-")) projectLocation.current = current;
    const changedProject = next.projectId !== navigationRef.current.projectId;
    historyRef.current = rememberNavigation(historyRef.current, next, replace);
    if (!replace || navigationIdentity(next) !== navigationIdentity(current)) {
      setRevealRequest(value => value + 1);
      const section = navigationSection(next.activeTab);
      if (section) { if (directoryRef.current) directoryScroll.current[directorySectionRef.current] = directoryRef.current.scrollTop; setDirectorySection(section); }
    }
    projectRequestGuard.current.activate(next.projectId);
    navigationRef.current = next;
    setNavigation(next);
    window.history.replaceState(null, "", syncNavigationUrl(new URL(window.location.href), next));
    if (changedProject) {
      viewRef.current = null;
      setView(null);
      setNavigationMenu(null);
      setNamedCreateTarget(null);
      setVisualTemplateTarget(null);
      setUtilityBusy(false);
    }
  }, []);
  const [snapshotSync] = useState(() => createWorkbenchSnapshotSync(projectRequestGuard.current, next => {
    navigate(reconcileNavigation(navigationRef.current, viewRef.current, next), true);
    viewRef.current = next;
    setView(next);
  }));
  const [countSnapshot, setCountSnapshot] = useState<{ projectId: string; counts: Record<string, number> } | null>(null);
  const candidateCounts = countSnapshot?.projectId === projectId ? countSnapshot.counts : null;
  useEffect(() => {
    setCountSnapshot(null);
    if (!projectId) return;
    const controller = new AbortController();
    let revision = "";
    const poller = createSerialPoller({ intervalMs: 2500, poll: async () => {
      if (document.hidden) return;
      try {
        const result = await loadCandidateCounts(projectId, controller.signal, revision);
        if (!controller.signal.aborted && result) {
          revision = result.revision;
          setCountSnapshot({ projectId, counts: result.counts });
        }
      } catch { /* 暂时离线保留已知数量，下一轮重试。 */ }
    } });
    poller.start();
    return () => { controller.abort(); poller.stop(); };
  }, [projectId]);
  const [promptOverviewRequest, setPromptOverviewRequest] = useState(0);
  const promptOverviewFocus = useMemo(() => navigation.activeTab === "prompt-overview" && navigation.activePageKey ? { pageId: navigation.activePageKey.page_id, request: promptOverviewRequest } : null, [navigation.activeTab, navigation.activePageKey, promptOverviewRequest]);
  const [globalResources, setGlobalResources] = useState<GlobalResources | null>(null);
  const [loraDatasets, setLoraDatasets] = useState<LoraDatasetSummary[]>([]);
  const [loraCounts, setLoraCounts] = useState<{ datasets?: number; tasks?: number; runs?: number }>({});
  const [loraDatasetId, setLoraDatasetId] = useState("");
  const [loraCreateDatasetRequest, setLoraCreateDatasetRequest] = useState(0);
  const selectedSceneId = navigation.sceneId ?? '';
  const sceneSettingId = navigation.sceneSettingId ?? 'profile';

  const [loraDirty, setLoraDirty] = useState(false);
  const [navigationMenu, setNavigationMenu] = useState<NavigationMenuRequest | null>(null);
  const [movingPage, setMovingPage] = useState<WorkbenchPage | null>(null);
  const [namedCreateTarget, setNamedCreateTarget] = useState<NamedCreateTarget | null>(null);
  const [visualTemplateTarget, setVisualTemplateTarget] = useState<VisualPageTemplateTarget | null>(null);
  const [utilityBusy, setUtilityBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtimeOnline, setRuntimeOnline] = useState(true);
  const [runtimeHardware, setRuntimeHardware] = useState<HardwareStatus | null>(null);
  const [runtimeTasks, setRuntimeTasks] = useState<TaskCollection>({ tasks: [], history: [] });
  const [selectedTask, setSelectedTask] = useState<GlobalTask | null>(null);
  const [taskPreview, setTaskPreview] = useState<TaskPreview | null>(null);
  const taskControlGeneration = useRef(0);
  const [imagesHidden, setImagesHidden] = useState(initialImagesHidden);
  const [imagesPeeking, setImagesPeeking] = useState(false);
  const imagesHiddenRef = useRef(imagesHidden);
  const imagePrivacyHold = useRef<{ source: "button" | "keyboard"; timer: number | null; long: boolean } | null>(null);
  const ignoreNextPrivacyClick = useRef(false);
  imagesHiddenRef.current = imagesHidden;
  const runtimeTaskQueueRevision = useRef<number | null>(null);
  const trackedRuntimeTasks = useRef<{ projectId: string; taskIds: string[] } | null>(null);
  const runtimeInstanceId = useRef("");
  const initialPaneLayout = useMemo(loadPaneLayout, []);
  // 导航宽度只在会话内生效：null 表示跟随视口的自动宽度，拖动后固定为像素值，刷新恢复自动。
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialPaneLayout.editor);
  const [candidateWidth, setCandidateWidth] = useState(initialPaneLayout.candidates);
  const [letteringCanvasWidth, setLetteringCanvasWidth] = useState<number | null>(null);
  const storyOverviewRequest = useRef(0);
  const storyOverviewTarget: StoryOverviewTarget | null = navigation.overviewTarget ? { ...navigation.overviewTarget, requestId: storyOverviewRequest.current } : null;
  const [loraDatasetsExpanded, setLoraDatasetsExpanded] = useState(true);
  const [expandedUtilities, setExpandedUtilities] = useState(() => utilitySectionsForTab(activeTab));
  const syncContext = useRef({ view, loading, utilityBusy, activeTab });
  syncContext.current = { view, loading, utilityBusy, activeTab };
  useEffect(() => {
    setExpandedUtilities(utilitySectionsForTab(syncContext.current.activeTab));
  }, [projectId]);
  useEffect(() => {
    if (projectId) writeLastProjectId(window.localStorage, projectId);
  }, [projectId]);

  const activateProject = useCallback((nextProjectId: string) => {
    if (nextProjectId !== navigationRef.current.projectId) {
      const current = navigationRef.current;
      navigate(current.activeTab === "comparison" || current.activeTab.startsWith("lora-") || current.activeTab.startsWith("resource-")
        ? { ...current, projectId: nextProjectId } : projectNavigation(nextProjectId));
    }
  }, [navigate]);

  const beginImagePrivacyHold = useCallback((source: "button" | "keyboard") => {
    if (imagePrivacyHold.current) return;
    const hold = { source, timer: null as number | null, long: false };
    imagePrivacyHold.current = hold;
    if (!imagesHiddenRef.current) return;
    hold.timer = window.setTimeout(() => {
      if (imagePrivacyHold.current !== hold) return;
      hold.long = true;
      setImagesPeeking(true);
    }, imagePrivacyHoldDelayMs);
  }, []);

  const finishImagePrivacyHold = useCallback((source: "button" | "keyboard", toggleOnShortPress: boolean) => {
    const hold = imagePrivacyHold.current;
    if (!hold || hold.source !== source) return;
    if (hold.timer !== null) window.clearTimeout(hold.timer);
    imagePrivacyHold.current = null;
    if (hold.long) setImagesPeeking(false);
    else if (toggleOnShortPress) setImagesHidden((current) => !current);
  }, []);

  const cancelImagePrivacyHold = useCallback(() => {
    const hold = imagePrivacyHold.current;
    if (hold?.timer !== null && hold?.timer !== undefined) window.clearTimeout(hold.timer);
    imagePrivacyHold.current = null;
    setImagesPeeking(false);
  }, []);

  const updateTrackedRuntimeTasks = useCallback((trackedProjectId: string, taskIds: string[]) => {
    trackedRuntimeTasks.current = taskIds.length ? { projectId: trackedProjectId, taskIds: [...taskIds] } : null;
  }, []);

  const applyTaskControl = useCallback((result: TaskControlResult) => {
    taskControlGeneration.current += 1;
    runtimeTaskQueueRevision.current = Math.max(runtimeTaskQueueRevision.current ?? 0, result.queue_revision);
    setRuntimeTasks(current => ({ ...current, queue_revision: runtimeTaskQueueRevision.current ?? undefined,
      tasks: current.tasks.map(task => task.id === result.task.id && task.project_id === result.task.project_id && task.purpose === result.task.purpose ? { ...task, ...result.task } : task),
    }));
  }, []);

  const reload = useCallback(async (background = false, signal?: AbortSignal) => {
    await snapshotSync.load(projectId, { background, signal, onApplied: () => {
      setError(null);
      if (!background) setLoading(false);
    } });
  }, [projectId, snapshotSync]);

  useEffect(() => {
    if (!projectId) return;
    const poller = createSerialPoller({
      intervalMs: 3000,
      poll: async (signal) => {
        const context = syncContext.current;
        if (document.hidden || context.loading || context.utilityBusy || context.view?.project.id !== projectId
          || isProjectWritePending(projectId) || snapshotSync.loading) return;
        const { revision } = await loadProjectRevision(projectId, signal);
        if (signal.aborted) return;
        if (revision !== getProjectWriteRevision(projectId) || isProjectRefreshRequired(projectId)) await reload(true, signal);
      },
    });
    poller.start();
    return () => poller.stop();
  }, [projectId, reload, snapshotSync]);

  const handleBackendRestart = useCallback(() => {
    if (projectId) void reload().catch(() => undefined);
  }, [projectId, reload]);

  useEffect(() => {
    const health = createSerialPoller({
      intervalMs: 2500,
      poll: async (signal) => {
        const next = await responseJson<BackendHealth>(await fetch("/api/health", { cache: "no-store", signal }));
        setRuntimeOnline(true);
        if (runtimeInstanceId.current && runtimeInstanceId.current !== next.instance_id) {
          runtimeTaskQueueRevision.current = null;
          handleBackendRestart();
        }
        runtimeInstanceId.current = next.instance_id;
      },
      onError: () => setRuntimeOnline(false),
    });
    const hardware = createSerialPoller({
      intervalMs: 2500,
      poll: async (signal) => {
        const next = await responseJson<HardwareStatus>(await fetch("/api/hardware-status", { cache: "no-store", signal }));
        setRuntimeHardware((current) => ({ ...next, comfyui: stabilizeComfyRuntimeProbe(current?.comfyui, next.comfyui) }));
      },
    });
    const tasks = createSerialPoller({
      intervalMs: 2500,
      poll: async (signal) => {
        const controlGeneration = taskControlGeneration.current;
        const query = new URLSearchParams();
        const tracked = trackedRuntimeTasks.current;
        if (tracked) for (const taskId of tracked.taskIds) query.append("tracked", `${tracked.projectId}/${taskId}`);
        const suffix = query.toString();
        const next = await responseJson<TaskCollection>(await fetch(`/api/tasks${suffix ? `?${suffix}` : ""}`, { cache: "no-store", signal }));
        if (signal.aborted || controlGeneration !== taskControlGeneration.current) return;
        const previousRevision = runtimeTaskQueueRevision.current;
        if (next.queue_revision !== undefined && previousRevision !== null && next.queue_revision < previousRevision) return;
        if (next.queue_revision !== undefined) runtimeTaskQueueRevision.current = next.queue_revision;
        setRuntimeTasks(next);
      },
    });
    health.start();
    hardware.start();
    tasks.start();
    return () => {
      health.stop();
      hardware.stop();
      tasks.stop();
    };
  }, [handleBackendRestart]);

  useEffect(() => {
    window.localStorage.setItem(paneLayoutStorageKey, JSON.stringify({ editor: editorWidth, candidates: candidateWidth }));
  }, [candidateWidth, editorWidth]);

  useLayoutEffect(() => {
    if (imagesHidden && imagesPeeking) applyImagePrivacy(document.documentElement, "peek");
    else persistImagePrivacy(imagePrivacyStorage, document.documentElement, imagesHidden);
  }, [imagePrivacyStorage, imagesHidden, imagesPeeking]);

  useEffect(() => {
    function beginKeyboardHold(event: KeyboardEvent) {
      if (event.key !== "F9") return;
      event.preventDefault();
      if (!event.repeat) beginImagePrivacyHold("keyboard");
    }
    function finishKeyboardHold(event: KeyboardEvent) {
      if (event.key !== "F9") return;
      event.preventDefault();
      finishImagePrivacyHold("keyboard", true);
    }
    window.addEventListener("keydown", beginKeyboardHold, true);
    window.addEventListener("keyup", finishKeyboardHold, true);
    window.addEventListener("blur", cancelImagePrivacyHold);
    return () => {
      window.removeEventListener("keydown", beginKeyboardHold, true);
      window.removeEventListener("keyup", finishKeyboardHold, true);
      window.removeEventListener("blur", cancelImagePrivacyHold);
      cancelImagePrivacyHold();
    };
  }, [beginImagePrivacyHold, cancelImagePrivacyHold, finishImagePrivacyHold]);

  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!document.querySelector(unsavedFactsSelector)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/projects", { headers: { accept: "application/json" } }).then((response) => responseJson<ProjectCollection>(response)).then((result) => {
      if (cancelled) return;
      setProjects(result.projects);
      const current = projectRequestGuard.current.scope().projectId;
      activateProject(chooseInitialProjectId(result.projects.map((project) => project.id), current, readLastProjectId(window.localStorage)));
    }).catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { cancelled = true; };
  }, [activateProject]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void snapshotSync.load(projectId, { signal: controller.signal, onSettled: () => setLoading(false), onApplied: () => {
      setError(null);
    } }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [projectId, snapshotSync]);

  useEffect(() => {
    if (!(activeTab === "comparison" || activeTab.startsWith("resource-")) || globalResources) return;
    let cancelled = false;
    void fetch("/api/resources", { headers: { accept: "application/json" } })
      .then((response) => responseJson<GlobalResources>(response))
      .then((resources) => { if (!cancelled) setGlobalResources(resources); })
      .catch((cause) => {
        if (!cancelled) notify({ kind: "error", message: `读取资源目录失败：${cause instanceof Error ? cause.message : String(cause)}` });
      });
    return () => { cancelled = true; };
  }, [activeTab, globalResources, notify]);

  const locations = useMemo(() => allPages(view), [view]);
  const activeLocation = locations.find((item) => item.key === selectedKey) ?? null;
  const activeOwnerLocations = useMemo(() => activeLocation ? locations.filter((item) => item.page.kind === activeLocation.page.kind && (item.page.kind === "story" || (item.page.character_id === activeLocation.page.character_id && item.page.scene_id === activeLocation.page.scene_id && item.page.variant_id === activeLocation.page.variant_id))) : [], [activeLocation, locations]);
  const pageNavigationVisible = Boolean(activeLocation && (activeTab === "story" || activeTab === "characters" || activeTab === "scenes" || activeTab === "orphan-pages"));
  const activePageIndex = activeOwnerLocations.findIndex((item) => item.key === selectedKey);
  const previousPage = activeOwnerLocations[activePageIndex - 1]?.page;
  const nextPage = activeOwnerLocations[activePageIndex + 1]?.page;
  const pageTurnPending = useRef(false);
  const activeCharacter = view?.characters.find((character) => character.id === activeCharacterId) ?? null;
  const activeScene = view?.scenes?.scenes.find(scene => scene.id === selectedSceneId) ?? null;
  const selectedProject = projects.find((project) => project.id === projectId);

  function showNavigationMenu(event: ContextMenuTrigger, label: string, items: NavigationMenuItem[]) {
    event.preventDefault?.();
    event.stopPropagation?.();
    // 菜单动作可能打开弹窗（重命名、新建等）；抽屉是顶层 modal，选中动作时收起抽屉避免弹窗被盖住。
    if (items.length) setNavigationMenu({ x: event.clientX, y: event.clientY, label, items: items.map((item) => ({ ...item, onSelect: () => { setNavigationOpen(false); item.onSelect(); } })) });
  }

  async function performNavigationAction(action: string, value: Record<string, unknown>, success: string) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return null;
    if (!await leaveCurrentAllowed()) return null;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return null;
    setUtilityBusy(true);
    try {
      let result;
      try { result = await runNavigationAction(projectId, action, value); }
      catch (error) {
        if (!(error instanceof InheritanceConfirmationRequired)) throw error;
        if (!await confirm({ kind: 'warning', title: '确认连带修改', message: error.changes.join('\n'), confirmLabel: '确认并保存' })) return null;
        result = await runNavigationAction(projectId, action, { ...value, confirmation_sha256: error.confirmation });
      }
      if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return null;
      const applied = await snapshotSync.load(projectId, { onApplied: (next) => {
        const createdPageId = typeof result.page_id === "string" ? result.page_id : null;
        if (createdPageId) {
          const location = allPages(next).find((item) => item.page.page_id === createdPageId);
          if (location) {
            navigate(openNavigationPage(navigationRef.current, location.page.page_key, next));
          }
        }
        if (!createdPageId && action.startsWith('create-')) {
          const id = typeof result.scene_id === 'string' ? result.scene_id : typeof result.character_id === 'string' ? result.character_id : typeof result.id === 'string' ? result.id : typeof value.id === 'string' ? value.id : '';
          const variantId = action.endsWith('-variant') ? String(result.variant_id ?? value.id ?? 'profile') : 'profile';
          if (action.startsWith('create-scene') && id) navigate(openNavigationScene(navigationRef.current, String(result.scene_id ?? value.scene_id ?? id), variantId));
          if (action.startsWith('create-character') && id) navigate(openNavigationCharacter(navigationRef.current, String(result.character_id ?? value.character_id ?? id), variantId));
        }
        notify({ kind: "success", message: success });
      } });
      if (!applied) return null;
      return result;
    } catch (cause) {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) notify({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) setUtilityBusy(false);
    }
  }

  function handleNavigationDrop(drop: NavigationDrop) {
    const current = view;
    if (!current) return;
    if (drop.kind === "story-page") {
      if (!drop.targetGroup) return;
      const sequence = current.outline.chapters.flatMap((chapter) => chapter.sequences).find((item) => item.id === drop.targetGroup);
      if (!sequence) return;
      const beforeId = navigationDropBeforeId(sequence.pages.map((page) => page.page_id), drop.id, drop.sourceGroup === drop.targetGroup, drop.targetId, drop.placement);
      if (beforeId === undefined) return;
      void performNavigationAction("move-page", { page_id: drop.id, owner: { owner_kind: "story", sequence_id: drop.targetGroup }, before_page_id: beforeId }, "页面已移动");
      return;
    }
    if (drop.kind === 'character-page' || drop.kind === 'scene-page') {
      if (!drop.targetGroup) return;
      const kind = drop.kind === 'scene-page' ? 'scene' : 'character';
      const setting = (kind === 'scene' ? current.scenes?.scenes ?? [] : current.characters).find(item => item.id === drop.owner);
      if (!setting || !setting.visual.variants.some(v => v.id === drop.targetGroup)) return;
      const ids = setting.pages.filter(page => page.variant_id === drop.targetGroup).map(page => page.page_id);
      const before = navigationDropBeforeId(ids, drop.id, drop.sourceGroup === drop.targetGroup, drop.targetId, drop.placement);
      if (before !== undefined) void performNavigationAction('move-page', {page_id:drop.id,owner:{owner_kind:kind,[`${kind}_id`]:setting.id,variant_id:drop.targetGroup},before_page_id:before},'页面已移动');
      return;
    }
    if (drop.kind === "chapter") {
      const chapter = current.outline.chapters.find((item) => item.id === drop.id);
      if (!chapter) return;
      const beforeId = navigationDropBeforeId(current.outline.chapters.map((item) => item.id), drop.id, true, drop.targetId, drop.placement);
      if (beforeId === undefined) return;
      const beforeChapter = beforeId ? current.outline.chapters.find((item) => item.id === beforeId) : null;
      void (async () => {
        if (await confirm({ kind: "warning", title: "移动章节", message: beforeChapter ? `将「${chapter.title}」移动到「${beforeChapter.title}」之前？` : `将「${chapter.title}」移动到末尾？`, confirmLabel: "移动" })) await performNavigationAction("move-chapter", { chapter_id: drop.id, before_chapter_id: beforeId }, "章节已移动");
      })();
      return;
    }
    if (drop.kind === "sequence") {
      if (!drop.targetGroup) return;
      const chapter = current.outline.chapters.find((item) => item.id === drop.targetGroup);
      const sequence = current.outline.chapters.flatMap((item) => item.sequences).find((item) => item.id === drop.id);
      if (!chapter || !sequence) return;
      const beforeId = navigationDropBeforeId(chapter.sequences.map((item) => item.id), drop.id, drop.sourceGroup === drop.targetGroup, drop.targetId, drop.placement);
      if (beforeId === undefined) return;
      const beforeSequence = beforeId ? chapter.sequences.find((item) => item.id === beforeId) : null;
      void (async () => {
        if (await confirm({ kind: "warning", title: "移动情节单元", message: beforeSequence ? `将「${sequence.title}」移动到「${beforeSequence.title}」之前？` : `将「${sequence.title}」移动到「${chapter.title}」末尾？`, confirmLabel: "移动" })) await performNavigationAction("move-sequence", { sequence_id: drop.id, chapter_id: drop.targetGroup, before_sequence_id: beforeId }, "情节单元已移动");
      })();
      return;
    }
    if (!drop.sourceGroup) return;
    const settingKind = drop.kind === "scene-variant" ? "scene" : "character";
    const character = (settingKind === "scene" ? current.scenes?.scenes ?? [] : current.characters).find((item) => item.id === drop.sourceGroup);
    const variant = character?.visual.variants.find((item) => item.id === drop.id);
    if (!character || !variant) return;
    const beforeId = navigationDropBeforeId(character.visual.variants.map((item) => item.id), drop.id, true, drop.targetId, drop.placement);
    if (beforeId === undefined) return;
    const beforeVariant = beforeId ? character.visual.variants.find((item) => item.id === beforeId) : null;
    void (async () => {
      if (await confirm({ kind: "warning", title: "移动子设定", message: beforeVariant ? `将「${variant.name}」移动到「${beforeVariant.name}」之前？` : `将「${variant.name}」移动到「${character.name}」末尾？`, confirmLabel: "移动" })) await performNavigationAction(`move-${settingKind}-variant`, { [`${settingKind}_id`]: character.id, variant_id: drop.id, before_variant_id: beforeId }, "子设定已移动");
    })();
  }

  function openVisualTemplateDialog(target: VisualPageTemplateTarget) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    setNavigationMenu(null);
    setVisualTemplateTarget(target);
    if (globalResources) return;
    void fetch("/api/resources", { headers: { accept: "application/json" } })
      .then((response) => responseJson<GlobalResources>(response))
      .then((resources) => { if (projectRequestGuard.current.isProjectCurrent(projectScope)) setGlobalResources(resources); })
      .catch((cause) => {
        if (projectRequestGuard.current.isProjectCurrent(projectScope)) notify({ kind: "error", message: `读取模板失败：${cause instanceof Error ? cause.message : String(cause)}` });
      });
  }

  async function createVisualPage(template: VisualPageTemplate | null, subject: VisualPageTemplateSubject | null) {
    const target = visualTemplateTarget;
    if (!target) return false;
    const owner = target.ownerKind === 'story' ? { owner_kind: 'story', sequence_id: target.sequenceId }
      : target.ownerKind === 'character' ? { owner_kind: 'character', character_id: target.characterId, variant_id: target.variantId }
      : { owner_kind: 'scene', scene_id: target.sceneId, variant_id: target.variantId };
    return Boolean(await performNavigationAction('create-page', { owner, template_id: template?.id ?? null, after_page_id: target.afterPageId,
      ...(subject ? { character_id: subject.characterId, variant_id: subject.variantId } : {}) }, '页面已创建'));
  }

  async function chooseScene(id: string, settingId = 'profile') {
    if ((activeTab !== 'scenes' || id !== selectedSceneId || selectedKey) && !await leaveCurrentAllowed()) return;
    navigate(openNavigationScene(navigationRef.current, id, settingId));
    setNavigationOpen(false);
  }
  function createScene() {
    setNavigationMenu(null);
    setNamedCreateTarget({kind: 'scene'});
  }
  function createCharacter() {
    setNavigationMenu(null);
    setNamedCreateTarget({ kind: "character" });
  }

  function createChapter(afterChapterId?: string) {
    const title = window.prompt("章节标题", "新章节")?.trim();
    if (title) void performNavigationAction("create-chapter", { title, after_chapter_id: afterChapterId }, "章节已创建");
  }

  function createCharacterVariant(character: WorkbenchCharacter, afterVariantId?: string) {
    setNavigationMenu(null);
    setNamedCreateTarget({ kind: "variant", characterId: character.id, characterName: character.name, afterVariantId });
  }

  function createSequence(chapter: StoryChapter, afterSequenceId?: string) {
    const title = window.prompt("情节单元标题", "新情节单元")?.trim();
    if (title) void performNavigationAction("create-sequence", { chapter_id: chapter.id, title, after_sequence_id: afterSequenceId }, "情节单元已创建");
  }

  function createCharacterPage(character: WorkbenchCharacter, variant: WorkbenchCharacter["visual"]["variants"][number], afterPageId?: string) {
    openVisualTemplateDialog({ ownerKind: "character", characterId: character.id, variantId: variant.id, afterPageId, targetLabel: `${character.name} · ${variant.name}` });
  }

  function createStoryPage(sequence: StorySequence, afterPageId?: string) {
    openVisualTemplateDialog({ ownerKind: "story", sequenceId: sequence.id, afterPageId, targetLabel: sequence.title });
  }

  function settingMenuItems(setting: WorkbenchCharacter, kind: 'character' | 'scene' = 'character'): NavigationMenuItem[] {
    const label = kind === 'scene' ? '场景' : '角色';
    const consumers = locations.filter(({page}) => setting.pages.some(p => p.page_id === page.page_id) || (kind === 'scene' ? page.prompt.scene_id === setting.id : page.characters?.some(ref => ref.character_id === setting.id) || page.dialogue?.some(line => line.speaker === setting.id)));
    return [
      { id: `create-variant-${setting.id}`, label: '新增子设定', onSelect: () => setNamedCreateTarget({ kind: 'variant', entityKind: kind, characterId: setting.id, characterName: setting.name }) },
      { id: `delete-${kind}-${setting.id}`, label: `删除${label}`, danger: true, hint: consumers.length ? `${consumers.length} 个页面需整理或修复引用` : undefined, onSelect: () => void (async () => {
        if (await confirm({kind: 'warning', title: `删除${label}`, message: `删除“${setting.name}”？保留引用、页面和图片。${consumers.length} 个页面可能需要整理或修复。`, danger: true}))
          await performNavigationAction(`delete-${kind}`, { [`${kind}_id`]: setting.id }, `${label}已删除`);
      })() },
    ];
  }

  function settingVariantMenuItems(setting: WorkbenchCharacter, variant: WorkbenchCharacter['visual']['variants'][number], kind: 'character' | 'scene' = 'character'): NavigationMenuItem[] {
    const inUse = locations.some(({page}) => setting.pages.some(p => p.page_id === page.page_id && p.variant_id === variant.id) || (kind === 'scene'
      ? page.prompt.scene_id === setting.id && page.prompt.scene_variant_id === variant.id
      : page.characters?.some(ref => ref.character_id === setting.id && ref.variant_id === variant.id)));
    const last = setting.visual.variants.length <= 1;
    return [
      {id: `variant-after-${variant.id}`, label: '新增子设定', onSelect: () => setNamedCreateTarget({kind:'variant', entityKind: kind, characterId: setting.id, characterName: setting.name, afterVariantId: variant.id})},
      {id: `page-${variant.id}`, label: '新增页面', onSelect: () => createSettingPage(setting, variant.id, kind)},
      {id: `delete-${variant.id}`, label: '删除子设定', danger: true, disabled: last || inUse, hint: last ? '至少保留一个子设定' : inUse ? '请先移走页面并修复引用' : undefined, onSelect: () => void (async () => {
        if (await confirm({kind:'warning',title:'删除子设定',message:`删除“${variant.name}”及其 Prompt / LoRA？`,danger:true})) await performNavigationAction(`delete-${kind}-variant`, {[`${kind}_id`]:setting.id,variant_id:variant.id},'子设定已删除');
      })()},
    ];
  }

  function createSettingPage(setting: WorkbenchCharacter, variantId: string, kind: 'character' | 'scene', afterPageId?: string) {
    const targetLabel = `${setting.name} · ${setting.visual.variants.find(v => v.id === variantId)?.name ?? variantId}`;
    openVisualTemplateDialog(kind === 'scene' ? {ownerKind:'scene',sceneId:setting.id,variantId,afterPageId,targetLabel} : {ownerKind:'character',characterId:setting.id,variantId,afterPageId,targetLabel});
  }

  function pageMenuItems(page: WorkbenchPage): NavigationMenuItem[] {
    return [
      {id:`copy-${page.page_id}`,label:'复制页面',onSelect:()=>void performNavigationAction('duplicate-page',{page_id:page.page_id},'页面已复制')},
      {id:`move-${page.page_id}`,label:'移动页面',onSelect:()=>setMovingPage(page)},
      {id:`delete-${page.page_id}`,label:'删除页面',danger:true,onSelect:()=>void (async()=>{
        if(await confirm({kind:'warning',title:'删除页面',message:`删除“${page.title}”？`,danger:true})) await performNavigationAction('delete-page',{page_id:page.page_id},'页面已删除');
      })()},
    ];
  }

  function settingPageMenuItems(setting: WorkbenchCharacter, page: WorkbenchPage, kind: 'character' | 'scene' = 'character'): NavigationMenuItem[] {
    return [{id:`create-after-${page.page_id}`,label:'新增页面',onSelect:()=>createSettingPage(setting,page.variant_id!,kind,page.page_id)},...pageMenuItems(page)];
  }

  function chapterMenuItems(chapter: StoryChapter): NavigationMenuItem[] {
    const onlyChapter = (view?.outline.chapters.length ?? 0) <= 1;
    return [
      { id: `create-chapter-after-${chapter.id}`, label: "新增章节", onSelect: () => createChapter(chapter.id) },
      { id: `create-sequence-${chapter.id}`, label: "新增单元", onSelect: () => createSequence(chapter) },
      { id: `delete-chapter-${chapter.id}`, label: "删除章节", hint: chapter.sequences.length ? "需先删除其中的情节单元" : onlyChapter ? "至少保留一个章节" : undefined, disabled: chapter.sequences.length > 0 || onlyChapter, danger: true, onSelect: () => void (async () => { if (await confirm({ kind: "warning", title: "删除章节", message: `删除“${chapter.title}”？`, danger: true })) await performNavigationAction("delete-chapter", { chapter_id: chapter.id }, "章节已删除"); })() },
    ];
  }

  function sequenceMenuItems(sequence: StorySequence): NavigationMenuItem[] {
    return [
      { id: `create-sequence-after-${sequence.id}`, label: "新增单元", onSelect: () => { const chapter = view?.outline.chapters.find(c => c.sequences.some(s => s.id === sequence.id)); if (chapter) createSequence(chapter, sequence.id); } },
      { id: `create-story-page-${sequence.id}`, label: "新增页面", onSelect: () => createStoryPage(sequence) },
      { id: `create-story-text-page-${sequence.id}`, label: "新增文字页", onSelect: () => void performNavigationAction("create-story-page", { sequence_id: sequence.id, page_kind: "text" }, "文字页已创建") },
      { id: `delete-sequence-${sequence.id}`, label: "删除情节单元", hint: sequence.pages.length ? "需先删除其中的页面" : undefined, disabled: sequence.pages.length > 0, danger: true, onSelect: () => void (async () => { if (await confirm({ kind: "warning", title: "删除情节单元", message: `删除“${sequence.title}”？`, danger: true })) await performNavigationAction("delete-sequence", { sequence_id: sequence.id }, "情节单元已删除"); })() },
    ];
  }

  function storyPageMenuItems(page: WorkbenchPage): NavigationMenuItem[] {
    return [
      { id: `move-${page.page_id}`, label: "移动页面", onSelect: () => setMovingPage(page) },
      { id: `create-story-page-after-${page.page_id}`, label: "新增页面", onSelect: () => { const sequence = view?.outline.chapters.flatMap(c => c.sequences).find(s => s.pages.some(p => p.page_id === page.page_id)); if (sequence) createStoryPage(sequence, page.page_id); } },
      { id: `duplicate-story-page-${page.page_id}`, label: "复制页面", onSelect: () => void performNavigationAction("duplicate-page", { page_id: page.page_id }, "页面已复制") },
      { id: `delete-story-page-${page.page_id}`, label: "删除页面", danger: true, onSelect: () => void (async () => { if (await confirm({ kind: "warning", title: "删除剧情页", message: `删除“${page.title}”？`, danger: true })) await performNavigationAction("delete-page", { page_id: page.page_id }, "剧情页已删除"); })() },
    ];
  }

  function focusPromptPage(page: WorkbenchPage) {
    setPromptOverviewRequest(current => current + 1);
    navigate(openNavigationPage(navigationRef.current, page.page_key, view, "prompt-overview"));
    setNavigationOpen(false);
  }

  async function openPromptOverview(page: WorkbenchPage) {
    if (!await leaveCurrentAllowed()) return;
    focusPromptPage(page);
  }

  function chooseNavigationPage(page: WorkbenchPage) {
    if (activeTab === "prompt-overview" && page.kind === "story") focusPromptPage(page);
    else void choosePage(page);
  }

  async function choosePage(page: WorkbenchPage) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    const tab = page.kind === "story" ? "story" : page.kind === "scene" ? "scenes" : "characters";
    if ((activeTab !== tab || selectedKey !== pageKey(page)) && !await leaveCurrentAllowed()) return;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    setNavigationOpen(false);
    navigate(openNavigationPage(navigationRef.current, page.page_key, view));
  }

  async function turnPage(offset: number) {
    if (!pageNavigationVisible || loading || pageTurnPending.current) return;
    const target = activeOwnerLocations[activePageIndex + offset];
    if (!target) return;
    pageTurnPending.current = true;
    try { await choosePage(target.page); } finally { pageTurnPending.current = false; }
  }

  useEffect(() => {
    if (!pageNavigationVisible) return;
    const turn = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!canUseWorkbenchShortcut(event)) return;
      event.preventDefault();
      if (!event.repeat) void turnPage(event.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", turn);
    return () => window.removeEventListener("keydown", turn);
  });

  async function chooseCharacter(character: WorkbenchCharacter, settingId = "") {
    const targetSettingId = settingId || character.visual.variants[0]?.id || "profile";
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    if ((activeTab !== "characters" || selectedKey || activeCharacterId !== character.id) && !await leaveCurrentAllowed()) return;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    setNavigationOpen(false);
    navigate(openNavigationCharacter(navigationRef.current, character.id, targetSettingId));
  }

  async function openStoryOverview(target: StoryOverviewTarget = { kind: "overview" }) {
    if (activeTab === "prompt-overview") {
      const chapter = view?.outline.chapters.find(item => target.kind === "chapter" && item.id === target.id);
      const sequence = view?.outline.chapters.flatMap(item => item.sequences).find(item => target.kind === "sequence" && item.id === target.id);
      const page = target.kind === "overview" ? locations.find(item => item.page.kind === "story")?.page : sequence?.pages[0] ?? chapter?.sequences.flatMap(item => item.pages)[0];
      if (page) focusPromptPage(page);
      return;
    }
    if (!await leaveCurrentAllowed()) return;
    setNavigationOpen(false);
    storyOverviewRequest.current += 1;
    navigate({ ...openNavigationTab(navigationRef.current, "project-story", view), overviewTarget: target });
  }

  async function refresh() {
    const projectScope = projectRequestGuard.current.scope(projectId);
    setLoading(true);
    try { await reload(); }
    catch (cause) {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        notify({ kind: "error", message });
      }
    } finally {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) setLoading(false);
    }
  }

  async function leaveCurrentAllowed({ loraDatasetChange = false }: { loraDatasetChange?: boolean } = {}) {
    if ((activeTab.startsWith("lora-") || loraDatasetChange) && loraDirty) {
      const accepted = await confirm({ kind: "warning", title: "放弃未保存 LoRA 修改", message: "当前 LoRA 页面有未保存修改，离开会放弃这些修改，是否继续？", danger: true });
      if (accepted) setLoraDirty(false);
      return accepted;
    }
    if (!document.querySelector(unsavedFactsSelector)) return true;
    return confirm({ kind: "warning", title: "放弃未保存修改", message: "当前页面有未保存修改，离开会放弃这些修改，是否继续？", danger: true });
  }

  async function switchProject(nextId: string) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!nextId || (nextId === projectId && !globalArea) || !await leaveCurrentAllowed()) return false;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return false;
    navigate(globalArea && projectLocation.current?.projectId === nextId ? projectLocation.current : projectNavigation(nextId));
    setNavigationOpen(false);
    return true;
  }

  async function openTab(tab: ActiveTab) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return false;
    if (tab === activeTab) { const section = navigationSection(tab); if (section) setDirectorySection(section); return true; }
    const leavingLora = activeTab.startsWith("lora-") && (!tab.startsWith("lora-") || tab !== activeTab);
    if ((leavingLora || (!activeTab.startsWith("lora-") && tab !== activeTab)) && !await leaveCurrentAllowed()) return false;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return false;
    setNavigationOpen(false);
    navigate(openNavigationTab(navigationRef.current, tab, view));
    return true;
  }

  async function openLoraDataset(datasetId: string) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (datasetId === loraDatasetId) return openTab("lora-datasets");
    if (loraDirty && !await leaveCurrentAllowed({ loraDatasetChange: true })) return false;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return false;
    setLoraDatasetId(datasetId);
    setNavigationOpen(false);
    navigate(openNavigationTab(navigationRef.current, "lora-datasets", view));
    return true;
  }

  async function createLoraDataset() {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (activeTab !== "lora-datasets" && !await openTab("lora-datasets")) return;
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    setLoraCreateDatasetRequest((current) => current + 1);
  }

  async function openTaskPage(taskProjectId: string, target: RuntimePageKey) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (taskProjectId !== projectId) {
      if (!await leaveCurrentAllowed()) return;
      if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
      navigate(openNavigationPage(projectNavigation(taskProjectId), target, null));
      return;
    }
    const location = locations.find((item) => samePageKey(item.page.page_key, target));
    if (!location) { notify({ kind: "warning", message: "任务对应页面已经不存在" }); return; }
    await choosePage(location.page);
  }

  async function saveProjectSettings(next: ProjectWorkbenchView["project"], label = "项目设置") {
    if (!next.canvas || !next.default_render_profile) return;
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    setUtilityBusy(true);
    try {
      const result = await responseJson<{ project: Pick<ProjectWorkbenchView["project"], "id" | "title" | "canvas" | "default_render_profile"> }>(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/project`, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ title: next.title, canvas: next.canvas, default_render_profile: next.default_render_profile }),
      }));
      if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
      setView((current) => current ? { ...current, project: { ...current.project, ...result.project } } : current);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, title: result.project.title } : project));
      notify({ kind: "success", message: `${label}已保存` });
    } catch (cause) {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) notify({ kind: "error", message: `${label}保存失败：${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) setUtilityBusy(false);
    }
  }

  async function saveProjectLetteringSettings(settings: LetteringSettings, expectedSha256: string) {
    const projectScope = projectRequestGuard.current.scope(projectId);
    if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
    setUtilityBusy(true);
    try {
      const result = await saveLetteringSettings(projectId, settings, expectedSha256);
      if (!projectRequestGuard.current.isProjectCurrent(projectScope)) return;
      setView((current) => current ? {
        ...current,
        project: { ...current.project, lettering_settings: result.settings, lettering_settings_sha256: result.sha256 },
        characters: current.characters.map((character) => ({
          ...character,
          style: result.settings.character_colors[character.id]
            ? { display_color: result.settings.character_colors[character.id] }
            : null,
        })),
      } : current);
      notify({ kind: "success", message: "嵌字设置已保存" });
    } catch (cause) {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) notify({ kind: "error", message: `嵌字设置保存失败：${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      if (projectRequestGuard.current.isProjectCurrent(projectScope)) setUtilityBusy(false);
    }
  }

  async function reloadProjectLists() {
    const [entries, collection] = await Promise.all([refreshLibrary(), responseJson<ProjectCollection>(await fetch("/api/projects"))]);
    setProjects(collection.projects); setLibraryVersion(version => version + 1); return entries;
  }
  async function selectRegisteredProject(entry: RegisteredProject) {
    if (entry.type === "training") await openLoraDataset(entry.id);
    else await switchProject(entry.id);
  }
  async function saveProjectDirectory(directory: string) {
    const target = directoryDialog;
    if (!target) return;
    if (!await leaveCurrentAllowed()) return;
    const endpoint = target === "add" ? "/api/project-library/open" : "/api/project-library/" + target.id + "/promote";
    const entry = await responseJson<RegisteredProject>(await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: directory }) }));
    await reloadProjectLists(); setDirectoryDialog(null);
    if (entry.type === "training") { setLoraDatasetId(entry.id); navigate(openNavigationTab(navigationRef.current, "lora-datasets", view)); }
    else activateProject(entry.id);
  }
  async function manageCurrentProject(action: ProjectAction) {
    const entry = currentRegisteredProject;
    if (!entry) return;
    setNavigationOpen(false);
    if (action === "promote") { setDirectoryDialog(entry); return; }
    if (!await leaveCurrentAllowed()) return;
    if (action !== "copy" && !await confirm({ kind: "warning", title: action === "delete" ? "删除临时项目" : "从列表移除", message: action === "delete" ? "将删除这个临时项目及其中全部素材和成果。" : "只取消登记，磁盘文件和 Git 历史保留。", danger: action === "delete", confirmLabel: "确认" })) return;
    setUtilityBusy(true);
    try {
      const result = await responseJson<RegisteredProject>(await fetch("/api/project-library/" + entry.id + "/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      const entries = await reloadProjectLists();
      if (action === "copy") {
        if (entry.type === "story") activateProject(result.id);
        else { setLoraDatasetId(result.id); navigate(openNavigationTab(navigationRef.current, "lora-datasets", view)); }
      } else if (entry.type === "story") activateProject(entries.find(item => item.type === "story" && item.available)?.id ?? "");
      else { setLoraDatasetId(""); navigate(openNavigationTab(navigationRef.current, "lora-datasets", view)); }
    } catch (cause) { notify({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setUtilityBusy(false); }
  }

  function changeDirectorySection(section: NavigationSection) {
    if (directoryRef.current) directoryScroll.current[directorySection] = directoryRef.current.scrollTop;
    setDirectorySection(section);
  }
  function sectionMenu(label: string, items: NavigationMenuItem[]) {
    return { 'data-long-press-context-menu': true,
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => showNavigationMenu(event, label, items),
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => sectionLongPress.start(event, point => showNavigationMenu(point, label, items)),
    };
  }
  useLayoutEffect(() => {
    if (directoryRef.current) directoryRef.current.scrollTop = directoryScroll.current[directorySection] ?? 0;
  }, [directorySection]);
  const locationIdentity = navigationIdentity(navigation);
  useEffect(() => {
    if (globalArea) return;
    setExpandedUtilities(current => ({ ...current, ...(activeTab === 'characters' ? { characters: true } : activeTab === 'scenes' ? { scenes: true } : {}) }));
    const frame = requestAnimationFrame(() => directoryRef.current?.querySelector<HTMLElement>('[aria-selected="true"], .is-active')?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [locationIdentity, navigationOpen, revealRequest]);
  async function travelNavigation(offset: number) {
    const history = historyRef.current, index = history.index + offset, target = history.entries[index];
    if (!target || !view || target.projectId !== projectId || !await leaveCurrentAllowed()) return;
    if (historyRef.current !== history) return;
    const next = reconcileNavigation(target, view, view);
    if (next.sceneId && !view.scenes?.scenes.some(scene => scene.id === next.sceneId)) next.sceneId = view.scenes?.scenes[0]?.id ?? '';
    historyRef.current = { ...history, index };
    storyOverviewRequest.current += 1;
    navigate(next, true);
    setNavigationOpen(false);
  }
  function historyLabel(offset: number) {
    const state = historyRef.current.entries[historyRef.current.index + offset];
    if (!state) return undefined;
    if (state.activePageKey) return locations.find(item => samePageKey(item.page.page_key, state.activePageKey))?.page.title ?? '页面';
    if (state.activeTab === 'characters') { const character = view?.characters.find(c => c.id === state.activeCharacterId); return character?.visual.variants.find(v => v.id === state.activeCharacterSettingId)?.name ?? character?.name; }
    return ({ 'project-settings': '基本信息', 'project-render-profile': '生成设置', 'project-lettering': '项目嵌字样式', 'project-materials': '参考材料', 'project-tasks': '任务历史', 'project-story': '故事总览', 'scenes': '场景', 'finished': '成品', 'comparison': '对比实验' } as Record<string, string>)[state.activeTab] ?? '页面';
  }

  const paneStyle = { ...(sidebarWidth !== null ? { "--sidebar-width": `${sidebarWidth}px` } : {}), "--story-editor-width": `${editorWidth}%`, "--candidate-width": `${candidateWidth}px`, ...(view?.project.canvas ? { "--canvas-aspect": view.project.canvas.replace(":", " / ") } : {}) } as CSSProperties;

  const resourceSectionActive = activeTab.startsWith("resource-");
  const loraSectionActive = activeTab.startsWith("lora-");
  const workspaceTitle = activeTab === "comparison" ? "对比实验" : loraSectionActive ? "LoRA 训练" : resourceSectionActive ? "资源" : selectedProject?.title ?? view?.project.title ?? "项目";
  const characterSectionActive = activeTab === "characters";
  const storySectionActive = activeTab === "story" || activeTab === "project-story" || activeTab === "prompt-overview";
  const baseResourceCount = globalResources?.models.filter((model) => model.kind !== "lora").length;
  const loraResourceCount = globalResources?.models.filter((model) => model.kind === "lora").length;
  const currentRegisteredProject = registeredProjects.find(entry => entry.id === (activeTab === "lora-history" ? null : activeTab.startsWith("lora-") ? loraDatasetId : !globalArea ? projectId : null));
  const renderedProjectScope = projectRequestGuard.current.scope(projectId);
  const storyNavRevealKeys = view ? storyRevealBranchKeys(view.outline, selectedKey) : [];
  if (view && activeTab === "project-story" && storyOverviewTarget?.kind === "sequence") { const chapter = view.outline.chapters.find(c => c.sequences.some(s => s.id === storyOverviewTarget.id)); if (chapter) storyNavRevealKeys.push(`chapter:${chapter.id}`); }
  const characterNavRevealKeys = view ? characterRevealBranchKeys(view.characters, selectedKey, activeCharacterId, activeCharacterSettingId) : [];

  return <main className={`workbench-shell is-full-layout ${navigationDrawer ? "is-drawer-navigation" : ""} workbench-shell--${activeTab === "comparison" ? "comparison" : activeTab === "story" || activeTab === "characters" ? "page" : "utility"}`} style={paneStyle}>
    {directoryDialog && <ProjectDirectoryDialog promote={directoryDialog === "add" ? undefined : directoryDialog} onClose={() => setDirectoryDialog(null)} onSave={saveProjectDirectory} />}
    <header className="topbar">
      {navigationDrawer && <button type="button" className="navigation-drawer-toggle" aria-label="目录" title="目录" aria-expanded={navigationOpen} aria-controls="workbench-navigation" onClick={() => setNavigationOpen((open) => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>}
      <Popover className="project-switcher" onOpenChange={open => { if (open) void refreshLibrary().catch(() => undefined); }}>{(close) => <>
        <summary className="brand-lockup" aria-label="切换项目或工具"><h1>{workspaceTitle}</h1><span className="project-switcher-chevron" aria-hidden="true" /></summary>
        <div className="project-switcher-menu"><small className="workspace-switcher-label">项目</small>
          <input aria-label="筛选项目" placeholder="搜索项目" value={projectFilter} onChange={event => setProjectFilter(event.target.value)} />
          {libraryError && <small role="alert">{libraryError}</small>}
          <div className="project-switcher-list">{([['story', '剧情项目'], ['training', 'LoRA 训练项目']] as const).map(([type, label]) => {
            const entries = registeredProjects.filter(entry => entry.type === type && (entry.title ?? entry.id).toLowerCase().includes(projectFilter.toLowerCase()));
            return entries.length > 0 && <section className="project-list-group" aria-label={label} key={type}><h2>{label}</h2>{entries.map(entry => <ProjectListEntry key={entry.id} entry={entry} active={entry.id === currentRegisteredProject?.id} onOpen={() => { close(); void selectRegisteredProject(entry); }} />)}</section>;
          })}</div>
          {!registeredProjects.length && !libraryError && <small>暂无项目</small>}
          <button type="button" className="project-list-add" onClick={() => { close(); setDirectoryDialog("add"); }}><span aria-hidden="true">＋</span>添加项目</button>
          <hr />
          <button type="button" aria-current={activeTab === "comparison" ? "page" : undefined} onClick={() => { close(); void openTab("comparison"); }}><b>对比实验</b></button>
          <button type="button" aria-current={activeTab.startsWith("lora-") ? "page" : undefined} onClick={() => { close(); void openTab("lora-datasets"); }}><b>LoRA 训练</b></button>
          <button type="button" aria-current={activeTab.startsWith("resource-") ? "page" : undefined} onClick={() => { close(); void openTab("resource-base"); }}><b>资源</b></button>
        </div>
      </>}</Popover>
      {!globalArea && <div className="navigation-history" aria-label="浏览历史"><button type="button" aria-label="后退" title={historyLabel(-1) ? `后退到：${historyLabel(-1)}` : '后退'} disabled={historyRef.current.index <= 0} onClick={() => void travelNavigation(-1)}>←</button><button type="button" aria-label="前进" title={historyLabel(1) ? `前进到：${historyLabel(1)}` : '前进'} disabled={historyRef.current.index >= historyRef.current.entries.length - 1} onClick={() => void travelNavigation(1)}>→</button></div>}
      {!globalArea && view && <NavigationSearch key={projectId} view={view} onPage={page => void choosePage(page)} onCharacter={(character, setting) => void chooseCharacter(character, setting)} onScene={id => void chooseScene(id)} />}
      {<RuntimeStatusBar projectTitle={workspaceTitle} online={runtimeOnline} hardware={runtimeHardware} tasks={runtimeTasks} onHardwareChange={setRuntimeHardware} onQueueRevision={(revision) => { runtimeTaskQueueRevision.current = Math.max(runtimeTaskQueueRevision.current ?? 0, revision); }} onOpenTask={setSelectedTask} onPreview={setTaskPreview} onControlled={applyTaskControl} />}
      <button type="button" className={`button image-privacy-toggle ${imagesHidden ? "is-active" : ""}`} aria-pressed={imagesHidden} title="短按切换；隐藏时长按临时透视（F9 同样支持）" onPointerDown={(event) => { if (event.button !== 0) return; ignoreNextPrivacyClick.current = true; event.currentTarget.setPointerCapture(event.pointerId); beginImagePrivacyHold("button"); }} onPointerUp={() => finishImagePrivacyHold("button", true)} onPointerCancel={() => { ignoreNextPrivacyClick.current = false; finishImagePrivacyHold("button", false); }} onClick={() => { if (ignoreNextPrivacyClick.current) { ignoreNextPrivacyClick.current = false; return; } setImagesHidden((current) => !current); }}>{imagesPeeking ? "正在透视" : imagesHidden ? "图片已隐藏" : "隐藏图片"}</button>
    </header>
    {error && !globalArea && <div className="project-write-banner project-write-banner--error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>重试</button></div>}
    {taskPreview && <TaskResultViewer key={`${taskPreview.images[taskPreview.index].id}:${taskPreview.index}`} preview={taskPreview} onClose={() => setTaskPreview(null)} />}
    {selectedTask && <TaskDetailDialog key={`${selectedTask.project_id}:${selectedTask.id}`} selected={selectedTask} onClose={() => setSelectedTask(null)} onOpenPage={(targetProject, targetPage) => void openTaskPage(targetProject, targetPage)} />}
    {namedCreateTarget && view && <NamedEntityCreateDialog kind={namedCreateTarget.kind} ownerName={namedCreateTarget.kind === 'variant' ? namedCreateTarget.characterName : undefined}
      existingIds={namedCreateTarget.kind === 'variant' ? (namedCreateTarget.entityKind === 'scene' ? view.scenes?.scenes ?? [] : view.characters).find(entity=>entity.id===namedCreateTarget.characterId)?.visual.variants.map(v=>v.id) ?? [] : (namedCreateTarget.kind === 'scene' ? view.scenes?.scenes ?? [] : view.characters).map(entity=>entity.id)}
      onClose={()=>setNamedCreateTarget(null)} onCreate={async({id,name})=>{
        const target=namedCreateTarget;
        const kind=target.kind==='variant' ? target.entityKind ?? 'character' : target.kind;
        return Boolean(await performNavigationAction(target.kind==='variant' ? `create-${kind}-variant` : `create-${kind}`,target.kind==='variant' ? {[`${kind}_id`]:target.characterId,id,name,after_variant_id:target.afterVariantId} : {id,name},'设定已创建'));
      }} />}
    {movingPage && view && <PageMoveDialog view={view} page={movingPage} onClose={()=>setMovingPage(null)} onMove={async owner=>Boolean(await performNavigationAction('move-page',{page_id:movingPage.page_id,owner},'页面已移动'))} />}
    {visualTemplateTarget && view && <VisualPageTemplateDialog resource={globalResources?.visual_page_templates ?? null} target={visualTemplateTarget} characters={view.characters} onClose={() => setVisualTemplateTarget(null)} onCreate={createVisualPage} />}
    <div className="workspace-layout">
      <WorkbenchNavigation drawer={navigationDrawer} open={navigationOpen} onClose={() => setNavigationOpen(false)}>
        <nav className="section-nav section-nav--partitioned" aria-label="工作台导航" {...sectionLongPress.captureProps} onContextMenu={event => event.preventDefault()}>
          {!globalArea && <div className="navigation-sections" aria-label="目录分区">{([['settings', '设定'], ['story', '系列'], ['output', '输出']] as const).map(([section, label]) => <button key={section} type="button" aria-pressed={directorySection === section} className={directorySection === section ? 'is-active' : ''} onClick={() => changeDirectorySection(section)} {...(section === 'story' ? sectionMenu('系列', [
            { id: 'create-chapter', label: '新增章节', onSelect: () => createChapter() },
            { id: 'story-overview', label: '故事总览', onSelect: () => void openStoryOverview() },
            { id: 'prompt-overview', label: 'Prompt 总览', onSelect: () => void openTab('prompt-overview') },
          ]) : {})}>{label}</button>)}</div>}
          <div className="navigation-directory" ref={directoryRef}>
            {!globalArea && <>
              <div hidden={directorySection !== 'settings'}>
                <div className="section-heading-row" {...sectionMenu('角色', [{ id: 'create-character', label: '新增角色', onSelect: createCharacter }])}>
                  {!!view?.characters.length && <NavigationDisclosureButton expanded={expandedUtilities.characters} label="角色" onClick={() => setExpandedUtilities(c => ({ ...c, characters: !c.characters }))} />}
                  <b>角色</b><small className="navigation-child-count">{view?.characters.length ?? '—'}</small>
                </div>
                {view && expandedUtilities.characters && <SettingNavigation key={projectId} revealRequest={revealRequest} view={view} candidateCounts={candidateCounts} selectedKey={selectedKey} revealKeys={characterNavRevealKeys} activeCharacterId={activeTab === 'characters' ? activeCharacterId : null} activeCharacterSettingId={activeCharacterSettingId} onCharacter={chooseCharacter} onPage={chooseNavigationPage} onRequestMenu={showNavigationMenu} onDrop={handleNavigationDrop} characterMenuItems={settingMenuItems} settingMenuItems={settingVariantMenuItems} pageMenuItems={settingPageMenuItems} />}
                <div className="section-heading-row" {...sectionMenu('场景', [{ id: 'create-scene', label: '新增场景', onSelect: () => void createScene() }])}>
                  {!!view?.scenes?.scenes.length && <NavigationDisclosureButton expanded={expandedUtilities.scenes} label="场景" onClick={() => setExpandedUtilities(c => ({ ...c, scenes: !c.scenes }))} />}
                  <b>场景</b><small className="navigation-child-count">{view?.scenes?.scenes.length ?? (view ? 0 : '—')}</small>
                </div>
                {view && expandedUtilities.scenes && <SettingNavigation key={`${projectId}:scenes`} kind="scene" view={view} revealRequest={revealRequest} candidateCounts={candidateCounts} selectedKey={selectedKey}
                  revealKeys={sceneRevealBranchKeys(view.scenes?.scenes ?? [],selectedKey,activeTab==='scenes'?selectedSceneId:null,sceneSettingId)} activeCharacterId={activeTab==='scenes'?selectedSceneId:null} activeCharacterSettingId={sceneSettingId}
                  onCharacter={(scene,id)=>void chooseScene(scene.id,id)} onPage={chooseNavigationPage} onRequestMenu={showNavigationMenu} onDrop={handleNavigationDrop}
                  characterMenuItems={scene=>settingMenuItems(scene,'scene')} settingMenuItems={(scene,variant)=>settingVariantMenuItems(scene,variant,'scene')} pageMenuItems={(scene,page)=>settingPageMenuItems(scene,page,'scene')} />}
                {!!view?.orphan_pages?.length && <button className="button button--quiet" onClick={()=>void openTab('orphan-pages')}>待整理页面 · {view.orphan_pages.length}</button>}
              </div>
              <div hidden={directorySection !== 'story'}>{view && <StoryNavigation key={projectId} revealRequest={revealRequest} overviewTarget={activeTab === "project-story" ? storyOverviewTarget : null} view={view} candidateCounts={candidateCounts} selectedKey={selectedKey} revealKeys={storyNavRevealKeys} onSelect={chooseNavigationPage} onOpenOverview={target => void openStoryOverview(target)} onRequestMenu={showNavigationMenu} onDrop={handleNavigationDrop} chapterMenuItems={chapterMenuItems} sequenceMenuItems={sequenceMenuItems} pageMenuItems={storyPageMenuItems} />}</div>
              <div className="utility-nav global-utility-nav" hidden={directorySection !== 'output'}><button type="button" className={activeTab === 'finished' ? 'is-active' : ''} onClick={() => void openTab('finished')}>成品</button><button type="button" className={activeTab === 'project-lettering' ? 'is-active' : ''} onClick={() => void openTab('project-lettering')}>项目嵌字样式</button></div>
            </>}
            {activeTab === "comparison" && <div className="utility-nav global-utility-nav"><button type="button" className="is-active">对比实验</button></div>}
            {resourceSectionActive && <div className="utility-nav global-utility-nav resource-utility-nav"><button type="button" className={activeTab === 'resource-base' ? 'is-active' : ''} onClick={() => void openTab('resource-base')}><span>基模</span><small>{baseResourceCount ?? '—'}</small></button><button type="button" className={activeTab === 'resource-loras' ? 'is-active' : ''} onClick={() => void openTab('resource-loras')}><span>LoRA</span><small>{loraResourceCount ?? '—'}</small></button></div>}
            {loraSectionActive && <div className="utility-nav global-utility-nav lora-utility-nav">
              <div className={`lora-dataset-nav-heading ${activeTab === 'lora-datasets' ? 'is-active' : ''}`} {...sectionMenu('训练项目', [{ id: 'create-dataset', label: '新增训练项目', onSelect: () => void createLoraDataset() }])}>
                {loraDatasets.length > 0 && <NavigationDisclosureButton expanded={loraDatasetsExpanded} label="数据集列表" onClick={() => setLoraDatasetsExpanded(c => !c)} />}
                <button type="button" aria-label="训练项目" onClick={() => void openTab('lora-datasets')}>训练项目</button><small className="navigation-child-count">{loraCounts.datasets ?? '—'}</small>
              </div>
              {loraDatasetsExpanded && loraDatasets.length > 0 && <div className="lora-dataset-nav-tree">{loraDatasets.map(dataset => <button type="button" key={dataset.id} className={`lora-dataset-nav-item ${activeTab === 'lora-datasets' && loraDatasetId === dataset.id ? 'is-active' : ''}`} onClick={() => void openLoraDataset(dataset.id)}><b>{dataset.name ?? dataset.id}</b><span>{dataset.error ? '记录无效' : `训练 ${dataset.effective_item_count ?? 0} 张 / 共 ${dataset.item_count ?? 0} 张`}</span></button>)}</div>}
              <button type="button" className={activeTab === 'lora-history' ? 'is-active' : ''} aria-current={activeTab === 'lora-history' ? 'page' : undefined} onClick={() => void openTab('lora-history')}>全部训练记录</button>
            </div>}
          </div>
          {(!globalArea || currentRegisteredProject) && <ProjectMenu activeTab={activeTab} project={currentRegisteredProject} busy={utilityBusy} onManage={action => void manageCurrentProject(action)} onOpen={tab => { setNavigationOpen(false); void openTab(tab); }} />}
        </nav>
      </WorkbenchNavigation>
      <PaneResizeHandle className="pane-resizer--workspace" label="调整左侧导航宽度" value={sidebarWidth ?? autoSidebarWidth()} defaultValue={272} min={SIDEBAR_MIN} max={SIDEBAR_MAX} onChange={setSidebarWidth} onReset={() => setSidebarWidth(null)} />
      <section className="project-main">{view?.project.canvas && <LetteringCanvasProbe canvas={view.project.canvas} onWidthChange={setLetteringCanvasWidth} />}{loraSectionActive ? <LoraTrainingView key={libraryVersion} allRuns={activeTab === "lora-history"} section={activeTab === "lora-history" ? "runs" : activeTab.slice("lora-".length) as "datasets" | "tasks" | "runs"} datasetId={loraDatasetId} createDatasetRequest={loraCreateDatasetRequest} onSectionChange={(section) => void openTab(`lora-${section}` as ActiveTab)} onDatasetSelected={setLoraDatasetId} onDatasetsChange={datasets => { setLoraDatasets(datasets); setLoraCounts(c => ({ ...c, datasets: datasets.length })); }} onTaskCountsChange={(tasks, runs) => setLoraCounts(c => ({ ...c, tasks, runs }))} onDirtyChange={setLoraDirty} />
        : resourceSectionActive ? <GlobalModelsView resources={globalResources} kind={activeTab === "resource-base" ? "base" : "lora"} />
        : activeTab === "comparison" ? <ComparisonExperimentsView resources={globalResources} runtimeTasks={runtimeTasks} />
        : !view ? <div className="empty-state"><h3>{error ? "项目加载失败" : projects.length ? "正在加载" : "还没有项目"}</h3><p>{error ?? (projects.length ? "正在读取项目事实。" : "在 workspace 中创建项目后刷新工作台。")}</p></div>
          : activeTab === "project-settings" && view.project.canvas && view.project.default_render_profile ? <ProjectSettingsView projectId={projectId} project={{ ...view.project, canvas: view.project.canvas, default_render_profile: view.project.default_render_profile }} busy={utilityBusy} onSave={(settings) => saveProjectSettings({ ...view.project, ...settings }, "基础设置")} directory={currentRegisteredProject?.path} />
          : activeTab === "project-render-profile" && view.project.canvas && view.project.default_render_profile ? <ProjectGenerationSettingsView projectId={projectId} project={{ ...view.project, canvas: view.project.canvas, default_render_profile: view.project.default_render_profile }} busy={utilityBusy} onSaveProject={(settings) => saveProjectSettings({ ...view.project, ...settings }, "生成设置")} />
          : activeTab === "project-lettering" && view.project.lettering_settings && view.project.lettering_settings_sha256 ? <ProjectLetteringSettingsView projectId={projectId} settings={view.project.lettering_settings} settingsSha256={view.project.lettering_settings_sha256} characters={view.characters.map(({ id, name }) => ({ id, name }))} previewCanvasWidth={letteringCanvasWidth} busy={utilityBusy} onSave={saveProjectLetteringSettings} />
          : activeTab === "project-story" ? <StoryOverview key={projectId} projectId={projectId} view={view} focusTarget={storyOverviewTarget} onSelectTarget={target => void openStoryOverview(target)} busy={loading} onReload={reload} onOpenPage={(page) => void choosePage(page)} onSaved={(result) => {
            if (!projectRequestGuard.current.isProjectCurrent(renderedProjectScope)) return;
            setView((current) => {
              if (!current) return current;
              const target = result.target;
              if (target.kind === "synopsis") return { ...current, outline: { ...current.outline, synopsis: result.text, synopsis_sha256: result.sha256 } };
              return { ...current, outline: { ...current.outline, chapters: current.outline.chapters.map((chapter) => target.kind === "chapter"
                ? chapter.id === target.id ? { ...chapter, summary: result.text, summary_sha256: result.sha256 } : chapter
                : { ...chapter, sequences: chapter.sequences.map((sequence) => sequence.id === target.id ? { ...sequence, summary: result.text, summary_sha256: result.sha256 } : sequence) }) } };
            });
          }} />
          : activeTab === 'orphan-pages' && !activeLocation ? <section className="resource-editor"><WorkspaceHeader title="待整理页面" /><p>所属目录已不存在；页面内容和图片仍保留，可以移动到新的目录。</p>{(view.orphan_pages ?? []).map(page=><div key={page.page_id}><button className="button" onClick={()=>chooseNavigationPage(page)} onContextMenu={event=>showNavigationMenu(event,page.title,pageMenuItems(page))}>{page.title}</button><button className="button button--quiet" onClick={()=>setMovingPage(page)}>移动页面</button></div>)}</section>
          : activeTab === "scenes" && !activeLocation && activeScene ? <SettingView key={`scene:${activeScene.id}`} kind="scene" projectId={projectId} character={activeScene} initialSettingId={sceneSettingId} busy={loading} onSaved={() => { void reload(true); }} onSettingChange={id => navigate(openNavigationScene(navigationRef.current, activeScene.id, id))} />
          : activeTab === "scenes" && !activeLocation ? <section className="empty-state"><h3>还没有场景</h3><button className="button" onClick={createScene}>新建场景</button></section>
          : activeTab === "prompt-overview" ? <PromptOverview key={projectId} projectId={projectId} view={view} focus={promptOverviewFocus} busy={loading} onOpenPage={(page) => void choosePage(page)} onSaved={(page) => { if (projectRequestGuard.current.isProjectCurrent(renderedProjectScope)) setView(current => current ? replaceWorkbenchPage(current, page, page) : current); }} onTrackedTasks={updateTrackedRuntimeTasks} />
          : activeTab === "finished" ? <FinishedPagesView key={projectId} projectId={projectId} onOpenPage={(key) => { const target = locations.find(item => samePageKey(item.page.page_key, key)); if (target) void choosePage(target.page); }} />
          : activeTab === "project-tasks" ? <section className="utility-page task-records-view"><TaskHistory page onOpen={setSelectedTask} onPreview={setTaskPreview} /></section>
          : activeTab === "project-materials" ? <ProjectMaterialsView projectId={projectId} />


          : activeLocation ? <PageWorkspace pageOrder={activeLocation.page.kind === "story" ? locations.filter(item => item.page.kind === "story").findIndex(item => item.key === activeLocation.key) + 1 : activeOwnerLocations.findIndex(item => item.key === activeLocation.key) + 1} editorTab={navigation.editorTab} onEditorTabChange={tab => navigate({ ...navigationRef.current, editorTab: tab }, true)} onOpenLetteringSettings={() => void openTab("project-lettering")} onOpenPromptOverview={() => void openPromptOverview(activeLocation.page)} projectId={projectId} location={activeLocation} ownerPages={activeOwnerLocations} characters={view.characters} scenes={view.scenes?.scenes ?? []} renderCapabilities={view.render_capabilities} defaultRenderProfile={view.project.default_render_profile} canvas={view.project.canvas} letteringStyle={view.project.lettering_settings} taskCollection={runtimeTasks} busy={loading} editorWidth={editorWidth} candidateWidth={candidateWidth} onEditorWidthChange={setEditorWidth} onCandidateWidthChange={setCandidateWidth} onPageChanged={(page, replacement) => { if (projectRequestGuard.current.isProjectCurrent(renderedProjectScope)) setView((current) => current ? replaceWorkbenchPage(current, page, replacement) : current); }} onReload={reload} onTrackedTasksChange={updateTrackedRuntimeTasks} />
          : activeTab === "characters" && activeCharacter ? (<SettingView key={`character:${activeCharacter.id}`} projectId={projectId} character={activeCharacter} initialSettingId={activeCharacterSettingId} busy={loading} onSaved={(result) => { if (!projectRequestGuard.current.isProjectCurrent(renderedProjectScope)) return; setView((current) => current ? { ...current, characters: current.characters.map((entry) => entry.id === activeCharacter.id ? { ...entry, ...result } : entry) } : current); void reload(true); }} onSettingChange={(next) => navigate(openNavigationCharacter(navigationRef.current, activeCharacter.id, next))} />)
            : <div className="empty-state"><h3>当前没有页面</h3><p>Agent 写入页面事实后会显示在这里。</p></div>}</section>
    </div>
    {!globalArea && navigationDrawer && pageNavigationVisible && <nav className="page-turn-navigation" aria-label="页面翻页">
      <button type="button" className="button button--quiet" disabled={loading || !previousPage} title={previousPage?.title} aria-label={previousPage ? `上一页：${previousPage.title}` : "已是首页"} onClick={() => void turnPage(-1)}><span aria-hidden="true">←</span><span className="page-turn-navigation__title">{previousPage?.title ?? "已是首页"}</span></button>
      <span aria-live="polite" aria-atomic="true">{activePageIndex + 1} / {activeOwnerLocations.length}</span>
      <button type="button" className="button button--primary" disabled={loading || !nextPage} title={nextPage?.title} aria-label={nextPage ? `下一页：${nextPage.title}` : "已是末页"} onClick={() => void turnPage(1)}><span className="page-turn-navigation__title">{nextPage?.title ?? "已是末页"}</span><span aria-hidden="true">→</span></button>
    </nav>}
    <NavigationContextMenu request={navigationMenu} onClose={() => setNavigationMenu(null)} />
  </main>;
}
