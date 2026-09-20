import { type ReactNode, useRef, useState } from "react";

export function InlineTitleEditor({ value, label, disabled = false, onChange }: {
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const initialValue = useRef(value);

  if (!editing) return <button type="button" className="inline-title-trigger" aria-label={label} disabled={disabled} onClick={() => { initialValue.current = value; setEditing(true); }}>{value || "未命名"}</button>;

  return <input
    className="inline-title-input"
    style={{ width: `calc(${Math.max(value.length, 2)}em + 10px)` }}
    aria-label={label}
    autoFocus
    disabled={disabled}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    onBlur={() => setEditing(false)}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onChange(initialValue.current);
        setEditing(false);
      }
    }}
  />;
}

export function WorkspaceHeader({ breadcrumb = [], title, description, meta, actions, className = "" }: {
  breadcrumb?: string[];
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <>
    {breadcrumb.length > 0 && <nav className="workspace-breadcrumb" aria-label="页面位置">{breadcrumb.map((item, index) => <span key={`${item}:${index}`}>{index > 0 && <i>›</i>}{item}</span>)}</nav>}
    <header className={`workspace-header ${className}`.trim()}>
      <div className="workspace-header__main"><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {(meta || actions) && <div className="workspace-header__aside">{meta && <span className="workspace-header__meta">{meta}</span>}{actions && <div className="workspace-header__actions">{actions}</div>}</div>}
    </header>
  </>;
}

export function SectionHeader({ title, description, actions, titleActions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; titleActions?: ReactNode }) {
  return <header className="section-header"><div className="section-header__title"><h3>{title}</h3>{titleActions}{description && <p>{description}</p>}</div>{actions && <div className="section-header__actions">{actions}</div>}</header>;
}
