import { floatingLayerHost } from "./floating-layer";
import { FloatingPanel } from "./FloatingPanel";
import { useFloatingLayer } from "./floating-layer";
import { useDismissableLayer } from "./use-dismissable-layer";
import { type FormEvent, type ReactNode, type SetStateAction, useEffect, useId, useMemo, useRef, useState } from "react";
import { createTrainingClient } from "./lora-training-client";
import { useFeedback } from "./feedback";
import { createPortal } from "react-dom";
import { Modal } from "./Modal";
import ZoomableImageLightbox from "./ImageLightbox";
import { mediaVariantUrl } from "./media-variant";
import LoraCropEditor, { type LoraCropRect } from "./LoraCropEditor";
import { loraRunControls } from "./lora-run-controls";
import { activePromptDictionarySuggestion, canSearchPromptDictionary, mergePromptDictionarySuggestions } from "./prompt-fragment-input";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { LoraLossChart } from "./LoraLossChart";
import type { LossPoint } from "../shared/lora-loss.mjs";

type ModelIdentity = { relative_path: string; sha256?: string; source?: string };
type UsageDefaults = { clip_skip: number | null; sampler: string; scheduler: string; steps: number; cfg: number };
type TrainingDataset = {
  version: 5;
  name: string;
  description: string;
  activation_terms: string[];
  groups: Array<{ id: string; name: string; enabled: boolean; repeats: number }>;
  items: Array<{ id: string; asset_id: string; group_id: string; enabled: boolean }>;
};
type ImagePreparation = { resolution: number; target: { width: number; height: number }; before_score: number; after_score: number | null; decision: "already_good" | "enhanced" | "no_gain"; baseline_file: string; enhanced_file: string | null };
type DatasetItem = TrainingDataset["items"][number] & { file: string; preparation?: ImagePreparation; preparation_error?: string; source?: string; caption: string; caption_sha256: string | null; image_bytes: number | null; image_width: number | null; image_height: number | null; image_version: string | null; media_url: string; original_file?: string; original_sha256?: string | null; processing?: { crop: { x: number; y: number; width: number; height: number }; upscale: boolean; output_scale: number | null; model?: { id: string; sha256: string } | null; pipeline_version: number } | null; original_media_url?: string; original_image_bytes?: number | null; original_image_width?: number | null; original_image_height?: number | null; original_image_version?: string | null };
type CaptionRawTag = { name?: string; score?: number; category_name?: string; threshold?: number };
type CaptionDictionaryMatch = { prompt_text: string; matched: boolean; allowed: boolean; provider_type: string | null; provider_category: string | null; display_text: string | null; source_text: string | null; post_count: number | null };
type CaptionDictionarySuggestion = { display_text: string; prompt_text: string; source_text?: string; provider_type?: string; post_count?: number; categories?: string[] };
type CaptioningItem = {
  item_id: string;
  current_prompt: string;
  base_prompt: string | null;
  image_sha256: string | null;
  caption_sha256: string | null;
  raw_tags: CaptionRawTag[];
  state: "unlabeled" | "unconfirmed" | "confirmed";
  confirmed: boolean;
};
type CaptioningDetail = { version: 1; latest: { updated_at: string; tagger: { id: string; version: string } | null } | null; summary: { total: number; with_base: number; confirmed: number; unconfirmed: number }; items: CaptioningItem[] };
type DatasetDetail = { id: string; dataset: TrainingDataset; items: DatasetItem[]; captioning: CaptioningDetail };
export type LoraDatasetSummary = { id: string; name?: string; activation_terms?: string[]; item_count?: number; enabled_item_count?: number; effective_item_count?: number; error?: string };

type TrainingTask = {
  version: 5;
  name: string;
  dataset_id: string;
  target: { family: "qwen-image-2-1"; base: { dit: ModelIdentity; text_encoder: ModelIdentity; vae: ModelIdentity; processor: ModelIdentity }; prompt_family: string; usage_defaults: UsageDefaults };
  training_recipe: { id: string; overrides: Partial<Record<RecipeOverrideKey, number>> };
  run_defaults: Record<Exclude<RunSettingKey, "gradient_accumulation_steps">, number>;
};
type DatasetReference = { id: string; name: string; activation_terms: string[]; item_count: number; enabled_item_count: number; effective_item_count: number };
type Checkpoint = { id: string; file: string; relative_path?: string; step: number; sha256: string; size: number; available?: boolean };
type RunResumePointer = { snapshot_id: string; step: number | null; sha256: string | null };
type RunPerformance = { wall_seconds?: number; phase_seconds?: Record<string, number>; seconds_per_update?: number | null; samples_seen?: number; runner?: unknown };
// v5 run 的预算在 manifest.run，v4（Anima）历史 run 在 manifest.config；legacy 项可能只有部分字段。
type Run = { id: string; created_at?: string; legacy?: boolean; legacy_note?: string; resumable?: boolean; manifest: { task_id: string; task_name?: string; dataset_name?: string; created_at?: string; run_settings?: { note?: string }; run?: { max_train_steps?: number; save_every_n_steps?: number; seed?: number; note?: string }; config?: { max_train_steps?: number; resolution?: number; learning_rate?: number; network_dim?: number }; semantic_config?: Partial<SemanticConfig>; resume?: { parent_run_id: string; source_snapshot_id: string; start_step: number } | null } | null; status: { status: string; phase?: string | null; completed_at?: string | null; interrupted_at?: string | null; step: number; loss: number | null; lr?: number | null; samples_seen?: number; cache_progress?: { done: number; total: number } | null; loss_history?: LossPoint[]; eta_seconds: number | null; error: string | null; checkpoints: Checkpoint[]; resume?: RunResumePointer | null; performance?: RunPerformance | null; log_tail?: string }; disk_bytes: number };
type TaskDetail = { id: string; task: TrainingTask; dataset: DatasetReference; runs: Run[] };
type TaskSummary = { id: string; name?: string; family?: string; dataset?: DatasetReference; error?: string; runs?: Array<{ id: string; status: string; step: number; created_at: string; resumable?: boolean; legacy?: boolean; legacy_note?: string; disk_bytes: number }> };
type Environment = { available: boolean; runtime: null | { gpu: string; vram_bytes: number; python: string; torch: string; cuda: string }; checks: Array<{ id: string; ok: boolean; message: string }>; reference_models?: Array<{ family: string; kind: string; relative_path: string; exists: boolean; matches: boolean; sha256: string | null; size: number | null }>; optional_capabilities?: { quality?: { ready: boolean; message: string }; upscaler?: { id: string; ready: boolean; path: string | null; relative_path: string | null; message: string; expected_sha256: string | null; sha256: string | null; size_bytes: number | null; output_scales?: number[] } }; captioning: { configured: boolean; ready: boolean; id: string | null; version: string | null; message: string; manifest?: { id: string; name: string } | null; files?: Array<{ id: string; path: string | null; exists: boolean; matches: boolean; sha256: string | null; expected_sha256: string | null }> } };
type TrainingRecipe = { id: string; version?: number; name: string; description: string; family: "qwen-image-2-1"; semantic_config: SemanticConfig };
type RunSettingKey = "max_train_steps" | "save_every_n_steps" | "seed" | "gradient_accumulation_steps";
type RecipeOverrideKey = "network_dim" | "learning_rate" | "gradient_accumulation_steps";
type SemanticConfig = { max_pixels: number; network_dim: number; network_alpha: number; learning_rate: number; gradient_accumulation_steps: number; micro_batch_size: number; optimizer: { type: string; betas: number[]; eps: number; weight_decay: number }; scheduler: { type: string; factor: number; total_iters: number }; precision: { base: string; lora: string; optimizer_state: string }; gradient_checkpointing: boolean; lora_target_modules: string[] };
type RunSettingsDetail = { recipe: { id: string; version: number; name: string }; semantic_config: SemanticConfig; values: Partial<Record<RunSettingKey, number>>; last_run: null | { id: string; created_at?: string; status: string; config: Record<string, unknown> | null } };
type PreflightIssue = { code: string; message: string; item_id?: string; other_item_id?: string; asset_id?: string; group_id?: string };
type PreflightModel = { kind?: string; label?: string; identity?: ModelIdentity; exists: boolean; matches: boolean; sha256: string | null; size: number | null };
type Preflight = { ready: boolean; blockers: PreflightIssue[]; warnings: PreflightIssue[]; recipe?: { id: string; version?: number; name: string } | null; semantic_config?: SemanticConfig; run_settings?: Partial<Record<RunSettingKey, number>> & { note?: string }; models?: PreflightModel[]; estimated_disk_bytes?: number; available_disk_bytes?: number };
type SectionKey = "datasets" | "tasks" | "runs";
type CropDraft = LoraCropRect & { itemId: string; cropEnabled?: boolean; upscale?: boolean; outputScale?: 1 | 2 | 4 };
type ActivationGuide = { title: string; markdown: string };
type TrainingImagePreview = { src: string; alt: string; footer: string };
type DatasetContextMenu = { itemId: string; x: number; y: number };
type PostprocessPreview = { previewId: string; key: string; src: string; width: number; height: number };
type PrepareResult = { prepared: number; reused: number; enhanced: number; already_good: number; no_gain: number; total: number; failed: Array<{ item_id: string; asset_id: string; error: { code: string; details: unknown[] } }>; dataset: DatasetDetail };

const RECIPE_PARAMETER_DEFINITIONS = [
  { key: "network_dim", label: "Rank", kind: "integer", description: "LoRA 的容量（秩）；越大能承载更多细节，也更容易过拟合。Alpha 恒等于 Rank。" },
  { key: "learning_rate", label: "学习率", kind: "number", description: "每一次更新参数的幅度；过高不稳定，过低学习慢。" },
  { key: "gradient_accumulation_steps", label: "梯度累积", kind: "integer", description: "累积多少张图片再做一次更新；Micro Batch 固定为 1，有效 Batch 等于累积次数。" },
] as const;

const RUN_PARAMETER_DEFINITIONS = [
  { key: "max_train_steps", label: "总更新步数", kind: "integer", description: "本轮预算的累计更新次数（optimizer step）；预算用完后可通过续训扩大。" },
  { key: "save_every_n_steps", label: "保存间隔", kind: "integer", description: "每隔多少更新步保存一个 checkpoint 与完整恢复状态。" },
  { key: "seed", label: "随机种子", kind: "integer", description: "随机种子；固定后便于复现实验。" },
] as const;

type TrainingRequester = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function readableError(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Error) return value.message || "请求失败";
  if (typeof value === "string") return value.trim() || "请求失败";
  if (Array.isArray(value)) return value.map((entry) => readableError(entry)).filter(Boolean).join("；");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.blockers)) {
      const blockers = record.blockers.map((entry) => readableError(entry)).filter(Boolean).join("；");
      if (blockers) return blockers;
    }
    if (record.details !== undefined) {
      const details = readableError(record.details);
      if (details) return details;
    }
    for (const key of ["message", "error", "code"]) {
      const message = readableError(record[key]);
      if (message) return message;
    }
    try { return JSON.stringify(record); } catch { return "请求失败"; }
  }
  return String(value);
}

async function apiWith<T>(requester: TrainingRequester, input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await requester(input, { ...init, headers: { accept: "application/json", ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }), ...init?.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok && value?.error === "training_revision_conflict") throw new Error("训练数据已被其他操作修改。请先保留草稿，再点击刷新重新读取后修改。");
  if (!response.ok) throw new Error(readableError(value) || `请求失败：${response.status}`);
  return value as T;
}

async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  return apiWith(fetch, input, init);
}

const loraEnvironmentRequests = new Map<string, Promise<Environment>>();

function loraEnvironmentStorageKey() {
  return `story-canvas:lora-environment:global`;
}

function readLoraEnvironmentCache() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(loraEnvironmentStorageKey());
    if (!raw) return null;
    const cached = JSON.parse(raw) as { version?: number; value?: Environment };
    if (cached.version !== 1 || !cached.value) {
      window.sessionStorage.removeItem(loraEnvironmentStorageKey());
      return null;
    }
    return cached.value;
  } catch {
    return null;
  }
}

function writeLoraEnvironmentCache(value: Environment) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(loraEnvironmentStorageKey(), JSON.stringify({ version: 1, value }));
  } catch {
    // sessionStorage 不可用时仍保留内存状态，不影响环境诊断。
  }
}

function loraDatasetSelectionStorageKey() {
  return `story-canvas:lora-dataset-selection:global`;
}

function readLoraDatasetSelection() {
  if (typeof window === "undefined") return "";
  try { return window.sessionStorage.getItem(loraDatasetSelectionStorageKey()) ?? ""; }
  catch { return ""; }
}

function writeLoraDatasetSelection(datasetId: string) {
  if (typeof window === "undefined" || !datasetId) return;
  try { window.sessionStorage.setItem(loraDatasetSelectionStorageKey(), datasetId); }
  catch { /* sessionStorage 不可用时只影响刷新后的选择恢复。 */ }
}

