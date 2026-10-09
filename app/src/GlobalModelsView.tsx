import { loraResourceItem, type GlobalModelResource } from "./global-resource-catalog";
export type { GlobalModelResource } from "./global-resource-catalog";
import { UtilityPage } from "./ProjectUtilityViews";
import {
  ResourceCatalogGrid,
  ResourceCompactList,
  resourceBytes,
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

export default function GlobalModelsView({ resources, kind }: { resources: GlobalResources | null; kind: "base" | "lora" }) {
  const title = kind === "base" ? "基模" : "LoRA";
  if (!resources) return <UtilityPage title={title} description="正在读取本机模型目录与登记信息。"><div className="empty-card">正在扫描…</div></UtilityPage>;
  if (kind === "lora") {
    const entries = resources.models.filter((model) => model.kind === "lora").map(loraResourceItem);
    const registered = entries.filter((item) => item.registered);
    const raw = entries.filter((item) => !registered.includes(item));
    return <UtilityPage title="LoRA" description={`已登记资源与本机 LoRA${resources.models_root ? "" : " · 未配置 models_root"}`}>
      <div className="resource-page-sections"><section><header><div><h3>已登记</h3><p>具有完整资源说明、预览与生成建议。</p></div><span>{registered.length} 项</span></header><ResourceCatalogGrid items={registered} empty="暂无已登记 LoRA。" /></section><section><header><div><h3>未登记的本机文件</h3><p>包含训练 checkpoint；可以使用，但没有完整资源说明。</p></div><span>{raw.length} 项</span></header>{raw.length ? <ResourceCompactList items={raw} /> : <div className="empty-card">暂无未登记 LoRA。</div>}</section></div>
    </UtilityPage>;
  }
  const entries = resources.models.filter((model) => model.kind !== "lora").map(baseResourceItem);
  const primary = entries.filter((item) => item.kind === "base");
  const components = entries.filter((item) => item.kind === "component");
  return <UtilityPage title="基模" description={`主模型与配套组件${resources.models_root ? "" : " · 未配置 models_root"}`}>
    <div className="resource-page-sections"><section><header><div><h3>主模型</h3><p>决定核心画面能力；项目选择基模时使用对应生成方案。</p></div><span>{primary.length} 项</span></header><ResourceCatalogGrid items={primary} empty="暂无可用基模。" /></section><section><header><div><h3>配套组件</h3><p>文本编码器、VAE 与其他生成依赖。</p></div><span>{components.length} 项</span></header>{components.length ? <ResourceCompactList items={components} /> : <div className="empty-card">暂无配套组件。</div>}</section></div>
  </UtilityPage>;
}
