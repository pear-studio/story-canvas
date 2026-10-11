import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import ZoomableImageLightbox from "./ImageLightbox";
import { Modal } from "./Modal";
import { FloatingPanel } from "./FloatingPanel";
import { floatingLayerHost } from "./floating-layer";

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
  ownerProjectId?: string;
  storage?: "repository" | "project" | "local";
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
  owner_project_id?: string;
  owner_project_title?: string;
  owner_project_type?: "story" | "training";
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
  const ownerLabel = entry.owner_project_id ? `${entry.owner_project_type === "training" ? "训练项目" : "剧情项目"}：${entry.owner_project_title || "未命名项目"}` : "工作台";
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
    ownerProjectId: entry.owner_project_id,
    storage: entry.owner_project_id ? "project" : repositoryRecord ? "repository" : "local",
    relativePath: resource.file.relative_path,
    sizeBytes: entry.size_bytes ?? resource.file.size_bytes,
    status: entry.status,
    recordLabel: ownerLabel,
    previewImages: loraResourcePreviewImages(resource),
    tags: resource.activation.tags,
    details: [
      { label: "归属", value: ownerLabel },
      { label: "项目 ID", value: entry.owner_project_id },
      { label: "登记位置", value: entry.owner_project_id ? "项目" : repositoryRecord ? "仓库" : "本机" },
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
    storage: "local",
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
      <div className="resource-catalog-card__tags">{item.purpose && <span>{item.purpose}</span>}{item.kind === "lora" && item.storage && <span>{item.storage === "repository" ? "仓库" : item.storage === "project" ? "项目" : "本机"}</span>}{item.kind !== "lora" && item.tags?.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
      <footer>{onToggle && <label className="resource-picker-check"><input type="checkbox" checked={selected} disabled={busy} onChange={onToggle} aria-label={`选择 ${item.name}`} />{selected ? "已选择" : "选择"}</label>}{onInspect ? <button className="button button--quiet" type="button" onClick={() => onInspect(item)}>查看详情</button> : <ResourceDetailsButton item={item} />}{onSelect && <button className="button button--primary" type="button" disabled={busy} onClick={() => onSelect(item)}>选择</button>}</footer>
    </div>
  </article>;
}

export function ResourceCatalogGrid({ items, onSelect, onInspect, busy = false, empty }: { items: ResourceCatalogItem[]; onSelect?: (item: ResourceCatalogItem) => void; onInspect?: (item: ResourceCatalogItem) => void; busy?: boolean; empty: string }) {
  if (!items.length) return <div className="empty-card">{empty}</div>;
  return <div className="resource-catalog-grid">{items.map((item) => <ResourceCatalogCard key={item.id} item={item} onSelect={onSelect} onInspect={onInspect} busy={busy} />)}</div>;
}

export type LoraCatalogSection = "registered" | "raw" | "checkpoints";
export function loraCatalogSection(item: ResourceCatalogItem): LoraCatalogSection {
  return item.registered !== false ? "registered" : item.relativePath.startsWith("loras/training/") ? "checkpoints" : "raw";
}

type LoraFilterDimension = "purpose" | "family" | "owner";
export type LoraCatalogFilter = { search: string } & Record<LoraFilterDimension, string[] | null>;
export const emptyLoraCatalogFilter: LoraCatalogFilter = { search: "", purpose: null, family: null, owner: null };

function loraFilterValue(item: ResourceCatalogItem, dimension: LoraFilterDimension) {
  if (dimension === "purpose") return item.purpose ?? "未分类";
  if (dimension === "family") return item.architectureFamily ?? "unknown";
  return item.ownerProjectId ? `project:${item.ownerProjectId}` : item.storage === "repository" ? "repository" : "local";
}

export function filterLoraCatalogItems(items: ResourceCatalogItem[], filter: LoraCatalogFilter) {
  const query = filter.search.trim().toLocaleLowerCase();
  return items.filter(item => (["purpose", "family", "owner"] as const).every(dimension => filter[dimension] === null || filter[dimension]!.includes(loraFilterValue(item, dimension)))
    && (!query || [item.name, item.originalName, item.summary, item.description, item.relativePath, item.id, item.recordLabel, item.ownerProjectId, ...(item.tags ?? [])].some(value => value?.toLocaleLowerCase().includes(query))));
}

type LoraFilterOption = { value: string; label: string; count: number };
function LoraFacetFilter({ label, allLabel, options, selected, onChange }: { label: string; allLabel: string; options: LoraFilterOption[]; selected: string[] | null; onChange: (values: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedCount = selected === null ? options.length : options.filter(option => selected.includes(option.value)).length;
  const all = selectedCount === options.length && (selected === null || options.length > 0);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector("input")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div className="lora-facet-filter">
    <span>{label}</span>
    <button ref={trigger} type="button" className="button button--quiet lora-facet-trigger" aria-label={`${label}筛选`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{all ? allLabel : selectedCount ? `已选 ${selectedCount} 项` : "未选择"}<span aria-hidden="true">▾</span></button>
    {open && createPortal(<FloatingPanel ref={panel} target={trigger.current ?? undefined} id={id} role="group" aria-label={`${label}选项`} className="lora-facet-panel">
      <div className="lora-facet-panel__actions"><label><input type="checkbox" aria-label={`${label}全选`} checked={all} ref={node => { if (node) node.indeterminate = !all && selectedCount > 0; }} onChange={() => onChange(all ? [] : null)} /><b>全选</b><span>{options.reduce((count, option) => count + option.count, 0)}</span></label><button type="button" className="button button--quiet" onClick={() => onChange([])}>清空</button></div>
      {options.map(option => <label className="lora-facet-option" key={option.value}><input type="checkbox" aria-label={option.label} checked={selected === null || selected.includes(option.value)} onChange={event => { const current = selected ?? options.map(item => item.value); const next = event.target.checked ? [...current, option.value] : current.filter(value => value !== option.value); onChange(options.every(item => next.includes(item.value)) ? null : next); }} /><span>{option.label}</span><small aria-label={`${option.label}资源数量`}>{option.count}</small></label>)}
      <button type="button" className="button button--quiet" onClick={() => { setOpen(false); trigger.current?.focus(); }}>完成</button>
    </FloatingPanel>, floatingLayerHost())}
  </div>;
}

export function LoraCatalogFilters({ items, filter, onChange, showMetadata = true }: { items: ResourceCatalogItem[]; filter: LoraCatalogFilter; onChange: (filter: LoraCatalogFilter) => void; showMetadata?: boolean }) {
  const families = [...new Set(items.map(item => item.architectureFamily ?? "unknown"))].sort();
  const owners = [...new Map(items.filter(item => item.ownerProjectId).map(item => [item.ownerProjectId!, item.recordLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  const options = (dimension: LoraFilterDimension, entries: Array<{ value: string; label: string }>): LoraFilterOption[] => {
    const matches = filterLoraCatalogItems(items, { ...filter, [dimension]: null });
    return entries.map(option => ({ ...option, count: matches.filter(item => loraFilterValue(item, dimension) === option.value).length }));
  };
  return <div className="resource-picker-filters">
    <label>搜索 LoRA<input type="search" placeholder="名称、标签或所属项目" value={filter.search} onChange={event => onChange({ ...filter, search: event.target.value })} /></label>
    {showMetadata && <>
      <LoraFacetFilter label="用途分类" allLabel="全部用途" options={options("purpose", loraPurposes.map(value => ({ value, label: value })))} selected={filter.purpose} onChange={purpose => onChange({ ...filter, purpose })} />
      <LoraFacetFilter label="底座" allLabel="全部底座" options={options("family", families.map(value => ({ value, label: value === "unknown" ? "未登记底座" : value === "other" ? "其他" : value.toUpperCase() })))} selected={filter.family} onChange={family => onChange({ ...filter, family })} />
      <LoraFacetFilter label="归属" allLabel="全部归属" options={options("owner", [{ value: "repository", label: "仓库" }, ...owners.map(([id, label]) => ({ value: `project:${id}`, label })), { value: "local", label: "本机" }])} selected={filter.owner} onChange={owner => onChange({ ...filter, owner })} />
    </>}
  </div>;
}

export function GroupedLoraCatalog({ items, renderItem, empty }: { items: ResourceCatalogItem[]; renderItem?: (item: ResourceCatalogItem) => React.ReactNode; empty: string }) {
  if (!items.length) return <div className="empty-card">{empty}</div>;
  const rank = { repository: 0, project: 1, local: 2 };
  return <div className="resource-page-sections lora-catalog-groups">{loraPurposes.map(purpose => {
    const group = items.filter(item => (item.purpose ?? "未分类") === purpose).sort((a, b) => rank[a.storage ?? "local"] - rank[b.storage ?? "local"] || (a.ownerProjectId && b.ownerProjectId ? a.recordLabel.localeCompare(b.recordLabel, "zh-CN") : 0) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id));
    return group.length ? <section key={purpose} aria-label={`${purpose}资源`}><header><h3>{purpose}</h3><span>{group.length} 项</span></header><div className="resource-catalog-grid">{group.map(item => renderItem ? renderItem(item) : <ResourceCatalogCard key={item.id} item={item} />)}</div></section> : null;
  })}</div>;
}

export function ResourcePicker({ items, onSelect, onInspect, busy = false, empty = "当前没有可选择的资源。", selection }: { items: ResourceCatalogItem[]; onSelect?: (item: ResourceCatalogItem) => void; onInspect?: (item: ResourceCatalogItem) => void; busy?: boolean; empty?: string; selection?: { ids: string[]; onChange: (ids: string[]) => void } }) {
  const [filter, setFilter] = useState(emptyLoraCatalogFilter);
  const [scope, setScope] = useState("registered");
  const isLora = items.every(item => item.kind === "lora");
  const scoped = items.filter(item => !isLora || scope === "all" || loraCatalogSection(item) === scope);
  const visible = filterLoraCatalogItems(scoped, filter);
  const ids = new Set(selection?.ids);
  const renderItem = (item: ResourceCatalogItem) => <ResourceCatalogCard key={item.id} item={item} onSelect={selection ? undefined : onSelect} onInspect={onInspect} busy={busy} selected={ids.has(item.id)} onToggle={selection ? () => selection.onChange(ids.has(item.id) ? selection.ids.filter(id => id !== item.id) : [...selection.ids, item.id]) : undefined} />;
  return <div className="resource-picker">
    <div className="resource-picker-toolbar">
      {isLora ? <><LoraCatalogFilters items={scoped} filter={filter} onChange={setFilter} showMetadata={scope === "registered" || scope === "all"} /><label className="resource-picker-scope">资源范围<select aria-label="资源范围" value={scope} onChange={event => { setScope(event.target.value); setFilter(emptyLoraCatalogFilter); }}><option value="registered">已登记</option><option value="raw">未登记文件</option><option value="checkpoints">训练 checkpoint</option><option value="all">全部资源</option></select></label></> : <div className="resource-picker-filters"><label>搜索资源<input type="search" placeholder="名称、说明或标签" value={filter.search} onChange={event => setFilter({ ...filter, search: event.target.value })} /></label></div>}
      <div className="resource-picker-actions"><span>{visible.length} 项{selection ? ` · 已选择 ${ids.size} 项` : ""}</span>{selection && <><button type="button" className="button button--quiet" disabled={busy || !visible.length || visible.every(item => ids.has(item.id))} onClick={() => selection.onChange([...new Set([...selection.ids, ...visible.map(item => item.id)])])}>选择筛选结果（{visible.length}）</button><button type="button" className="button button--quiet" disabled={busy || !ids.size} onClick={() => selection.onChange([])}>清空选择</button></>}</div>
      {selection && ids.size > 0 && <div className="resource-picker-selected" aria-label="已选 LoRA">{items.filter(item => ids.has(item.id)).map(item => <button type="button" className="button button--quiet" disabled={busy} key={item.id} aria-label={`移除 ${item.name}`} onClick={() => selection.onChange(selection.ids.filter(id => id !== item.id))}>{item.name} ×</button>)}</div>}
    </div>
    {isLora ? <GroupedLoraCatalog items={visible} renderItem={renderItem} empty={items.length ? "没有匹配的资源，请调整筛选条件。" : empty} /> : visible.length ? <div className="resource-catalog-grid">{visible.map(renderItem)}</div> : <div className="empty-card">{empty}</div>}
  </div>;
}

export function ResourceCompactList({ items }: { items: ResourceCatalogItem[] }) {
  return <div className="resource-compact-list">{items.map((item) => <article className={item.status !== "available" ? "has-warning" : ""} key={item.id}><div><b>{item.name}</b><small title={item.relativePath}>{item.relativePath}</small></div><span>{item.recordLabel}</span><span>{resourceStatusLabel(item.status)}</span><ResourceDetailsButton item={item} /></article>)}</div>;
}