function requestLoraEnvironment(force = false) {
  if (!force) {
    const pending = loraEnvironmentRequests.get("global");
    if (pending) return pending;
  }
  const query = force ? "?refresh=1" : "";
  const promise = api<Environment>(`/api/lora-training/environment${query}`).finally(() => {
    if (loraEnvironmentRequests.get("global") === promise) loraEnvironmentRequests.delete("global");
  });
  loraEnvironmentRequests.set("global", promise);
  return promise;
}


function bytes(value: number | null | undefined) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function resolution(width: number | null | undefined, height: number | null | undefined) {
  return width && height ? `${width}×${height}` : "未知分辨率";
}

const TRAINING_MIN_SHORT_SIDE = 512;

function hasLowResolution(width: number | null | undefined, height: number | null | undefined) {
  return typeof width === "number" && typeof height === "number" && Math.min(width, height) < TRAINING_MIN_SHORT_SIDE;
}

function captionPieces(value: string) {
  const text = value.trim();
  if (!text) return [];
  const pieces = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  return pieces.length > 1 ? pieces : [text];
}

function captionDictionaryKey(value: string) {
  return value.trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

function captionHasChinese(value: string | null | undefined) {
  return typeof value === "string" && /[\u3400-\u9fff]/u.test(value);
}

function captionTagDisplay(value: string, match: CaptionDictionaryMatch | undefined) {
  const canonical = match?.source_text ?? value;
  return match?.matched && captionHasChinese(match.display_text) ? match.display_text! : canonical;
}

function captionFrequency(postCount: number | null | undefined) {
  if (typeof postCount !== "number") return null;
  if (postCount >= 1000) return "常见";
  if (postCount >= 100) return "低频";
  return "稀有";
}

function captionCategoryLabel(category: string | null | undefined) {
  return category === "general" ? "通用" : category === "character" ? "角色" : category === "copyright" ? "作品" : category ?? "未分类";
}

function rawCaptionTag(rawTags: CaptionRawTag[] | undefined, value: string) {
  const key = captionDictionaryKey(value);
  return rawTags?.find((tag) => typeof tag?.name === "string" && captionDictionaryKey(tag.name) === key) ?? null;
}

function captionTagTooltip(value: string, match: CaptionDictionaryMatch | undefined, rawTag: CaptionRawTag | null) {
  const canonical = match?.source_text ?? value;
  const lines = [`标签：${canonical}`];
  if (match?.matched && captionHasChinese(match.display_text)) lines.push(`翻译：${match.display_text}`);
  else if (match?.matched) lines.push("词库：已收录");
  else lines.push("词库：未收录");
  if (match?.provider_category) lines.push(`类别：${captionCategoryLabel(match.provider_category)}`);
  const frequency = captionFrequency(match?.post_count);
  if (frequency) lines.push(`词频：${frequency}（${match?.post_count}）`);
  if (rawTag && typeof rawTag.score === "number") lines.push(`模型分数：${rawTag.score.toFixed(3)}${typeof rawTag.threshold === "number" ? ` · 阈值 ${rawTag.threshold.toFixed(3)}` : ""}`);
  return lines.join("\n");
}

function CaptionTagChip({ value, match, rawTag, prefix = "", onClick, actionLabel }: { value: string; match?: CaptionDictionaryMatch; rawTag?: CaptionRawTag | null; prefix?: string; onClick?: () => void; actionLabel?: string }) {
  const display = captionTagDisplay(value, match);
  const tooltip = captionTagTooltip(value, match, rawTag ?? null);
  return <span className="lora-caption-tag-anchor" data-tooltip={tooltip} tabIndex={0}>
    <button type="button" className={`lora-caption-tag ${match?.matched ? "is-matched" : "is-unmatched"}`} aria-label={`${prefix}${display}${actionLabel ? `，${actionLabel}` : ""}`} onClick={onClick} disabled={!onClick}>
      <span className="lora-caption-tag-main">{prefix}{display}</span>
    </button>
  </span>;
}

function CaptionTagPicker({ existingTags, onAdd, disabled = false }: { existingTags: string[]; onAdd: (tag: string) => void; disabled?: boolean }) {
  const listboxId = useId();
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<CaptionDictionarySuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "results" | "empty" | "unavailable" | "error">("idle");
  const [panelPlacement, setPanelPlacement] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const requestSerial = useRef(0);
  const existingKeys = useMemo(() => new Set(existingTags.map(captionDictionaryKey)), [existingTags]);

  useEffect(() => {
    const requestId = ++requestSerial.current;
    const text = query.trim();
    if (disabled || !focused || (!text && !suggestions.length) || (text && !canSearchPromptDictionary(text))) {
      setSuggestions([]);
      setActiveIndex(-1);
      setSearchState(text && !canSearchPromptDictionary(text) ? "idle" : "idle");
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchState("loading");
      void fetch(`/api/prompt-dictionary?q=${encodeURIComponent(text)}&scope=lora&limit=12&offset=0`, { headers: { accept: "application/json" } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`prompt_dictionary_${response.status}`);
          return await response.json() as { available?: boolean; suggestions?: CaptionDictionarySuggestion[] };
        })
        .then((payload) => {
          if (requestSerial.current !== requestId) return;
          const next = payload.available === false ? [] : mergePromptDictionarySuggestions<CaptionDictionarySuggestion>([], payload.suggestions ?? []);
          setSuggestions(next);
          setActiveIndex(-1);
          setSearchState(payload.available === false ? "unavailable" : next.length ? "results" : "empty");
        })
        .catch(() => {
          if (requestSerial.current !== requestId) return;
          setSuggestions([]);
          setActiveIndex(-1);
          setSearchState("error");
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [disabled, focused, query]);

  function close() {
    setFocused(false);
    setSuggestions([]);
    setActiveIndex(-1);
    setSearchState("idle");
  }

  function addTag(value: string) {
    const tag = value.trim();
    if (!tag || existingKeys.has(captionDictionaryKey(tag))) return;
    onAdd(tag);
    setQuery("");
    close();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" && suggestions.length) { event.preventDefault(); setActiveIndex((current) => current < 0 ? 0 : (current + 1) % suggestions.length); }
    else if (event.key === "ArrowUp" && suggestions.length) { event.preventDefault(); setActiveIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const active = activePromptDictionarySuggestion(suggestions, activeIndex);
      addTag(active?.source_text ?? active?.prompt_text ?? query);
    } else if (event.key === "Escape") { event.preventDefault(); close(); }
  }

  const panelVisible = focused && Boolean(query.trim());
  useEffect(() => {
    if (!panelVisible) {
      setPanelPlacement(null);
      return;
    }
    let frame = 0;
    const updatePanelPlacement = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const input = pickerRef.current?.querySelector("input");
        if (!input) return;
        const rect = input.getBoundingClientRect();
        const gutter = 8;
        if (rect.bottom <= gutter || rect.top >= window.innerHeight - gutter) {
          setPanelPlacement(null);
          return;
        }
        const width = Math.min(420, Math.max(180, window.innerWidth - gutter * 2));
        const left = Math.min(Math.max(gutter, rect.left), Math.max(gutter, window.innerWidth - width - gutter));
        const belowSpace = Math.max(0, window.innerHeight - rect.bottom - gutter);
        const aboveSpace = Math.max(0, rect.top - gutter);
        const availableSpace = Math.max(aboveSpace, belowSpace);
        if (availableSpace < 80) {
          setPanelPlacement(null);
          return;
        }
        const openAbove = belowSpace < 280 && aboveSpace > belowSpace;
        const maxHeight = Math.min(280, openAbove ? aboveSpace : belowSpace);
        const top = openAbove ? Math.max(gutter, rect.top - maxHeight - 4) : rect.bottom + 4;
        setPanelPlacement({ top, left, width, maxHeight });
      });
    };
    updatePanelPlacement();
    window.addEventListener("resize", updatePanelPlacement);
    window.addEventListener("scroll", updatePanelPlacement, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePanelPlacement);
      window.removeEventListener("scroll", updatePanelPlacement, true);
    };
  }, [panelVisible]);
  const panelStyle = panelPlacement ? { top: panelPlacement.top, left: panelPlacement.left, width: panelPlacement.width, maxHeight: panelPlacement.maxHeight } : undefined;
  const panel = panelVisible && panelPlacement ? createPortal(<FloatingPanel className="prompt-fragment-suggestions prompt-fragment-suggestions--portal" id={listboxId} role="listbox" style={panelStyle}>
    {suggestions.map((suggestion, index) => {
      const tag = suggestion.source_text ?? suggestion.prompt_text;
      const duplicate = existingKeys.has(captionDictionaryKey(tag));
      const frequency = captionFrequency(suggestion.post_count);
      const display = captionHasChinese(suggestion.display_text) ? suggestion.display_text : tag;
      return <button type="button" role="option" aria-selected={index === activeIndex} className={`${index === activeIndex ? "is-active" : ""} ${duplicate ? "is-disabled" : ""}`.trim()} disabled={duplicate} key={`${tag}-${index}`} onMouseEnter={() => setActiveIndex(index)} onPointerDown={(event) => event.preventDefault()} onClick={() => addTag(tag)}><span><b>{display}</b>{captionHasChinese(suggestion.display_text) && <code>{tag}</code>}</span>{duplicate ? <small>已存在</small> : frequency ? <small className={`frequency-${frequency === "常见" ? "common" : frequency === "低频" ? "low" : "rare"}`}>{frequency} · {suggestion.post_count}</small> : null}</button>;
    })}
    {!suggestions.length && <div className="lora-caption-tag-picker-status">{searchState === "loading" ? "正在搜索候选词…" : searchState === "unavailable" ? "词库不可用，可按 Enter 保留手动标签" : searchState === "error" ? "候选词搜索失败，可按 Enter 保留手动标签" : searchState === "empty" ? "没有匹配候选词，可按 Enter 保留手动标签" : "输入标签后搜索"}</div>}
  </FloatingPanel>, floatingLayerHost()) : null;
  return <div className="lora-caption-tag-picker" ref={pickerRef}>
    <input role="combobox" aria-autocomplete="list" aria-expanded={panelVisible && (suggestions.length > 0 || searchState !== "idle")} aria-controls={panelVisible ? listboxId : undefined} placeholder="添加标签：搜索中文或 Danbooru 标签" value={query} disabled={disabled} onFocus={() => setFocused(true)} onBlur={() => window.setTimeout(() => setFocused(false), 120)} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} />
    {panel}
  </div>;
}

type CaptionStatus = { key: "confirmed" | "unconfirmed" | "unlabeled"; label: string; detail: string };

function captionStatusForItem(item: Pick<DatasetItem, "caption">, projection?: CaptioningItem | null): CaptionStatus {
  if (projection?.state === "confirmed") return { key: "confirmed", label: "已确认", detail: "当前图片与 Caption 已按最新哈希确认" };
  if (projection?.state === "unconfirmed") return { key: "unconfirmed", label: "待确认", detail: "图片或 Caption 已变化，需要重新确认" };
  return { key: "unlabeled", label: "未打标", detail: item.caption.trim() ? "已有 Caption，但尚未完成自动打标确认" : "尚未生成基础 Prompt 或 Caption" };
}

function datasetMediaUrl(item: Pick<DatasetItem, "media_url" | "image_version" | "original_media_url" | "original_image_version">, source: "current" | "original" = "current") {
  const mediaUrl = source === "original" ? item.original_media_url ?? item.media_url : item.media_url;
  const imageVersion = source === "original" ? item.original_image_version ?? item.image_version : item.image_version;
  const version = imageVersion ? `?v=${encodeURIComponent(imageVersion)}` : "";
  return `/api/lora-training/media/${mediaUrl.replace(/^lora-training\//, "")}${version}`;
}

function postprocessRequestForDraft(draft: CropDraft) {
  const upscale = draft.upscale === true;
  const crop = draft.cropEnabled === false ? { x: 0, y: 0, width: 1, height: 1 } : { x: draft.x, y: draft.y, width: draft.width, height: draft.height };
  return {
    item_id: draft.itemId,
    crop,
    upscale,
    output_scale: upscale ? (draft.outputScale ?? 2) : null,
  };
}

function processingMatchesDraft(item: DatasetItem, draft: CropDraft) {
  const processing = item.processing;
  const width = item.original_image_width ?? item.image_width;
  const height = item.original_image_height ?? item.image_height;
  if (item.preparation || !processing || !width || !height || item.id !== draft.itemId) return false;
  const effective = draft.cropEnabled === false ? { x: 0, y: 0, width: 1, height: 1 } : draft;
  const left = Math.round(effective.x * width);
  const top = Math.round(effective.y * height);
  const right = Math.round((effective.x + effective.width) * width);
  const bottom = Math.round((effective.y + effective.height) * height);
  const crop = processing.crop;
  return crop.x === left
    && crop.y === top
    && crop.width === right - left
    && crop.height === bottom - top
    && processing.upscale === (draft.upscale === true)
    && processing.output_scale === (draft.upscale === true ? (draft.outputScale ?? 2) : null);
}

