import { floatingLayerHost, useFloatingLayer } from "./floating-layer";
import { promptWeightPresets } from "../shared/prompt-weight-presets.mjs";
import { FloatingPanel } from "./FloatingPanel";
import { InlinePromptInput, type InlinePromptHandle } from "./InlinePromptInput";
import { useDismissableLayer } from "./use-dismissable-layer";
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { activePromptDictionarySuggestion, canSearchPromptDictionary, inferUserPromptType, mergePromptDictionarySuggestions, shouldOpenPromptDictionarySearch } from "./prompt-fragment-input";
import { type PromptDictionaryMatch, usePromptDictionaryMatches } from "./prompt-display";
import { type CameraSettings } from "../shared/camera-prompt.mjs";
import { promptTagMarkerErrors, promptCompletionSpan } from "../shared/prompt-tags.mjs";
import { placePromptSuggestions } from "./prompt-suggestion-placement";
import "./prompt-dictionary-details.css";
import "./prompt-compact.css";



export type PromptType = "danbooru" | "custom_description";

export type PromptFragment = {
  id: string;
  /** 草稿定位信息；不会随本页内容持久化。 */
  source_index?: number;
  inheritance_key?: string;
  inheritance_source?: string;
  inheritance?: { weight?: number; enabled?: boolean };
  prompt_type: PromptType;
  prompt_text: string;
  camera_settings?: CameraSettings;
  weight?: number;
  role?: string;
  /** 缺省为启用；关闭时仅持久化 false，便于保留草稿和顺序。 */
  enabled?: boolean;
};

export type PromptAuditIssue = {
  severity?: "error" | "warning";
  code?: string;
  message?: string;
  details?: string;
  fragment_id?: string;
  token_id?: string;
  source_id?: string;
  prompt_text?: string;
  category?: string;
  scope?: string;
  index?: number;
  path?: string;
};

export type PromptDictionarySuggestion = {
  display_text: string;
  prompt_text: string;
  source_text?: string;
  provider_type?: string;
  post_count?: number;
  category?: string | number;
  categories?: string[];
  keywords?: string[];
  aliases?: string[];
  description?: string;
  original_description?: string;
  description_language?: "zh" | "original";
  other_names?: string[];
};

function hasDictionaryDetails(entry: PromptDictionaryMatch | undefined): entry is PromptDictionaryMatch {
  return Boolean(entry?.source_text);
}

function PromptDictionaryDetailsDialog({ entry, onClose }: { entry: PromptDictionaryMatch; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const sourceTag = entry.source_text || entry.prompt_text.replaceAll(" ", "_");
  const sourcePath = /^\d+$/.test(sourceTag) ? `~${sourceTag}` : sourceTag;
  const originalDescription = entry.original_description;
  const frequency = frequencyLabel(entry.post_count);
  const providerLabels: Record<string, string> = { "0": "通用标签", "1": "画师", "3": "作品", "4": "角色", "5": "元信息" };
  const chips = (values: string[] | undefined) => values?.length
    ? <span className="prompt-dictionary-detail-chips">{values.map((value) => <span key={value}>{value}</span>)}</span>
    : <span className="prompt-dictionary-detail-empty">暂无</span>;
  return createPortal(<dialog className="prompt-dictionary-details" ref={dialogRef} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="prompt-dictionary-details-header">
      <div><h2 id={titleId}>{entry.display_text || entry.prompt_text}</h2><code>{sourceTag}</code></div>
      <button type="button" onClick={onClose} aria-label="关闭词条说明">×</button>
    </header>
    <div className="prompt-dictionary-details-content">
      <dl className="prompt-dictionary-detail-facts">
        <dt>使用频率</dt><dd>{frequency ? `${frequency.label} · ${entry.post_count!.toLocaleString("zh-CN")} 次使用` : "暂无数据"}</dd>
        <dt>标签类型</dt><dd>{providerLabels[entry.provider_type ?? ""] ?? "暂无"}</dd>
        <dt>分类</dt><dd>{chips(entry.categories?.map((id) => categoryShortLabels[id] ?? id))}</dd>
        <dt>关键词</dt><dd>{chips(entry.keywords)}</dd>
        <dt>标签别名</dt><dd>{chips(entry.aliases)}</dd>
        <dt>其他名称</dt><dd>{chips(entry.other_names)}</dd>
        <dt>来源</dt><dd><a href={`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(sourcePath)}`} target="_blank" rel="noreferrer">Danbooru Wiki ↗</a></dd>
      </dl>
      {entry.description_language === "zh" && entry.description && <section className="prompt-dictionary-description-section">
        <h3>中文说明</h3><div className="prompt-dictionary-description-body">{entry.description}</div>
      </section>}
      <section className="prompt-dictionary-description-section prompt-dictionary-original-section">
        <h3>原文说明</h3>{originalDescription
          ? <div className="prompt-dictionary-description-body" lang="en">{originalDescription}</div>
          : <p className="prompt-dictionary-detail-empty">暂无原文说明。</p>}
      </section>
    </div>
  </dialog>, document.body);
}

export function withPromptType(fragment: PromptFragment, promptType: PromptType) {
  return { ...fragment, prompt_type: promptType };
}

export type PromptDictionaryScope = "page" | "character" | "render_profile";

type PromptDictionarySearchState = "idle" | "loading" | "results" | "empty" | "unavailable" | "error";
type PromptDictionaryPagingState = "idle" | "loading" | "error";

type PromptRoleOption = { id: string; label: string; color?: string };

export type PromptEditMetadata = {
  group?: string;
  continueGroup?: boolean;
};

const promptHistoryLimit = 100;
const promptTypingGroupMilliseconds = 1000;
const promptDictionaryPageSize = 24;
const promptDictionaryScrollThreshold = 56;
type PromptDictionaryPanelPlacement = NonNullable<ReturnType<typeof placePromptSuggestions>>;

function clonePromptValue<T>(value: T): T {
  return structuredClone(value);
}

export function usePromptUndoHistory<T>({ value, scopeKey, onChange }: {
  value: T;
  scopeKey: string;
  onChange: (value: T) => void;
}) {
  const current = useRef(value);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastEdit = useRef<{ group: string; at: number } | null>(null);

  current.current = value;

  useEffect(() => {
    past.current = [];
    future.current = [];
    lastEdit.current = null;
    current.current = value;
  }, [scopeKey]);

  function apply(next: T, metadata: PromptEditMetadata = {}) {
    const now = Date.now();
    const previousEdit = lastEdit.current;
    const grouped = Boolean(metadata.group)
      && previousEdit !== null
      && previousEdit.group === metadata.group
      && (metadata.continueGroup || now - previousEdit.at <= promptTypingGroupMilliseconds);
    if (!grouped) {
      past.current.push(clonePromptValue(current.current));
      if (past.current.length > promptHistoryLimit) past.current.shift();
    }
    future.current = [];
    lastEdit.current = metadata.group ? { group: metadata.group, at: now } : null;
    current.current = next;
    onChange(next);
  }

  function undo() {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(clonePromptValue(current.current));
    current.current = previous;
    lastEdit.current = null;
    onChange(previous);
  }

  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(clonePromptValue(current.current));
    current.current = next;
    lastEdit.current = null;
    onChange(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      redo();
    }
  }

  return { apply, onKeyDown };
}

