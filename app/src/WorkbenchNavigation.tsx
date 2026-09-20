import { type ReactNode, useEffect, useRef } from "react";

export function WorkbenchNavigation({ drawer, open, onClose, children }: {
  drawer: boolean;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!drawer || !open || !dialog.current) return;
    const element = dialog.current;
    const previousOverflow = document.documentElement.style.overflow;
    element.showModal();
    document.documentElement.style.overflow = "hidden";
    return () => {
      element.close();
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [drawer, open]);

  if (!drawer) return <aside id="workbench-navigation" className="project-sidebar">{children}</aside>;

  return <dialog ref={dialog} id="workbench-navigation" className="navigation-drawer" aria-label="目录"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header><button type="button" className="navigation-drawer-toggle" onClick={onClose} aria-label="关闭目录" title="关闭目录" autoFocus><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button><strong>目录</strong></header>
    <aside className="project-sidebar">{children}</aside>
  </dialog>;
}
