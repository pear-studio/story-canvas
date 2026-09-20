import { Popover } from "./Popover";
import { useRef } from "react";
import { useLongPressContextMenu } from "./use-long-press-context-menu";

export function GenerateSplitButton({ dirty, count, pageCount, disabled, reason, menuDirection = "up", onSubmit, onCountChange }: {
  dirty: boolean;
  count: 1 | 3;
  pageCount?: number;
  disabled: boolean;
  reason: string;
  menuDirection?: "up" | "down";
  onSubmit: () => void;
  onCountChange?: (count: 1 | 3) => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const longPress = useLongPressContextMenu();
  const openOptions = () => { const menu = root.current?.querySelector("details"); if (menu && !disabled) menu.open = true; };
  const suffix = pageCount === undefined || pageCount === 1 ? "" : `（${pageCount} 页）`;
  return <span ref={root} className="generate-split" {...longPress.captureProps}>
    <button type="button" className="button button--primary generate-split__action" disabled={disabled}
      title={reason || `${dirty ? "保存当前页修改，并" : ""}${pageCount === undefined ? "为当前页生成" : `为选中的 ${pageCount} 页各生成`} ${count} 张候选（Ctrl+G）；长按调整张数`}
      data-long-press-context-menu onPointerDown={event => { if (!disabled) longPress.start(event, openOptions); }}
      onContextMenu={event => { event.preventDefault(); openOptions(); }}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); openOptions(); root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus(); } }}
      onClick={onSubmit}><span className="generate-split__desktop-verb">{dirty ? "保存并生成" : "生成"}</span><span className="generate-split__mobile-verb">生成</span> ×{count}{suffix}</button>
    <Popover className="generate-split__menu">{(close) => <>
      <summary className="generate-split__toggle" aria-label="选择生成张数" title="选择生成张数" onClick={(event) => { if (disabled) event.preventDefault(); }} />
      <span className={`generate-split__options${menuDirection === "down" ? " generate-split__options--down" : ""}`} role="menu">
        {([1, 3] as const).map((value) => <button type="button" role="menuitemradio" aria-checked={count === value} disabled={disabled} key={value}
          onClick={() => { onCountChange?.(value); close(); }}>生成 ×{value}</button>)}
      </span>
    </>}</Popover>
  </span>;
}
