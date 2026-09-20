import { useId } from "react";

import "./render-profile-inspection.css";

export type InspectionDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  source?: string;
};

export type InspectionAsset = {
  id: string;
  name?: string;
  kind?: string;
  filename?: string;
  sha256?: string;
  status?: string;
  reason?: string | null;
  actual_sha256?: string | null;
  relative_path?: string;
  size_bytes?: number;
  source?: unknown;
  available: boolean;
  diagnostics?: InspectionDiagnostic[];
};

export type InspectionValueState = {
  exists: boolean;
  value?: unknown;
};

export type InspectionChange = {
  target: string;
  label: string;
  original: InspectionValueState;
  current: InspectionValueState;
  project: InspectionValueState;
};

export type RenderProfileInspectionProjection = {
  version: 1;
  current_contract: {
    profile_format: "asset_resolved";
    base_profile_compiled: true;
    project_override_supported: true;
    request_effective_render_plan_compiled: false;
  };
  base_profile: {
    id: string;
    name: string;
    architecture_family: string;
    prompt_family?: string | null;
    description?: string;
    sha256: string;
    source_file: string | null;
    source_sha256: string | null;
    available: boolean;
    diagnostics?: InspectionDiagnostic[];
  };
  project_override: {
    status: "none" | "applied" | "conflict";
    blocked: boolean;
    source_file: string | null;
    source_sha256: string | null;
    effective_sha256: string | null;
    changes: InspectionChange[];
    conflicts: InspectionChange[];
    redundant: InspectionChange[];
  };
  prompt: {
    family: string | null;
    policy_id: string;
    policy_source_file: string | null;
    policy_sha256: string | null;
    positive_fragments: number;
    negative_fragments: number;
    summary?: string;
    diagnostics?: InspectionDiagnostic[];
    category_order?: string[];
    separator?: string | null;
    fragments: Array<{
      id: string;
      polarity: "positive" | "negative";
      placement: "prefix" | "suffix";
      order: number;
      prompt_type: string;
      prompt_text: string;
      weight?: number;
      source: { source_kind: string; source_id: string } | null;
    }>;
  };
  models: Record<string, InspectionAsset>;
  style_loras: Record<string, InspectionAsset & { weight?: number; trigger?: string }>;
  routes: Array<{
    operation: string;
    input_source: string;
    recipe: {
      source_id: string;
      source_file: string | null;
      source_sha256: string | null;
      instance_sha256: string;
      summary: string;
      parameters: Record<string, unknown>;
    };
    workflow: {
      id: string;
      template_file: string | null;
      manifest_file: string | null;
      template_sha256: string | null;
      manifest_sha256: string | null;
      modifiers: string[];
    };
    available: boolean;
    diagnostics: InspectionDiagnostic[];
  }>;
};

type RenderProfileInspectionProps = {
  inspection: RenderProfileInspectionProjection;
  isCurrent: boolean;
  className?: string;
};

function diagnosticLabel(severity: InspectionDiagnostic["severity"]) {
  if (severity === "error") return "错误";
  if (severity === "warning") return "提醒";
  return "说明";
}

