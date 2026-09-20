import { SourceAdjustmentBar, PromptTextField } from "./SourcePromptEditor";
import { useState } from "react";
import type { FreePrompt } from "./project-workbench-client";
import { rawLoraResourceDefinition, useProjectLoraResources } from "./use-lora-resources";
import { ResourcePicker, loraResourceCatalogItem, rawLoraCatalogItem } from "./ResourceCatalog";
import { Modal } from "./Modal";

export function FreePromptEditor({ projectId, value, onChange, disabled, onClear, onKeep, conflict, hasOverride, baseReady }: {
  projectId: string; value: FreePrompt; onChange: (value: FreePrompt) => void;
  disabled: boolean; onClear: () => void; onKeep: () => void; conflict: boolean; hasOverride: boolean; baseReady: boolean;
}) {
  const { list, compatibility, error } = useProjectLoraResources(projectId);
  const [picker, setPicker] = useState(false);
  const entries = [
    ...(list?.resources ?? []).filter(({ resource }) => resource.architecture.family === compatibility?.architectureFamily && resource.architecture.prompt_family === compatibility?.promptFamily).map(entry => ({ resource: entry.resource, item: loraResourceCatalogItem(entry) })),
    ...(list?.raw ?? []).map(raw => ({ resource: rawLoraResourceDefinition(raw, compatibility), item: rawLoraCatalogItem(raw) })),
  ].filter(({ resource }) => !value.loras.some(lora => lora.sha256 === resource.file.sha256));
  return <div className="free-prompt-editor">
    <SourceAdjustmentBar disabled={disabled} hasOverride={hasOverride} conflict={conflict} baseReady={baseReady} onReset={onClear} onKeep={onKeep} keepLabel="保留自定义" />
    {!baseReady && <p>正在读取结构化基础；若读取失败，请查看生成详情。</p>}
    <PromptTextField label="正向 Prompt" ariaLabel="自定义正向 Prompt" value={value.positive} disabled={disabled || !baseReady} onChange={positive => onChange({ ...value, positive })} placeholder="填写完整正向 Prompt，支持标签和自然语言" />
    <PromptTextField label="负向 Prompt" ariaLabel="自定义负向 Prompt" value={value.negative} rows={4} disabled={disabled || !baseReady} onChange={negative => onChange({ ...value, negative })} placeholder="可留空" />
    <div className="free-lora-heading"><b>LoRA</b><button type="button" className="button button--quiet" disabled={disabled || !baseReady} onClick={() => setPicker(true)}>＋ 添加</button></div>
    {!value.loras.length && <p>未选择 LoRA</p>}
    {value.loras.map((lora, index) => <div className="free-lora-row" key={lora.filename}><div><b title={lora.filename}>{lora.filename.split("/").pop()}</b>{lora.trigger && <small>触发词：{lora.trigger}</small>}{lora.trigger && !value.positive.toLowerCase().includes(lora.trigger.toLowerCase()) && <small className="free-prompt-warning">⚠ 正向 Prompt 中未找到触发词，不影响生成。</small>}</div><label>权重<input aria-label={`${lora.filename} 权重`} type="number" min={-2} max={2} step={0.05} value={lora.weight} disabled={disabled} onChange={event => onChange({ ...value, loras: value.loras.map((entry, i) => i === index ? { ...entry, weight: event.target.valueAsNumber } : entry) })} /></label><button type="button" className="button button--quiet free-lora-remove" aria-label={`移除 ${lora.filename}`} disabled={disabled} onClick={() => onChange({ ...value, loras: value.loras.filter((_, i) => i !== index) })}>×</button></div>)}
    {picker && <Modal title="选择 LoRA" onClose={() => setPicker(false)} ariaLabel="选择 LoRA"><div className="lora-picker-body">{error ? <p>{error}</p> : !list ? <p>正在读取 LoRA…</p> : <ResourcePicker items={entries.map(entry => entry.item)} empty="没有其他兼容 LoRA" onSelect={item => {
      const resource = entries.find(entry => entry.item.id === item.id)?.resource;
      if (!resource) return;
      const trigger = resource.activation.trigger_words.join(", ").trim();
      const recommended = resource.recommended_generation.weight.default;
      onChange({ ...value, loras: [...value.loras, { filename: resource.file.relative_path.replace(/^loras\//, ""), sha256: resource.file.sha256, weight: typeof recommended === "number" ? Math.max(-2, Math.min(2, recommended)) : 1, ...(trigger ? { trigger } : {}) }] });
      setPicker(false);
    }} />}</div></Modal>}
  </div>;
}
