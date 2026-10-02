import { useReferencedSettings } from './use-referenced-settings';
import {ModelPromptEditor} from './models/registry';
import {PageGenerationSettings} from './models/PageGenerationSettings';
import {ReferenceRow,ReferenceLabel,ParticipantEditor} from './PromptReferences';
import { ReferenceLibrary, ReferenceSelection, referenceUrl, type ReferenceEntry } from "./ReferenceLibrary";
import { defaultTextPageLayout, type TextPageLayout } from "../shared/text-page-layout.mjs";
import { SceneReferenceEditor } from './SceneReferenceEditor';
import { characterSource, sceneSource } from './project-workbench-client';
import type { Scene } from './project-workbench-client';
import type { ImageOverlayTarget } from "./ImageLightbox";
import {
  type CSSProperties,
  type ReactNode,
  Fragment,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent as ReactSyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createPortal } from "react-dom";
import { countStoryCharacters, storyContentWarnings, SCENE_DESCRIPTION_CHARACTER_LIMIT, NARRATION_CHARACTER_LIMIT } from "../shared/story-content-guidance.mjs";
import { GenerationDetailsPanel } from "./GenerationDetailsPanel";
import { GenerateSplitButton } from "./GenerateSplitButton";
import { Modal } from "./Modal";
import { PromptIssueList } from "./PromptIssueList";
import type { PromptIssue } from "./prompt-audit-display";
import { PromptTextArea } from "./SourcePromptEditor";
import { ProjectRefreshRequiredError } from "./api-response";
import { InlineTitleEditor, SectionHeader, WorkspaceHeader } from "./WorkspaceHeader";
import {
  deletePageTextSource,
  loadPageTextSources,
  loadTextSourceContext,
  type PagePrompt,
  type PromptSourceVersions,
  type PageRewriteValue,
  type PromptSourceChoice,
  type PageRenderInspection,
  type TextSourceContext,
  type TextSourceEntry,
  type WorkbenchCharacter,
  type EditableWorkbenchPage as WorkbenchPage,
} from "./project-workbench-client";
import {
  previewLetteringItems,
  darkenDisplayColor,
  lightenDisplayColor,
  geometryIssues,
  letteringIssueLabels,
  letteringPreset,
  letteringTypographyVariables,
  neutralLetteringColor,
  type DialogueMode,
  type LetteringIssue,
  type LetteringItem,
  type LetteringStyle,
  type NarrationPosition,
} from "./lettering";
import { canvasDimensions, resizeLetteringBox, resolveLetteringLayout } from "./lettering-layout";
import { TextPageEditor } from "./TextPageEditor";
import { TextPageArtwork } from "./TextPageArtwork";
import "./WorkbenchPageEditor.css";
import { HeartLettering, DiceIcon, heartSettings, resolveHeart, useHeartFont, type HeartSettings } from "./HeartLettering";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function UndoIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 14 4 9l5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

let dialogueDraftSequence = 0;
function newDialogueDraftKey() {
  dialogueDraftSequence += 1;
  return `draft-dialogue-${dialogueDraftSequence}`;
}

export type WorkbenchDialogueDraft = {
  id?: string;
  mode: DialogueMode;
  speaker?: string;
  text: string;
  position?: NarrationPosition;
};

type EditableDialogueLine = WorkbenchDialogueDraft & { draftKey: string };

export type WorkbenchPageContentDraft = {
  title: string;
  visual_goal: string;
  scene_description: string;
  characters?: Array<{ character_id: string; variant_id: string }>;
  dialogue?: WorkbenchDialogueDraft[];
  page_kind?: "text" | null;
  body?: string;
  display_title?: string;
  text_layout?: TextPageLayout;

};

type EditorTab = "visual" | "lettering" | "flow";
type SavePhase = "saved" | "saving" | "error";

export type WorkbenchPageEditorProps = {
  projectId: string;
  page: WorkbenchPage;
  characters: WorkbenchCharacter[];
  scenes?: Scene[];
  breadcrumb?: string[];
  pageOrder?: number;
  busy?: boolean;
  canvas?: string;
  letteringStyle?: LetteringStyle | null;
  letteringItems?: LetteringItem[];
  desktopActionsTarget?: HTMLDivElement|null;
  letteringTarget?: HTMLSpanElement | null;
  fullscreenLetteringTarget?: ImageOverlayTarget | null;
  flowPreview?: PageRenderInspection | null;
  flowPreviewError?: string;
  rewriteValue?: PageRewriteValue | null;
  rewriteLoading?: boolean;
  rewriteRunning?: boolean;
  rewriteProgress?: PageRewriteValue['progress'];
  rewriteError?: string;
  promptSource?: PromptSourceChoice;
  onPromptSourceChange?: (value: PromptSourceChoice) => void;
  onRewrite?: () => void;
  onSavePage: (draft: WorkbenchPageContentDraft, prompt: PagePrompt, items: LetteringItem[], baseline: WorkbenchPage, sourceVersions: PromptSourceVersions) => Promise<{ page: WorkbenchPage; content: WorkbenchPageContentDraft & { dialogue: NonNullable<WorkbenchPage["dialogue"]> }; prompt: PagePrompt; items: LetteringItem[] }>;
  onPageSaved?: () => void;
  onReloadContent?: () => Promise<void> | void;
  onReloadPrompt?: () => Promise<void> | void;
  onPromptDraftChange?: (prompt: PagePrompt) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenPromptOverview?: () => void;
  onOpenLetteringSettings?: () => void;
  editorTab?: EditorTab;
  onEditorTabChange?: (tab: EditorTab) => void;
  saveAllRef?: { current: (() => Promise<boolean>) | null };
  discardAllRef?: { current: (() => void) | null };
  onGenerate?: (request: { count: 1 | 3 }) => void | Promise<void>;
  generationCount?: 1 | 3;
  onGenerationCountChange?: (count: 1 | 3) => void;
  generationDisabled?: boolean;
  generationDisabledReason?: string;
  generationProblems?: PromptIssue[];
};

function contentFromPage(page: WorkbenchPage): WorkbenchPageContentDraft {
  return {
    title: page.title,
    visual_goal: page.visual_goal ?? "",
    scene_description: page.scene_description ?? "",
    ...{
        page_kind: page.page_kind ?? null,
        body: page.body ?? "",
        display_title: page.display_title ?? "",
        text_layout: page.text_layout ?? { ...defaultTextPageLayout },
        characters: clone(page.characters ?? []),
        dialogue: (page.dialogue ?? []).map((line) => ({
          id: line.id,
          mode: (line.mode === "speech" || line.mode === "thought" || line.mode === "heart" ? line.mode : "narration") as DialogueMode,
          ...(line.speaker ? { speaker: line.speaker } : {}),
          ...(line.position ? { position: line.position } : {}),
          text: line.text,
        })),
      },
  };
}

function readPromptSourceVersions(model: 'anima' | 'qwen', characters: WorkbenchCharacter[], scenes: Scene[]): PromptSourceVersions {
  return Object.fromEntries([
    ...characters.flatMap(setting => Object.entries(setting.prompt_source_versions?.[model] ?? {}).map(([variant, sha]) => [characterSource(setting.id, variant), sha])),
    ...scenes.flatMap(setting => Object.entries(setting.prompt_source_versions?.[model] ?? {}).map(([variant, sha]) => [sceneSource(setting.id, variant), sha])),
  ]);
}