function valueText(value: unknown) {
  if (value === undefined) return "—";
  if (value === null) return "无";
  if (typeof value === "string") return value || "（空）";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stateText(state: InspectionValueState) {
  return state.exists ? valueText(state.value) : "已移除";
}

function Diagnostics({ items = [] }: { items?: InspectionDiagnostic[] }) {
  if (!items.length) return null;
  return <ul className="rpi-diagnostics">
    {items.map((item, index) => <li className={`rpi-diagnostic rpi-diagnostic--${item.severity}`} key={`${item.code ?? item.message}-${index}`}>
      <strong>{diagnosticLabel(item.severity)}</strong>
      <span>{item.message}</span>
      {item.code && <code>{item.code}</code>}
    </li>)}
  </ul>;
}

function StatusBadge({ available, label }: { available: boolean; label?: string }) {
  return <span className={`rpi-status ${available ? "rpi-status--available" : "rpi-status--blocked"}`}>
    <span aria-hidden="true">{available ? "✓" : "!"}</span>
    {label ?? (available ? "可用" : "不可用")}
  </span>;
}

function TechnicalIdentity({ id, hashes }: { id: string; hashes?: Array<{ label: string; value?: string | null }> }) {
  const visibleHashes = hashes?.filter((hash) => !/(sha|哈希)/i.test(hash.label));
  return <details className="rpi-identity">
    <summary>资产详情</summary>
    <dl>
      <div><dt>ID</dt><dd><code>{id}</code></dd></div>
      {visibleHashes?.map((hash) => <div key={hash.label}><dt>{hash.label}</dt><dd><code>{hash.value || "未记录"}</code></dd></div>)}
    </dl>
  </details>;
}

type InspectionPromptFragment = RenderProfileInspectionProjection["prompt"]["fragments"][number];

function PromptFragmentPreview({ title, polarity, fragments, separator }: { title: string; polarity: "positive" | "negative"; fragments: InspectionPromptFragment[]; separator: string }) {
  return <article className="rpi-prompt-preview-card">
    <header><b>{title}</b><span>{fragments.length} 个片段</span></header>
    <div className="rpi-prompt-fragments">
      {fragments.length ? fragments.map((fragment, index) => <span className="rpi-prompt-fragment" key={fragment.id}>
        <mark className={`rpi-prompt-mark--${polarity}`}>{fragment.prompt_text}</mark>
        {fragment.weight !== undefined && <small>{fragment.weight}</small>}
        {index < fragments.length - 1 && <i>{separator}</i>}
      </span>) : <span className="rpi-prompt-empty">无</span>}
    </div>
  </article>;
}

function OverrideInspection({ override, isCurrent, onResetChange, resettingTarget }: { override: RenderProfileInspectionProjection["project_override"]; isCurrent: boolean; onResetChange?: (target: string) => void; resettingTarget?: string | null }) {
  const headingId = useId();
  const visibleChangeCount = override.changes.length + override.conflicts.length;
  return <div className="rpi-override-groups">
    {visibleChangeCount === 0 && <div className="rpi-override-empty" role="status">
      <strong>尚无有效项目调整</strong>
      <span>{`${isCurrent ? "当前项目" : "采用后"}没有覆盖基础配置中的任何值。`}</span>
    </div>}
    {override.conflicts.length > 0 && <section className="rpi-change-group rpi-change-group--conflict" aria-labelledby={`${headingId}-conflicts`}>
      <h4 id={`${headingId}-conflicts`}>必须处理的冲突 · {override.conflicts.length}</h4>
      <ChangeList items={override.conflicts} onResetChange={onResetChange} resettingTarget={resettingTarget} />
    </section>}
    {override.changes.length > 0 && <section className="rpi-change-group" aria-labelledby={`${headingId}-changes`}>
      <h4 id={`${headingId}-changes`}>项目调整 · {override.changes.length}</h4>
      <ChangeList items={override.changes} onResetChange={onResetChange} resettingTarget={resettingTarget} />
    </section>}
    <TechnicalIdentity id={override.source_file ?? "render-profile.override.json"} hashes={[
      { label: "项目调整文件", value: override.source_file },
      { label: "项目调整 SHA-256", value: override.source_sha256 },
      { label: "有效配置 SHA-256", value: override.effective_sha256 },
    ]} />
  </div>;
}

export function RenderProfileOverrideInspection({ inspection, isCurrent, className = "", embedded = false, onResetChange, resettingTarget = null }: { inspection: RenderProfileInspectionProjection; isCurrent: boolean; className?: string; embedded?: boolean; onResetChange?: (target: string) => void; resettingTarget?: string | null }) {
  const id = useId();
  const override = inspection.project_override;
  const visibleChangeCount = override.changes.length + override.conflicts.length;
  const status = override.conflicts.length > 0 ? "conflict" : visibleChangeCount > 0 ? "applied" : "none";
  if (embedded) {
    return <div className={`rpi-override-embedded ${className}`.trim()}>
      <OverrideInspection override={override} isCurrent={isCurrent} onResetChange={onResetChange} resettingTarget={resettingTarget} />
    </div>;
  }
  return <section className={`render-profile-inspection rpi-override-page ${className}`.trim()} aria-labelledby={`${id}-title`}>
    <header className="rpi-override-page__header">
      <div><span>项目级稀疏调整</span><h2 id={`${id}-title`}>项目调整</h2></div>
      <StatusBadge available={!override.blocked} label={override.blocked ? "需要处理" : status === "none" ? "未设置" : "已记录"} />
    </header>
    <OverrideInspection override={override} isCurrent={isCurrent} onResetChange={onResetChange} resettingTarget={resettingTarget} />
  </section>;
}

function ChangeList({ items, onResetChange, resettingTarget }: { items: InspectionChange[]; onResetChange?: (target: string) => void; resettingTarget?: string | null }) {
  return <ul className="rpi-change-list">
    {items.map((item, index) => <li key={`${item.target}-${index}`}>
      <div className="rpi-change-list__heading"><strong>{item.label}</strong><code>{item.target}</code>{onResetChange && <button type="button" className="rpi-change-list__reset" disabled={Boolean(resettingTarget)} onClick={() => onResetChange(item.target)}>{resettingTarget === item.target ? "恢复中…" : "恢复基础值"}</button>}</div>
      <dl>
        <div><dt>当前基础值</dt><dd>{stateText(item.current)}</dd></div>
        <div className={`rpi-change-list__project ${stateText(item.current) !== stateText(item.project) ? "is-different" : ""}`}><dt>项目值</dt><dd>{stateText(item.project)}</dd></div>
      </dl>
    </li>)}
  </ul>;
}

function AssetList({ title, emptyText, assets }: { title: string; emptyText: string; assets: Array<InspectionAsset & { weight?: number }> }) {
  const titleId = useId();
  return <section className="rpi-panel" aria-labelledby={titleId}>
    <header><div><h3 id={titleId}>{title}</h3></div><b>{assets.length}</b></header>
    {!assets.length ? <p className="rpi-empty">{emptyText}</p> : <div className="rpi-asset-list">
      {assets.map((asset) => <article className={!asset.available ? "is-blocked" : ""} key={asset.id}>
        <div className="rpi-item-heading">
          <div><strong>{asset.name || asset.filename || asset.id}</strong><small>{[asset.kind, asset.filename].filter(Boolean).join(" · ")}</small></div>
          <StatusBadge available={asset.available} label={asset.reason === "remote_unverified" ? "远端验证" : undefined} />
        </div>
        {asset.weight !== undefined && <p>权重 <b>{asset.weight}</b></p>}
        <Diagnostics items={asset.diagnostics} />
        <TechnicalIdentity id={asset.id} hashes={[
          { label: "预期 SHA-256", value: asset.sha256 },
          { label: "实际 SHA-256", value: asset.actual_sha256 },
        ]} />
      </article>)}
    </div>}
  </section>;
}

export default function RenderProfileInspection({ inspection, isCurrent, className = "" }: RenderProfileInspectionProps) {
  const id = useId();
  const unavailableAssets = [...Object.values(inspection.models), ...Object.values(inspection.style_loras)].filter((asset) => !asset.available).length;
  const effectiveAvailable = inspection.base_profile.available && unavailableAssets === 0;
  const remotelyVerified = [...Object.values(inspection.models), ...Object.values(inspection.style_loras)].some((asset) => asset.reason === "remote_unverified");
  const title = "模型配置详情";
  const modeLabel = isCurrent ? "当前模型配置 · 只读检查" : "模型配置预览 · 只读检查";
  const blockerDetails = unavailableAssets ? `${unavailableAssets} 项模型或 LoRA 不可用` : "";

  return <section className={`render-profile-inspection ${className}`.trim()} aria-labelledby={`${id}-title`}>
    <header className="rpi-hero">
      <div><span>{modeLabel}</span><h2 id={`${id}-title`}>{title}</h2></div>
       <StatusBadge available={effectiveAvailable} label={effectiveAvailable ? remotelyVerified ? "可提交" : "可用" : "不可用"} />
    </header>

    {blockerDetails && <div className="rpi-blocker" role={effectiveAvailable ? "status" : "alert"}>
      <strong>{effectiveAvailable ? "部分内容不可用" : "当前内容不可用"}</strong>
      <span>{blockerDetails}</span>
    </div>}

    <>
      <div className="rpi-overview-grid">
      <section className="rpi-panel rpi-panel--base" aria-labelledby={`${id}-base-title`}>
        <header><div><h3 id={`${id}-base-title`}>模型配置概览</h3></div><StatusBadge available={inspection.base_profile.available} /></header>
        <strong className="rpi-primary-name">{inspection.base_profile.name}</strong>
        {inspection.base_profile.description && <p>{inspection.base_profile.description}</p>}
        <Diagnostics items={inspection.base_profile.diagnostics} />
        <TechnicalIdentity id={inspection.base_profile.id} hashes={[
          { label: "源文件", value: inspection.base_profile.source_file },
          { label: "解析配置 SHA-256", value: inspection.base_profile.sha256 },
          { label: "源文件 SHA-256", value: inspection.base_profile.source_sha256 },
        ]} />
      </section>
      <section className="rpi-panel rpi-panel--prompt" aria-labelledby={`${id}-prompt-title`}>
        <header><div><h3 id={`${id}-prompt-title`}>Prompt 摘要</h3></div></header>
        <div className="rpi-prompt-counts"><span><b>{inspection.prompt.positive_fragments}</b>正向片段</span><span><b>{inspection.prompt.negative_fragments}</b>负向片段</span></div>
        {inspection.prompt.summary && <p>{inspection.prompt.summary}</p>}
        <Diagnostics items={inspection.prompt.diagnostics} />
        <TechnicalIdentity id={inspection.prompt.policy_id} hashes={[
          { label: "策略源文件", value: inspection.prompt.policy_source_file },
          { label: "策略 SHA-256", value: inspection.prompt.policy_sha256 },
        ]} />
        <div className="rpi-prompt-preview">
          <PromptFragmentPreview title="正向 Prompt" polarity="positive" fragments={inspection.prompt.fragments.filter((fragment) => fragment.polarity === "positive")} separator={inspection.prompt.separator || ", "} />
          <PromptFragmentPreview title="负向 Prompt" polarity="negative" fragments={inspection.prompt.fragments.filter((fragment) => fragment.polarity === "negative")} separator={inspection.prompt.separator || ", "} />
        </div>
      </section>
      </div>

      <div className="rpi-assets-grid">
        <AssetList title="模型" emptyText="当前配置没有模型记录。" assets={Object.values(inspection.models)} />
        <AssetList title="风格 LoRA" emptyText="当前配置不使用风格 LoRA。" assets={Object.values(inspection.style_loras)} />
      </div>
    </>

  </section>;
}