function postprocessLabel(item: DatasetItem) {
  const width = item.original_image_width ?? item.image_width;
  const height = item.original_image_height ?? item.image_height;
  const crop = item.processing?.crop;
  const manuallyCropped = crop && width && height && (crop.x !== 0 || crop.y !== 0 || crop.width !== width || crop.height !== height);
  const target = item.preparation?.target;
  const inputWidth = crop?.width ?? width;
  const inputHeight = crop?.height ?? height;
  const bucketCropped = target && inputWidth && inputHeight && Math.abs(inputWidth * target.height - inputHeight * target.width) > Math.max(inputWidth, inputHeight);
  const enhanced = item.preparation ? item.preparation.decision === "enhanced" : item.processing?.upscale;
  return [manuallyCropped || bucketCropped ? "裁剪" : null, enhanced ? "超分" : null].filter(Boolean).join(" · ");
}

function mergeDatasetItems(items: DatasetItem[], draftItems: TrainingDataset["items"]) {
  const drafts = new Map(draftItems.map((item) => [item.id, item]));
  return items.filter((item) => drafts.has(item.id)).map((item) => {
    const draft = drafts.get(item.id);
    return draft ? { ...item, ...draft } : item;
  });
}

const datasetNaturalCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareDatasetItems(left: DatasetItem, right: DatasetItem) {
  return datasetNaturalCollator.compare(left.asset_id, right.asset_id)
    || datasetNaturalCollator.compare(left.file, right.file)
    || datasetNaturalCollator.compare(left.id, right.id);
}

function orderDatasetItems(items: DatasetItem[]) {
  return [...items].sort(compareDatasetItems);
}

function orderDatasetSections(items: DatasetItem[], groups: TrainingDataset["groups"]) {
  const itemsByGroup = new Map<string, DatasetItem[]>();
  for (const item of items) {
    const groupItems = itemsByGroup.get(item.group_id) ?? [];
    groupItems.push(item);
    itemsByGroup.set(item.group_id, groupItems);
  }
  const orderedGroups = groups;
  const sections = orderedGroups
    .map((group) => ({ group, items: orderDatasetItems(itemsByGroup.get(group.id) ?? []) }))
    .filter((section) => section.items.length > 0);
  const knownGroupIds = new Set(groups.map((group) => group.id));
  const ungrouped = orderDatasetItems(items.filter((item) => !knownGroupIds.has(item.group_id)));
  if (ungrouped.length > 0) sections.push({ group: { id: "__ungrouped__", name: "未分组", enabled: true, repeats: 1 }, items: ungrouped });
  return sections;
}

function effectiveTrainingItemCount(items: DatasetItem[], groups: TrainingDataset["groups"]) {
  const enabledGroupIds = new Set(groups.filter((group) => group.enabled).map((group) => group.id));
  return items.filter((item) => item.enabled && enabledGroupIds.has(item.group_id)).length;
}

function duration(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function statusText(status: string) {
  return ({ starting: "正在启动", running: "训练中", stopping: "正在停止", completed: "已完成", failed: "失败", interrupted: "已中断" } as Record<string, string>)[status] ?? status;
}

function secondsText(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value < 120) return `${Math.round(value * 10) / 10} 秒`;
  return duration(value);
}

function runTarget(run: Run) {
  return run.manifest?.run?.max_train_steps ?? run.manifest?.config?.max_train_steps ?? null;
}

function runNoteText(run: Run) {
  return run.manifest?.run?.note ?? run.manifest?.run_settings?.note ?? "";
}

function runPhaseText(status: Run["status"]) {
  if (status.phase === "cache") {
    const progress = status.cache_progress;
    return progress ? `缓存 ${progress.done}/${progress.total}` : "缓存";
  }
  if (status.phase === "train") return "训练";
  return "";
}

function browserId(prefix: string) {
  const value = new Uint8Array(6);
  crypto.getRandomValues(value);
  return `${prefix}-${[...value].map((entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-card lora-training-empty"><div><h3>{title}</h3><p>{detail}</p></div></div>;
}

function LoraDatasetLoading({ name }: { name?: string }) {
  return <div className="lora-dataset-workspace lora-dataset-loading" aria-busy="true" aria-label="正在加载数据集">
    <section className="lora-panel lora-panel--overview"><header><div><h3>{name || "训练项目"}</h3><p>正在载入项目信息…</p></div></header><div className="lora-dataset-loading-fields"><i /><i /><i /></div></section>
    <div className="lora-material-workspace"><section className="lora-panel"><header><div><h3>素材与分组</h3><p>正在载入素材…</p></div></header><div className="lora-dataset-loading-grid">{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</div></section><aside className="lora-panel lora-caption-dock"><header><div><h3>Caption</h3><p>正在载入当前素材…</p></div></header></aside></div>
  </div>;
}

function guideInline(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const value = match[0];
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(value);
    if (link) nodes.push(<a key={`${index}-${link[2]}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
    else nodes.push(<code key={`${index}-${value}`}>{value.slice(1, -1)}</code>);
    cursor = index + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function MarkdownGuide({ markdown }: { markdown: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(<p key={`p-${blocks.length}`}>{guideInline(paragraph.join(" "))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) {
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={`l-${blocks.length}`}>{list.map((item, index) => <li key={`${index}-${item}`}>{guideInline(item)}</li>)}</Tag>);
    }
    list = [];
  };
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      if (heading[1].length === 1) blocks.push(<h2 key={`h-${blocks.length}`}>{guideInline(heading[2])}</h2>);
      else if (heading[1].length === 2) blocks.push(<h3 key={`h-${blocks.length}`}>{guideInline(heading[2])}</h3>);
      else blocks.push(<h4 key={`h-${blocks.length}`}>{guideInline(heading[2])}</h4>);
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const nextOrdered = Boolean(numbered);
      if (list.length && nextOrdered !== ordered) flushList();
      ordered = nextOrdered;
      list.push((numbered ?? bullet)![1]);
      continue;
    }
    if (list.length) list[list.length - 1] = `${list[list.length - 1]} ${line}`;
    else paragraph.push(line);
  }
  flushParagraph(); flushList();
  return <article className="lora-activation-guide">{blocks}</article>;
}

