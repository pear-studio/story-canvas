import { useState } from "react";

import ZoomableImageLightbox from "./ImageLightbox";
import { Modal } from "./Modal";

export type ResourcePreviewImage = { src: string; alt: string; source?: string };
export type ResourceDetail = { label: string; value?: string; values?: string[]; href?: string };
export const loraPurposes = ["画风", "角色", "服装／道具", "场景", "外观调节", "动作／效果", "未分类"] as const;
export type LoraPurpose = typeof loraPurposes[number];
export type ResourceCatalogItem = {
  id: string;
  kind: "base" | "lora" | "component";
  name: string;
  originalName?: string;
  summary?: string;
  purpose?: LoraPurpose;
  registered?: boolean;
  description?: string;
  architectureFamily?: string;
  relativePath: string;
  sizeBytes?: number | null;
  status: string;
  recordLabel: string;
  previewImages?: ResourcePreviewImage[];
  tags?: string[];
  details: ResourceDetail[];
};

export type LoraResourceDefinition = {
  id: string;
  name: string;
  name_zh?: string;
  summary_zh?: string;
  purpose?: LoraPurpose;
  file: { relative_path: string; sha256: string; size_bytes: number };
  architecture: { family: string; prompt_family: string };
  base_models: Array<{ name: string; relative_path?: string | null }>;
  activation: { trigger_words: string[]; tags: string[] };
  recommended_generation: {
    weight: { default: number | null; minimum: number | null; maximum: number | null; status: string };
    clip_skip?: number | null;
    sampler?: string | null;
    scheduler?: string | null;
    steps?: number | null;
    cfg?: number | null;
    status: string;
  };
  description: string;
  usage_notes?: string;
  source: { type: string; url?: string; version_name?: string; civitai_version_id?: number };
  previews: Array<{ file: string; alt: string; source?: string }>;
  examples: Array<{ file: string; prompt: string; alt?: string; source?: string }>;
};

export type LoraResourceEntry = {
  status: string;
  reason?: string | null;
  size_bytes?: number | null;
  repository_record?: boolean;
  storage?: string;
  resource: LoraResourceDefinition;
};

export type RawLoraResource = { id: string; name: string; relative_path: string; sha256: string; size_bytes: number; status: string };