export const promptTypeLabels: Record<PromptType, string> = {
  danbooru: "Danbooru 标签",
  custom_description: "描述",
};

export const promptTypeShortLabels: Record<PromptType, string> = {
  danbooru: "标签",
  custom_description: "描述",
};

const categoryShortLabels: Record<string, string> = { population: "人数", person: "人物", appearance: "外观", action: "动作",  setting: "场景", camera: "镜头", avoid: "避免", identity: "身份", hair: "发型", face: "面部", body: "身体", clothing: "服装", accessories: "配饰", equipment: "装备" };

function frequencyLabel(postCount: number | null | undefined) {
  if (!Number.isFinite(postCount)) return null;
  if ((postCount ?? 0) >= 1000) return { label: "常用", tone: "common" };
  if ((postCount ?? 0) >= 100) return { label: "低频", tone: "low" };
  return { label: "稀有", tone: "rare" };
}

function compactLabel(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  return Array.from(words[0] ?? "?").slice(0, 2).join("");
}

function promptFragmentEnabled(fragment: PromptFragment) {
  return fragment.enabled !== false;
}

function promptWeightLabel(weight: number | undefined) {
  const value = Number.isFinite(weight) ? weight as number : 1;
  return `×${value.toFixed(1)}`;
}

function promptWeightDraft(weight: number | undefined) {
  return Number.isFinite(weight) ? String(weight) : "1.0";
}

function issueText(issue: PromptAuditIssue) {
  return issue.message?.trim() || issue.details?.trim() || issue.code?.trim() || "Prompt 需要检查";
}

function issueBelongsToFragment(issue: PromptAuditIssue, fragment: PromptFragment, categoryId: string) {
  const issueId = issue.fragment_id ?? issue.token_id ?? issue.source_id;
  if (issueId) return issueId === fragment.id;
  if (issue.category && issue.category !== categoryId) return false;
  if (issue.index !== undefined) return issue.index === fragment.source_index;
  return Boolean(issue.path?.includes(fragment.id));
}

