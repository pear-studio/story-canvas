import { type RefObject, useEffect, useRef } from "react";

const layers: symbol[] = [];

/** 虚拟键盘弹出/收起与移动端地址栏显隐只改变视口高度；只有宽度变化（旋转、桌面窗口调整）才需要关闭浮层。 */
export function layerClosesOnResize(previousWidth: number, nextWidth: number) {
  return nextWidth !== previousWidth;
}

// 临时浮层的公共关闭行为；不用于正文折叠区或带保存保护的 Modal。
export function useDismissableLayer({ open, ref, triggerRef, onClose, closeOnScroll = false }: {
  open: boolean;
  ref: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  closeOnScroll?: boolean;
}) {
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    if (!open) return;
    const layer = Symbol();
    layers.push(layer);
    const inside = (event: Event) => event.composedPath().some((target) => target === ref.current || target === triggerRef?.current);
    const outside = (event: Event) => { if (!inside(event)) latestClose.current(); };
    const close = () => latestClose.current();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || layers.at(-1) !== layer) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      triggerRef?.current?.focus();
    };
    // 捕获阶段不受内部控件 stopPropagation 影响，也不吞掉外部目标的点击。
    let lastWidth = window.innerWidth;
    const resize = () => {
      const width = window.innerWidth;
      if (!layerClosesOnResize(lastWidth, width)) return;
      lastWidth = width;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", close);
    if (closeOnScroll) document.addEventListener("scroll", outside, true);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", close);
      if (closeOnScroll) document.removeEventListener("scroll", outside, true);
    };
  }, [open, ref, triggerRef, closeOnScroll]);
}
