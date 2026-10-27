/** 自适应多行自由文本框：原生 textarea，输入法合成由浏览器原生处理，高度随内容伸缩。 */
export function PromptTextArea({ ariaLabel, value, onChange, disabled, rows = 3, placeholder, className = "", onKeyDown }: {
  ariaLabel: string; value: string; onChange: (text: string) => void; disabled?: boolean; rows?: number; placeholder?: string; className?: string; onKeyDown?:import('react').KeyboardEventHandler<HTMLTextAreaElement>;
}) {
  return <textarea className={`prompt-free-text ${className}`.trim()} aria-label={ariaLabel} rows={rows} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} />;
}

export function PromptTextField({ label, ariaLabel, value, onChange, disabled, rows = 8, placeholder }: {
  label: string; ariaLabel: string; value: string; onChange: (text: string) => void; disabled: boolean; rows?: number; placeholder?: string;
}) {
  return <label>{label}<PromptTextArea ariaLabel={ariaLabel} rows={rows} disabled={disabled} value={value} onChange={onChange} placeholder={placeholder} /></label>;
}
