import { useEffect, useState } from "react";
import { defaultTextPageLayout, type TextPageAlignment, type TextPageLayout } from "../shared/text-page-layout.mjs";

type TextPageDraft = { display_title?: string; body?: string; text_layout?: TextPageLayout };
const alignments: [TextPageAlignment, string][] = [["left", "左对齐"], ["center", "居中"], ["right", "右对齐"]];

function FontSizeInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input aria-label={label} type="number" min={12} max={192} step={1} value={draft}
    onChange={event => {
      setDraft(event.target.value);
      const size = event.target.valueAsNumber;
      if (Number.isInteger(size) && size >= 12 && size <= 192) onChange(size);
    }} onBlur={() => setDraft(String(value))} />;
}

export function TextPageEditor({ value, disabled, onChange }: {
  value: TextPageDraft;
  disabled: boolean;
  onChange: (patch: TextPageDraft) => void;
}) {
  const layout = value.text_layout ?? defaultTextPageLayout;
  const changeLayout = (patch: Partial<TextPageLayout>) => onChange({ text_layout: { ...layout, ...patch } });
  return <fieldset className="text-page-editor" disabled={disabled}>
    {(["title", "body"] as const).map(kind => {
      const title = kind === "title", label = title ? "标题" : "正文";
      return <section className="text-page-editor__section" key={kind}>
        <label className="text-page-editor__text"><span>{title ? "显示标题" : "正文"}</span>
          <textarea rows={title ? 2 : 6} aria-label={title ? "显示标题" : "正文"} placeholder={title ? "可留空，独立于页面名称" : "支持换行，可留空"}
            value={(title ? value.display_title : value.body) ?? ""} onChange={event => onChange({ [title ? "display_title" : "body"]: event.target.value })} />
        </label>
        <div className="text-page-editor__controls">
          <label className="text-page-editor__size"><span>字号</span><FontSizeInput label={`${label}字号`} value={layout[`${kind}_font_size`]} onChange={size => changeLayout({ [`${kind}_font_size`]: size })} /></label>
          <div className="text-page-editor__choices" role="group" aria-label={`${label}对齐`}>
            {alignments.map(([align, name]) => <button type="button" key={align} aria-pressed={layout[`${kind}_align`] === align} onClick={() => changeLayout({ [`${kind}_align`]: align })}>{name}</button>)}
          </div>
        </div>
      </section>;
    })}
    <div className="text-page-editor__section"><span className="text-page-editor__label">整组位置</span>
      <div className="text-page-editor__choices" role="group" aria-label="整组位置">
        {([["upper", "上三分之一"], ["center", "居中"], ["lower", "下三分之一"]] as const).map(([position, label]) =>
          <button type="button" key={position} aria-pressed={layout.position === position} onClick={() => changeLayout({ position })}>{label}</button>)}
      </div>
      <p className="text-page-editor__note">标题与正文一起定位；长文靠近边缘时自动向内收。</p>
    </div>
  </fieldset>;
}
