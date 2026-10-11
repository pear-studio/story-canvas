import { useState } from "react";
import { loraResourceItem, type GlobalModelResource } from "./global-resource-catalog";
export type { GlobalModelResource } from "./global-resource-catalog";
import { UtilityPage } from "./ProjectUtilityViews";
import {
  ResourceCatalogGrid,
  ResourceCompactList,
  resourceBytes,
  emptyLoraCatalogFilter,
  filterLoraCatalogItems,
  loraCatalogSection,
  LoraCatalogFilters,
  GroupedLoraCatalog,
  type LoraCatalogSection,
  type ResourceCatalogItem,
} from "./ResourceCatalog";
import type { VisualPageTemplateResource } from "./visual-page-templates";

export type GlobalResources = {
  models_root: string | null;
  models: GlobalModelResource[];
  render_profiles?: unknown[];
  visual_page_templates?: VisualPageTemplateResource;
};

function baseResourceItem(model: GlobalModelResource): ResourceCatalogItem {
  const profiles = model.usage?.profiles?.map((profile) => profile.name) ?? [];
  return {
    id: `${model.kind}:${model.id}`,
    kind: model.kind === "dit" || model.kind === "checkpoint" ? "base" : "component",
    name: model.name,
    architectureFamily: model.architecture_family,
    relativePath: model.relative_path,
    sizeBytes: model.size_bytes,
    status: model.status,
    recordLabel: model.registered ? model.storage === "local" ? "本机登记" : "仓库登记" : "未登记",
    previewImages: model.preview?.images ?? [],
    details: [
      { label: "文件", value: model.relative_path },
      { label: "大小", value: resourceBytes(model.size_bytes) },
      { label: "模型角色", value: model.kind },
      { label: "结构家族", value: model.architecture_family },
      { label: "Prompt 家族", value: model.prompt_family ?? "未登记" },
      { label: "生成配置", value: profiles.join("、") || "尚未引用" },
      { label: "来源", value: model.source, href: model.source },
      { label: "SHA-256", value: model.sha256 ?? "未登记" },
    ],
  };
}

function GlobalLorasView({ resources }: { resources: GlobalResources }) {
  const [section, setSection] = useState<LoraCatalogSection>("registered");
  const [filter, setFilter] = useState(emptyLoraCatalogFilter);
  const entries = resources.models.filter(model => model.kind === "lora").map(loraResourceItem);
  const scoped = entries.filter(item => loraCatalogSection(item) === section);
  const visible = filterLoraCatalogItems(scoped, section === "registered" ? filter : { ...emptyLoraCatalogFilter, search: filter.search });
  const sections = [{ id: "registered", name: "已登记" }, { id: "raw", name: "未登记文件" }, { id: "checkpoints", name: "训练 checkpoint" }] as const;
  return <UtilityPage title="LoRA" description={`已登记资源与本机 LoRA${resources.models_root ? "" : " · 未配置 models_root"}`}>
    <div className="resource-picker-toolbar">
      <div className="resource-picker-actions" role="group" aria-label="LoRA 分区">{sections.map(tab => <button key={tab.id} type="button" className={`button ${section === tab.id ? "button--primary" : "button--quiet"}`} aria-pressed={section === tab.id} onClick={() => setSection(tab.id)}>{tab.name}（{entries.filter(item => loraCatalogSection(item) === tab.id).length}）</button>)}</div>
      <LoraCatalogFilters items={scoped} filter={filter} onChange={setFilter} showMetadata={section === "registered"} />
      <div className="resource-picker-actions"><span>{visible.length} / {scoped.length} 项</span><button type="button" className="button button--quiet" onClick={() => setFilter(emptyLoraCatalogFilter)}>清空筛选</button></div>
    </div>
    {section === "registered" ? <GroupedLoraCatalog items={visible} empty={scoped.length ? "没有匹配的 LoRA，请调整筛选条件。" : "暂无已登记 LoRA。"} /> : visible.length ? <ResourceCompactList items={visible} /> : <div className="empty-card">{scoped.length ? "没有匹配的文件，请调整搜索。" : section === "raw" ? "暂无未登记 LoRA。" : "暂无训练 checkpoint。"}</div>}
  </UtilityPage>;
}

export default function GlobalModelsView({ resources, kind }: { resources: GlobalResources | null; kind: "base" | "lora" }) {
  const title = kind === "base" ? "基模" : "LoRA";
  if (!resources) return <UtilityPage title={title} description="正在读取本机模型目录与登记信息。"><div className="empty-card">正在扫描…</div></UtilityPage>;
  if (kind === "lora") return <GlobalLorasView resources={resources} />;
  const entries = resources.models.filter((model) => model.kind !== "lora").map(baseResourceItem);
  const primary = entries.filter((item) => item.kind === "base");
  const components = entries.filter((item) => item.kind === "component");
  return <UtilityPage title="基模" description={`主模型与配套组件${resources.models_root ? "" : " · 未配置 models_root"}`}>
    <div className="resource-page-sections"><section><header><div><h3>主模型</h3><p>决定核心画面能力；项目选择基模时使用对应生成方案。</p></div><span>{primary.length} 项</span></header><ResourceCatalogGrid items={primary} empty="暂无可用基模。" /></section><section><header><div><h3>配套组件</h3><p>文本编码器、VAE 与其他生成依赖。</p></div><span>{components.length} 项</span></header>{components.length ? <ResourceCompactList items={components} /> : <div className="empty-card">暂无配套组件。</div>}</section></div>
  </UtilityPage>;
}
