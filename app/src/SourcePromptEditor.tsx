export function SourceAdjustmentBar({ disabled, hasOverride, conflict, baseReady, onReset, onKeep, keepLabel }: {
  disabled: boolean; hasOverride: boolean; conflict: boolean; baseReady: boolean;
  onReset: () => void; onKeep: () => void; keepLabel: string;
}) {
  return <div className="free-prompt-import">
    <span role="status" className={`custom-prompt-status ${conflict ? "is-conflict" : hasOverride ? "is-modified" : ""}`}>
      {!baseReady ? "检查中" : !hasOverride ? "无修改" : conflict ? "来源已变化" : "已修改"}
    </span>
    <button type="button" className="button button--quiet" disabled={disabled || !hasOverride} onClick={onReset}>重置</button>
    {conflict && <button type="button" className="button button--quiet" disabled={disabled || !baseReady} onClick={onKeep}>{keepLabel}</button>}
  </div>;
}

export function PromptTextField({ label, ariaLabel, value, onChange, disabled, rows = 8, placeholder }: {
  label: string; ariaLabel: string; value: string; onChange: (text: string) => void; disabled: boolean; rows?: number; placeholder?: string;
}) {
  return <label>{label}<textarea aria-label={ariaLabel} rows={rows} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