function PromptFragmentRow({
  categoryId,
  categoryLabel,
  scope,
  fragment,
  dictionaryMatch,
  dictionaryMatches = {},
  index,
  roles,
  issues,
  dragPosition,
  toggleOnly = false,
  upstreamWeight,
  upstreamEnabled,
  onChange,
  onDelete,
  onDragStart,
}: {
  categoryId: string;
  categoryLabel: string;
  scope: PromptDictionaryScope;
  fragment: PromptFragment;
  dictionaryMatch?: PromptDictionaryMatch;
  dictionaryMatches?: Record<string, PromptDictionaryMatch>;
  index: number;
  roles?: PromptRoleOption[];
  issues: PromptAuditIssue[];
  dragPosition?: "source" | "before" | "after";
  /** 仅启用开关可交互，文本、类型、权重、拖拽与删除均只读（用于身份继承区域）。 */
  toggleOnly?: boolean;
  upstreamWeight?: number;
  upstreamEnabled?: boolean;
  onChange: (fragment: PromptFragment, metadata?: PromptEditMetadata) => void;
  onDelete: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const listboxId = useId();
  const [queryFocused, setQueryFocused] = useState(false);
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [queryDraft, setQueryDraft] = useState(fragment.prompt_text ?? "");
  const queryDraftRef = useRef(queryDraft);
  queryDraftRef.current = queryDraft;
  const [queryCaret, setQueryCaret] = useState(fragment.prompt_text?.length ?? 0);
  const completion = promptCompletionSpan(queryDraft, queryCaret);
  // person 是外观+动作的合并编辑视图，不是词库分类；搜索时不带分类过滤，跨分类返回候选。
  const dictionaryCategory = (categoryId === "person" || categoryId === "population") ? null : categoryId;
  const draftMatches = usePromptDictionaryMatches(useMemo(() => [{ prompt_text: queryDraft, prompt_type: fragment.prompt_type }], [queryDraft, fragment.prompt_type]), scope);
  const currentMatches = useMemo(() => ({ ...dictionaryMatches, ...draftMatches }), [dictionaryMatches, draftMatches]);
  const [queryComposing, setQueryComposing] = useState(false);
  const [searchState, setSearchState] = useState<PromptDictionarySearchState>("idle");
  const [pagingState, setPagingState] = useState<PromptDictionaryPagingState>("idle");
  const [hasMoreSuggestions, setHasMoreSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<PromptDictionarySuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [detailEntry, setDetailEntry] = useState<PromptDictionaryMatch | null>(null);
  const dictionaryDetailsOpen = useRef(false);
  const [deferEmptyError, setDeferEmptyError] = useState(() => !fragment.prompt_text.trim());
  const [weightMenuOpen, setWeightMenuOpen] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia("(max-width: 680px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const update = () => { setMobileLayout(media.matches); setWeightMenuOpen(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [weightDraft, setWeightDraft] = useState(() => promptWeightDraft(fragment.weight));
  const [weightError, setWeightError] = useState("");
  // 触屏设备不自动聚焦权重输入框，避免虚拟键盘立即弹出挤压布局。
  const coarsePointer = useMemo(() => window.matchMedia("(pointer: coarse)").matches, []);
  const fragmentRef = useRef(fragment);
  const onChangeRef = useRef(onChange);
  const weightTriggerRef = useRef<HTMLButtonElement | null>(null);
  const weightMenuRef = useRef<HTMLDivElement | null>(null);
  useFloatingLayer(weightMenuRef, weightMenuOpen ? weightTriggerRef.current : null);
  const queryComposingRef = useRef(false);
  const searchRequestSerial = useRef(0);
  const pagingRequestSerial = useRef(0);
  const searchSessionRef = useRef<{ id: number; query: string; category: string | null; scope: PromptDictionaryScope; controller: AbortController; nextOffset: number } | null>(null);
  const pagingLoadingRef = useRef(false);
  const inferenceRequestSerial = useRef(0);
  const inferenceAbortController = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const suggestionsRef = useRef<HTMLDivElement | null>(null);
  const promptFieldRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<InlinePromptHandle | null>(null);
  const [suggestionPlacement, setSuggestionPlacement] = useState<PromptDictionaryPanelPlacement | null>(null);
  fragmentRef.current = fragment;
  onChangeRef.current = onChange;
  const fragmentIssues = useMemo(
    () => issues.filter((issue) => issueBelongsToFragment(issue, fragment, categoryId)),
    [categoryId, fragment, issues],
  );
  const type = fragment.prompt_type ?? "danbooru";
  const isCameraFragment = Boolean(fragment.camera_settings);
  const promptTextMissing = !fragment.prompt_text.trim();
  const visibleFragmentIssues = fragmentIssues.filter((issue) =>
    issue.code !== "prompt.fragment.text_empty" || (promptTextMissing && !deferEmptyError),
  );
  const markerErrors = queryFocused || queryComposing ? [] : promptTagMarkerErrors(queryDraft, tag => currentMatches[tag] === undefined || currentMatches[tag].matched === true);
  const hasVisibleError = markerErrors.length > 0 || visibleFragmentIssues.some((issue) => issue.severity === "error");

  useEffect(() => {
    if (!promptTextMissing) setDeferEmptyError(false);
  }, [promptTextMissing]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      searchRequestSerial.current += 1;
      pagingRequestSerial.current += 1;
      searchSessionRef.current?.controller.abort();
      inferenceRequestSerial.current += 1;
      inferenceAbortController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const canonicalPrompt = fragment.prompt_text ?? "";
    if (!queryFocused || (!queryEnabled && !queryComposing)) setQueryDraft(canonicalPrompt);
  }, [fragment.prompt_text, queryComposing, queryEnabled, queryFocused]);

  useEffect(() => {
    if (!weightMenuOpen) setWeightDraft(promptWeightDraft(fragment.weight));
  }, [fragment.weight, weightMenuOpen]);

  useDismissableLayer({ open: weightMenuOpen, ref: weightMenuRef, triggerRef: weightTriggerRef, onClose: () => setWeightMenuOpen(false) });

  useEffect(() => {
    const query = completion.query;
    const requestId = ++searchRequestSerial.current;
    pagingRequestSerial.current += 1;
    searchSessionRef.current?.controller.abort();
    searchSessionRef.current = null;
    pagingLoadingRef.current = false;
    setPagingState("idle");
    setHasMoreSuggestions(false);
    if (!shouldOpenPromptDictionarySearch({ focused: queryFocused, enabled: queryEnabled, composing: queryComposing, query })) {
      setSuggestions([]);
      setActiveSuggestionIndex(-1);
      setSearchState("idle");
      return;
    }
    const controller = new AbortController();
    const session = { id: requestId, query, category: dictionaryCategory, scope, controller, nextOffset: 0 };
    searchSessionRef.current = session;
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setSearchState("loading");
    const timer = window.setTimeout(() => {
      void fetch(`/api/prompt-dictionary?q=${encodeURIComponent(query)}&limit=${promptDictionaryPageSize}&offset=0${dictionaryCategory ? `&category=${encodeURIComponent(dictionaryCategory)}` : ""}&scope=${encodeURIComponent(scope)}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`prompt_dictionary_${response.status}`);
          return await response.json() as { available?: boolean; suggestions?: PromptDictionarySuggestion[]; has_more?: boolean };
        })
        .then((payload) => {
          if (searchRequestSerial.current !== requestId || searchSessionRef.current !== session) return;
          if (payload.available === false) {
            setSuggestions([]);
            setActiveSuggestionIndex(-1);
            setHasMoreSuggestions(false);
            setSearchState("unavailable");
            return;
          }
          const next = payload.suggestions ?? [];
          const uniqueNext = mergePromptDictionarySuggestions<PromptDictionarySuggestion>([], next);
          session.nextOffset = next.length;
          setSuggestions(uniqueNext);
          setActiveSuggestionIndex(-1);
          setHasMoreSuggestions(Boolean(payload.has_more) && next.length > 0);
          setSearchState(uniqueNext.length > 0 ? "results" : "empty");
        })
        .catch(() => {
          if (controller.signal.aborted || searchRequestSerial.current !== requestId || searchSessionRef.current !== session) return;
          setSuggestions([]);
          setActiveSuggestionIndex(-1);
          setHasMoreSuggestions(false);
          setSearchState("error");
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (searchSessionRef.current === session) searchSessionRef.current = null;
    };
  }, [dictionaryCategory, queryComposing, completion.query, queryEnabled, queryFocused, scope]);

  useEffect(() => {
    const panel = suggestionsRef.current;
    const option = panel?.querySelector<HTMLElement>("[aria-selected='true']");
    if (!panel || !option) return;
    const panelRect = panel.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < panelRect.top) panel.scrollTop -= panelRect.top - optionRect.top;
    else if (optionRect.bottom > panelRect.bottom) panel.scrollTop += optionRect.bottom - panelRect.bottom;
  }, [activeSuggestionIndex]);

  async function inferPromptTypeAfterUserEdit(promptTextOverride?: string) {
    const requestId = ++inferenceRequestSerial.current;
    inferenceAbortController.current?.abort();
    const startingFragment = fragmentRef.current;
    const promptText = (promptTextOverride ?? startingFragment.prompt_text).trim();
    const startingPromptType = startingFragment.prompt_type;
    if (!promptText || startingPromptType === "custom_description") return;
    const controller = new AbortController();
    inferenceAbortController.current = controller;
    let payload: { available?: boolean; matches?: Array<{ prompt_text?: string; matched?: boolean; allowed?: boolean }> } | null = null;
    try {
      const response = await fetch("/api/prompt-dictionary/matches", {
        method: "POST",
        signal: controller.signal,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ prompts: [promptText], scope }),
      });
      payload = response.ok ? await response.json() : null;
    } catch {
      return;
    } finally {
      if (inferenceAbortController.current === controller) inferenceAbortController.current = null;
    }
    if (!payload?.available
      || !mountedRef.current
      || controller.signal.aborted
      || inferenceRequestSerial.current !== requestId
      || fragmentRef.current.prompt_text.trim() !== promptText
      || fragmentRef.current.prompt_type !== startingPromptType) return;
    const dictionaryMatch = payload.matches?.find((entry) => entry.prompt_text === promptText);
    const promptType: PromptType | null = inferUserPromptType(promptText, {
      dictionaryMatched: Boolean(dictionaryMatch?.matched),
      dictionaryAllowed: Boolean(dictionaryMatch?.allowed),
      scope,
      category: categoryId,
    });
    if (!promptType) return;
    if (fragmentRef.current.prompt_type === promptType) return;
    onChangeRef.current(withPromptType(fragmentRef.current, promptType), { group: `${fragment.id}:prompt_text`, continueGroup: true });
  }

  function openWeightMenu() {
    setWeightDraft(promptWeightDraft(fragmentRef.current.weight));
    setWeightError("");
    setWeightMenuOpen(true);
  }

  function toggleWeightMenu() {
    if (weightMenuOpen) setWeightMenuOpen(false);
    else openWeightMenu();
  }

  function commitWeight(preset?: number) {
    const raw = preset === undefined ? weightDraft.trim() : String(preset);
    const weight = Number(raw);
    if (!raw || !Number.isFinite(weight) || weight < 0.2 || weight > 10) {
      setWeightError("请输入 0.2 到 10 之间的数字");
      return;
    }
    const next = { ...fragmentRef.current };
    if (next.inheritance) {
      next.inheritance = { ...next.inheritance, weight };
      next.weight = weight;
    } else if (weight === 1) delete next.weight;
    else next.weight = weight;
    onChange(next, { group: `${next.id}:weight` });
    setWeightMenuOpen(false);
  }

  function restoreInheritance(field?: 'weight' | 'enabled') {
    const current = fragmentRef.current;
    if (!current.inheritance) return;
    const inheritance = { ...current.inheritance };
    if (field) delete inheritance[field];
    else { delete inheritance.weight; delete inheritance.enabled; }
    const next = { ...current, inheritance };
    if (!field || field === 'weight') next.weight = upstreamWeight;
    if (!field || field === 'enabled') next.enabled = upstreamEnabled;
    onChange(next);
    if (!field || field === 'weight') setWeightMenuOpen(false);
  }

  function loadMoreSuggestions() {
    const session = searchSessionRef.current;
    if (!session || searchState !== "results" || !hasMoreSuggestions || pagingLoadingRef.current || session.controller.signal.aborted) return;
    const offset = session.nextOffset;
    const pagingRequestId = ++pagingRequestSerial.current;
    pagingLoadingRef.current = true;
    setPagingState("loading");
    void fetch(`/api/prompt-dictionary?q=${encodeURIComponent(session.query)}&limit=${promptDictionaryPageSize}&offset=${offset}${session.category ? `&category=${encodeURIComponent(session.category)}` : ""}&scope=${encodeURIComponent(session.scope)}`, {
      signal: session.controller.signal,
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`prompt_dictionary_${response.status}`);
        return await response.json() as { available?: boolean; suggestions?: PromptDictionarySuggestion[]; has_more?: boolean };
      })
      .then((payload) => {
        if (searchSessionRef.current !== session || pagingRequestSerial.current !== pagingRequestId) return;
        if (payload.available === false) {
          setHasMoreSuggestions(false);
          setPagingState("error");
          return;
        }
        const incoming = payload.suggestions ?? [];
        session.nextOffset = offset + incoming.length;
        setSuggestions((current) => mergePromptDictionarySuggestions(current, incoming));
        setHasMoreSuggestions(Boolean(payload.has_more) && incoming.length > 0);
        setPagingState("idle");
      })
      .catch(() => {
        if (session.controller.signal.aborted || searchSessionRef.current !== session || pagingRequestSerial.current !== pagingRequestId) return;
        setPagingState("error");
      })
      .finally(() => {
        if (pagingRequestSerial.current === pagingRequestId) pagingLoadingRef.current = false;
      });
  }

  function handleSuggestionScroll(event: { currentTarget: HTMLDivElement }) {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= promptDictionaryScrollThreshold) loadMoreSuggestions();
  }

  function closeQuerySearch() {
    searchRequestSerial.current += 1;
    pagingRequestSerial.current += 1;
    searchSessionRef.current?.controller.abort();
    searchSessionRef.current = null;
    pagingLoadingRef.current = false;
    setQueryEnabled(false);
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setHasMoreSuggestions(false);
    setPagingState("idle");
    setSearchState("idle");
  }

  function commitQueryDraft() {
    const current = fragmentRef.current;
    if ((current.prompt_text ?? "") === queryDraft) return;
    const next = { ...current, prompt_text: queryDraft };
    fragmentRef.current = next;
    onChange(next, { group: `${current.id}:prompt_text` });
    // 只在提交真实文字编辑时识别类型；单纯聚焦/失焦不能改变既有标签或撤销历史。
    void inferPromptTypeAfterUserEdit(queryDraft);
  }

  function updateQueryDraft(value: string) {
    setActiveSuggestionIndex(-1);
    setQueryDraft(value);
    if (!queryComposingRef.current) setQueryEnabled(true);
  }

  function applySuggestion(suggestion: PromptDictionarySuggestion) {
    const replacement = suggestion.prompt_text + (completion.closeBrace ? "}" : "");
    const text = queryDraft.slice(0, completion.start) + replacement + queryDraft.slice(completion.end);
    const wholeTag = completion.start === 0 && completion.end === queryDraft.length;
    const next = withPromptType({ ...fragmentRef.current, prompt_text: text }, wholeTag ? "danbooru" : "custom_description");
    setQueryDraft(text);
    const caret = completion.start + replacement.length;
    setQueryCaret(caret);
    fragmentRef.current = next;
    onChange(next);
    closeQuerySearch();
    requestAnimationFrame(() => {
      // 浮层关闭后的迟到焦点恢复不能覆盖用户已经输入的新文本选区。
      if (queryDraftRef.current === text) promptInputRef.current?.setSelectionRange(caret, caret);
    });
  }

  function handleQueryKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || queryComposingRef.current;
    if (event.key === "Enter" && !event.shiftKey) {
      // 合成中的 Enter 也拦截默认行为：IME 未消费时浏览器会在 contentEditable 里插入换行。
      event.preventDefault();
      if (composing) return;
      const activeSuggestion = activePromptDictionarySuggestion(suggestions, activeSuggestionIndex);
      if (activeSuggestion) applySuggestion(activeSuggestion);
      else {
        commitQueryDraft();
        closeQuerySearch();
      }
      return;
    }
    if (composing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ["s", "g"].includes(event.key.toLowerCase())) {
      // 全局保存/生成快捷键不让输入框失焦（不会触发 blur 提交），这里随按键直接提交草稿。
      commitQueryDraft();
      return;
    }
    if (event.key === "F1") {
      const activeSuggestion = activePromptDictionarySuggestion(suggestions, activeSuggestionIndex);
      if (hasDictionaryDetails(activeSuggestion ?? undefined)) {
        event.preventDefault();
        openDictionaryDetails(activeSuggestion!);
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === "z"
      && queryDraft !== (fragmentRef.current.prompt_text ?? "")) {
      event.preventDefault();
      event.stopPropagation();
      setQueryDraft(fragmentRef.current.prompt_text ?? "");
      closeQuerySearch();
      return;
    }
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestionIndex((current) => current < 0 ? 0 : (current + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestionIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1);
      return;
    }
    if (event.key === "Escape" && (queryEnabled || queryDraft !== (fragmentRef.current.prompt_text ?? ""))) {
      event.preventDefault();
      setQueryDraft(fragmentRef.current.prompt_text ?? "");
      closeQuerySearch();
    }
  }

  const queryHasText = Boolean(queryDraft.trim());
  const queryCanSearch = canSearchPromptDictionary(completion.query);
  const queryPanelVisible = queryFocused && queryEnabled && !queryComposing && queryHasText;
  const queryResultsVisible = queryPanelVisible && queryCanSearch && searchState === "results";
  const queryStatusId = `${listboxId}-status`;
  const activeSuggestionId = activeSuggestionIndex >= 0 ? `${listboxId}-option-${activeSuggestionIndex}` : undefined;

  useEffect(() => {
    if (!queryPanelVisible) {
      setSuggestionPlacement(null);
      return;
    }
    let frame = 0;
    const updateSuggestionPlacement = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const anchor = promptFieldRef.current;
        if (!anchor) return;
        const viewport = window.visualViewport;
        setSuggestionPlacement(placePromptSuggestions(anchor.getBoundingClientRect(), {
          top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0,
          width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
        }));
      });
    };
    updateSuggestionPlacement();
    window.addEventListener("resize", updateSuggestionPlacement);
    window.addEventListener("scroll", updateSuggestionPlacement, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", updateSuggestionPlacement);
    viewport?.addEventListener("scroll", updateSuggestionPlacement);
    const observer = new ResizeObserver(updateSuggestionPlacement);
    if (promptFieldRef.current) observer.observe(promptFieldRef.current);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateSuggestionPlacement);
      window.removeEventListener("scroll", updateSuggestionPlacement, true);
      viewport?.removeEventListener("resize", updateSuggestionPlacement);
      viewport?.removeEventListener("scroll", updateSuggestionPlacement);
      observer.disconnect();
    };
  }, [queryPanelVisible]);

  const suggestionPanelStyle = suggestionPlacement ? {
    top: suggestionPlacement.top,
    left: suggestionPlacement.left,
    width: suggestionPlacement.width,
    maxHeight: suggestionPlacement.maxHeight,
    transform: suggestionPlacement.openAbove ? "translateY(-100%)" : undefined,
  } : undefined;
  function openDictionaryDetails(entry: PromptDictionaryMatch) {
    dictionaryDetailsOpen.current = true;
    setDetailEntry(entry);
  }
  const suggestionPanel = suggestionPlacement && queryResultsVisible
    ? createPortal(<FloatingPanel className="prompt-fragment-suggestions prompt-fragment-suggestions--portal" id={listboxId} role="listbox" aria-busy={pagingState === "loading"} ref={suggestionsRef} style={suggestionPanelStyle} onScroll={handleSuggestionScroll}>{suggestions.map((suggestion, suggestionIndex) => {
      const frequency = frequencyLabel(suggestion.post_count);
      const categoryBadges = (suggestion.categories ?? []).filter((id) => id !== categoryId).map((id) => categoryShortLabels[id] ?? id);
      return <div role="presentation" className={`prompt-dictionary-suggestion-row${suggestionIndex === activeSuggestionIndex ? " is-active" : ""}`} key={`${suggestion.source_text ?? ""}-${suggestion.prompt_text}-${suggestionIndex}`}>
        <button type="button" className="prompt-dictionary-suggestion-select" id={`${listboxId}-option-${suggestionIndex}`} role="option" aria-selected={suggestionIndex === activeSuggestionIndex} tabIndex={-1} onPointerDown={(event) => event.preventDefault()} onClick={() => applySuggestion(suggestion)}>
          <span><b>{suggestion.display_text || suggestion.source_text}</b><code>{suggestion.prompt_text}</code>{categoryBadges.length > 0 && <em className="prompt-suggestion-categories">{categoryBadges.slice(0, 2).map((label) => <i key={label}>{label}</i>)}</em>}</span>
        </button>
        <button type="button" className={`prompt-dictionary-frequency-button${frequency ? ` frequency-${frequency.tone}` : ""}`} tabIndex={-1} title="查看词条详情（F1）" aria-label={`查看 ${suggestion.display_text || suggestion.prompt_text} 的词条说明`} aria-haspopup="dialog" onPointerDown={(event) => event.preventDefault()} onClick={() => openDictionaryDetails(suggestion)}>
          {frequency ? `${frequency.label} · ${suggestion.post_count!.toLocaleString("zh-CN")}` : "详情"}<span aria-hidden="true">ⓘ</span>
        </button>
      </div>;
    })}<div className={`prompt-fragment-suggestion-tail ${pagingState === "error" ? "is-error" : ""}`} role="status" aria-live="polite">{pagingState === "loading" ? "正在加载更多候选词…" : pagingState === "error" ? "更多候选词加载失败，继续滚动可重试" : !hasMoreSuggestions ? "已加载全部候选词" : ""}</div></FloatingPanel>, floatingLayerHost())
    : suggestionPlacement && queryPanelVisible && !queryResultsVisible
      ? createPortal(<FloatingPanel className="prompt-fragment-suggestions prompt-fragment-suggestion-status prompt-fragment-suggestions--portal" id={queryStatusId} role="status" aria-busy={searchState === "loading"} aria-live="polite" style={suggestionPanelStyle}><div>{!queryCanSearch ? "输入 1 个中日韩文字，或至少 2 个字母/数字；按 Enter 可保留为自由 Prompt" : searchState === "loading" ? "正在搜索候选词…" : searchState === "empty" ? "没有匹配的候选词；按 Enter 可保留为自由 Prompt" : searchState === "unavailable" ? "Prompt 词库当前不可用；按 Enter 可保留为自由 Prompt" : searchState === "error" ? "候选词搜索失败；按 Enter 可保留为自由 Prompt" : "正在准备搜索…"}</div></FloatingPanel>, floatingLayerHost())
      : null;

  const enabled = promptFragmentEnabled(fragment);
  const enabledControl = <label className={`prompt-fragment-enabled ${enabled ? "is-on" : "is-off"}`} title={fragment.inheritance ? Object.hasOwn(fragment.inheritance, 'enabled') ? '开关已覆盖' : '开关随上游' : enabled ? "参与生成" : "已关闭，不参与生成"}>
      <input type="checkbox" aria-label={`${categoryLabel}第 ${index + 1} 项参与生成`} checked={enabled} onChange={(event) => {
        if (fragment.inheritance) onChange({ ...fragment, enabled: event.target.checked, inheritance: { ...fragment.inheritance, enabled: event.target.checked } });
        else if (event.target.checked) {
          const next = { ...fragment };
          delete next.enabled;
          onChange(next);
        } else onChange({ ...fragment, enabled: false });
      }} />
      <span aria-hidden="true"><i /></span>
      {mobileLayout && <b>参与生成</b>}
    </label>;
  const deleteControl = toggleOnly ? (fragment.inheritance && Object.keys(fragment.inheritance).length > 0
      ? <button type="button" className="prompt-fragment-delete prompt-fragment-reset" title="恢复继承的权重和开关" aria-label={`恢复${categoryLabel}第 ${index + 1} 项继承值`} onClick={() => restoreInheritance()}>{mobileLayout ? '恢复继承' : '↶'}</button>
      : <span className="prompt-fragment-delete" aria-hidden="true" />)
      : <button type="button" className="prompt-fragment-delete" onClick={onDelete} aria-label={`删除${categoryLabel}第 ${index + 1} 项`}>{mobileLayout ? '删除词条' : '×'}</button>;
  return <article className={`prompt-fragment-row ${isCameraFragment ? "is-camera-control" : ""} ${toggleOnly ? "prompt-fragment-row--toggle-only" : ""} ${enabled ? "" : "is-disabled"} ${hasVisibleError ? "has-error" : visibleFragmentIssues.length ? "has-warning" : ""} ${dragPosition ? `is-drag-${dragPosition}` : ""}`.replace(/\s+/g, " ").trim()} data-fragment-id={fragment.id} data-prompt-type={type} aria-label={isCameraFragment ? "机位控制" : undefined} title={fragment.inheritance_source ?? (isCameraFragment ? "机位控制" : undefined)} onBlurCapture={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDeferEmptyError(false);
  }}>
    <button type="button" className="prompt-fragment-drag" disabled={toggleOnly} onPointerDown={toggleOnly ? undefined : (event) => { commitQueryDraft(); onDragStart(event); }} title="拖动排序" aria-label={`拖动${categoryLabel}第 ${index + 1} 项排序`}>⋮</button>
    <div className="prompt-fragment-fields">
      <div className="prompt-fragment-prompt" ref={promptFieldRef}>
        <InlinePromptInput inputRef={promptInputRef} value={toggleOnly ? fragment.prompt_text : queryDraft} matches={currentMatches} readOnly={toggleOnly}
          role={toggleOnly ? "textbox" : "combobox"} aria-autocomplete={toggleOnly ? undefined : "list"} aria-expanded={toggleOnly ? undefined : queryResultsVisible}
          aria-controls={queryResultsVisible ? listboxId : undefined} aria-activedescendant={queryResultsVisible ? activeSuggestionId : undefined}
          aria-describedby={queryPanelVisible && !queryResultsVisible ? queryStatusId : undefined} aria-label={`${categoryLabel}第 ${index + 1} 项 Prompt`}
          className={promptTextMissing && !deferEmptyError ? "is-missing" : ""} aria-keyshortcuts="F1"
          onDetails={entry => { dictionaryDetailsOpen.current = true; setDetailEntry(entry); }}
          onFocus={() => { if (!toggleOnly) setQueryFocused(true); }} onCaretChange={setQueryCaret}
          onBlur={() => { if (toggleOnly || dictionaryDetailsOpen.current) return; setQueryFocused(false); commitQueryDraft(); closeQuerySearch(); }}
          onCompositionStart={() => { queryComposingRef.current = true; setQueryComposing(true); closeQuerySearch(); }}
          onCompositionEnd={() => { queryComposingRef.current = false; setQueryComposing(false); }}
          onKeyDown={handleQueryKeyDown} onValueChange={(text, caret) => { setQueryCaret(caret); updateQueryDraft(text); }} />
      </div>
      <button ref={weightTriggerRef} type="button" className="prompt-fragment-weight-button" disabled={!mobileLayout && toggleOnly && upstreamWeight === undefined} onPointerDown={(event) => event.stopPropagation()} onClick={toggleWeightMenu} title={mobileLayout ? '词条选项' : fragment.inheritance ? Object.hasOwn(fragment.inheritance, 'weight') ? '权重已覆盖，点击修改或恢复继承' : '权重随上游，点击设置覆盖' : '点击修改权重'} aria-haspopup="dialog" aria-expanded={weightMenuOpen} aria-label={mobileLayout ? `${categoryLabel}第 ${index + 1} 项选项` : `${categoryLabel}第 ${index + 1} 项权重 ${promptWeightLabel(fragment.weight)}`}>{mobileLayout ? '···' : promptWeightLabel(fragment.weight)}{fragment.inheritance && Object.hasOwn(fragment.inheritance, 'weight') ? ' •' : ''}</button>
      {weightMenuOpen && <div className="prompt-fragment-weight-menu" ref={weightMenuRef} role="dialog" aria-label={`${categoryLabel}第 ${index + 1} 项${mobileLayout ? '选项' : '权重编辑'}`} onPointerDown={(event) => event.stopPropagation()}>
        <strong>{mobileLayout ? `${categoryLabel}第 ${index + 1} 项选项` : fragment.inheritance ? '权重与继承' : '修改权重'}</strong>
        {mobileLayout && <div className="prompt-fragment-mobile-actions">{enabledControl}{deleteControl}</div>}
        {(!toggleOnly || upstreamWeight !== undefined) && <>
        {upstreamWeight !== undefined && <div className="prompt-fragment-weight-upstream">
          <span>上游 <span className="prompt-fragment-weight-value">{promptWeightLabel(upstreamWeight)}</span></span>
          <button type="button" disabled={fragment.inheritance && !Object.hasOwn(fragment.inheritance, 'weight')} onClick={() => fragment.inheritance ? restoreInheritance('weight') : commitWeight(upstreamWeight)}>恢复上游权重</button>
        </div>}
        {fragment.inheritance && Object.hasOwn(fragment.inheritance, 'enabled') && <div className="prompt-fragment-weight-upstream"><span>开关已覆盖 · 上游{upstreamEnabled ? '启用' : '关闭'}</span><button type="button" onClick={() => restoreInheritance('enabled')}>恢复开关继承</button></div>}
        <div className="prompt-fragment-weight-input-row"><label><span>{upstreamWeight !== undefined ? '当前权重' : '权重'}</span><input autoFocus={!coarsePointer} type="number" min="0.2" max="10" step="0.1" value={weightDraft} aria-label={`${categoryLabel}第 ${index + 1} 项权重`} onChange={(event) => { setWeightDraft(event.target.value); setWeightError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitWeight(); } else if (event.key === "Escape") { event.preventDefault(); setWeightMenuOpen(false); } }} /></label><div className="prompt-fragment-weight-menu-actions"><button type="button" className="is-primary" onClick={() => commitWeight()}>确定</button></div></div>
        {weightError && <small className="prompt-fragment-weight-error" role="alert">{weightError}</small>}
        <div className="prompt-fragment-weight-menu-actions prompt-fragment-weight-presets">{promptWeightPresets.map(weight => <button key={weight} type="button" onClick={() => commitWeight(weight)}>×{weight}</button>)}</div>
        </>}
      </div>}
    </div>
    {!mobileLayout && enabledControl}
    {!mobileLayout && deleteControl}
    {markerErrors.length > 0 && <div className="prompt-fragment-issues" role="alert">{markerErrors.map(message => <p className="is-error" key={message}>{message}</p>)}</div>}
    {visibleFragmentIssues.length > 0 && <div className="prompt-fragment-issues">{visibleFragmentIssues.map((issue, issueIndex) => <p className={issue.severity === "error" ? "is-error" : "is-warning"} key={`${issue.code ?? "issue"}-${issueIndex}`}><b>{issue.severity === "error" ? "错误" : "警告"}</b>{issueText(issue)}</p>)}</div>}
    {suggestionPanel}
    {detailEntry && <PromptDictionaryDetailsDialog entry={detailEntry} onClose={() => { setDetailEntry(null); dictionaryDetailsOpen.current = false; }} />}
  </article>;
}

export function PromptFragmentList({ categoryId, categoryLabel, scope, rowScopeKey = "", fragments, roles, issues = [], toggleOnly = false, upstreamWeights, upstreamEnabled, onPersonDragStart, onChange }: {
  categoryId: string;
  categoryLabel: string;
  scope: PromptDictionaryScope;
  rowScopeKey?: string;
  fragments: PromptFragment[];
  roles?: PromptRoleOption[];
  issues?: PromptAuditIssue[];
  toggleOnly?: boolean;
  /** 人物分组的跨组排序由外层编辑器统一处理（指针拖拽），行内列表不自行排序。 */
  onPersonDragStart?: (event: ReactPointerEvent<HTMLButtonElement>, fragmentId: string) => void;
  upstreamWeights?: Record<string, number>;
  upstreamEnabled?: Record<string, boolean>;
  onChange: (fragments: PromptFragment[], metadata?: PromptEditMetadata) => void;
}) {
  const categoryIssues = issues.filter((issue) => issue.category === categoryId && !issue.fragment_id && !issue.token_id && !issue.source_id && !issue.path?.includes("token-"));
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ from: number; to: number; pointerId: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; pointerId: number } | null>(null);
  const dictionaryMatches = usePromptDictionaryMatches(fragments, scope);

  function updateDrag(next: { from: number; to: number; pointerId: number } | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function startDragging(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    listRef.current?.setPointerCapture(event.pointerId);
    updateDrag({ from: index, to: index, pointerId: event.pointerId });
  }

  function moveDrag(clientY: number, pointerId: number) {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(".prompt-fragment-row") ?? [])];
    if (!rows.length) return;
    const insertionSlot = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    const rawSlot = insertionSlot === -1 ? rows.length : insertionSlot;
    const to = Math.max(0, Math.min(rows.length - 1, rawSlot > current.from ? rawSlot - 1 : rawSlot));
    if (to !== current.to) updateDrag({ ...current, to });
  }

  function finishDrag(pointerId: number, canceled = false) {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    updateDrag(null);
    if (canceled || current.from === current.to) return;
    const next = [...fragments];
    const [item] = next.splice(current.from, 1);
    next.splice(current.to, 0, item);
    onChange(next);
  }

  return <div className={`prompt-fragment-list ${roles ? "has-roles" : ""}`} ref={listRef} onPointerMove={(event) => moveDrag(event.clientY, event.pointerId)} onPointerUp={(event) => finishDrag(event.pointerId)} onPointerCancel={(event) => finishDrag(event.pointerId, true)}>
    {fragments.map((fragment, index) => {
      const dragPosition = drag?.from === index ? "source" : drag && drag.to !== drag.from && drag.to === index ? (drag.to < drag.from ? "before" : "after") : undefined;
      return <div className="prompt-fragment-entry" key={`${rowScopeKey}:${fragment.id}`}><PromptFragmentRow categoryId={categoryId} categoryLabel={categoryLabel} scope={scope} fragment={fragment} dictionaryMatch={dictionaryMatches[fragment.prompt_text.trim()]} dictionaryMatches={dictionaryMatches} index={index} roles={roles} issues={issues} dragPosition={dragPosition} toggleOnly={toggleOnly} upstreamWeight={upstreamWeights?.[fragment.id]} upstreamEnabled={upstreamEnabled?.[fragment.id]} onChange={(next, metadata) => onChange(fragments.map((current) => current.id === fragment.id ? next : current), metadata)} onDelete={() => onChange(fragments.filter((current) => current.id !== fragment.id))} onDragStart={categoryId === "person" && onPersonDragStart ? (event) => onPersonDragStart(event, fragment.id) : (event) => startDragging(event, index)} /></div>;
    })}
    {categoryIssues.length > 0 && <div className="prompt-fragment-category-issues">{categoryIssues.map((issue, index) => <p className={issue.severity === "error" ? "is-error" : "is-warning"} key={`${issue.code ?? "category"}-${index}`}>{issueText(issue)}</p>)}</div>}
  </div>;
}

export function PromptFragmentTableHeader({ roles = false, category = false, deleteLabel = false, compact = false }: { roles?: boolean; category?: boolean; deleteLabel?: boolean | string; compact?: boolean }) {
  return <div className={`prompt-fragment-table-head ${roles ? "has-roles" : ""} ${category ? "has-category" : ""}`} aria-hidden="true">
    {category && <span className="prompt-fragment-category-heading">分类</span>}
    <span className="prompt-fragment-table-columns"><span className="prompt-fragment-drag-heading">排序</span>{roles && <span>角色</span>}<span className="prompt-fragment-field-headings">{!compact && <span>类型</span>}<span>Prompt</span><span>权重</span></span><span className="prompt-fragment-enabled-heading">启用</span><span className="prompt-fragment-delete-heading">{typeof deleteLabel === "string" ? deleteLabel : deleteLabel ? "删除" : ""}</span></span>
  </div>;
}

export function PromptFragmentEditor(props: PromptFragmentEditorProps) {
  return <CategoryPromptEditor {...props} />;
}

type PromptFragmentEditorProps = {
  categories: Array<{ id: string; label: string }>;
  scope: PromptDictionaryScope;
  fragments: Record<string, PromptFragment[]>;
  roles?: PromptRoleOption[];
  issues?: PromptAuditIssue[];
  createFragment: (categoryId: string) => PromptFragment;
  onChange: (fragments: Record<string, PromptFragment[]>) => void;
  historyScopeKey?: string;
  /** 仅启用开关可交互，隐藏添加入口；行内文本、类型、权重、拖拽与删除只读。 */
  toggleOnly?: boolean;
  upstreamWeights?: Record<string, number>;
  upstreamEnabled?: Record<string, boolean>;
  showEmptyCategories?: boolean;
};

function CategoryPromptEditor({ categories, scope, fragments, roles, issues = [], createFragment, onChange, historyScopeKey = "prompt", toggleOnly = false, upstreamWeights, upstreamEnabled, showEmptyCategories = false }: PromptFragmentEditorProps) {
  const history = usePromptUndoHistory({ value: fragments, scopeKey: historyScopeKey, onChange });
  const editorRef = useRef<HTMLDivElement | null>(null);
  // 人物分组排序用指针拖拽（与其他分类一致）；HTML5 原生拖拽在 Windows Chrome 会触发非法 hover/事件洪流导致页面卡死。
  const personDrag = useRef<{ id: string; pointerId: number; roleId: string; beforeId: string | null } | null>(null);
  const [personIndicator, setPersonIndicator] = useState<{ roleId: string; line: number | null } | null>(null);

  function updatePersonIndicator(next: { roleId: string; line: number | null } | null) {
    setPersonIndicator(current => current?.roleId === next?.roleId && current?.line === next?.line ? current : next);
  }

  function startPersonDrag(event: ReactPointerEvent<HTMLButtonElement>, fragmentId: string) {
    if (event.button !== 0 || toggleOnly) return;
    event.preventDefault();
    event.stopPropagation();
    editorRef.current?.setPointerCapture(event.pointerId);
    const roleId = (fragments.person ?? []).find(entry => entry.id === fragmentId)?.role ?? "";
    personDrag.current = { id: fragmentId, pointerId: event.pointerId, roleId, beforeId: fragmentId };
    updatePersonIndicator({ roleId, line: null });
  }

  function movePersonDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = personDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const groups = [...(editorRef.current?.querySelectorAll<HTMLElement>("[data-person-role]") ?? [])];
    if (!groups.length) return;
    const group = groups.find(item => event.clientY < item.getBoundingClientRect().bottom) ?? groups[groups.length - 1];
    const roleId = group.dataset.personRole ?? "";
    const groupRect = group.getBoundingClientRect();
    const rows = [...group.querySelectorAll<HTMLElement>("[data-fragment-id]")];
    const before = rows.find(row => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    // 悬停在被拖行本身：不显示指示线，放下保持原位。
    drag.roleId = roleId;
    drag.beforeId = before?.dataset.fragmentId ?? null;
    updatePersonIndicator({ roleId, line: drag.beforeId === drag.id ? null : before
      ? before.getBoundingClientRect().top - groupRect.top
      : rows.length ? groupRect.height : groupRect.height / 2 });
  }

  function finishPersonDrag(event: ReactPointerEvent<HTMLDivElement>, canceled = false) {
    const drag = personDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    personDrag.current = null;
    updatePersonIndicator(null);
    if (canceled || drag.beforeId === drag.id) return;
    const entries = fragments.person ?? [];
    const source = entries.find(entry => entry.id === drag.id);
    if (!source) return;
    const moved = { ...source };
    if (drag.roleId) moved.role = drag.roleId; else delete moved.role;
    const next = entries.filter(entry => entry.id !== drag.id);
    const beforeIndex = drag.beforeId ? next.findIndex(entry => entry.id === drag.beforeId) : -1;
    const insertion = beforeIndex >= 0 ? beforeIndex : next.map(entry => entry.role ?? "").lastIndexOf(drag.roleId) + 1;
    next.splice(insertion, 0, moved);
    // 顺序和角色都没变时不产生编辑记录。
    if (next.every((entry, index) => entry.id === entries[index]?.id && (entry.role ?? "") === (entries[index]?.role ?? ""))) return;
    history.apply({ ...fragments, person: next });
  }
  const populatedCategories = categories.filter((category) => showEmptyCategories || (fragments[category.id] ?? []).length > 0);
  const emptyCategories = showEmptyCategories ? [] : categories.filter((category) => (fragments[category.id] ?? []).length === 0);

  function addFragment(categoryId: string) {
    const entries = fragments[categoryId] ?? [];
    history.apply({ ...fragments, [categoryId]: [...entries, createFragment(categoryId)] });
  }

  return <div className="visual-editor prompt-fragment-editor workbench-prompt-fragment-editor prompt-compact" ref={editorRef} onKeyDown={history.onKeyDown} onPointerMove={movePersonDrag} onPointerUp={event => finishPersonDrag(event)} onPointerCancel={event => finishPersonDrag(event, true)}>
    <PromptFragmentTableHeader category deleteLabel={toggleOnly ? "恢复" : true} compact />
    <div className="category-list">
      {populatedCategories.map((category) => {
        const entries = (fragments[category.id] ?? []).map((fragment, index) => ({ ...fragment, source_index: index }));
        return <section data-prompt-category={category.id} className={`category-card ${category.id === "avoid" ? "category-card--avoid" : ""}`} key={category.id}>
          <header>
            <span className="category-label"><b>{category.label}</b></span>
            {!toggleOnly && <span className="category-header-actions"><button type="button" className="category-header-action" title={`添加${category.label}`} aria-label={`添加${category.label}`} onClick={() => addFragment(category.id)}>＋</button></span>}
          </header>
          <div className="category-content">
            {category.id === "person" && roles ? (() => {
              const groups = [...roles,
                ...[...new Set(entries.map(entry => entry.role).filter((id): id is string => Boolean(id) && !roles.some(role => role.id === id)))].map(id => ({ id, label: `缺失角色 ${id}`, color: "#b25b57" })),
                { id: "", label: "未绑定", color: "#929a96" }];
              return groups.map(role => {
                const groupEntries = entries.filter(entry => (entry.role ?? "") === role.id);
                if (!role.id && !groupEntries.length && !personIndicator) return null;
                return <section key={role.id} className={`prompt-person-group ${groupEntries.length ? "" : "is-empty"} ${personIndicator?.roleId === role.id ? "is-drop-target" : ""}`} data-person-role={role.id} aria-label={role.label} title={role.label} style={{ "--person-color": role.color ?? "#929a96" } as CSSProperties}>
                  {personIndicator?.roleId === role.id && personIndicator.line !== null && <span className="prompt-person-drop-line" aria-hidden="true" style={{ top: personIndicator.line }} />}
                  <PromptFragmentList categoryId="person" categoryLabel={`人物·${role.label}`} scope={scope} rowScopeKey={historyScopeKey} fragments={groupEntries} roles={roles} issues={issues} toggleOnly={toggleOnly} upstreamWeights={upstreamWeights} upstreamEnabled={upstreamEnabled} onPersonDragStart={startPersonDrag} onChange={(next, metadata) => {
                    const ids = new Set(groupEntries.map(entry => entry.id)); let cursor = 0;
                    const combined = entries.flatMap(entry => ids.has(entry.id) ? (cursor < next.length ? [next[cursor++]] : []) : [entry]);
                    history.apply({ ...fragments, person: [...combined, ...next.slice(cursor)] }, metadata);
                  }} />
                </section>;
              });
            })() : <PromptFragmentList categoryId={category.id} categoryLabel={category.label} scope={scope} rowScopeKey={historyScopeKey} fragments={entries} issues={issues} toggleOnly={toggleOnly} upstreamWeights={upstreamWeights} upstreamEnabled={upstreamEnabled} onChange={(next, metadata) => history.apply({ ...fragments, [category.id]: next }, metadata)} />}
          </div>
        </section>;
      })}
    </div>
    {!toggleOnly && emptyCategories.length > 0 && <div className="empty-category-actions">{emptyCategories.map((category) => <button type="button" key={category.id} onClick={() => addFragment(category.id)}>＋ {category.label}</button>)}</div>}
  </div>;
}

export function ReadonlyPromptFragmentEditor({ categories, scope, fragments, roles, busy = false, onEnabledChange, emptyLabel = "这个分类还没有片段" }: {
  categories: Array<{ id: string; label: string }>;
  scope: PromptDictionaryScope;
  fragments: Record<string, PromptFragment[]>;
  roles?: PromptRoleOption[];
  busy?: boolean;
  onEnabledChange?: (categoryId: string, index: number, enabled: boolean) => void;
  emptyLabel?: string;
}) {
  const [detailEntry, setDetailEntry] = useState<PromptDictionaryMatch | null>(null);
  const allFragments = categories.flatMap((category) => fragments[category.id] ?? []);
  const dictionaryMatches = usePromptDictionaryMatches(allFragments, scope);
  return <div className="prompt-fragment-editor prompt-fragment-editor--readonly prompt-compact">
    {detailEntry && <PromptDictionaryDetailsDialog entry={detailEntry} onClose={() => setDetailEntry(null)} />}
    <PromptFragmentTableHeader roles={Boolean(roles)} compact />
    {categories.map((category) => {
      const entries = fragments[category.id] ?? [];
      const enabledCount = entries.filter(promptFragmentEnabled).length;
      return <section className="prompt-fragment-category" key={category.id}>
        <header><span><b>{category.label}</b><small>{enabledCount} / {entries.length} 项启用</small></span>{!onEnabledChange && <em>只读</em>}</header>
        {entries.length > 0 ? <div className={`prompt-fragment-list ${roles ? "has-roles" : ""}`}>
          {entries.map((fragment, index) => {
            const type = fragment.prompt_type;
            const enabled = promptFragmentEnabled(fragment);
            const boundRole = roles?.find((role) => role.id === fragment.role);
            return <article className={`prompt-fragment-row prompt-fragment-row--readonly ${fragment.camera_settings ? "is-camera-control" : ""} ${enabled ? "" : "is-disabled"}`} data-prompt-type={type} key={fragment.id}>
              <span className="prompt-fragment-drag" aria-hidden="true">·</span>
              {roles && <span className={`prompt-fragment-role token-role ${boundRole ? "is-bound" : ""}`} title={boundRole?.label ?? (fragment.role ? `角色 ${fragment.role}` : "不绑定角色")}>
                {boundRole ? <span className="role-badge"><i style={{ backgroundColor: boundRole.color ?? "#89938E" }} />{compactLabel(boundRole.label)}</span> : <span className="role-bind-action">—</span>}
              </span>}
              <div className="prompt-fragment-fields">
                <div className="prompt-fragment-prompt"><InlinePromptInput aria-label={`${category.label}第 ${index + 1} 项 Prompt`} role="textbox" readOnly value={fragment.prompt_text} matches={dictionaryMatches} onDetails={setDetailEntry} /></div>
                <span className="prompt-fragment-weight-button" title="片段权重">{promptWeightLabel(fragment.weight)}</span>
              </div>
              <label className={`prompt-fragment-enabled ${enabled ? "is-on" : "is-off"}`} title={onEnabledChange ? (enabled ? "参与生成" : "已关闭，不参与生成") : "只读"}>
                <input type="checkbox" aria-label={`${category.label}第 ${index + 1} 项参与生成`} checked={enabled} disabled={busy || !onEnabledChange} onChange={(event) => onEnabledChange?.(category.id, index, event.target.checked)} />
                <span aria-hidden="true"><i /></span>
              </label>
              <span className="prompt-fragment-delete" aria-hidden="true" />
            </article>;
          })}
        </div> : <p className="prompt-fragment-empty">{emptyLabel}</p>}
      </section>;
    })}
  </div>;
}

export function ReadonlyLoraTrigger({ trigger }: { trigger?: string }) {
  const value = trigger?.trim();
  return <div className="readonly-lora-trigger"><span>LoRA 触发词</span><code>{value || "未提供"}</code><small>{value ? "自动加入 Positive；不作为普通 Prompt 片段编辑。" : "仅加载 LoRA 权重；不自动补词。"}</small></div>;
}
