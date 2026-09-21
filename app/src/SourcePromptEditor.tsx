export function PromptTextField({ label, ariaLabel, value, onChange, disabled, rows = 8, placeholder }: {
  label: string; ariaLabel: string; value: string; onChange: (text: string) => void; disabled: boolean; rows?: number; placeholder?: string;
}) {
  return <label>{label}<textarea aria-label={ariaLabel} rows={rows} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