export default function LoraTrainingView({ section, allRuns = false, datasetId, createDatasetRequest = 0, onSectionChange, onDatasetSelected, onDatasetsChange, onTaskCountsChange, onDirtyChange }: { section: SectionKey; allRuns?: boolean; datasetId?: string; createDatasetRequest?: number; onSectionChange: (section: SectionKey) => void; onDatasetSelected?: (datasetId: string) => void; onDatasetsChange?: (datasets: LoraDatasetSummary[]) => void; onTaskCountsChange?: (tasks: number, runs: number) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { confirm, notify } = useFeedback();
  const base = "/api/lora-training";
  const [client] = useState(() => createTrainingClient());
  const mutateFactsApi = <T,>(input: RequestInfo | URL, init?: RequestInit) => apiWith<T>(client.write, input, init);
  const deriveFactsApi = mutateFactsApi;
  const readFactsApi = <T,>(input: RequestInfo | URL, init?: RequestInit) => apiWith<T>(client.read, input, init);
  const mutateDerivedApi = api;

  const [datasets, setDatasets] = useState<LoraDatasetSummary[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState(() => datasetId || readLoraDatasetSelection());
  const [datasetDetail, setDatasetDetailState] = useState<DatasetDetail | null>(null);
  const datasetSource = useRef<DatasetDetail | null>(null);
  function setDatasetDetail(value: SetStateAction<DatasetDetail | null>) {
    if (typeof value !== "function") datasetSource.current = value;
    setDatasetDetailState(value);
  }
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [datasetDirty, setDatasetDirty] = useState(false);
  const [captionDirty, setCaptionDirty] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  function syncRunSummary(detail: TaskDetail) {
    setTasks(current => current.map(task => task.id === detail.id ? { ...task, runs: detail.runs.map(run => ({ id: run.id, status: run.status.status, step: run.status.step, created_at: run.created_at ?? run.manifest?.created_at ?? "", resumable: Boolean(run.resumable), ...(run.legacy ? { legacy: true, legacy_note: run.legacy_note } : {}), disk_bytes: run.disk_bytes })) } : task));
  }
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskLoadError, setTaskLoadError] = useState("");
  const [taskDetail, setTaskDetailState] = useState<TaskDetail | null>(null);
  const taskSource = useRef<TaskDetail | null>(null);
  function setTaskDetail(value: SetStateAction<TaskDetail | null>) {
    if (typeof value !== "function") taskSource.current = value;
    setTaskDetailState(value);
  }
  const [taskDirty, setTaskDirty] = useState(false);
  const [environment, setEnvironment] = useState<Environment | null>(() => readLoraEnvironmentCache());
  const [environmentLoading, setEnvironmentLoading] = useState(() => !readLoraEnvironmentCache());
  const [environmentError, setEnvironmentError] = useState("");
  const [recipes, setRecipes] = useState<TrainingRecipe[]>([]);
  const [runSettings, setRunSettings] = useState<RunSettingsDetail | null>(null);
  const [runNote, setRunNote] = useState("");
  useEffect(() => { setRunNote(""); }, [selectedTaskId]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState("");
  const [showCreateDataset, setShowCreateDataset] = useState(false);
  const [newDataset, setNewDataset] = useState({ name: "" });
  const [showActivationGuide, setShowActivationGuide] = useState(false);
  const [activationGuide, setActivationGuide] = useState<ActivationGuide | null>(null);
  const [activationGuideLoading, setActivationGuideLoading] = useState(false);
  const [captionItemId, setCaptionItemId] = useState("");
  const [captionDictionary, setCaptionDictionary] = useState<Map<string, CaptionDictionaryMatch>>(new Map());
  const [captionDictionaryState, setCaptionDictionaryState] = useState<"idle" | "loading" | "ready" | "unavailable" | "error">("idle");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [resumeDraft, setResumeDraft] = useState<{ run: Run; target: string; note: string } | null>(null);
  useEffect(() => {
    if (section === "runs" && !runsLoading) onTaskCountsChange?.(tasks.length, runs.length);
  }, [section, runsLoading, tasks.length, runs.length]);
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const [postprocessPreview, setPostprocessPreview] = useState<PostprocessPreview | null>(null);
  const [postprocessError, setPostprocessError] = useState("");
  const [imagePreview, setImagePreview] = useState<TrainingImagePreview | null>(null);
  const datasetMenuRef = useRef<HTMLDivElement | null>(null);
  const [datasetContextMenu, setDatasetContextMenu] = useState<DatasetContextMenu | null>(null);
  useFloatingLayer(datasetMenuRef, datasetContextMenu);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const datasetLoadRequestRef = useRef(0);
  const taskLoadRequestRef = useRef(0);

  useEffect(() => {
    if (datasetId && datasetId !== selectedDatasetId) {
      writeLoraDatasetSelection(datasetId);
      setSelectedDatasetId(datasetId);
    }
  }, [datasetId]);
  useEffect(() => {
    if (createDatasetRequest > 0) {
      setNewDataset({ name: "" });
      setShowCreateDataset(true);
    }
  }, [createDatasetRequest]);
  useEffect(() => { onDirtyChange?.(datasetDirty || captionDirty || taskDirty); }, [datasetDirty, captionDirty, taskDirty]);

  async function perform<T>(name: string, operation: () => Promise<T>) {
    setBusy(name);
    try {
      const result = await operation();
      return result;
    } catch (error) {
      const message = readableError(error) || "请求失败";
      if (name.startsWith("postprocess-")) setPostprocessError(message);
      else notify({ kind: "error", message });
      return null;
    } finally {
      setBusy("");
    }
  }

  const loadDatasets = async (preferred?: string, showLoading = false) => {
    if (showLoading) setDatasetsLoading(true);
    try {
      const collection = await readFactsApi<{ datasets: LoraDatasetSummary[] }>(`${base}/datasets`);
      setDatasets(collection.datasets);
      onDatasetsChange?.(collection.datasets);
      const available = collection.datasets.filter((item) => !item.error);
      const next = [preferred, selectedDatasetId].find((id) => id && available.some((item) => item.id === id)) || available[0]?.id || "";
      if (next) writeLoraDatasetSelection(next);
      if (next !== selectedDatasetId) setDatasetLoading(Boolean(next));
      else if (!next) setDatasetLoading(false);
      setSelectedDatasetId(next);
      // 仅内部选定或回退时通知导航；不能用 Effect 将尚未同步的旧选择回传。
      onDatasetSelected?.(next);
      return next;
    } finally {
      if (showLoading) setDatasetsLoading(false);
    }
  };
  const loadDataset = async (id = selectedDatasetId) => {
    const requestId = ++datasetLoadRequestRef.current;
    if (!id) { setDatasetDetail(null); setDatasetLoading(false); return; }
    setDatasetLoading(true);
    setDatasetDetail((current) => current?.id === id ? current : null);
    try {
      const value = await readFactsApi<DatasetDetail>(`${base}/datasets/${encodeURIComponent(id)}`);
      if (requestId !== datasetLoadRequestRef.current) return;
      setDatasetDetail(value);
      setDatasetDirty(false);
      setCaptionDirty(false);
      setCaptionItemId((current) => value.items.some((item) => item.id === current) ? current : value.items[0]?.id ?? "");
    } finally {
      if (requestId === datasetLoadRequestRef.current) setDatasetLoading(false);
    }
  };
  const loadTasks = async (preferred?: string) => {
    const collection = await readFactsApi<{ tasks: TaskSummary[] }>(`${base}/tasks`);
    setTasks(collection.tasks);
    onTaskCountsChange?.(collection.tasks.length, collection.tasks.reduce((sum, task) => sum + (task.runs?.length ?? 0), 0));
    const next = preferred || selectedDatasetId || collection.tasks.find((item) => !item.error)?.id || "";
    setSelectedTaskId(next);
    return next;
  };
  const loadTask = async (id = selectedTaskId, reloadSettings = true) => {
    const requestId = ++taskLoadRequestRef.current;
    setTaskLoadError("");
    if (!id) { setTaskDetail(null); setRunSettings(null); setTaskLoading(false); return; }
    setTaskLoading(true);
    try {
    const [value, settings] = await Promise.all([readFactsApi<TaskDetail>(`${base}/tasks/${encodeURIComponent(id)}`), reloadSettings ? readFactsApi<RunSettingsDetail>(`${base}/tasks/${encodeURIComponent(id)}/run-settings`) : Promise.resolve(null)]);
    if (requestId !== taskLoadRequestRef.current) return;
    setTaskDetail(value);
    syncRunSummary(value);
    if (settings) setRunSettings(settings);
    setTaskDirty(false);
    setPreflight(null);
    } catch (error) {
      if (requestId !== taskLoadRequestRef.current) return;
      setTaskLoadError(readableError(error) || "请求失败");
      throw error;
    } finally {
      if (requestId === taskLoadRequestRef.current) setTaskLoading(false);
    }
  };
  const toggleActivationGuide = async () => {
    if (showActivationGuide) { setShowActivationGuide(false); return; }
    setShowActivationGuide(true);
    if (activationGuide) return;
    setActivationGuideLoading(true);
    try {
      setActivationGuide(await api<ActivationGuide>("/api/lora-training/guides/activation-tags"));
    } catch (error) {
      setShowActivationGuide(false);
      notify({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setActivationGuideLoading(false);
    }
  };
  const refreshTask = async (id = selectedTaskId) => { const selected = await loadTasks(id); await loadTask(selected, false); };
  const loadEnvironment = async (force = false) => {
    const cached = force ? null : readLoraEnvironmentCache();
    if (force && typeof window !== "undefined") {
      try { window.sessionStorage.removeItem(loraEnvironmentStorageKey()); } catch { /* 忽略不可用的 sessionStorage。 */ }
    }
    if (cached) {
      setEnvironment(cached);
      setEnvironmentError("");
      setEnvironmentLoading(false);
    } else {
      setEnvironmentLoading(true);
    }
    try {
      const value = await requestLoraEnvironment(force);
      writeLoraEnvironmentCache(value);
      setEnvironment(value);
      setEnvironmentError("");
      return value;
    } catch (error) {
      setEnvironmentError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setEnvironmentLoading(false);
    }
  };

  useEffect(() => {
    const rememberedDatasetId = datasetId || readLoraDatasetSelection();
    setSelectedDatasetId(rememberedDatasetId); setDatasetDetail(null); setDatasets([]); setDatasetsLoading(true); setDatasetLoading(Boolean(rememberedDatasetId)); setSelectedTaskId(""); setTaskDetail(null); setRunSettings(null); setPreflight(null);
    const cachedEnvironment = readLoraEnvironmentCache();
    setEnvironment(cachedEnvironment);
    setEnvironmentLoading(!cachedEnvironment);
    setEnvironmentError("");
    void loadEnvironment().catch(() => undefined);
    void Promise.all([
      api<{ recipes: TrainingRecipe[] }>("/api/lora-training/recipes").then((value) => setRecipes(value.recipes)),
      loadDatasets(rememberedDatasetId, true),
      loadTasks(),
    ]).catch((error) => notify({ kind: "error", message: error.message }));
  }, []);
  useEffect(() => { setSelectedTaskId(selectedDatasetId); }, [selectedDatasetId]);
  useEffect(() => { void loadDataset(selectedDatasetId).catch((error) => notify({ kind: "error", message: error.message })); }, [selectedDatasetId, notify]);
  useEffect(() => { setImagePreview(null); setDatasetContextMenu(null); setShowActivationGuide(false); setPostprocessPreview(null); }, [selectedDatasetId, section]);
  useEffect(() => {
    if (!imagePreview) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setImagePreview(null); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [imagePreview]);
  useEffect(() => {
    if (!showActivationGuide) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setShowActivationGuide(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showActivationGuide]);
  useDismissableLayer({ open: Boolean(datasetContextMenu), ref: datasetMenuRef, onClose: () => setDatasetContextMenu(null), closeOnScroll: true });
  useEffect(() => { if (section !== "runs") void loadTask(selectedTaskId).catch((error) => notify({ kind: "error", message: error.message })); }, [selectedTaskId, section, notify]);
  const acceptRuns = (value: Run[]) => {
    setRuns(value);
    setSelectedRunId(current => value.some(run => run.id === current) ? current : value[0]?.id ?? "");
    setRunsLoading(false);
  };
  const loadRuns = async () => acceptRuns(allRuns ? (await api<{ runs: Run[] }>(`${base}/runs`)).runs : selectedDatasetId ? (await api<{ runs: Run[] }>(`${base}/tasks/${selectedDatasetId}`)).runs : []);
  useEffect(() => {
    if (section !== "runs") return;
    setRuns([]); setSelectedRunId(""); setRunsLoading(true);
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        const value = allRuns ? await api<{ runs: Run[] }>(`${base}/runs`) : selectedDatasetId ? await api<{ runs: Run[] }>(`${base}/tasks/${selectedDatasetId}`) : { runs: [] };
        if (!stopped) acceptRuns(value.runs);
      } catch (error) {
        if (!stopped) { setRunsLoading(false); notify({ kind: "error", message: error instanceof Error ? error.message : String(error) }); }
      }
      if (!stopped) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [section, selectedDatasetId, allRuns]);
  useEffect(() => {
    const active = taskDetail?.runs.some((run) => ["starting", "running", "stopping"].includes(run.status.status));
    if (section === "runs" || !active || !selectedTaskId) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        // 轮询仅接纳运行记录；不更换草稿、保存版本或用户填写的运行参数。
        const value = await api<TaskDetail>(`${base}/tasks/${encodeURIComponent(selectedTaskId)}`);
        if (!stopped) {
          setTaskDetail((current) => current?.id === value.id ? { ...current, runs: value.runs } : current);
          syncRunSummary(value);
        }
      } catch { /* 下一轮重试。 */ }
      if (!stopped) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [section, selectedTaskId, taskDetail?.runs.some((run) => ["starting", "running", "stopping"].includes(run.status.status))]);

  const mutateDataset = (update: (dataset: TrainingDataset) => TrainingDataset) => {
    setDatasetDetail((current) => current ? { ...current, dataset: update(structuredClone(current.dataset)) } : current);
    setDatasetDirty(true);
  };
  const mutateTask = (update: (task: TrainingTask) => TrainingTask) => {
    setTaskDetail((current) => current ? { ...current, task: update(structuredClone(current.task)) } : current);
    setTaskDirty(true);
    setPreflight(null);
  };

  const createDataset = async (event: FormEvent) => {
    event.preventDefault();
    const created = await perform("create-dataset", () => mutateFactsApi<DatasetDetail>(`${base}/datasets`, { method: "POST", body: JSON.stringify({ name: newDataset.name }) }));
    if (!created) return;
    setNewDataset({ name: "" });
    setShowCreateDataset(false);
    setSelectedDatasetId(created.id);
    onDatasetSelected?.(created.id);
    await loadDatasets(created.id);
    setDatasetDetail(created);
  };
  const saveDataset = async () => {
    if (!datasetDetail) return;
    const saved = await perform("save-dataset", () => mutateFactsApi<DatasetDetail>(`${base}/datasets/${datasetDetail.id}`, { method: "PUT", body: JSON.stringify(datasetDetail.dataset) }));
    if (saved) { setDatasetDetail(saved); setDatasetDirty(false); await loadDatasets(saved.id); await loadTasks(); }
  };
  const selectTask = async (id: string) => {
    if (id === selectedTaskId) return;
    if (taskDirty && !await confirm({ kind: "warning", title: "切换训练设置", message: "当前配置尚未保存，切换会放弃这些修改。", confirmLabel: "放弃并切换", danger: true })) return;
    setRunNote("");
    setSelectedTaskId(id);
  };
  const saveTask = async () => {
    if (!taskDetail) return;
    const saved = await perform("save-task", () => mutateFactsApi<TaskDetail>(`${base}/tasks/${taskDetail.id}`, { method: "PUT", body: JSON.stringify(taskDetail.task) }));
    if (saved) { setTaskDetail(saved); setTaskDirty(false); await loadTasks(saved.id); await loadTask(saved.id); }
  };
  const upload = async (files: FileList | null) => {
    if (!datasetDetail || !files?.length) return;
    const group = datasetDetail.dataset.groups.find((item) => item.enabled) ?? datasetDetail.dataset.groups[0];
    if (!group) { notify({ kind: "warning", message: "请先建立分组" }); return; }
    const form = new FormData();
    form.set("group_id", group.id);
    for (const file of files) form.append("files", file);
    const updated = await perform("upload", () => mutateFactsApi<DatasetDetail>(`${base}/datasets/${datasetDetail.id}/assets`, { method: "POST", body: form }));
    if (updated) { if (updated.items.some(item => item.preparation_error)) notify({ kind: "warning", message: "素材已保存，但部分图片处理失败；卡片显示原因，可点击重试。" }); setDatasetDetail(updated); await loadDatasets(updated.id); await loadTasks(); }
    if (uploadRef.current) uploadRef.current.value = "";
  };
  const createCrop = async (draft = cropDraft, overwrite = true) => {
    if (!datasetDetail || !draft) return;
    if (datasetDirty || captionDirty) { notify({ kind: "warning", message: "当前有未保存的 Caption 或数据集修改，请先保存后再应用图片后处理" }); return; }
    const upscale = draft.upscale === true;
    const outputScale = draft.outputScale ?? 2;
    const request = postprocessRequestForDraft(draft);
    const requestKey = JSON.stringify(request);
    setPostprocessError("");
    if (postprocessPreview?.key === requestKey) {
      const updated = await perform("postprocess-apply", () => mutateFactsApi<DatasetDetail>(`${base}/datasets/${datasetDetail.id}/postprocess/apply`, { method: "POST", body: JSON.stringify({ ...request, preview_id: postprocessPreview.previewId }) }));
      if (updated) { if (updated.items.some(item => item.preparation_error)) notify({ kind: "warning", message: "素材已保存，但部分图片处理失败；卡片显示原因，可点击重试。" }); setDatasetDetail(updated); setCropDraft(null); setPostprocessPreview(null); await loadDatasets(updated.id); await loadTasks(); }
      return;
    }
    const preview = await perform("postprocess-preview", () => deriveFactsApi<{ preview_id: string; fingerprint: string; output_sha256: string; width: number; height: number }>(`${base}/datasets/${datasetDetail.id}/postprocess/preview`, { method: "POST", body: JSON.stringify(request) }));
    if (!preview) return;
    setPostprocessPreview({ previewId: preview.preview_id, key: requestKey, width: preview.width, height: preview.height, src: `/api/lora-training/datasets/${encodeURIComponent(datasetDetail.id)}/postprocess/preview/${preview.preview_id}` });
  };
  const restoreOriginal = async () => {
    if (!datasetDetail || !cropDraft) return;
    if (datasetDirty || captionDirty) { notify({ kind: "warning", message: "当前有未保存的 Caption 或数据集修改，请先保存后再恢复原图" }); return; }
    const updated = await perform("postprocess-restore", () => mutateFactsApi<DatasetDetail>(`${base}/datasets/${datasetDetail.id}/postprocess/restore`, { method: "POST", body: JSON.stringify({ item_id: cropDraft.itemId }) }));
    if (updated) { if (updated.items.some(item => item.preparation_error)) notify({ kind: "warning", message: "素材已保存，但部分图片处理失败；卡片显示原因，可点击重试。" }); setDatasetDetail(updated); setCropDraft(null); setPostprocessPreview(null); await loadDatasets(updated.id); await loadTasks(); }
  };
  const openPostprocess = (item: DatasetItem) => {
    const width = item.original_image_width ?? item.image_width ?? 1;
    const height = item.original_image_height ?? item.image_height ?? 1;
    const crop = item.processing?.crop;
    setDatasetContextMenu(null);
    setPostprocessPreview(null);
    setPostprocessError("");
    setCropDraft({
      itemId: item.id,
      x: crop ? crop.x / width : 0,
      y: crop ? crop.y / height : 0,
      width: crop ? crop.width / width : 1,
      height: crop ? crop.height / height : 1,
      cropEnabled: Boolean(crop && (crop.x !== 0 || crop.y !== 0 || crop.width !== width || crop.height !== height)),
      upscale: item.processing?.upscale === true,
      outputScale: item.processing?.output_scale === 1 ? 1 : item.processing?.output_scale === 4 ? 4 : 2,
    });
  };
  const copyDatasetItem = async (item: DatasetItem | null) => {
    if (!datasetDetail || !item) return;
    setDatasetContextMenu(null);
    const updated = await perform("copy-item", () => mutateFactsApi<DatasetDetail>(`${base}/datasets/${datasetDetail.id}/copies`, { method: "POST", body: JSON.stringify({ source_item_id: item.id, group_id: item.group_id }) }));
    if (updated) { if (updated.items.some(item => item.preparation_error)) notify({ kind: "warning", message: "素材已保存，但部分图片处理失败；卡片显示原因，可点击重试。" }); setDatasetDetail(updated); await loadDatasets(updated.id); await loadTasks(); }
  };
  const mergedDatasetItems = useMemo(() => mergeDatasetItems(datasetDetail?.items ?? [], datasetDetail?.dataset.items ?? []), [datasetDetail?.items, datasetDetail?.dataset.items]);
  const captionItem = mergedDatasetItems.find((item) => item.id === captionItemId) ?? null;
  const captioningItem = datasetDetail?.captioning.items.find((entry) => entry.item_id === captionItemId) ?? null;
  const captionDictionaryPrompts = useMemo(() => [...new Set([
    ...captionPieces(captionItem?.caption ?? ""),
    ...captionPieces(captioningItem?.base_prompt ?? ""),
  ].map((value) => value.trim()).filter(Boolean))], [captionItem?.caption, captioningItem?.base_prompt]);
  useEffect(() => {
    if (!captionDictionaryPrompts.length) {
      setCaptionDictionary(new Map());
      setCaptionDictionaryState("idle");
      return;
    }
    let active = true;
    setCaptionDictionaryState("loading");
    void api<{ available?: boolean; matches?: CaptionDictionaryMatch[] }>("/api/prompt-dictionary/matches", { method: "POST", body: JSON.stringify({ scope: "lora", prompts: captionDictionaryPrompts }) })
      .then((payload) => {
        if (!active) return;
        if (payload.available === false) {
          setCaptionDictionary(new Map());
          setCaptionDictionaryState("unavailable");
          return;
        }
        setCaptionDictionary(new Map((payload.matches ?? []).map((match) => [captionDictionaryKey(match.prompt_text), match])));
        setCaptionDictionaryState("ready");
      })
      .catch(() => {
        if (!active) return;
        setCaptionDictionary(new Map());
        setCaptionDictionaryState("error");
      });
    return () => { active = false; };
  }, [captionDictionaryPrompts]);
  const captioningAvailable = environment?.captioning.ready === true;
  const setCaptionText = (text: string) => {
    if (!captionItem) return;
    setCaptionDirty(true);
    setDatasetDetail((current) => current ? { ...current, items: current.items.map((item) => item.id === captionItem.id ? { ...item, caption: text } : item) } : current);
  };
  const removeCaptionPart = (index: number) => {
    if (!captionItem) return;
    const parts = captionPieces(captionItem.caption);
    parts.splice(index, 1);
    setCaptionText(parts.join(", "));
  };
  const addCaptionPart = (value: string) => {
    if (!captionItem) return;
    const tag = value.trim();
    if (!tag) return;
    const parts = captionPieces(captionItem.caption);
    if (parts.some((part) => captionDictionaryKey(part) === captionDictionaryKey(tag))) return;
    setCaptionText([...parts, tag].join(", "));
  };
  const cropItem = mergedDatasetItems.find((item) => item.id === cropDraft?.itemId) ?? null;
  const selectedDatasetSummary = datasets.find((item) => item.id === selectedDatasetId) ?? null;
  const currentPostprocessKey = cropDraft ? JSON.stringify(postprocessRequestForDraft(cropDraft)) : null;
  const freshPostprocessPreviewMatches = Boolean(postprocessPreview && postprocessPreview.key === currentPostprocessKey);
  const appliedPostprocessMatches = Boolean(cropItem && cropDraft && processingMatchesDraft(cropItem, cropDraft));
  const comparisonImage = freshPostprocessPreviewMatches && postprocessPreview
    ? { src: postprocessPreview.src, width: postprocessPreview.width, height: postprocessPreview.height }
    : appliedPostprocessMatches && cropItem
      ? { src: datasetMediaUrl(cropItem, "current"), width: cropItem.image_width ?? undefined, height: cropItem.image_height ?? undefined }
      : null;
  const visibleDatasetSections = useMemo(() => orderDatasetSections(mergedDatasetItems, datasetDetail?.dataset.groups ?? []), [mergedDatasetItems, datasetDetail?.dataset.groups]);
  const effectiveItemCount = useMemo(() => effectiveTrainingItemCount(mergedDatasetItems, datasetDetail?.dataset.groups ?? []), [mergedDatasetItems, datasetDetail?.dataset.groups]);
  const taskEffectiveItemCount = taskDetail && datasetDetail?.id === taskDetail.dataset.id
    ? effectiveItemCount
    : taskDetail?.dataset.effective_item_count ?? taskDetail?.dataset.enabled_item_count ?? 0;
  const lowResolutionTrainingItems = useMemo(() => {
    const enabledGroups = new Set((datasetDetail?.dataset.groups ?? []).filter((group) => group.enabled).map((group) => group.id));
    return mergedDatasetItems.filter((item) => item.enabled && enabledGroups.has(item.group_id) && hasLowResolution(item.image_width, item.image_height));
  }, [mergedDatasetItems, datasetDetail?.dataset.groups]);
  const contextMenuItem = datasetContextMenu ? mergedDatasetItems.find((item) => item.id === datasetContextMenu.itemId) ?? null : null;
  const removeDatasetItem = async (itemId: string) => {
    const item = mergedDatasetItems.find((entry) => entry.id === itemId);
    setDatasetContextMenu(null);
    if (!item || !await confirm({ kind: "warning", title: "移除训练素材", message: `确认从数据集中移除“${item.asset_id}”？\n保存后会删除对应的图片与 Caption 文件；未保存前刷新页面仍可恢复。`, danger: true })) return;
    mutateDataset((dataset) => ({ ...dataset, items: dataset.items.filter((entry) => entry.id !== itemId) }));
    if (captionItemId === itemId) setCaptionItemId("");
  };
  const runCaptioning = async (mode: "missing" | "single", itemId?: string) => {
    if (!datasetDetail) return;
    const target = mode === "single" ? datasetDetail.items.find((item) => item.id === itemId) : null;
    if (mode === "single" && !target) return;
    const overwritesCaption = Boolean(target?.caption.trim());
    if (mode === "single" && overwritesCaption && !await confirm({ kind: "warning", title: "覆盖当前 Caption", message: "重新打标此图会覆盖当前 Caption 及其逐图确认，并丢弃旧基础 Prompt。确认继续吗？", danger: true })) return;
    const result = await perform(`caption-run:${mode}`, () => mutateFactsApi<{ run_id: string; processed: number; updated: number }>(`${base}/datasets/${datasetDetail.id}/caption-runs`, { method: "POST", body: JSON.stringify({ mode, ...(mode === "single" ? { item_id: itemId, confirm_overwrite: overwritesCaption } : {}) }) }));
    if (!result) return;
    await loadDataset(datasetDetail.id);
  };
  const prepareImages = async () => {
    if (!datasetDetail || captionDirty || datasetDirty || cropDraft) return;
    const requestId = datasetLoadRequestRef.current;
    setBusy("prepare-images");
    try {
      const result = await mutateFactsApi<PrepareResult>(`${base}/datasets/${datasetDetail.id}/postprocess/prepare`, { method: "POST", body: JSON.stringify({ item_ids: datasetDetail.items.filter(item => !item.preparation || item.preparation_error).map(item => item.id) }) });
      if (requestId !== datasetLoadRequestRef.current) return;
      setDatasetDetail(result.dataset);
      if (result.failed.length) notify({ kind: "warning", message: `部分图片自动准备失败，保留原状态。${result.failed[0].asset_id}：${result.failed[0].error.details?.join("；") || result.failed[0].error.code}。处理原因后点击重试。` });
      await loadTasks();
    } catch (error) {
      notify({ kind: "error", message: `图片自动准备失败：${readableError(error)}。处理原因后点击重试。` });
    } finally {
      setBusy("");
    }
  };
  const saveCaption = async () => {
    if (!datasetDetail || !captionItem) return;
    const saved = await perform("caption", () => mutateFactsApi<{ saved: boolean; item_id: string; caption: string }>(`${base}/datasets/${datasetDetail.id}/captions/${captionItem.id}`, { method: "PUT", body: JSON.stringify({ caption: captionItem.caption }) }));
    if (saved) { setCaptionDirty(false); await loadDataset(datasetDetail.id); }
  };
  const confirmCaption = async () => {
    if (!datasetDetail || !captionItem || captionDirty || !captionItem.caption.trim()) return;
    const confirmed = await perform("caption-confirm", () => mutateFactsApi<{ saved: boolean; confirmed: boolean }>(`${base}/datasets/${datasetDetail.id}/captioning/items/${captionItem.id}`, { method: "PUT", body: JSON.stringify({ prompt: captionItem.caption, confirm: true }) }));
    if (confirmed) { await loadDataset(datasetDetail.id); }
  };
  const runPreflight = async () => {
    if (!taskDetail || !runSettings) return;
    const result = await perform("preflight", () => readFactsApi<Preflight>(`${base}/tasks/${taskDetail.id}/preflight`, { method: "POST", body: JSON.stringify({ run_settings: { note: runNote } }) }));
    if (result) setPreflight(result);
  };
  const startTraining = async () => {
    if (!taskDetail || !runSettings) return;
    const started = await perform("start", () => deriveFactsApi(`${base}/tasks/${taskDetail.id}/runs`, { method: "POST", body: JSON.stringify({ run_settings: { note: runNote } }) }));
    if (started) { onSectionChange("runs"); await refreshTask(taskDetail.id); }
  };

  const currentRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  const currentModel = useMemo(() => taskDetail?.task.target.base.dit.relative_path ?? "", [taskDetail]);
  const selectedRecipe = useMemo(() => recipes.find((recipe) => recipe.id === taskDetail?.task.training_recipe.id) ?? null, [recipes, taskDetail?.task.training_recipe.id]);
  const taskOverrides = taskDetail?.task.training_recipe.overrides;
  const networkDim = Number(taskOverrides?.network_dim ?? selectedRecipe?.semantic_config.network_dim ?? runSettings?.semantic_config.network_dim ?? 0);
  const accumulation = Number(taskOverrides?.gradient_accumulation_steps ?? selectedRecipe?.semantic_config.gradient_accumulation_steps ?? runSettings?.semantic_config.gradient_accumulation_steps ?? 0);
  const accumulationValid = Number.isInteger(accumulation) && accumulation >= 1;
  const maxTrainSteps = taskDetail?.task.run_defaults.max_train_steps ?? 0;
  const optimizerType = selectedRecipe?.semantic_config.optimizer.type ?? runSettings?.semantic_config.optimizer.type ?? "AdamW";
  const environmentProblems = environment?.checks.filter((check) => !check.ok).map((check) => check.message) ?? [];
  const environmentState = environmentLoading ? "is-checking" : environment?.available ? "is-ready" : "is-blocked";
  const environmentStatusText = environmentLoading ? "环境检查中" : environment?.available ? "环境就绪" : "环境不可用";
  const environmentStatusTitle = environmentLoading
    ? "正在检查训练器、CUDA、底座模型和打标器文件；首次检查可能需要几十秒。"
    : environmentProblems.length
      ? environmentProblems.join("；")
      : environmentError || "无法读取训练环境状态";
  const setOverride = (key: RecipeOverrideKey, raw: string, kind: "integer" | "number" = "integer") => mutateTask((task) => {
    const overrides = { ...task.training_recipe.overrides };
    overrides[key] = kind === "integer" ? Math.trunc(Number(raw)) : Number(raw);
    return { ...task, training_recipe: { ...task.training_recipe, overrides } };
  });
  const setRunSetting = (key: Exclude<RunSettingKey, "gradient_accumulation_steps">, raw: string) => {
    mutateTask(task => ({ ...task, run_defaults: { ...task.run_defaults, [key]: Math.trunc(Number(raw)) } }));
  };
  const recipeField = (definition: typeof RECIPE_PARAMETER_DEFINITIONS[number]) => {
    const { key, label, kind, description } = definition;
    return <label key={key}><span className="lora-field-label">{label}<i className="lora-info" data-tooltip={description} aria-label={`${label}说明`} tabIndex={0}>?</i></span><input type="number" min={kind === "integer" ? 1 : 0} step={kind === "integer" ? 1 : "any"} value={String(taskDetail?.task.training_recipe.overrides[key] ?? selectedRecipe?.semantic_config[key] ?? "")} onChange={event => setOverride(key, event.target.value, kind)} /></label>;
  };
  const runField = (definition: typeof RUN_PARAMETER_DEFINITIONS[number]) => {
    const { key, label, description } = definition;
    return <label key={key}><span className="lora-field-label">{label}<i className="lora-info" data-tooltip={description} aria-label={`${label}说明`} tabIndex={0}>?</i></span><input type="number" min={1} step={1} value={String(taskDetail?.task.run_defaults[key] ?? "")} onChange={event => setRunSetting(key, event.target.value)} /></label>;
  };
  const applyPreset = async (id: string) => {
    const recipe = recipes.find(item => item.id === id);
    if (!recipe || !taskDetail) return;
    const changes = RECIPE_PARAMETER_DEFINITIONS.filter(({ key }) => taskDetail.task.training_recipe.overrides[key] !== recipe.semantic_config[key]).map(({ key, label }) => `${label}：${taskDetail.task.training_recipe.overrides[key]} → ${recipe.semantic_config[key]}`);
    if (!await confirm({ kind: "warning", title: "应用参数预设", message: `${changes.join("；") || "训练参数与该预设一致"}。总更新步数、保存间隔与随机种子保持当前值；应用后仍需保存配置。`, confirmLabel: "应用到草稿" })) return;
    mutateTask(task => ({ ...task, training_recipe: { id, overrides: Object.fromEntries(RECIPE_PARAMETER_DEFINITIONS.map(({ key }) => [key, recipe.semantic_config[key]])) } }));
  };
  const currentParameters: Record<string, unknown> = { ...taskDetail?.task.training_recipe.overrides, ...taskDetail?.task.run_defaults };
  const parameterChanges = runSettings?.last_run ? [...RECIPE_PARAMETER_DEFINITIONS, ...RUN_PARAMETER_DEFINITIONS].map(({ key, label }) => {
    const before = runSettings.last_run!.config?.[key];
    return { key, label, before, after: currentParameters[key] };
  }).filter(item => item.before !== undefined && item.before !== item.after) : [];
  const checkpointSteps = (() => {
    const total = taskDetail?.task.run_defaults.max_train_steps ?? 0;
    const interval = taskDetail?.task.run_defaults.save_every_n_steps ?? 0;
    if (interval < 1 || total < interval) return "保存间隔应为正整数且不超过总步数";
    const count = Math.floor(total / interval);
    return count <= 8 ? `预计保存：${Array.from({ length: count }, (_, index) => (index + 1) * interval).join("、")} 步；结束时另存最终模型。` : `每 ${interval} 步保存，共 ${count} 个定期检查点；结束时另存最终模型。`;
  })();

  const runAction = async (requester: TrainingRequester, name: string, path: string, method: "POST" | "PUT" | "DELETE") => {
    const result = await perform(name, () => apiWith(requester, path, { method, body: JSON.stringify({}) }));
    if (result) await loadRuns();
  };
  const deleteRun = async (run: Run) => {
    if (!run.manifest?.task_id) return;
    if (!await confirm({ kind: "warning", title: "删除训练记录", message: "只删除训练快照、日志和记录；已经生成的 checkpoint 会保留在 LoRA 目录中。", confirmLabel: "删除记录", danger: true })) return;
    await runAction(fetch, "delete-run", `${base}/tasks/${run.manifest.task_id}/runs/${run.id}`, "DELETE");
  };
  const resumeDraftStep = resumeDraft?.run.status.resume?.step ?? 0;
  const resumeTarget = Math.trunc(Number(resumeDraft?.target));
  const resumeTargetValid = Boolean(resumeDraft) && Number.isFinite(Number(resumeDraft?.target)) && resumeTarget > resumeDraftStep;
  const submitResume = async () => {
    if (!resumeDraft || !resumeTargetValid) return;
    const run = resumeDraft.run;
    const pointer = run.status.resume;
    const taskId = run.manifest?.task_id;
    if (!pointer || !taskId) return;
    setBusy("resume");
    try {
      // 续训要求 If-Match：先读取任务事实的最新版本，再提交。
      await readFactsApi(`${base}/tasks/${encodeURIComponent(taskId)}`);
      const response = await client.write(`${base}/tasks/${encodeURIComponent(taskId)}/runs/${run.id}/resume`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ max_train_steps: resumeTarget, ...(resumeDraft.note.trim() ? { note: resumeDraft.note.trim() } : {}), source_snapshot_id: pointer.snapshot_id, source_sha256: pointer.sha256 }) });
      const value = await response.json().catch(() => ({}));
      if (response.status === 409 && value?.error === "lora_training_resume_source_stale") {
        notify({ kind: "warning", message: "恢复状态已被更新的训练取代。已刷新训练记录，请确认最新恢复点后重试。" });
        setResumeDraft(null);
        await loadRuns();
        return;
      }
      if (!response.ok) throw new Error(readableError(value) || `请求失败：${response.status}`);
      setResumeDraft(null);
      await loadRuns();
      if (value?.run?.id) setSelectedRunId(value.run.id);
    } catch (error) {
      notify({ kind: "error", message: readableError(error) || "请求失败" });
    } finally {
      setBusy("");
    }
  };
  const refreshTraining = async () => {
    if (section === "runs") { await perform("refresh", loadRuns); return; }
    if ((datasetDirty || taskDirty || captionDirty) && !await confirm({ kind: "warning", title: "重新读取训练数据", message: "刷新会放弃当前未保存修改，是否继续？", danger: true })) return;
    await perform("refresh", async () => { const dataset = await loadDatasets(); await loadDataset(dataset); const task = await loadTasks(); await loadTask(task); });
  };
  const refreshAction = <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void refreshTraining()}>刷新</button>;
  const factDraftDirty = datasetDirty || taskDirty || captionDirty || showCreateDataset || Boolean(cropDraft);
  const captionerName = environment?.captioning.manifest?.name ?? environment?.captioning.id ?? "打标器";
  const captionMatchFor = (value: string) => captionDictionary.get(captionDictionaryKey(value));

  return <section className="utility-page lora-training-page" data-project-write-section={section === "runs" ? "derived" : "facts"} data-project-fact-dirty={factDraftDirty ? "true" : undefined}>
    {!allRuns && <nav className="lora-actions" aria-label="训练项目内容"><button className="button" aria-current={section === "datasets" ? "page" : undefined} onClick={() => onSectionChange("datasets")}>素材与 Caption</button><button className="button" disabled={!selectedDatasetId} aria-current={section === "tasks" ? "page" : undefined} onClick={() => onSectionChange("tasks")}>训练设置</button><button className="button" aria-current={section === "runs" ? "page" : undefined} onClick={() => onSectionChange("runs")}>训练记录</button></nav>}
    {section === "datasets" && <>
      <WorkspaceHeader actions={refreshAction} title={datasetDetail?.dataset.name || selectedDatasetSummary?.name || "训练项目"} meta={datasetDetail ? `已确认 ${datasetDetail.captioning.summary.confirmed}/${datasetDetail.captioning.summary.total} · 待确认 ${datasetDetail.captioning.summary.unconfirmed}` : undefined} />
      {showCreateDataset && <form className="lora-create-card" onSubmit={(event) => void createDataset(event)}><header><div><h3>新建训练项目</h3><p>创建后再加入图片和 Caption。</p></div></header><div className="lora-form-grid"><label><span>名称</span><input autoFocus required value={newDataset.name} onChange={(event) => setNewDataset({ name: event.target.value })} /></label></div><footer><button type="button" className="button" onClick={() => setShowCreateDataset(false)}>取消</button><button className="button button--primary" disabled={Boolean(busy) || !newDataset.name.trim()}>创建训练项目</button></footer></form>}
      <div className="lora-training-layout lora-training-layout--dataset">
        {!datasetDetail ? datasetsLoading || datasetLoading ? <LoraDatasetLoading name={selectedDatasetSummary?.name} /> : <EmptyState title="暂无数据集" detail="新建训练项目后即可准备素材。" /> : <div className="lora-dataset-workspace" inert={["prepare-images", "upload", "postprocess-apply", "postprocess-restore"].includes(busy)}>
          <section className="lora-panel lora-panel--overview"><header><div><h3>项目信息</h3><p>{datasetDetail.id}</p></div></header><div className="lora-form-grid"><label><span>名称</span><input value={datasetDetail.dataset.name} onChange={(event) => mutateDataset((dataset) => ({ ...dataset, name: event.target.value }))} /></label><label className="is-wide"><span>说明</span><textarea value={datasetDetail.dataset.description} onChange={(event) => mutateDataset((dataset) => ({ ...dataset, description: event.target.value }))} /></label></div><div className="lora-activation-editor"><header><div><h4>激活标签 <small>可选</small></h4><p>用于在生成时调用训练概念；按顺序保存为字符串列表。</p></div><button type="button" className="button" aria-haspopup="dialog" aria-expanded={showActivationGuide} onClick={() => void toggleActivationGuide()}>激活标签说明</button></header><div className="lora-activation-terms">{datasetDetail.dataset.activation_terms.map((term, index) => <div key={index}><label><span>标签</span><input value={term} placeholder="简短、可读、低冲突" onChange={(event) => mutateDataset((dataset) => ({ ...dataset, activation_terms: dataset.activation_terms.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry) }))} /></label><button className="icon-button" title="删除激活标签" onClick={() => mutateDataset((dataset) => ({ ...dataset, activation_terms: dataset.activation_terms.filter((_, entryIndex) => entryIndex !== index) }))}>×</button></div>)}</div><button className="button" onClick={() => mutateDataset((dataset) => ({ ...dataset, activation_terms: [...dataset.activation_terms, ""] }))}>新增激活标签</button></div></section>
          <div className="lora-material-workspace">
            <section className="lora-panel"><header><div><h3>素材与分组</h3><p>实际训练集 {effectiveItemCount} 张 · 素材共 {mergedDatasetItems.length} 张{lowResolutionTrainingItems.length > 0 && <span className="lora-material-warning" title={`训练预检：${lowResolutionTrainingItems.length} 张实际训练图片短边低于 ${TRAINING_MIN_SHORT_SIDE} 像素`}> · {lowResolutionTrainingItems.length} 张短边低于 {TRAINING_MIN_SHORT_SIDE}</span>}{environment && environment.optional_capabilities?.upscaler?.ready !== true && <span className="lora-material-warning"> · 图片超分不可用：{environment.optional_capabilities?.upscaler?.message ?? "模型未就绪"}</span>}</p></div><div className="lora-actions"><input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => void upload(event.target.files)} /><button className="button" onClick={() => uploadRef.current?.click()} disabled={Boolean(busy)}>上传图片</button></div></header>
              <div className="lora-captioning-actions"><div><strong>基础 Prompt</strong><span>默认只处理缺失 Caption；需要覆盖时请在当前图片的 Caption 面板中单独重新打标。</span>{!environment ? <small>正在检查打标器配置…</small> : !captioningAvailable ? <small>{environment.captioning.message || (environment.captioning.configured ? "打标器文件未就绪" : "尚未配置打标器")}</small> : null}</div><div className="lora-actions"><button className="button" disabled={Boolean(busy) || captionDirty || !captioningAvailable} title={!environment ? "正在检查打标器配置" : captioningAvailable ? undefined : environment.captioning.message} onClick={() => void runCaptioning("missing")}>为无标签图片生成基础 Prompt</button></div></div>
              <p className="lora-auto-preparation" role="status">{["prepare-images", "upload", "postprocess-apply", "postprocess-restore"].includes(busy) ? "正在处理图片：缩放、评分及必要的超分，请稍候…" : "导入和应用裁剪时处理为 1024 训练图；原图保留。"}</p>
              {datasetDetail.items.some(item => !item.preparation || item.preparation_error) && <button className="button" disabled={Boolean(busy) || datasetDirty || captionDirty || Boolean(cropDraft)} onClick={() => void prepareImages()}>重试未完成图片</button>}
              <div className="lora-groups">{datasetDetail.dataset.groups.map((group) => <div className={`lora-group-row${group.enabled ? "" : " is-disabled"}`} key={group.id}><label className="lora-group-enabled"><input type="checkbox" checked={group.enabled} onChange={(event) => mutateDataset((dataset) => ({ ...dataset, groups: dataset.groups.map((entry) => entry.id === group.id ? { ...entry, enabled: event.target.checked } : entry) }))} /><span>启用</span></label><input className="lora-group-name" aria-label="分组名称" value={group.name} onChange={(event) => mutateDataset((dataset) => ({ ...dataset, groups: dataset.groups.map((entry) => entry.id === group.id ? { ...entry, name: event.target.value } : entry) }))} /><span className="lora-group-count">{datasetDetail.dataset.items.filter((item) => item.group_id === group.id).length} 张</span><label className="lora-group-repeats"><span>重复</span><input type="number" min="1" value={group.repeats} onChange={(event) => mutateDataset((dataset) => ({ ...dataset, groups: dataset.groups.map((entry) => entry.id === group.id ? { ...entry, repeats: Number(event.target.value) } : entry) }))} /></label><button className="icon-button" title="删除空分组" disabled={datasetDetail.dataset.items.some((item) => item.group_id === group.id) || datasetDetail.dataset.groups.length <= 1} onClick={() => mutateDataset((dataset) => ({ ...dataset, groups: dataset.groups.filter((entry) => entry.id !== group.id) }))}>×</button></div>)}<button className="button" onClick={() => mutateDataset((dataset) => ({ ...dataset, groups: [...dataset.groups, { id: browserId("group"), name: "新分组", enabled: true, repeats: 1 }] }))}>新增分组</button></div>
                {visibleDatasetSections.length ? (
                  <div className="lora-material-groups">
                    {visibleDatasetSections.map(({ group, items }) => (
                      <section className={`lora-material-group${group.enabled ? "" : " is-disabled"}`} key={group.id}>
                        <header className="lora-material-group-header"><strong>{group.name}</strong><span>{items.length} 张</span></header>
                        <div className="lora-image-grid">
                          {items.map((item) => {
                      const lowResolution = hasLowResolution(item.image_width, item.image_height);
                      const captionStatus = captionStatusForItem(item, datasetDetail.captioning.items.find((entry) => entry.item_id === item.id));
                      const postprocessStatus = postprocessLabel(item);
                      return (
                        <article
                          key={item.id}
                          className={`${item.enabled ? "" : "is-disabled"} ${postprocessStatus ? "is-processed" : ""} ${lowResolution ? "has-warning" : ""} ${captionItemId === item.id ? "is-selected" : ""}`}
                          title="右键查看分组、复制、图片后处理和移除操作"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setDatasetContextMenu({ itemId: item.id, x: event.clientX, y: event.clientY });
                          }}
                        >
                          <button
                            type="button"
                            className="lora-image-button"
                            aria-pressed={captionItemId === item.id}
                            onClick={(event) => {
                              const wasSelected = captionItemId === item.id;
                              setCaptionItemId(item.id);
                              if (wasSelected && event.target instanceof HTMLImageElement) {
                                setImagePreview({ src: datasetMediaUrl(item), alt: `训练素材 · ${item.asset_id}`, footer: `${item.preparation ? "训练图 · 已准备" : "当前素材 · 尚未完成训练图准备"} · ${item.asset_id} · ${resolution(item.image_width, item.image_height)} · ${bytes(item.image_bytes)}` });
                              }
                            }}
                            title="点击选中；已选中后点击缩略图可全屏查看"
                          >
                            <span className="lora-image-thumb" title={captionStatus.detail}>
                              <img src={mediaVariantUrl(datasetMediaUrl(item), 320)} alt="训练素材" loading="lazy" decoding="async" />
                              <span className={`lora-caption-status is-${captionStatus.key}`} aria-hidden="true"><i />{captionStatus.label}</span>
                              {lowResolution && <i className="lora-image-warning" title={`图片短边低于 ${TRAINING_MIN_SHORT_SIDE} 像素`} aria-label="低分辨率警告" tabIndex={0}>!</i>}
                              {postprocessStatus && <span className="lora-postprocess-status">{postprocessStatus}</span>}
                            </span>
                            <span className="lora-image-meta">
                              <span className="lora-image-dimensions"><span>{resolution(item.original_image_width ?? item.image_width, item.original_image_height ?? item.image_height)}</span><span>→ {resolution(item.image_width, item.image_height)}</span></span>
                              {item.preparation ? <span className="lora-quality-scores" title={item.preparation.decision === "enhanced" ? "缩放后 → 超分后，已采用超分" : item.preparation.decision === "already_good" ? "缩放后评分；分数足够，未执行超分" : "缩放后 → 超分后；提升不足，使用缩放图"}>MUSIQ {item.preparation.before_score.toFixed(1)}{item.preparation.after_score !== null && ` → ${item.preparation.after_score.toFixed(1)}${item.preparation.decision === "no_gain" ? "（未采用）" : ""}`}</span> : <span className="lora-quality-scores" title={item.preparation_error}>处理失败 · 请重试</span>}
                            </span>
                          </button>
                        </article>
                      );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : <div className="lora-empty"><b>暂无图片</b><span>上传图片后即可开始整理。</span></div>}
             </section>
          <section className="lora-panel lora-caption-dock" aria-label="Caption 编辑">
            <header><div><h3>{captionItem?.asset_id ?? "Caption"}</h3><p>{captionItem ? `${datasetDetail.items.findIndex((item) => item.id === captionItem.id) + 1} / ${datasetDetail.items.length}` : "选择图片"}</p></div><div className="lora-caption-dock-actions">{captionDirty && <span className="lora-state is-warning">未保存</span>}{captionItem && <button className="button" disabled={Boolean(busy) || captionDirty || !captioningAvailable} title="只重新打标当前图片；覆盖已有 Caption 前会请求确认" onClick={() => void runCaptioning("single", captionItem.id)}>重新打标此图</button>}{captionItem && <button className="button button--primary" disabled={Boolean(busy) || !captionDirty} onClick={() => void saveCaption()}>保存 Caption</button>}{captionItem && captioningItem && captioningItem.state !== "confirmed" && <button className="button" disabled={Boolean(busy) || captionDirty || !captionItem.caption.trim()} onClick={() => void confirmCaption()}>确认当前 Caption</button>}</div></header>
            {captionItem ? <div className="lora-caption-editor"><button type="button" className="lora-caption-preview" onClick={() => setImagePreview({ src: datasetMediaUrl(captionItem), alt: `训练素材 · ${captionItem.asset_id}`, footer: `${captionItem.preparation ? "训练图 · 已准备" : "当前素材 · 尚未完成训练图准备"} · ${captionItem.asset_id} · ${resolution(captionItem.image_width, captionItem.image_height)} · ${bytes(captionItem.image_bytes)}` })} title="全屏查看训练素材"><img src={datasetMediaUrl(captionItem)} alt="当前素材" /></button><div>
              <section className="lora-caption-current" aria-label="当前 Caption 标签"><header><span>当前 Caption</span><small>点击标签删除；标签仍以英文 Danbooru 文本保存</small></header><div className="lora-caption-tag-list">{captionPieces(captionItem.caption).map((tag, index) => <CaptionTagChip key={`${tag}-${index}`} value={tag} match={captionMatchFor(tag)} rawTag={rawCaptionTag(captioningItem?.raw_tags, tag)} onClick={() => removeCaptionPart(index)} actionLabel="点击删除" />)}{!captionPieces(captionItem.caption).length && <p className="lora-caption-tag-empty">当前没有 Caption 标签，请从下方添加。</p>}</div><CaptionTagPicker existingTags={captionPieces(captionItem.caption)} onAdd={addCaptionPart} disabled={Boolean(busy)} />{captionDictionaryState === "loading" && <small className="lora-caption-dictionary-state">正在读取标签翻译…</small>}{captionDictionaryState === "unavailable" && <small className="lora-caption-dictionary-state is-warning">词库不可用，仍可以添加手动标签。</small>}{captionDictionaryState === "error" && <small className="lora-caption-dictionary-state is-warning">标签翻译读取失败，仍可以继续编辑。</small>}</section>
              <details className="lora-caption-raw-editor"><summary>直接编辑 Caption 文本</summary><textarea value={captionItem.caption} onChange={(event) => setCaptionText(event.target.value)} /></details>
              {captioningItem && <div className={`lora-caption-confirmation is-${captioningItem.state}`}><strong>{captioningItem.state === "confirmed" ? "已确认" : captioningItem.state === "unconfirmed" ? "待确认" : "未打标"}</strong><span>{captioningItem.state === "confirmed" ? "当前图片与 Caption 的哈希已绑定。" : captioningItem.state === "unconfirmed" ? "图片或 Caption 已变化，请先保存 Caption，再确认当前 Caption。" : "请先生成基础 Prompt，或先保存 Caption，再确认当前 Caption。"}</span></div>}
              {captioningItem && captioningItem.base_prompt !== null ? <details className="lora-caption-base"><summary>基础 Prompt（{captionerName}）</summary><div className="lora-caption-tag-list is-read-only">{captionPieces(captioningItem.base_prompt).map((tag, index) => <CaptionTagChip key={`${tag}-${index}`} value={tag} match={captionMatchFor(tag)} rawTag={rawCaptionTag(captioningItem.raw_tags, tag)} />)}</div><code>{captioningItem.base_prompt}</code></details> : <p className="lora-caption-empty-note">尚未生成基础 Prompt。</p>}
              <p>当前 Caption 写入素材目录固定的 <code>caption.txt</code>；基础 Prompt 由打标器生成，作为只读基准。</p>
            </div></div> : <div className="lora-empty"><span>点击素材图片后，在这里编辑 Caption。</span></div>}
          </section>
          </div>
          {datasetDirty && <button type="button" className="button button--primary lora-dataset-savebar" disabled={Boolean(busy)} onClick={() => void saveDataset()}>保存数据集修改</button>}
        </div>}
      </div>
    </>}

    {section === "tasks" && <>
      <WorkspaceHeader title={`${taskDetail?.task.name ?? "训练项目"} · 训练设置`} actions={<div className="lora-toolbar-actions">{refreshAction}<div className={`training-environment training-environment--inline ${environmentState}`} title={environmentStatusTitle}><i /><div><b>{environmentStatusText}</b>{environment?.runtime && <span>{environment.runtime.gpu} · {Math.round(environment.runtime.vram_bytes / 1024 ** 3)} GB</span>}{!environmentLoading && !environment?.available && environmentProblems.length > 0 && <span>{environmentProblems[0]}</span>}</div></div><button className="button" disabled={environmentLoading || Boolean(busy)} title="跳过缓存，重新检查训练器、GPU、底座模型和打标器" onClick={() => void loadEnvironment(true)}>重新检查环境</button></div>} />
      <div className="lora-training-layout lora-training-layout--dataset">
        {taskLoading || (selectedTaskId && taskDetail?.id !== selectedTaskId && !taskLoadError) ? <div className="lora-panel" role="status" aria-busy="true">正在加载训练设置…</div> : taskLoadError ? <div className="lora-panel" role="alert"><p>方案加载失败：{taskLoadError}</p><button className="button" onClick={() => void loadTask().catch(() => undefined)}>重试</button></div> : !taskDetail ? <EmptyState title={datasets.length ? "暂无训练设置" : "请先建立数据集"} detail={datasets.length ? "请先选择训练项目。" : "创建项目时自动建立训练配置。"} /> : <div className="lora-task-workspace" key={taskDetail.id}>
          <section className="lora-panel lora-panel--overview"><header><div><h3>训练设置</h3><p>可复用的训练配置</p></div><div className="lora-actions"><span className={`lora-state ${taskDirty ? "is-warning" : "is-ready"}`}>{taskDirty ? "未保存" : "已保存"}</span><button className="button button--primary" disabled={!taskDirty || !accumulationValid || Boolean(busy)} onClick={() => void saveTask()}>保存配置</button></div></header><p>{taskDetail.task.name} · 当前项目的训练配置</p><details className="lora-model-detail"><summary>底座模型 · Qwen-Image-2.1</summary><p>{currentModel}</p><small>创建方案后固定</small><p>方案 ID · {taskDetail.id}</p></details>
            <p>实际训练集 {taskEffectiveItemCount} 张 · 以下配置统一保存，后续训练沿用。</p>
            <h4 className="lora-section-title">训练设置</h4>
            <div className="lora-parameter-grid">{RUN_PARAMETER_DEFINITIONS.filter(item => item.key !== "save_every_n_steps").map(runField)}{RECIPE_PARAMETER_DEFINITIONS.filter(item => item.key === "learning_rate").map(recipeField)}</div>
            <p className="lora-preflight-hint">Micro Batch 固定 1 · 有效 Batch {accumulationValid ? accumulation : "—"} · 本轮图片处理量 {accumulationValid && maxTrainSteps > 0 ? maxTrainSteps * accumulation : "—"} 张次</p>
            <details className="lora-model-detail"><summary>LoRA 与优化器 · Rank {networkDim || "—"} / Alpha {networkDim || "—"} · {optimizerType}</summary><div className="lora-parameter-grid">{RECIPE_PARAMETER_DEFINITIONS.filter(item => item.key !== "learning_rate").map(recipeField)}<label><span className="lora-field-label">Alpha<i className="lora-info" data-tooltip="Alpha 恒等于 Rank，不提供独立旋钮。" aria-label="Alpha说明" tabIndex={0}>?</i></span><input readOnly value={networkDim || ""} /></label><label><span className="lora-field-label">Micro Batch<i className="lora-info" data-tooltip="单次前后向固定处理 1 张图片；批量通过梯度累积调整。" aria-label="Micro Batch说明" tabIndex={0}>?</i></span><input readOnly value="1" /></label><label><span>优化器（预设固定）</span><input readOnly value={optimizerType} /></label></div><div className="lora-actions"><span>参数预设</span>{recipes.map(recipe => <button className="button" key={recipe.id} onClick={() => void applyPreset(recipe.id)}>应用 {recipe.name}</button>)}</div><small>仅提供初始参数，不限制训练题材。应用前显示变化。</small></details>
            {!accumulationValid && <p role="alert" className="run-error">梯度累积必须为正整数。</p>}
            <h4 className="lora-section-title">检查点保存</h4><div className="lora-parameter-grid">{RUN_PARAMETER_DEFINITIONS.filter(item => item.key === "save_every_n_steps").map(runField)}</div><p className="lora-preflight-hint">{checkpointSteps}</p>
          </section>
          <section className="lora-panel"><header><div><h3>启动本轮训练</h3><p>使用已保存配置创建独立训练记录</p></div></header>
          {runSettings?.last_run ? <details className="lora-model-detail" open><summary>与上次训练的参数差异 · {parameterChanges.length} 项</summary>{parameterChanges.length ? <ul>{parameterChanges.map(item => <li key={item.key}>{item.label}：{String(item.before ?? "未记录")} → {String(item.after)}</li>)}</ul> : <p>训练参数相同。图片与 Caption 仍以启动时的数据集为准。</p>}</details> : <p>尚无历史训练可比较。</p>}
          <label className="lora-run-note"><span>本次训练备注</span><textarea value={runNote} onChange={event => { setRunNote(event.target.value); setPreflight(null); }} placeholder="例如：学习率改为 0.00005，比较与上一轮的差异" /><small>仅保存到本次训练记录，不写入当前配置。</small></label>{preflight ? <div className="preflight-grid"><div className="preflight-section preflight-section--blockers"><b>阻断项（{preflight.blockers.length}）</b>{preflight.blockers.length ? <ul>{preflight.blockers.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul> : <p className="is-good">无</p>}</div><div className="preflight-section preflight-section--warnings"><b>警告（{preflight.warnings.length}）</b>{preflight.warnings.length ? <ul>{preflight.warnings.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul> : <p className="is-good">无</p>}</div><small>预计磁盘占用 {bytes(preflight.estimated_disk_bytes)} · 可用 {bytes(preflight.available_disk_bytes)}</small></div> : <p className="lora-preflight-hint">{taskDirty ? "请先保存方案修改，再执行预检。" : "确认本次参数后执行预检。"}</p>}<div className="lora-primary-action"><button className="button" disabled={taskDirty || !runSettings || !accumulationValid || Boolean(busy)} onClick={() => void runPreflight()}>执行预检</button><button className="button button--primary" disabled={!preflight?.ready || !accumulationValid || taskDirty || Boolean(busy) || !environment?.available} onClick={() => void startTraining()}>开始训练</button></div></section>
        </div>}
      </div>
    </>}

    {section === "runs" && <>
      <WorkspaceHeader actions={refreshAction} title={allRuns ? "全部训练记录" : "训练记录"} />
      <div className={`lora-training-layout ${runs.length ? "" : "is-empty"}`}>
        {runs.length > 0 && <aside className="lora-task-list"><header><h3>运行记录</h3><span>{runs.length}</span></header><div>{runs.map(run => <button key={run.id} className={run.id === currentRun?.id ? "is-active" : ""} onClick={() => setSelectedRunId(run.id)}><b>{run.manifest?.task_name ?? run.id}</b><span>{new Date(run.status.completed_at ?? run.status.interrupted_at ?? run.created_at ?? run.manifest?.created_at ?? "").toLocaleString()}</span><small>{run.legacy ? "历史记录" : statusText(run.status.status)}{run.status.status === "running" && runPhaseText(run.status) ? ` · ${runPhaseText(run.status)}` : ""} · {run.status.step}/{runTarget(run) ?? "—"} step{run.resumable && run.status.resume?.step != null ? ` · 可从第 ${run.status.resume.step} 步恢复` : ""}</small></button>)}</div></aside>}
        {!currentRun ? <EmptyState title={runsLoading ? "正在读取训练记录" : "暂无训练记录"} detail="每次启动训练独立记录，最近运行优先显示。" /> : <div className="lora-task-workspace"><section className="lora-panel"><header><div><h3>{currentRun.manifest?.task_name ?? currentRun.id}</h3><p>{[currentRun.manifest?.dataset_name, currentRun.id].filter(Boolean).join(" · ")}</p>{!currentRun.legacy && <p>Rank {currentRun.manifest?.semantic_config?.network_dim ?? currentRun.manifest?.config?.network_dim ?? "—"} · 学习率 {currentRun.manifest?.semantic_config?.learning_rate ?? currentRun.manifest?.config?.learning_rate ?? "—"}</p>}</div></header>
          {currentRun.legacy && <p className="lora-preflight-hint">{currentRun.legacy_note ?? "历史记录，不支持精确续训。"}</p>}
          {currentRun.manifest?.resume && <p className="lora-preflight-hint">续训自 {currentRun.manifest.resume.parent_run_id} · 从第 {currentRun.manifest.resume.start_step} 步继续</p>}
          {runNoteText(currentRun) && <p className="lora-run-note-text"><b>训练备注</b>{runNoteText(currentRun)}</p>}
          {currentRun ? (() => {
            const controls = loraRunControls(currentRun.status.status);
            const resumePointer = currentRun.status.resume ?? null;
            const performance = currentRun.status.performance ?? null;
            return <article className="lora-run-card"><header><div><b>{statusText(currentRun.status.status)}{["starting", "running", "stopping"].includes(currentRun.status.status) && runPhaseText(currentRun.status) ? ` · ${runPhaseText(currentRun.status)}` : ""}</b><span>{new Date(currentRun.created_at ?? currentRun.manifest?.created_at ?? "").toLocaleString()}</span></div><div className="lora-actions">
              {!currentRun.legacy && currentRun.resumable && resumePointer && <button className="button" disabled={Boolean(busy)} title="沿用父 run 冻结的数据集、模型与训练参数，从最新完整恢复状态继续" onClick={() => setResumeDraft({ run: currentRun, target: "", note: "" })}>继续训练</button>}
              {controls.showStop && currentRun.manifest?.task_id && <button className="button button--danger" disabled={Boolean(busy)} onClick={() => void runAction(fetch, "stop", `${base}/tasks/${currentRun.manifest!.task_id}/runs/${currentRun.id}/stop`, "POST")}>停止训练</button>}
              {controls.showDelete && currentRun.manifest?.task_id && <button className="button button--danger" disabled={Boolean(busy)} onClick={() => void deleteRun(currentRun)}>删除记录</button>}
            </div></header>
              <div className="run-metrics"><span><b>{currentRun.status.step}</b> / {runTarget(currentRun) ?? "—"} step</span><span>loss <b>{currentRun.status.loss?.toFixed(4) ?? "—"}</b></span><span>当前 LR <b>{typeof currentRun.status.lr === "number" ? currentRun.status.lr.toExponential(2) : "—"}</b></span><span>已处理 <b>{currentRun.status.samples_seen ?? "—"}</b> 张次</span><span>预计剩余 <b>{duration(currentRun.status.eta_seconds)}</b></span><span>记录磁盘占用 <b>{bytes(currentRun.disk_bytes)}</b></span></div>
              {!currentRun.legacy && currentRun.resumable && resumePointer && <p className="lora-preflight-hint">可从第 {resumePointer.step ?? "—"} 步的完整恢复状态继续训练。</p>}
              {performance && <p className="lora-preflight-hint">总耗时 {secondsText(performance.wall_seconds)}{performance.phase_seconds?.cache != null && ` · 缓存 ${secondsText(performance.phase_seconds.cache)}`}{performance.phase_seconds?.train != null && ` · 训练 ${secondsText(performance.phase_seconds.train)}`}{performance.seconds_per_update != null && ` · 每更新 ${secondsText(performance.seconds_per_update)}`} · 处理 {performance.samples_seen ?? currentRun.status.samples_seen ?? "—"} 张次</p>}
              <LoraLossChart key={currentRun.id} history={currentRun.status.loss_history} log={currentRun.status.log_tail ?? ""} active={controls.showStop} />
              {currentRun.status.error && <p className="run-error">{currentRun.status.error}</p>}
              <div className="checkpoint-list">{(currentRun.status.checkpoints ?? []).map((checkpoint) => <article key={checkpoint.id}><div><b>Step {checkpoint.step || "末尾"}</b><span>{checkpoint.relative_path ?? checkpoint.file} · {bytes(checkpoint.size)} · {checkpoint.available === false ? "文件缺失" : "通用 LoRA"}</span></div></article>)}</div>
            </article>;
          })() : <div className="lora-empty"><span>该方案暂无训练记录。</span></div>}
          {currentRun?.status.log_tail && <details className="run-log"><summary>日志</summary>{currentRun.status.log_tail.includes("\ufffd") && <p>此记录包含已损坏的编码字符。原始内容保留；UTF-8 修复在更新服务后新启动的训练中生效。</p>}<pre>{currentRun.status.log_tail}</pre></details>}
        </section></div>}
      </div>
    </>}

    {datasetContextMenu && contextMenuItem && createPortal(<div ref={datasetMenuRef} className="navigation-context-menu lora-dataset-context-menu" role="menu" aria-label="训练素材操作" onPointerDown={(event) => event.stopPropagation()}><strong>{contextMenuItem.asset_id}</strong><button type="button" role="menuitem" onClick={() => { mutateDataset(dataset => ({ ...dataset, items: dataset.items.map(item => item.id === contextMenuItem.id ? { ...item, enabled: !item.enabled } : item) })); setDatasetContextMenu(null); }}>{contextMenuItem.enabled ? "停用此图" : "启用此图"}</button><label><span>分组</span><select value={contextMenuItem.group_id} onChange={(event) => mutateDataset((dataset) => ({ ...dataset, items: dataset.items.map((entry) => entry.id === contextMenuItem.id ? { ...entry, group_id: event.target.value } : entry) }))}>{datasetDetail?.dataset.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><button type="button" onClick={() => void copyDatasetItem(contextMenuItem)}>复制为独立训练项</button><button type="button" onClick={() => openPostprocess(contextMenuItem)}>图片后处理</button><button type="button" className="is-danger" onClick={() => removeDatasetItem(contextMenuItem.id)}>从数据集中移除</button></div>, floatingLayerHost())}
    {showActivationGuide && <Modal size="content" title="激活标签说明" onClose={() => setShowActivationGuide(false)} className="lora-guide-dialog"><div className="lora-guide-shell">{activationGuideLoading ? <p>正在读取说明…</p> : activationGuide ? <MarkdownGuide markdown={activationGuide.markdown} /> : null}</div></Modal>}
    {cropDraft && cropItem && <LoraCropEditor src={datasetMediaUrl(cropItem, "original")} comparisonSrc={comparisonImage?.src} comparisonWidth={comparisonImage?.width} comparisonHeight={comparisonImage?.height} comparisonMatches={Boolean(comparisonImage)} applyReady={freshPostprocessPreviewMatches} errorMessage={postprocessError} alt={`图片后处理 · ${cropItem.asset_id}`} imageWidth={cropItem.original_image_width ?? cropItem.image_width} imageHeight={cropItem.original_image_height ?? cropItem.image_height} initial={cropDraft} busy={Boolean(busy)} hasProcessing={Boolean(cropItem.processing || cropItem.preparation)} upscaleAvailable={environment?.optional_capabilities?.upscaler?.ready === true} upscaleDisabledReason={environment?.optional_capabilities?.upscaler?.message} onCancel={() => { setCropDraft(null); setPostprocessPreview(null); setPostprocessError(""); }} onDraftChange={(draft) => setCropDraft((current) => {
      if (!current || current.itemId !== cropItem.id) return current;
      const same = current.x === draft.x && current.y === draft.y && current.width === draft.width && current.height === draft.height && current.cropEnabled === draft.cropEnabled && current.upscale === draft.upscale && current.outputScale === draft.outputScale;
      return same ? current : { itemId: current.itemId, ...draft };
    })} onRestore={() => void restoreOriginal()} onConfirm={(rect, cropEnabled, upscale, outputScale) => void createCrop({ ...cropDraft, ...rect, cropEnabled, upscale, outputScale }, true)} />}
    {imagePreview && <ZoomableImageLightbox fullResolutionOnly src={imagePreview.src} alt={imagePreview.alt} footer={imagePreview.footer} onClose={() => setImagePreview(null)} />}
    {resumeDraft && <Modal title="继续训练" onClose={() => setResumeDraft(null)} busy={busy === "resume"} footer={<><button type="button" className="button" disabled={busy === "resume"} onClick={() => setResumeDraft(null)}>取消</button><button type="button" className="button button--primary" disabled={busy === "resume" || !resumeTargetValid} onClick={() => void submitResume()}>开始续训</button></>}>
      <p>从第 {resumeDraftStep} 步的完整恢复状态继续，创建新的训练记录。续训沿用父 run 冻结的数据集、模型、Rank、学习率、梯度累积与随机种子；首版只能修改累计目标步数与备注。</p>
      <label className="lora-run-note"><span>累计目标步数</span><input type="number" min={resumeDraftStep + 1} step={1} autoFocus value={resumeDraft.target} onChange={event => setResumeDraft(current => current ? { ...current, target: event.target.value } : current)} />{resumeDraft.target.trim() && !resumeTargetValid ? <small className="run-error">累计目标步数必须为大于 {resumeDraftStep} 的整数。</small> : <small>当前已完成 {resumeDraftStep} 步；目标为累计值，例如 {resumeDraftStep} → {resumeDraftStep + (resumeDraft.run.manifest?.run?.max_train_steps ?? resumeDraftStep)}。</small>}</label>
      <label className="lora-run-note"><span>备注（可选）</span><textarea value={resumeDraft.note} onChange={event => setResumeDraft(current => current ? { ...current, note: event.target.value } : current)} placeholder="例如：预算扩大到 4000，观察后期变化" /></label>
    </Modal>}
  </section>;
}
