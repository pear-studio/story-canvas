import { mountFloatingLayer } from "./floating-layer";
import { type ReactNode, useRef, useState, useLayoutEffect } from "react";
import { useDismissableLayer } from "./use-dismissable-layer";

export function Popover({ className, children, onOpenChange }: {
  className: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  onOpenChange?: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (ref.current) ref.current.open = false; };
  useDismissableLayer({ open, ref, onClose: close });
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const trigger = ref.current.querySelector("summary");
    const panel = trigger?.nextElementSibling;
    if (trigger && panel instanceof HTMLElement) return mountFloatingLayer(panel, trigger, panel.classList.contains("generate-split__options") && !panel.classList.contains("generate-split__options--down"));
  }, [open]);
  return <details ref={ref} className={className} name="workbench-popover" onToggle={(event) => {
    const next = event.currentTarget.open;
    setOpen(next);
    onOpenChange?.(next);
    if (!next && ref.current?.contains(document.activeElement)) ref.current.querySelector("summary")?.focus();
  }}>{typeof children === "function" ? children(close) : children}</details>;
}