function editableDialogue(lines: WorkbenchDialogueDraft[] | undefined): EditableDialogueLine[] {
  return (lines ?? []).map((line) => ({ ...clone(line), draftKey: line.id ? `saved:${line.id}` : newDialogueDraftKey() }));
}

function persistedDialogue(lines: EditableDialogueLine[]): WorkbenchDialogueDraft[] {
  return lines.map(({ draftKey: _draftKey, ...line }) => line);
}

function dialogueKey(line: EditableDialogueLine) { return line.id ?? line.draftKey; }

function characterAbbreviation(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  return Array.from(words[0] ?? "?").slice(0, 2).join("");
}

function lineColor(line: WorkbenchDialogueDraft, characters: WorkbenchCharacter[]) {
  if (line.mode === "heart") return "#d52587";
  if (line.mode === "narration" || line.speaker === "npc") return neutralLetteringColor;
  return darkenDisplayColor(characters.find((character) => character.id === line.speaker)?.style?.display_color);
}

function lineSpeakerName(line: WorkbenchDialogueDraft, characters: WorkbenchCharacter[]) {
  if (line.mode === "heart") return "爱心";
  if (line.mode === "narration") return "旁白";
  if (line.speaker === "npc") return "NPC";
  return characters.find((character) => character.id === line.speaker)?.name ?? line.speaker ?? "角色";
}

function resolveLetteringObject(line: WorkbenchDialogueDraft, item: LetteringItem, style: LetteringStyle, dimensions: { width: number; height: number }) {
  if (line.mode === "heart") return resolveHeart(line.text, item, dimensions, style.font_size);
  const preset = letteringPreset(line as Parameters<typeof letteringPreset>[0], style);
  return resolveLetteringLayout({ text: line.text, direction: preset.direction, kind: preset.kind, fontSize: style.font_size, canvasWidth: dimensions.width, canvasHeight: dimensions.height, box: item.box });
}

