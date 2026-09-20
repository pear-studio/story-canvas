import type { TwoStepPrompt } from "./project-workbench-client";
import { PromptTextField, SourceAdjustmentBar } from "./SourcePromptEditor";

export function TwoStepPromptPanel({ value, source, base, supported, disabled, onChange }: {
  base: { positive: string; base_sha256: string } | null;
  value?: TwoStepPrompt; source: string | null; supported: boolean; disabled: boolean;
  onChange: (value: TwoStepPrompt | undefined) => void;
}) {
  const baseHash = base?.positive === source ? base.base_sha256 : null;
  const config = value ?? { enabled: false, strength: 0.5 };
  const conflict = Boolean(config.draft && baseHash && config.draft.base_sha256 !== baseHash);
  const update = (next: TwoStepPrompt) => onChange(!next.enabled && next.strength === 0.5 && !next.draft ? undefined : next);
  return <details className="two-step-panel">
    <summary>两步生成实验 <span className="custom-prompt-status">{config.enabled ? "已启用" : "未启用"}</span></summary>
    <div className="two-step-panel__body">
      <div className="two-step-controls">
        <label><input type="checkbox" checked={config.enabled} disabled={disabled || (!supported && !config.enabled)} onChange={event => update({ ...config, enabled: event.target.checked })} />启用两步生成</label>
        <label>深度强度 <input aria-label="深度控制强度" type="number" min={0} max={1} step={0.1} value={config.strength} disabled={disabled} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) update({ ...config, strength: Math.min(1, Math.max(0, event.target.valueAsNumber)) }); }} /></label>
        <div className="prompt-mode-switch" role="group" aria-label="深度强度预设">{[0.2, 0.5, 0.8, 1].map(strength => <button key={strength} type="button" disabled={disabled} aria-pressed={config.strength === strength} className={`button ${config.strength === strength ? "button--primary" : "button--quiet"}`} onClick={() => update({ ...config, strength })}>{strength.toFixed(1)}</button>)}</div>
      </div>
      <p className="two-step-note">{supported ? "每张候选重新生成草稿 → 提取深度 → 生成成片。草稿仅使用项目风格 LoRA，沿用最终负向 Prompt；16 步，shift 5。" : "此实验仅支持 Anima Base v1.0。"}</p>
      <div className="free-prompt-editor">
        <SourceAdjustmentBar disabled={disabled} hasOverride={Boolean(config.draft)} conflict={conflict} baseReady={Boolean(baseHash)} keepLabel="保留草稿" onReset={() => update({ ...config, draft: undefined })} onKeep={() => { if (baseHash && config.draft) update({ ...config, draft: { ...config.draft, base_sha256: baseHash } }); }} />
        <PromptTextField label="草稿正向 Prompt" ariaLabel="草稿正向 Prompt" value={config.draft?.positive ?? source ?? ""} disabled={disabled || !baseHash} onChange={positive => {
          if (baseHash) update({ ...config, draft: positive === source ? undefined : { positive, base_sha256: config.draft?.base_sha256 ?? baseHash } });
        }} placeholder="默认跟随当前最终 Prompt；可简化动作，并保留人物的位置、发型和体型。" />
      </div>
      <p className="two-step-note">未修改时跟随当前最终 Prompt。修改后独立保留，可在任务详情查看草稿和深度图。</p>
    </div>
  </details>;
}
