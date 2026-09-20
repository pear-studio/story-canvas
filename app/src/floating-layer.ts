import { useLayoutEffect, useRef, type RefObject } from "react";

// 原生 popover 的焦点恢复不能改动正文输入框的选区。
function preserveFocus(action: () => void) {
  const active = document.activeElement;
  const selection = window.getSelection();
  const anchor = selection?.anchorNode, focus = selection?.focusNode;
  const anchorOffset = selection?.anchorOffset ?? 0, focusOffset = selection?.focusOffset ?? 0;
  action();
  if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  if (anchor?.isConnected && focus?.isConnected) selection?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
}

export type FloatingTarget = HTMLElement | { x: number; y: number; above?: boolean };

/** 所有临时浮层共用浏览器 top layer；测量真实尺寸后避让可视视口。 */
export function mountFloatingLayer(node: HTMLElement, source: FloatingTarget | (() => FloatingTarget), preferAbove = false) {
  const previousStyle = node.getAttribute("style");
  const previousPopover = node.getAttribute("popover");
  node.setAttribute("popover", "manual");
  node.classList.add("floating-layer");
  const computed = getComputedStyle(node);
  const widthLimit = parseFloat(computed.maxWidth);
  const heightLimit = parseFloat(computed.maxHeight);
  const position = () => {
    const target = typeof source === "function" ? source() : source;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8;
    const top = (viewport?.offsetTop ?? 0) + 8;
    const width = (viewport?.width ?? window.innerWidth) - 16;
    const height = (viewport?.height ?? window.innerHeight) - 16;
    Object.assign(node.style, { position: "fixed", margin: "0", inset: "auto", transform: "none", maxWidth: `${Math.max(0, Math.min(width, widthLimit || width))}px`, maxHeight: `${Math.max(0, Math.min(height, heightLimit || height))}px`, minWidth: "0", boxSizing: "border-box", overflowY: "auto" });
    const bounds = node.getBoundingClientRect();
    const anchor = target instanceof HTMLElement ? target.getBoundingClientRect() : null;
    let x = anchor ? anchor.left : (target as { x: number }).x;
    let y = anchor ? anchor.bottom + 6 : (target as { y: number }).y;
    if (!anchor && "above" in target && target.above) y -= bounds.height;
    if (anchor && ((preferAbove && anchor.top - bounds.height - 6 >= top) || (y + bounds.height > top + height && anchor.top - bounds.height - 6 >= top))) y = anchor.top - bounds.height - 6;
    x = Math.max(left, Math.min(x, left + width - bounds.width));
    y = Math.max(top, Math.min(y, top + height - bounds.height));
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  };
  preserveFocus(() => node.showPopover());
  position();
  const observer = new ResizeObserver(position);
  observer.observe(node);
  const initialTarget = typeof source === "function" ? source() : source;
  if (initialTarget instanceof HTMLElement) observer.observe(initialTarget);
  node.addEventListener("floating-position", position);
  window.addEventListener("resize", position);
  document.addEventListener("scroll", position, true);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  return () => {
    observer.disconnect();
    node.removeEventListener("floating-position", position);
    window.removeEventListener("resize", position);
    document.removeEventListener("scroll", position, true);
    window.visualViewport?.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("scroll", position);
    if (node.matches(":popover-open")) preserveFocus(() => node.hidePopover());
    node.classList.remove("floating-layer");
    if (previousPopover === null) node.removeAttribute("popover"); else node.setAttribute("popover", previousPopover);
    if (previousStyle === null) node.removeAttribute("style"); else node.setAttribute("style", previousStyle);
  };
}

export function useFloatingLayer(ref: RefObject<HTMLElement | null>, target: FloatingTarget | null) {
  const latest = useRef(target);
  latest.current = target;
  useLayoutEffect(() => {
    if (ref.current && latest.current) return mountFloatingLayer(ref.current, () => latest.current!);
  }, [ref, Boolean(target)]);
  useLayoutEffect(() => { if (target) ref.current?.dispatchEvent(new Event("floating-position")); });
}

/** 原生 modal dialog 外部节点是 inert；交互浮层必须属于当前弹窗。 */
export function floatingLayerHost() {
  return Array.from(document.querySelectorAll<HTMLDialogElement>("dialog:modal")).at(-1) ?? document.body;
}