export function WorkbenchLetteringOverlay({ dialogue, items, characters, style, canvas = "3:4", interactive = false, selectedId = "", onSelect, onChange, onDiagnosticsChange }: {
  dialogue: WorkbenchDialogueDraft[];
  items: LetteringItem[];
  characters: WorkbenchCharacter[];
  style: LetteringStyle;
  canvas?: string;
  interactive?: boolean;
  selectedId?: string;
  onSelect?: (dialogueId: string) => void;
  onChange?: (item: LetteringItem) => void;
  onDiagnosticsChange?: (value: Record<string, LetteringIssue[]>) => void;
}) {
  const heartFontReady = useHeartFont();
  const gesture = useRef<{ pointerId: number; dialogueId: string; mode: "move" | "resize" | "rotate"; startX: number; startY: number; item: LetteringItem; rect: DOMRect; pivot: { x: number; y: number } } | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, LetteringIssue[]>>({});
  const diagnosticsRef = useRef("");
  const lines = useMemo(() => new Map(dialogue.flatMap((line) => line.id ? [[line.id, line] as const] : [])), [dialogue]);
  const clampValue = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

  function beginGesture(event: ReactPointerEvent<HTMLElement>, item: LetteringItem, mode: "move" | "resize" | "rotate") {
    if (!interactive || !onChange) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    const host = event.currentTarget.closest(".lettering-overlay") as HTMLElement | null;
    if (!host) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
    const objectRect = event.currentTarget.closest(".lettering-object")!.getBoundingClientRect();
    gesture.current = { pivot: { x: objectRect.x + objectRect.width / 2, y: objectRect.y + objectRect.height / 2 }, pointerId: event.pointerId, dialogueId: item.dialogue_id, mode, startX: event.clientX, startY: event.clientY, item: clone(item), rect: host.getBoundingClientRect() };
    onSelect?.(item.dialogue_id);
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || !onChange) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - current.startX) / Math.max(1, current.rect.width);
    const dy = (event.clientY - current.startY) / Math.max(1, current.rect.height);
    const item = clone(current.item);
    if (current.mode === "move") {
      const line = lines.get(item.dialogue_id);
      const preset = line ? letteringPreset(line as Parameters<typeof letteringPreset>[0], style) : null;
      const dimensions = canvasDimensions(canvas);
      const resolved = line && preset ? resolveLetteringObject(line, item, style, dimensions) : { box: item.box };
      item.box.x = clampValue(current.item.box.x + dx, 0, 1 - resolved.box.w);
      item.box.y = clampValue(current.item.box.y + dy, 0, 1 - resolved.box.h);
    } else if (current.mode === "rotate") {
      const line = lines.get(item.dialogue_id);
      if (line?.mode !== "heart") return;
      const heart = heartSettings(current.item, style.font_size), dimensions = canvasDimensions(canvas);
      const oldLayout = resolveHeart(line.text, current.item, dimensions, style.font_size);
      const start = Math.atan2(current.startY-current.pivot.y, current.startX-current.pivot.x);
      const angle = Math.atan2(event.clientY-current.pivot.y, event.clientX-current.pivot.x);
      const rotation = Math.round(((heart.rotation + (angle-start)*180/Math.PI + 540) % 360) - 180);
      item.heart = { ...heart, rotation };
      const nextLayout = resolveHeart(line.text, item, dimensions, style.font_size);
      item.box.x = clampValue(current.item.box.x + (oldLayout.box.w-nextLayout.box.w)/2, 0, Math.max(0,1-nextLayout.box.w));
      item.box.y = clampValue(current.item.box.y + (oldLayout.box.h-nextLayout.box.h)/2, 0, Math.max(0,1-nextLayout.box.h));
    } else {
      const line = lines.get(item.dialogue_id);
      const preset = line ? letteringPreset(line as Parameters<typeof letteringPreset>[0], style) : null;
      if (line && preset) {
        const dimensions = canvasDimensions(canvas);
        const rendered = resolveLetteringObject(line, current.item, style, dimensions);
        if (line.mode === "heart") {
          const heart = heartSettings(current.item, style.font_size);
          const width = rendered.box.w * current.rect.width, height = rendered.box.h * current.rect.height;
          const scale = ((width + event.clientX - current.startX) * width + (height + event.clientY - current.startY) * height) / (width * width + height * height);
          item.heart = { ...heart, font_size: Math.round(clampValue(heart.font_size * scale, 12, 192)) };
        } else item.box = resizeLetteringBox(current.item.box, rendered.box, preset.direction, dx, dy);
      }
    }
    onChange(item);
  }

  function end(event: ReactPointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* synthetic event */ }
    gesture.current = null;
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const dimensions = canvasDimensions(canvas);
      const resolvedById = new Map<string, ReturnType<typeof resolveLetteringLayout>>();
      const resolvedItems = items.flatMap((item) => {
        const line = lines.get(item.dialogue_id);
        if (!line) return [];
        const preset = letteringPreset(line as Parameters<typeof letteringPreset>[0], style);
        const resolved = resolveLetteringObject(line, item, style, dimensions);
        resolvedById.set(item.dialogue_id, resolved);
        return [{ ...item, box: resolved.box }];
      });
      const issueSets = geometryIssues(resolvedItems);
      for (const [id, resolved] of resolvedById) if (resolved.overflow) issueSets.get(id)?.add("overflow");
      const next = Object.fromEntries([...issueSets].map(([id, issues]) => [id, [...issues]]));
      const signature = JSON.stringify(next);
      if (signature === diagnosticsRef.current) return;
      diagnosticsRef.current = signature;
      setDiagnostics(next);
      onDiagnosticsChange?.(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvas, items, lines, onDiagnosticsChange, style, heartFontReady]);

  const narration = dialogue.find((line) => line.mode === "narration" && line.text.trim());
  return <div className={`lettering-overlay ${interactive ? "is-interactive" : ""}`.trim()} onPointerDown={(event) => { if (interactive && event.target === event.currentTarget) onSelect?.(""); }}>
    {items.map((item) => {
      const line = lines.get(item.dialogue_id);
      if (!line || line.mode === "narration") return null;
      const selected = selectedId === item.dialogue_id;
      const preset = letteringPreset(line as Parameters<typeof letteringPreset>[0], style);
      const color = preset.kind === "caption" && line.mode !== "heart" && line.speaker && line.speaker !== "npc"
        ? lightenDisplayColor(characters.find((character) => character.id === line.speaker)?.style?.display_color)
        : lineColor(line, characters);
      const dimensions = canvasDimensions(canvas);
      const resolved = resolveLetteringObject(line, item, style, dimensions);
      const left = resolved.box.x * 100;
      const top = resolved.box.y * 100;
      const width = resolved.box.w * 100;
      const height = resolved.box.h * 100;
      const kindLabel = preset.kind === "plain" ? "无框" : preset.kind === "balloon" ? "对话框" : preset.kind === "float" ? "浮字" : "叙述框";
      const directionLabel = preset.direction === "vertical" ? "竖排" : "横排";
      return <div key={item.dialogue_id} role="group" aria-label={`${lineSpeakerName(line, characters)}：${line.text}；${directionLabel}${kindLabel}`} data-dialogue-id={item.dialogue_id} data-lettering-kind={line.mode === "heart" ? "heart" : preset.kind} data-lettering-direction={preset.direction} data-lettering-box={`${item.box.x},${item.box.y},${item.box.w},${item.box.h}`} data-lettering-issues={(diagnostics[item.dialogue_id] ?? []).join(",")} tabIndex={interactive ? 0 : undefined} className={`lettering-object lettering-object--${line.mode === "heart" ? "heart" : preset.kind} lettering-object--${preset.direction} ${selected ? "is-selected" : ""}`.trim()} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`, "--lettering-color": color, ...letteringTypographyVariables(style, "canvas") } as CSSProperties} onPointerDown={(event) => beginGesture(event, item, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={(event) => {
        if (!interactive || !onChange || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 0.02 : 0.005;
        const next = clone(item);
        if (event.key === "ArrowLeft") next.box.x = clampValue(next.box.x - step, 0, 1 - resolved.box.w);
        if (event.key === "ArrowRight") next.box.x = clampValue(next.box.x + step, 0, 1 - resolved.box.w);
        if (event.key === "ArrowUp") next.box.y = clampValue(next.box.y - step, 0, 1 - resolved.box.h);
        if (event.key === "ArrowDown") next.box.y = clampValue(next.box.y + step, 0, 1 - resolved.box.h);
        onChange(next);
      }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSelect?.(item.dialogue_id); }}>
        {line.mode === "heart" ? (heartFontReady && <HeartLettering text={line.text} layout={resolveHeart(line.text, item, dimensions, style.font_size)} />) : <span className="lettering-text">{preset.direction === "horizontal" ? resolved.lines.join("\n") : line.text}</span>}
        {interactive && selected && line.mode === "heart" && <button type="button" className="lettering-rotate-handle" title="拖动调整排布方向" aria-label="旋转爱心排布" onPointerDown={event => beginGesture(event, item, "rotate")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 10a7 7 0 1 0-1 7M19 4v6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
        {interactive && selected && <i className={`lettering-resize-handle lettering-resize-handle--${preset.direction}`} aria-hidden="true" title={line.mode === "heart" ? "拖动缩放爱心文字" : preset.direction === "vertical" ? "拖动调整列高" : "拖动调整行宽"} onPointerDown={(event) => beginGesture(event, item, "resize")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />}
      </div>;
    })}
    {narration && <div className={`narration-bar ${narration.position === "top" ? "narration-bar--top" : ""}`.trim()} style={letteringTypographyVariables(style, "canvas") as CSSProperties}><span className="narration-bar__text">{narration.text}</span></div>}
  </div>;
}

function textSourceBookName(sourceFile: string) {
  const file = sourceFile.split("/").pop() ?? sourceFile;
  return file.replace(/\.txt$/i, "");
}

function TextSourceBlock({ projectId, dialogueId, entry, onDelete }: {
  projectId: string;
  dialogueId: string;
  entry: TextSourceEntry;
  onDelete: (dialogueId: string) => Promise<void>;
}) {
  const [context, setContext] = useState<TextSourceContext | null>(null);
  const [contextError, setContextError] = useState("");
  const [removing, setRemoving] = useState(false);

  function loadContext(event: ReactSyntheticEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open || context || contextError) return;
    loadTextSourceContext(projectId, entry).then(
      (value) => setContext(value),
      (cause) => setContextError(cause instanceof Error ? cause.message : String(cause)),
    );
  }

  return <details className="lettering-text-source" onToggle={loadContext}>
    <summary>原文参考<small>{textSourceBookName(entry.source_file)} · 偏移 {entry.offset}</small></summary>
    <div className="lettering-text-source-body">
      <p className="lettering-text-source-sentence">{entry.original_sentence}</p>
      <p className="lettering-text-source-origin">出处：{entry.source_file} @ {entry.offset}</p>
      {contextError && <p className="lettering-text-source-error" role="alert">{contextError}</p>}
      {context && <ol className="lettering-text-source-context">
        {context.lines.map((line) => <li key={line.number} value={line.number} className={line.hit ? "is-hit" : undefined}>{line.text}</li>)}
      </ol>}
      <button type="button" className="is-danger" disabled={removing} onClick={(event) => {
        event.stopPropagation();
        setRemoving(true);
        void onDelete(dialogueId).finally(() => setRemoving(false));
      }}>删除出处</button>
    </div>
  </details>;
}

function LetteringEditor({ dialogue, items, characters, style, diagnostics, hasImage, projectId, pageId, selectedDraftKey, onSelectedDraftKeyChange, onDialogueChange, onItemsChange }: {
  dialogue: EditableDialogueLine[];
  items: LetteringItem[];
  characters: WorkbenchCharacter[];
  style: LetteringStyle;
  diagnostics: Record<string, LetteringIssue[]>;
  hasImage: boolean;
  projectId: string;
  pageId: string;
  selectedDraftKey: string;
  onSelectedDraftKeyChange: (draftKey: string) => void;
  onDialogueChange: (dialogue: EditableDialogueLine[]) => void;
  onItemsChange: (items: LetteringItem[]) => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ from: number; to: number; pointerId: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; pointerId: number } | null>(null);
  const [textSources, setTextSources] = useState<{ entries: Record<string, TextSourceEntry>; sha256: string; contextSha256: string } | null>(null);
  const [textSourceError, setTextSourceError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setTextSources(null);
    setTextSourceError("");
    loadPageTextSources(projectId, pageId).then(
      (draft) => { if (!cancelled) setTextSources({ entries: draft.document, sha256: draft.expected_sha256, contextSha256: draft.expected_context_sha256 }); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [projectId, pageId]);

  async function removeTextSource(dialogueId: string) {
    if (!textSources) return;
    try {
      const result = await deletePageTextSource(projectId, pageId, dialogueId, {
        expected_sha256: textSources.sha256,
        expected_context_sha256: textSources.contextSha256,
      });
      setTextSources({ entries: result.text_sources, sha256: result.text_sources_sha256, contextSha256: textSources.contextSha256 });
      setTextSourceError("");
    } catch (cause) {
      setTextSourceError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function updateDrag(next: typeof drag) {
    dragRef.current = next;
    setDrag(next);
  }
  function startDragging(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    body.current?.setPointerCapture(event.pointerId);
    updateDrag({ from: index, to: index, pointerId: event.pointerId });
  }
  function moveDrag(clientY: number, pointerId: number) {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const rows = [...(body.current?.querySelectorAll<HTMLElement>(".lettering-line") ?? [])];
    const insertionSlot = rows.findIndex((row) => clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    const rawSlot = insertionSlot === -1 ? rows.length : insertionSlot;
    const heartDrag = listed[current.from]?.mode === "heart";
    const lower = heartDrag ? listedStandard.length : 0;
    const upper = heartDrag ? rows.length - 1 : Math.max(0, listedStandard.length - 1);
    const to = Math.max(lower, Math.min(upper, rawSlot > current.from ? rawSlot - 1 : rawSlot));
    if (to !== current.to) updateDrag({ ...current, to });
  }
  function finishDrag(pointerId: number, canceled = false) {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    updateDrag(null);
    if (canceled || current.from === current.to) return;
    const next = [...listed];
    const [moved] = next.splice(current.from, 1);
    next.splice(current.to, 0, moved);
    onDialogueChange([...next, ...dialogue.filter((line) => line.mode === "narration")]);
  }
  function updateLine(draftKey: string, patch: Partial<WorkbenchDialogueDraft>) {
    onDialogueChange(dialogue.map((line) => line.draftKey === draftKey ? { ...line, ...patch } : line));
  }
  function changeSpeaker(line: EditableDialogueLine, speaker: string) {
    if (speaker === "npc") updateLine(line.draftKey, { mode: "speech", speaker: "npc" });
    else if (speaker) updateLine(line.draftKey, { mode: line.mode === "thought" ? "thought" : "speech", speaker });
  }
  function updateHeart(line: EditableDialogueLine, patch: Partial<HeartSettings>) {
    onItemsChange(items.map(item => item.dialogue_id === dialogueKey(line) ? { ...item, heart: { ...heartSettings(item), ...patch } } : item));
  }
  function changeMode(line: EditableDialogueLine, mode: DialogueMode) {
    const speaker = mode === "heart" ? line.speaker : mode === "thought" ? (line.speaker && line.speaker !== "npc" ? line.speaker : characters[0]?.id) : line.speaker ?? "npc";
    updateLine(line.draftKey, { mode, speaker });
  }
  function changeNarration(text: string) {
    const existing = dialogue.find((line) => line.mode === "narration");
    if (!text.trim()) {
      if (existing) onDialogueChange(dialogue.filter((line) => line.draftKey !== existing.draftKey));
      return;
    }
    if (existing) updateLine(existing.draftKey, { text });
    else onDialogueChange([...dialogue, { draftKey: newDialogueDraftKey(), mode: "narration", text }]);
  }
  function changeNarrationPosition(position: NarrationPosition) {
    const existing = dialogue.find((line) => line.mode === "narration");
    if (existing) updateLine(existing.draftKey, { position: position === "bottom" ? undefined : position });
  }
  function removeLine(line: EditableDialogueLine) {
    onDialogueChange(dialogue.filter((candidate) => candidate.draftKey !== line.draftKey));
    onItemsChange(items.filter((item) => item.dialogue_id !== dialogueKey(line)));
    if (selectedDraftKey === line.draftKey) onSelectedDraftKeyChange("");
  }
  function resetLine(line: EditableDialogueLine) {
    onItemsChange(previewLetteringItems(dialogue.map(line => ({ ...line, id: dialogueKey(line) })), items.filter((item) => item.dialogue_id !== dialogueKey(line)), style));
    onSelectedDraftKeyChange(line.draftKey);
  }

  const listedStandard = dialogue.filter((line) => line.mode !== "narration" && line.mode !== "heart");
  const listedHearts = dialogue.filter((line) => line.mode === "heart");
  const listed = [...listedStandard, ...listedHearts];
  const narrationLine = dialogue.find((line) => line.mode === "narration");
  const narrationLength = countStoryCharacters(narrationLine?.text ?? "");

  return <div className="lettering-editor">
    <div className="narration-editor">
      <div className="narration-editor-head">
        <span title="每页一条，以通栏字幕条显示在画面顶部或底部，不参与拖动排版">旁白
          <label className="lettering-option narration-position token-role" title="字幕条显示位置">
            <span className="lettering-option-badge">{narrationLine?.position === "top" ? "顶部" : "底部"}<i aria-hidden="true" /></span>
            <select aria-label="旁白位置" disabled={!narrationLine} value={narrationLine?.position === "top" ? "top" : "bottom"} onChange={(event) => changeNarrationPosition(event.target.value as NarrationPosition)}><option value="bottom">底部</option><option value="top">顶部</option></select>
          </label>
        </span>
        <small className={narrationLength > NARRATION_CHARACTER_LIMIT ? "is-over-limit" : undefined} aria-live="polite">{narrationLength} / {NARRATION_CHARACTER_LIMIT} 字</small>
      </div>
      <textarea rows={5} aria-label="旁白" placeholder="以通栏字幕条显示，可选顶部或底部，可留空" value={narrationLine?.text ?? ""} onChange={(event) => changeNarration(event.target.value)} />
    </div>
    <div className="lettering-list" ref={body} onPointerMove={(event) => moveDrag(event.clientY, event.pointerId)} onPointerUp={(event) => finishDrag(event.pointerId)} onPointerCancel={(event) => finishDrag(event.pointerId, true)}>
      <header><b>文案</b><button type="button" onClick={() => {
        const next = { draftKey: newDialogueDraftKey(), mode: "speech" as const, speaker: "npc", text: "新文字" };
        onDialogueChange([...listed, next, ...dialogue.filter((line) => line.mode === "narration")]);
        onSelectedDraftKeyChange(next.draftKey);
      }}>＋ 添加</button></header>
      {listed.length ? listed.map((line, index) => {
        const selected = selectedDraftKey === line.draftKey;
        const issues = diagnostics[dialogueKey(line)] ?? [];
        const dragPosition = drag?.from === index ? "source" : drag && drag.to !== drag.from && drag.to === index ? (drag.to < drag.from ? "before" : "after") : undefined;
        const heartsHeader = index === listedStandard.length && listedHearts.length > 0
          ? <header className="lettering-hearts-header">♥ 爱心 ×{listedHearts.length}</header>
          : null;
        const warning = issues.length > 0 && <span className="lettering-warning" role="img" aria-label={issues.map((issue) => letteringIssueLabels[issue]).join("；")} data-tooltip={issues.map((issue) => letteringIssueLabels[issue]).join("\n")}>!</span>;
        const modeSelect = <label className={`lettering-option lettering-mode token-role ${line.mode === "heart" ? "lettering-mode--heart" : ""}`.trim()} title="文案类型"><span className="lettering-option-badge">{{ speech: "对白", thought: "心理", narration: "旁白", heart: "爱心" }[line.mode]}<i aria-hidden="true" /></span><select aria-label="文案类型" value={line.mode} onChange={(event) => changeMode(line, event.target.value as DialogueMode)}><option value="speech">对白</option><option value="thought" disabled={!characters.length}>心理</option><option value="heart">爱心</option></select></label>;
        if (line.mode === "heart") {
          const item = items.find((candidate) => candidate.dialogue_id === dialogueKey(line));
          return <Fragment key={line.draftKey}>{heartsHeader}<article data-lettering-issues={issues.join(",")} className={`lettering-line lettering-line--heart ${selected ? "is-selected" : ""} ${dragPosition ? `is-drag-${dragPosition}` : ""}`.trim()} onClick={() => onSelectedDraftKeyChange(line.draftKey)}>
            <div className="lettering-line-heading">
              <button className="lettering-drag" onPointerDown={(event) => startDragging(event, index)} title="拖动排序" aria-label={`拖动第 ${index + 1} 条文案排序`}>⋮</button>
              {modeSelect}
              {warning}
              <textarea rows={1} aria-label={`第 ${index + 1} 条文案`} value={line.text} onChange={(event) => updateLine(line.draftKey, { text: event.target.value })} />
              {item && <button type="button" title="重新排列" aria-label="重新排列爱心" onClick={() => updateHeart(line, { seed: (heartSettings(item, style.font_size).seed + 1) >>> 0 })}><DiceIcon /></button>}
              <button type="button" disabled={!hasImage} onClick={(event) => { event.stopPropagation(); resetLine(line); }}>重置</button>
              <button className="is-danger" onClick={(event) => { event.stopPropagation(); removeLine(line); }} aria-label="删除文案">×</button>
            </div>
          </article></Fragment>;
        }
        const speaker = characters.find((character) => character.id === line.speaker);
        const roleLabel = line.speaker === "npc" ? "NPC" : speaker ? characterAbbreviation(speaker.name) : "角色";
        return <Fragment key={line.draftKey}>{heartsHeader}<article data-lettering-issues={issues.join(",")} className={`lettering-line ${selected ? "is-selected" : ""} ${dragPosition ? `is-drag-${dragPosition}` : ""}`.trim()} onClick={() => onSelectedDraftKeyChange(line.draftKey)}>
          <div className="lettering-line-heading">
            <button className="lettering-drag" onPointerDown={(event) => startDragging(event, index)} title="拖动排序" aria-label={`拖动第 ${index + 1} 条文案排序`}>⋮</button>
            <label className={`lettering-role token-role ${speaker ? "is-bound" : ""}`} title={lineSpeakerName(line, characters)}>
              <span className="role-badge"><i style={{ backgroundColor: speaker?.style?.display_color ?? (line.speaker === "npc" ? "#6f7772" : "#89938E") }} />{roleLabel}</span>
              <select aria-label="表达者" value={line.speaker ?? "npc"} onChange={(event) => changeSpeaker(line, event.target.value)}><option value="npc">NPC</option>{characters.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}</select>
            </label>
            {modeSelect}
            {warning}
            <span className="lettering-line-spacer" />
            <button className="is-danger" onClick={(event) => { event.stopPropagation(); removeLine(line); }} aria-label="删除文案">×</button>
          </div>
          <div className="lettering-line-content">
          <textarea rows={1} aria-label={`第 ${index + 1} 条文案`} value={line.text} onChange={(event) => updateLine(line.draftKey, { text: event.target.value })} />
          <footer>
          <button type="button" disabled={!hasImage} onClick={(event) => { event.stopPropagation(); resetLine(line); }}>重置位置</button>
          </footer>
          </div>
          {line.id && textSources?.entries[line.id] && (
            <TextSourceBlock projectId={projectId} dialogueId={line.id} entry={textSources.entries[line.id]} onDelete={removeTextSource} />
          )}
        </article></Fragment>;
      }) : <p className="lettering-empty">暂无文案</p>}
      {items.length > 0 && <button type="button" className="lettering-clear" onClick={() => { onItemsChange(previewLetteringItems(dialogue.map(line => ({ ...line, id: dialogueKey(line) })), [], style)); onSelectedDraftKeyChange(""); }}>重置所有布局</button>}
      {textSourceError && <p className="prompt-save-error" role="alert">{textSourceError}</p>}
    </div>
  </div>;
}

function FlowPreviewPanel({ projectId, preview, error = "" }: { projectId: string; preview?: PageRenderInspection | null; error?: string }) {
  if (!preview) return <div className="workbench-flow-placeholder"><b>{error ? "生成详情读取失败" : "正在编译生成详情"}</b><p>{error || "稍后将显示当前配置、参数、模型、LoRA 与最终 Prompt。"}</p></div>;
  return <div className="generation-details">
    <section className="generation-details__section" aria-label="生成参考图">
      <h3>参考图 · {preview.prompt.images.length} 张</h3>
      <div className="generation-reference-images">{preview.prompt.images.length ? preview.prompt.images.map(image => <figure key={`${image.source}:${image.id}`}>
        <a href={referenceUrl(projectId, image.file)} target="_blank" rel="noreferrer" aria-label={`查看参考图 ${image.index}`}><img src={referenceUrl(projectId, image.file)} alt={`参考图 ${image.index}`} /></a>
        <figcaption><b>参考图 {image.index}</b><p>{image.purpose || '未填写用途说明'}</p></figcaption>
      </figure>) : <p>本页未使用参考图。</p>}</div>
    </section>
    <GenerationDetailsPanel details={preview.generation} />
  </div>;
}

export default function WorkbenchPageEditor({
  projectId,
  page,
  characters: directoryCharacters,
  scenes: directoryScenes = [],
  breadcrumb = [],
  pageOrder,
  busy = false,
  canvas = "3:4",
  letteringStyle,
  letteringItems = [],
  letteringTarget, desktopActionsTarget,
  fullscreenLetteringTarget,
  flowPreview,
  flowPreviewError = "",
  rewriteValue = null,
  rewriteLoading = false,
  rewriteRunning = false,
  rewriteProgress = null,
  rewriteError = "",
  promptSource = "original",
  onPromptSourceChange,
  onRewrite,
  onSavePage,
  onReloadContent,
  onReloadPrompt,
  onPageSaved,
  onPromptDraftChange,
  onDirtyChange,
  onOpenPromptOverview,
  onOpenLetteringSettings,
  editorTab,
  onEditorTabChange,
  saveAllRef,
  discardAllRef,
  onGenerate,
  generationCount = 3,
  onGenerationCountChange,
  generationDisabled = false,
  generationDisabledReason = "",
  generationProblems = [],
}: WorkbenchPageEditorProps) {
  const pageIdentity = `${page.page_id}:${page.model_id}:${page.render_sha256??''}`;
  const isTextPage = page.page_kind === "text";
  const [textOverflow, setTextOverflow] = useState(false);
  const activeIdentity = useRef(pageIdentity);
  activeIdentity.current = pageIdentity;
  const savingPage = useRef<{ identity: string } | null>(null);
  const editBaseline = useRef(page);
  const hasDraft = useRef(false);
  const [externalConflict, setExternalConflict] = useState(false);
  const incomingContent = useMemo(() => contentFromPage(page), [page.characters, page.dialogue, page.kind, page.title, page.visual_goal, page.scene_description, page.page_kind, page.body, page.display_title, page.text_layout]);
  const incomingContentSignature = JSON.stringify(incomingContent);
  const [contentBaseline, setContentBaseline] = useState(incomingContent);
  const [contentDraft, setContentDraft] = useState(incomingContent);
  const [dialogueDraft, setDialogueDraft] = useState(() => editableDialogue(incomingContent.dialogue));
  const [contentPhase, setContentPhase] = useState<SavePhase>("saved");
  const [contentError, setContentError] = useState("");

  const incomingPrompt = useMemo(() => clone(page.prompt), [page.prompt_sha256,page.model_id]);
  const [promptBaseline, setPromptBaseline] = useState(incomingPrompt);
  const [promptDraft, setPromptDraft] = useState(incomingPrompt);
  const [promptDiscardCount, setPromptDiscardCount] = useState(0);
  const references = useReferencedSettings(projectId, page.page_id, directoryCharacters, directoryScenes, promptDraft.composition === 'standalone' ? [] : (contentDraft.characters ?? []).map(ref=>ref.character_id), promptDraft.composition === 'standalone' ? undefined : promptDraft.scene_id);
  const {characters, scenes} = references;
  const incomingSourceVersions = readPromptSourceVersions(page.model_id, characters, scenes);
  const sourceVersions = useRef(incomingSourceVersions);
  const persistedPrompt = promptDraft;
  const [promptPhase, setPromptPhase] = useState<SavePhase>("saved");
  const [promptError, setPromptError] = useState("");
  const [promptWarningsOpen, setPromptWarningsOpen] = useState(false);
  const [generationProblemsOpen, setGenerationProblemsOpen] = useState(false);

  const incomingLayoutSignature = JSON.stringify(letteringItems);
  const [layoutBaseline, setLayoutBaseline] = useState(() => clone(letteringItems));
  const [layoutDraft, setLayoutDraft] = useState(() => clone(letteringItems));
  const [localTab, setLocalTab] = useState<EditorTab>("visual");
  const activeTab = editorTab ?? localTab;
  const setActiveTab = (tab: EditorTab) => { setLocalTab(tab); onEditorTabChange?.(tab); };
  const [selectedDraftKey, setSelectedDraftKey] = useState("");
  const [letteringDiagnostics, setLetteringDiagnostics] = useState<Record<string, LetteringIssue[]>>({});

  useEffect(() => {
    if (savingPage.current?.identity === pageIdentity) return;
    if (editBaseline.current.page_id === page.page_id && editBaseline.current.model_id === page.model_id && hasDraft.current) {
      const changed = editBaseline.current.content_sha256 !== page.content_sha256 || editBaseline.current.prompt_sha256 !== page.prompt_sha256 || editBaseline.current.prompt_context_sha256 !== page.prompt_context_sha256 || !sameJson(layoutBaseline, letteringItems);
      setExternalConflict(changed);
      // 其他页保存布局只改变全文件指纹，当前页布局未变时可继续使用新指纹。
      if (sameJson(layoutBaseline, letteringItems)) editBaseline.current = { ...editBaseline.current, layout_sha256: page.layout_sha256 };
      return;
    }
    editBaseline.current = page;
    sourceVersions.current = incomingSourceVersions;
    setExternalConflict(false);
    setContentBaseline(clone(incomingContent)); setContentDraft(clone(incomingContent)); setDialogueDraft(editableDialogue(incomingContent.dialogue));
    setPromptBaseline(clone(incomingPrompt)); setPromptDraft(clone(incomingPrompt));
    setLayoutBaseline(clone(letteringItems)); setLayoutDraft(clone(letteringItems));
    setContentPhase('saved'); setPromptPhase('saved'); setContentError(''); setPromptError('');
  }, [pageIdentity, incomingContentSignature, page.content_sha256, page.prompt_sha256, page.prompt_context_sha256, page.layout_sha256, incomingLayoutSignature]);
  useEffect(() => {
    // 脏草稿保留已读来源的版本；新载入的来源才补入，不能在保存时刷新读据。
    sourceVersions.current = hasDraft.current ? {...incomingSourceVersions, ...sourceVersions.current} : incomingSourceVersions;
  }, [characters, scenes, pageIdentity]);
  useEffect(() => {
    setSelectedDraftKey("");
    setLetteringDiagnostics({});
  }, [pageIdentity]);
  const visibleTab: EditorTab = activeTab;
  useEffect(() => { onPromptDraftChange?.(persistedPrompt); }, [onPromptDraftChange, persistedPrompt]);

  const contentToSave: WorkbenchPageContentDraft = {
    ...contentDraft,
    dialogue: persistedDialogue(dialogueDraft),
  };
  const contentDirty = !sameJson(contentToSave, contentBaseline);
  const sceneDescriptionLength = countStoryCharacters(contentDraft.scene_description);
  const sceneDescriptionWarning = storyContentWarnings(contentDraft).find((warning) => warning.field === "scene_description");
  const promptDirty = !sameJson(promptDraft, promptBaseline);
  const previewDialogue = useMemo(() => dialogueDraft.map(line => ({ ...line, id: dialogueKey(line) })), [dialogueDraft]);
  const previewItems = useMemo(() => letteringStyle ? previewLetteringItems(previewDialogue, layoutDraft, letteringStyle) : layoutDraft, [previewDialogue, layoutDraft, letteringStyle]);
  const layoutDirty = !sameJson(layoutDraft, layoutBaseline);
  hasDraft.current = contentDirty || promptDirty || layoutDirty;
  useEffect(() => { onDirtyChange?.(contentDirty || promptDirty || layoutDirty || contentPhase === "error"); }, [contentDirty, layoutDirty, onDirtyChange, promptDirty, contentPhase]);
  const selectedDialogueId = previewDialogue.find((line) => line.draftKey === selectedDraftKey)?.id ?? "";
  const promptAuditErrors = !promptDirty && flowPreview?.audit.status === "complete" ? flowPreview.audit.errors : [];
  const promptAuditWarnings = flowPreview?.audit.status === "complete" ? flowPreview.audit.warnings : [];

  async function reloadAll() {
    discardAll();
    hasDraft.current = false;
    await onReloadContent?.();
  }

  async function saveAll(): Promise<boolean> {
    if (references.pending) { setContentError(references.error || '正在读取新引用的设定，请稍后保存。'); return false; }
    if (savingPage.current || (!contentDirty && !layoutDirty && !promptDirty)) return !savingPage.current;
    const run = { identity: pageIdentity };
    savingPage.current = run;
    const isActive = () => savingPage.current === run && activeIdentity.current === pageIdentity;
    setContentPhase('saving'); setPromptPhase('saving'); setContentError(''); setPromptError('');
    const snapshot = { ...clone(contentToSave), dialogue: dialogueDraft.map(line => ({ ...persistedDialogue([line])[0], id: dialogueKey(line) })) };
    try {
      const saved = await onSavePage(snapshot, persistedPrompt, clone(previewItems), editBaseline.current, sourceVersions.current);
      if (isActive()) {
        const content = contentFromPage({ ...page, ...saved.content });
        editBaseline.current = saved.page; setExternalConflict(false);
        sourceVersions.current = incomingSourceVersions;
        setContentBaseline(clone(content)); setContentDraft(clone(content)); setDialogueDraft(editableDialogue(content.dialogue));
        setPromptDraft(clone(saved.prompt)); setPromptBaseline(clone(saved.prompt));
        setLayoutDraft(clone(saved.items)); setLayoutBaseline(clone(saved.items));
        setSelectedDraftKey(''); setContentPhase('saved'); setPromptPhase('saved'); onPageSaved?.();
      }
      return true;
    } catch (error) {
      if (isActive()) { setContentPhase('error'); setPromptPhase('error'); setContentError(`保存未完成，草稿已保留：${error instanceof Error ? error.message : String(error)}`); }
      return false;
    } finally { if (savingPage.current === run) savingPage.current = null; }
  }
  useEffect(() => {
    if (!saveAllRef) return;
    saveAllRef.current = saveAll;
    return () => { saveAllRef.current = null; };
  });

  function discardAll() {
    // 明确放弃时重建编辑区，清除词条撤销历史及尚未提交的输入。
    setPromptDiscardCount(count => count + 1);
    references.reset();
    editBaseline.current = page; setExternalConflict(false);
    sourceVersions.current = incomingSourceVersions;
    setContentDraft(clone(incomingContent)); setContentBaseline(clone(incomingContent)); setDialogueDraft(editableDialogue(incomingContent.dialogue));
    setPromptDraft(clone(incomingPrompt)); setPromptBaseline(clone(incomingPrompt));
    setLayoutDraft(clone(letteringItems)); setLayoutBaseline(clone(letteringItems));
    setSelectedDraftKey(''); setContentPhase('saved'); setPromptPhase('saved'); setContentError(''); setPromptError('');
  }
  useEffect(() => {
    if (!discardAllRef) return;
    discardAllRef.current = discardAll;
    return () => { discardAllRef.current = null; };
  });

  const anyDirty = contentDirty || promptDirty || layoutDirty;
  const saveNeeded = anyDirty || contentPhase === "error" || promptPhase === "error";
  const saving = contentPhase === "saving" || promptPhase === "saving";
  const rewritePhases={preparing:'准备中',queued:'排队中',running:'执行中',loading:'加载模型／准备优化',generating:'优化中',saving:'保存结果',completed:'已完成',failed:'失败'};
  const rewriteSeconds=Math.floor((rewriteProgress?.elapsed_ms??0)/1000);
  const runningStatus=rewriteProgress?`${rewritePhases[rewriteProgress.phase]}${rewriteProgress.tokens?` · ${rewriteProgress.tokens} token`:''} · ${Math.floor(rewriteSeconds/60)}分${rewriteSeconds%60}秒`:'正在提交…';
  const rewriteStatus = rewriteRunning ? runningStatus : rewriteError ? "失败" : rewriteLoading ? "读取中" : anyDirty ? "待保存" : rewriteValue?.status === "current" ? "当前" : rewriteValue?.status === "stale" ? "已过期" : "未生成";
  const canChooseRewrite = !anyDirty && !rewriteLoading && Boolean(rewriteValue?.rewrite);

  function pruneOverrideSources(keep: (source: string) => boolean) {
    setPromptDraft(current => ({
      ...current,
      ...(current.text_overrides ? {text_overrides: Object.fromEntries(Object.entries(current.text_overrides).filter(([key]) => keep(key)))} : {}),
      ...(current.reference_overrides ? {reference_overrides: Object.fromEntries(Object.entries(current.reference_overrides).filter(([key]) => keep(key)))} : {}),
      ...(current.inheritance?{inheritance: Object.fromEntries(Object.entries(current.inheritance).filter(([key]) => keep(key)))}:{}),
    }));
  }
  function changeCharacters(value: Array<{ character_id: string; variant_id: string }>) {
    const keep = new Set(value.map(r => characterSource(r.character_id, r.variant_id)));
    pruneOverrideSources(key => !key.startsWith('character:') || keep.has(key));
    setContentDraft(current => ({ ...current, characters: value }));
  }

  const [generationSettingsTarget,setGenerationSettingsTarget]=useState<HTMLDivElement|null>(null);
  const [desktopSettings,setDesktopSettings]=useState(()=>window.matchMedia('(min-width: 1161px)').matches);
  useEffect(()=>{const query=window.matchMedia('(min-width: 1161px)');const update=()=>setDesktopSettings(query.matches);query.addEventListener('change',update);return ()=>query.removeEventListener('change',update);},[]);
  const generationSettings=<PageGenerationSettings compact={desktopSettings} projectId={projectId} page={page} disabled={busy||saving} beforeChange={saveAll} onSaved={()=>onReloadPrompt?.()}/>;
  const pageActions=<span className="workbench-page-editor__dock-actions">
          <button type="button" className="button button--quiet" disabled={busy || saving || !saveNeeded} title="放弃本页全部未保存修改" onClick={discardAll}>放弃修改</button>
          <button type="button" className="button button--primary" disabled={busy || saving || !saveNeeded} title="保存本页全部修改（Ctrl+S）" onClick={() => void saveAll()}>{saving ? "保存中…" : "保存"}</button>
          {generationProblems.length > 0 && <button type="button" className="issue-indicator issue-indicator--error" aria-label={`查看 ${generationProblems.length} 个生成问题`} title="查看生成问题" onClick={() => setGenerationProblemsOpen(true)}>!</button>}
          {onGenerate && <GenerateSplitButton dirty={anyDirty} count={generationCount} disabled={generationDisabled || saving} reason={generationDisabledReason} menuDirection="down" onSubmit={() => void onGenerate({ count: generationCount })} onCountChange={onGenerationCountChange} />}
        </span>;
  return <section className="document-editor workbench-page-editor" data-page-content-dirty={contentDirty ? "true" : undefined} data-page-prompt-dirty={promptDirty ? "true" : undefined} data-lettering-dirty={layoutDirty ? "true" : undefined}>
    {desktopActionsTarget&&createPortal(pageActions,desktopActionsTarget)}
    <fieldset className="page-save-fields" inert={contentPhase === "saving"} disabled={contentPhase === "saving"}>
    <WorkspaceHeader breadcrumb={breadcrumb} className="story-toolbar" title={<span className="page-title-editor">
        {pageOrder !== undefined && <span className="page-order" aria-label={`第 ${pageOrder} 页`}>{String(pageOrder).padStart(2, "0")}</span>}
        <><InlineTitleEditor label="重命名页面" value={contentDraft.title} disabled={busy} onChange={(title) => setContentDraft(current => ({ ...current, title }))} /></>
      </span>} actions={<div className="workbench-page-editor__actions">
        {contentPhase === "error" && <button type="button" className="button button--quiet" onClick={() => void reloadAll()}>放弃本页草稿并重新载入</button>}
        <div ref={setGenerationSettingsTarget} className="page-title-generation-settings"/>
        {!desktopActionsTarget&&pageActions}
      </div>} />
    {externalConflict && <p role="alert">页面事实已变化，当前草稿已保留。<button type="button" className="button button--quiet" onClick={discardAll}>放弃草稿并载入最新</button></p>}
    {contentError && <p className="prompt-save-error" role="alert">{contentError}</p>}

    <div className="page-storyboard-fields">
      {isTextPage
        ? <><TextPageEditor value={contentDraft} disabled={busy || saving} onChange={patch => setContentDraft(current => ({ ...current, ...patch }))} />{textOverflow && <p className="prompt-save-error" role="alert">文字超出画布，请缩小字号或减少内容后再输出。</p>}</>
        : <>
        <label><span>画面内容<small className={sceneDescriptionWarning ? "is-over-limit" : undefined} aria-live="polite">{sceneDescriptionLength} / {SCENE_DESCRIPTION_CHARACTER_LIMIT} 字</small></span><textarea className="page-scene-description" rows={1} aria-label="画面内容" placeholder="简单描述谁在做什么，20 字以内" value={contentDraft.scene_description} onChange={(event) => setContentDraft((current) => ({ ...current, scene_description: event.target.value }))} />{sceneDescriptionWarning && <small className="is-over-limit" role="status">{sceneDescriptionWarning.message}</small>}</label>
      </>}
    </div>

    {desktopSettings&&generationSettingsTarget?createPortal(generationSettings,generationSettingsTarget):generationSettings}
    {!isTextPage && <div className="editor-mode-tabs" role="tablist" aria-label="页面编辑内容">
      <button role="tab" aria-selected={visibleTab === "visual"} className={visibleTab === "visual" ? "is-active" : ""} onClick={() => setActiveTab("visual")}>视觉描述 / Prompt{promptDirty && <i />}</button>
      {<button role="tab" aria-selected={visibleTab === "lettering"} className={visibleTab === "lettering" ? "is-active" : ""} onClick={() => setActiveTab("lettering")}>嵌字{layoutDirty && <i />}</button>}
      <button role="tab" aria-selected={visibleTab === "flow"} className={visibleTab === "flow" ? "is-active" : ""} onClick={() => setActiveTab("flow")}>生成详情</button>
    </div>}

    {(visibleTab === "lettering" || isTextPage) && onOpenLetteringSettings && <button type="button" className="button button--quiet lettering-settings-link" onClick={onOpenLetteringSettings}>项目嵌字样式 ↗</button>}
    {!isTextPage && visibleTab === "visual" && <section className="current-workbench-prompts character-prompt-editor">

      {promptError && <p className="prompt-save-error" role="alert">{promptError}</p>}
      {promptAuditErrors.length > 0 && <PromptIssueList issues={promptAuditErrors} title="Prompt 错误" />}
      {references.pending && <p role={references.error ? 'alert' : 'status'}>{references.error || '正在读取引用设定…'}{references.error && <button type="button" onClick={references.retry}>重试</button>}</p>}
      <ModelPromptEditor key={promptDiscardCount} header={<SectionHeader title="Prompt" actions={<div className="prompt-save-actions">{promptPhase === "error" && <button type="button" className="button button--quiet" onClick={() => void reloadAll()}>放弃本页草稿并重新载入</button>}{promptAuditWarnings.length > 0 && <button type="button" className="issue-indicator issue-indicator--warning" aria-label={`查看 ${promptAuditWarnings.length} 条 Prompt 警告`} title="查看 Prompt 警告" onClick={() => setPromptWarningsOpen(true)}>!</button>}</div>} />} projectId={projectId} page={page} prompt={promptDraft} onChange={setPromptDraft} characters={characters} scenes={scenes} references={contentDraft.characters??[]} onReferencesChange={changeCharacters} disabled={busy||saving} onOpenOverview={onOpenPromptOverview} rewrite={<>{onRewrite && <div className="page-rewrite" aria-label="最终 Prompt 优化">
        <div className="page-rewrite__toolbar">
          <label className="page-rewrite__choice"><input type="checkbox" checked={promptSource === "rewrite"} disabled={promptSource !== "rewrite" && !canChooseRewrite} onChange={(event) => onPromptSourceChange?.(event.target.checked ? "rewrite" : "original")} />使用优化结果</label>
          <span className="page-rewrite__status" role="status">状态：{rewriteStatus}</span>
          <button type="button" className="button button--quiet" disabled={busy || saving || anyDirty || rewriteRunning} onClick={onRewrite}>{rewriteRunning ? "优化中…" : "优化"}</button>
        </div>
        {anyDirty && <p className="page-rewrite__hint">请先保存本页修改，再运行优化或使用已有结果。</p>}
        {rewriteError && <p className="prompt-save-error" role="alert">优化失败：{rewriteError}</p>}
        <details key={`${pageIdentity}:rewrite`} className="page-rewrite__details"><summary>优化文本</summary><div className="page-rewrite__body">{rewriteValue?.rewrite ? <><pre>{rewriteValue.rewrite.rewritten_prompt}</pre><small>建议画幅：{rewriteValue.rewrite.wh_ratio}（不改变本页画幅）</small></> : <p>尚无优化结果。</p>}</div></details>
        <details key={`${pageIdentity}:original`} className="page-rewrite__details"><summary>原文</summary><div className="page-rewrite__body"><pre>{rewriteValue?.original_prompt || "当前最终合成 Prompt 尚未载入。"}</pre></div></details>
      </div>}</>}/>
    </section>}

    {!isTextPage && visibleTab === "lettering" && letteringStyle && <>
      <LetteringEditor dialogue={dialogueDraft} items={previewItems} characters={characters} style={letteringStyle} diagnostics={letteringDiagnostics} hasImage={Boolean(letteringTarget)} projectId={projectId} pageId={page.page_id} selectedDraftKey={selectedDraftKey} onSelectedDraftKeyChange={setSelectedDraftKey} onDialogueChange={setDialogueDraft} onItemsChange={setLayoutDraft} />
      <p className="workbench-lettering-note">{letteringTarget ? "在右侧拖动文字；普通文字调整框宽，爱心可独立缩放、旋转；旁白固定在画面底部。文案与布局一起保存。" : "文案可先编辑；有候选图后自动显示嵌字。"}</p>

    </>}
    {!isTextPage && visibleTab === "lettering" && !letteringStyle && <div className="workbench-flow-placeholder"><b>嵌字样式不可用</b><p>项目嵌字样式接入后即可编辑布局。</p></div>}
    {isTextPage && letteringTarget && letteringStyle && createPortal(
      <TextPageArtwork title={contentDraft.display_title ?? ""} body={contentDraft.body ?? ""} layout={contentDraft.text_layout} style={letteringStyle} onOverflow={setTextOverflow} />,
      letteringTarget)}
    {!isTextPage && letteringTarget && letteringStyle && createPortal(<>
      <WorkbenchLetteringOverlay dialogue={previewDialogue} items={previewItems} characters={characters} style={letteringStyle} canvas={canvas}
        interactive={!busy && contentPhase !== "saving"} selectedId={selectedDialogueId}
        onSelect={(id) => setSelectedDraftKey(previewDialogue.find((line) => line.id === id)?.draftKey ?? "")}
        onChange={(item) => setLayoutDraft(previewItems.map((candidate) => candidate.dialogue_id === item.dialogue_id ? item : candidate))}
        onDiagnosticsChange={setLetteringDiagnostics} />
      {layoutDirty && <span className="lettering-unsaved-hint">布局未保存 · 点击「保存」</span>}
    </>, letteringTarget)}
    {!isTextPage && fullscreenLetteringTarget && letteringStyle && createPortal(
      <WorkbenchLetteringOverlay dialogue={previewDialogue} items={previewItems} characters={characters} style={letteringStyle} canvas={fullscreenLetteringTarget.canvas} />,
      fullscreenLetteringTarget.element)}
    {!isTextPage && visibleTab === "flow" && <FlowPreviewPanel projectId={projectId} preview={flowPreview} error={flowPreviewError} />}
    {promptWarningsOpen && <Modal title="Prompt 警告" subtitle={`${promptAuditWarnings.length} 条`} onClose={() => setPromptWarningsOpen(false)} ariaLabel="Prompt 警告"><div className="issue-dialog-body"><PromptIssueList issues={promptAuditWarnings} tone="warning" /></div></Modal>}
    {generationProblemsOpen && <Modal title="无法生成" subtitle={`${generationProblems.length} 个问题`} onClose={() => setGenerationProblemsOpen(false)} ariaLabel="生成问题"><div className="issue-dialog-body"><PromptIssueList issues={generationProblems} /></div></Modal>}
    </fieldset>
  </section>;
}
