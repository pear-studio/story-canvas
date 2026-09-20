import { floatingLayerHost } from "./floating-layer";
import { useFloatingLayer } from "./floating-layer";
import { useRef } from "react";
import { useDismissableLayer } from "./use-dismissable-layer";
import { createPortal } from "react-dom";

export type NavigationMenuItem = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

export type NavigationMenuRequest = {
  x: number;
  y: number;
  label: string;
  items: NavigationMenuItem[];
};

export function NavigationContextMenu({ request, onClose }: { request: NavigationMenuRequest | null; onClose: () => void }) {
  const menu = useRef<HTMLDivElement | null>(null);
  useFloatingLayer(menu, request);

  useDismissableLayer({ open: Boolean(request), ref: menu, onClose, closeOnScroll: true });

  if (!request) return null;
  return createPortal(<div className="navigation-context-menu" role="menu" aria-label={request.label} ref={menu}>
    <strong className="navigation-context-menu__label">{request.label}</strong>
    {request.items.map((item) => <button type="button" role="menuitem" className={item.danger ? "is-danger" : ""} disabled={item.disabled} key={item.id} onClick={() => { item.onSelect(); onClose(); }}><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}</button>)}
  </div>, floatingLayerHost());
}