export function loraResourceMediaUrl(resourceId: string, file: string) {
  return `/api/lora-resources/${encodeURIComponent(resourceId)}/media/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export function loraResourcePreviewImages(resource: LoraResourceDefinition): ResourcePreviewImage[] {
  const media = resource.previews.length ? resource.previews : resource.examples.slice(0, 3).map((example) => ({ ...example, alt: example.alt ?? `${resource.name} 的示例图` }));
  return media.map((item) => ({ src: loraResourceMediaUrl(resource.id, item.file), alt: item.alt, source: item.source }));
}

function loraSourceLabel(resource: LoraResourceDefinition) {
  const source = resource.source.type === "civitai" ? "Civitai" : resource.source.type === "local_training" ? "本地训练" : resource.source.type;
  const version = resource.source.version_name || (resource.source.civitai_version_id ? `版本 ${resource.source.civitai_version_id}` : "");
  return [source, version].filter(Boolean).join(" · ") || "未说明";
}

export function loraResourceCatalogItem(entry: LoraResourceEntry): ResourceCatalogItem {
  const { resource } = entry;
  const weight = resource.recommended_generation.weight;
  const range = weight.minimum !== null || weight.maximum !== null ? `${weight.minimum ?? "—"}～${weight.maximum ?? "—"}` : "";
  const generation = [resource.recommended_generation.steps ? `${resource.recommended_generation.steps} 步` : "", resource.recommended_generation.cfg !== null && resource.recommended_generation.cfg !== undefined ? `CFG ${resource.recommended_generation.cfg}` : "", resource.recommended_generation.sampler, resource.recommended_generation.scheduler].filter(Boolean).join(" · ");
  const repositoryRecord = entry.repository_record === true || entry.storage === "repository";
  return {
    id: resource.id,
    kind: "lora",
    name: resource.name_zh || resource.name,
    originalName: resource.name,
    summary: resource.summary_zh,
    purpose: resource.purpose ?? "未分类",
    registered: true,
    description: resource.description,
    architectureFamily: resource.architecture.family,
    relativePath: resource.file.relative_path,
    sizeBytes: entry.size_bytes ?? resource.file.size_bytes,
    status: entry.status,
    recordLabel: repositoryRecord ? "仓库登记" : "本机登记",
    previewImages: loraResourcePreviewImages(resource),
    tags: resource.activation.tags,
    details: [
      { label: "原名", value: resource.name },
      { label: "用途", value: resource.purpose ?? "未分类" },
      { label: "原始标签", values: resource.activation.tags },
      { label: "文件", value: resource.file.relative_path },
      { label: "大小", value: resourceBytes(entry.size_bytes ?? resource.file.size_bytes) },
      { label: "适用底座", value: resource.base_models.map((model) => model.name).join("、") || "未说明" },
      { label: "Prompt 家族", value: resource.architecture.prompt_family },
      { label: "触发词", values: resource.activation.trigger_words.length ? resource.activation.trigger_words : ["未提供"] },
      { label: "推荐权重", value: `${weight.default ?? "未测试"}${range ? `（${range}）` : ""}${weight.status === "tested" ? " · 已验证" : ""}` },
      { label: "建议参数", value: generation || "未提供" },
      { label: "来源 / 版本", value: loraSourceLabel(resource), href: resource.source.url },
      { label: "SHA-256", value: resource.file.sha256 },
    ],
  };
}

export function rawLoraCatalogItem(raw: RawLoraResource): ResourceCatalogItem {
  const checkpoint = raw.relative_path.startsWith("loras/training/");
  return {
    id: raw.id,
    kind: "lora",
    name: raw.name,
    purpose: "未分类",
    registered: false,
    relativePath: raw.relative_path,
    sizeBytes: raw.size_bytes,
    status: raw.status,
    recordLabel: checkpoint ? "训练 checkpoint" : "未登记",
    details: [
      { label: "文件", value: raw.relative_path },
      { label: "大小", value: resourceBytes(raw.size_bytes) },
      { label: "资源状态", value: checkpoint ? "训练 checkpoint，尚未登记为正式 LoRA" : "本机文件，尚未登记" },
      { label: "SHA-256", value: raw.sha256 },
    ],
  };
}

export function resourceBytes(value?: number | null) {
  if (!Number.isFinite(value)) return "—";
  if (Number(value) < 1024 ** 3) return `${Math.round(Number(value) / 1024 ** 2)} MB`;
  return `${(Number(value) / 1024 ** 3).toFixed(1)} GB`;
}

export function resourceStatusLabel(status: string) {
  if (status === "available") return "可用";
  if (status === "missing") return "缺失";
  if (status === "hash_mismatch") return "校验不符";
  if (status === "not_configured") return "未配置";
  if (status === "unavailable") return "不可用";
  return status || "需处理";
}

export function ResourcePreview({ images = [], placeholder, compact = false }: { images?: ResourcePreviewImage[]; placeholder: string; compact?: boolean }) {
  const [index, setIndex] = useState(0);
  const [opened, setOpened] = useState<ResourcePreviewImage | null>(null);
  const image = images[Math.min(index, Math.max(0, images.length - 1))];
  return <>
    <figure className={`resource-catalog-preview ${compact ? "is-compact" : ""} ${image ? "" : "is-empty"}`}>
      {image ? <button type="button" onClick={() => setOpened(image)} aria-label={`查看${image.alt}`}><img src={image.src} alt={image.alt} /></button> : <span>{placeholder}</span>}
      {images.length > 1 && <div className="resource-catalog-preview__nav"><button type="button" aria-label="上一张" onClick={() => setIndex((value) => (value - 1 + images.length) % images.length)}>‹</button><span>{index + 1}/{images.length}</span><button type="button" aria-label="下一张" onClick={() => setIndex((value) => (value + 1) % images.length)}>›</button></div>}
    </figure>
    {opened && <ZoomableImageLightbox src={opened.src} alt={opened.alt} footer={opened.source ?? placeholder} onClose={() => setOpened(null)} />}
  </>;
}

function ResourceDetails({ item }: { item: ResourceCatalogItem }) {
  return <div className="resource-details">
    <ResourcePreview images={item.previewImages} placeholder={item.kind === "lora" ? "LoRA" : item.kind === "base" ? "基模" : "组件"} />
    <div className="resource-details__body">
      {item.summary && <p>{item.summary}</p>}
      {item.description && <p>{item.description}</p>}
      <dl>{item.details.filter((detail) => detail.value || detail.values?.length).map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.values?.length ? <span className="resource-details__values">{detail.values.map((value) => <code key={value}>{value}</code>)}</span> : detail.href ? <a href={detail.href} target="_blank" rel="noreferrer">{detail.value}</a> : detail.value}</dd></div>)}</dl>
    </div>
  </div>;
}

export function ResourceDetailsButton({ item, label = "查看详情" }: { item: ResourceCatalogItem; label?: string }) {
  const [opened, setOpened] = useState(false);
  return <>
    <button className="button button--quiet" type="button" onClick={() => setOpened(true)}>{label}</button>
    {opened && <Modal size="workspace" title={item.name} subtitle={`${item.recordLabel} · ${resourceStatusLabel(item.status)}`} onClose={() => setOpened(false)} ariaLabel={`查看资源：${item.name}`}><ResourceDetails item={item} /></Modal>}
  </>;
}

export function ResourceCatalogCard({ item, onSelect, onInspect, busy = false, selected, onToggle }: { item: ResourceCatalogItem; onSelect?: (item: ResourceCatalogItem) => void; onInspect?: (item: ResourceCatalogItem) => void; busy?: boolean; selected?: boolean; onToggle?: () => void }) {
  return <article className={`resource-catalog-card ${item.kind === "lora" ? "is-lora" : ""} ${!item.previewImages?.length ? "without-preview" : ""} ${selected ? "is-selected" : ""} ${item.status !== "available" ? "has-warning" : ""}`}>
    {(item.kind !== "lora" || Boolean(item.previewImages?.length)) && <ResourcePreview images={item.previewImages} placeholder={item.kind === "lora" ? "LoRA" : "基模"} />}
    <div className="resource-catalog-card__body">
      <header><div><b>{item.name}</b><small>{item.architectureFamily ? `${item.architectureFamily.toUpperCase()} · ` : ""}{item.recordLabel}</small></div><span>{resourceStatusLabel(item.status)}</span></header>
      {item.originalName && item.originalName !== item.name && <small className="resource-catalog-card__original" title={item.originalName}>{item.originalName}</small>}
      {item.summary && <p className="resource-catalog-card__summary">{item.summary}</p>}
      {item.kind !== "lora" && <small className="resource-catalog-card__path" title={item.relativePath}>{item.relativePath}</small>}
      <div className="resource-catalog-card__tags">{item.purpose && <span>{item.purpose}</span>}{item.kind !== "lora" && item.tags?.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
      <footer>{onToggle && <label className="resource-picker-check"><input type="checkbox" checked={selected} disabled={busy} onChange={onToggle} aria-label={`选择 ${item.name}`} />{selected ? "已选择" : "选择"}</label>}{onInspect ? <button className="button button--quiet" type="button" onClick={() => onInspect(item)}>查看详情</button> : <ResourceDetailsButton item={item} />}{onSelect && <button className="button button--primary" type="button" disabled={busy} onClick={() => onSelect(item)}>选择</button>}</footer>
    </div>
  </article>;
}

export function ResourceCatalogGrid({ items, onSelect, onInspect, busy = false, empty }: { items: ResourceCatalogItem[]; onSelect?: (item: ResourceCatalogItem) => void; onInspect?: (item: ResourceCatalogItem) => void; busy?: boolean; empty: string }) {
  if (!items.length) return <div className="empty-card">{empty}</div>;
  return <div className="resource-catalog-grid">{items.map((item) => <ResourceCatalogCard key={item.id} item={item} onSelect={onSelect} onInspect={onInspect} busy={busy} />)}</div>;
}

export function ResourcePicker({ items, onSelect, onInspect, busy = false, empty = "当前没有可选择的资源。", selection }: { items: ResourceCatalogItem[]; onSelect?: (item: ResourceCatalogItem) => void; onInspect?: (item: ResourceCatalogItem) => void; busy?: boolean; empty?: string; selection?: { ids: string[]; onChange: (ids: string[]) => void } }) {
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState("registered");
  const isLora = items.every(item => item.kind === "lora");
  const query = search.trim().toLocaleLowerCase();
  const visible = items.filter(item => (!isLora || scope === "all" || (scope === "registered" ? item.registered !== false : item.registered === false))
    && (!purpose || item.purpose === purpose)
    && (!query || [item.name, item.originalName, item.summary, item.description, item.relativePath, item.id, ...(item.tags ?? [])].some(value => value?.toLocaleLowerCase().includes(query))));
  const ids = new Set(selection?.ids);
  return <div className="resource-picker">
    <div className="resource-picker-toolbar">
      <div className="resource-picker-filters">
        <label>搜索{isLora ? " LoRA" : "资源"}<input type="search" placeholder="中文名、原名、说明或标签" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {isLora && <><label>用途分类<select value={purpose} onChange={event => setPurpose(event.target.value)}><option value="">全部用途</option>{loraPurposes.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>资源范围<select value={scope} onChange={event => setScope(event.target.value)}><option value="registered">已登记</option><option value="raw">未登记／训练 checkpoint</option><option value="all">全部资源</option></select></label></>}
      </div>
      <div className="resource-picker-actions"><span>{visible.length} 项{selection ? ` · 已选择 ${ids.size} 项` : ""}</span>{selection && <><button type="button" className="button button--quiet" disabled={busy || !visible.length || visible.every(item => ids.has(item.id))} onClick={() => selection.onChange([...new Set([...selection.ids, ...visible.map(item => item.id)])])}>选择筛选结果（{visible.length}）</button><button type="button" className="button button--quiet" disabled={busy || !ids.size} onClick={() => selection.onChange([])}>清空选择</button></>}</div>
      {selection && ids.size > 0 && <div className="resource-picker-selected" aria-label="已选 LoRA">{items.filter(item => ids.has(item.id)).map(item => <button type="button" className="button button--quiet" disabled={busy} key={item.id} aria-label={`移除 ${item.name}`} onClick={() => selection.onChange(selection.ids.filter(id => id !== item.id))}>{item.name} ×</button>)}</div>}
    </div>
    {visible.length ? <div className="resource-catalog-grid">{visible.map(item => <ResourceCatalogCard key={item.id} item={item} onSelect={selection ? undefined : onSelect} onInspect={onInspect} busy={busy} selected={ids.has(item.id)} onToggle={selection ? () => selection.onChange(ids.has(item.id) ? selection.ids.filter(id => id !== item.id) : [...selection.ids, item.id]) : undefined} />)}</div> : <div className="empty-card">{items.length ? "没有匹配的资源，请调整搜索、用途或资源范围。" : empty}</div>}
  </div>;
}

export function ResourceCompactList({ items }: { items: ResourceCatalogItem[] }) {
  return <div className="resource-compact-list">{items.map((item) => <article className={item.status !== "available" ? "has-warning" : ""} key={item.id}><div><b>{item.name}</b><small title={item.relativePath}>{item.relativePath}</small></div><span>{item.recordLabel}</span><span>{resourceStatusLabel(item.status)}</span><ResourceDetailsButton item={item} /></article>)}</div>;
}
