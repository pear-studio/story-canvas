import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type ModalSize = "content" | "workspace";

export function Modal({ size = "content", title, subtitle, children, footer, onClose, dismissible = true, busy = false, ariaLabel, className = "" }: {
  size?: ModalSize;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  busy?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const restoreFocus = useRef<HTMLElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ onClose, dismissible, busy });
  latest.current = { onClose, dismissible, busy };
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      const backdrops = document.querySelectorAll<HTMLElement>(".modal-backdrop");
      const isTopmost = backdrops[backdrops.length - 1] === backdrop.current;
      if (event.key === "Escape" && isTopmost && latest.current.dismissible && !latest.current.busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.current.onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => { window.removeEventListener("keydown", handleKeyDown); restoreFocus.current?.focus(); };
  }, []);
  const close = () => { if (dismissible && !busy) onClose(); };
  return createPortal(<div ref={backdrop} className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className={`modal modal--${size} ${className}`.trim()} role="dialog" aria-modal="true" aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)} onMouseDown={(event) => event.stopPropagation()}>
      {(title || subtitle) && <header className="modal__header"><div>{title && <b>{title}</b>}{subtitle && <span>{subtitle}</span>}</div><button type="button" onClick={close} disabled={busy || !dismissible} aria-label="关闭">×</button></header>}
      <div className="modal__body">{children}</div>
      {footer && <footer className="modal__footer">{footer}</footer>}
    </section>
  </div>, document.body);
}
