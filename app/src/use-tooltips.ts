import { useEffect } from "react";
import { mountFloatingLayer } from "./floating-layer";

/** data-tooltip 是全站文字提示入口，不在业务容器内绘制伪元素。 */
export function useTooltips() {
  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let cleanup: (() => void) | undefined;
    let tooltip: HTMLElement | null = null;
    let oldDescription: string | null = null;
    const close = () => {
      cleanup?.(); cleanup = undefined;
      tooltip?.remove(); tooltip = null;
      if (anchor) {
        if (oldDescription === null) anchor.removeAttribute("aria-describedby");
        else anchor.setAttribute("aria-describedby", oldDescription);
      }
      anchor = null;
    };
    const show = (event: Event) => {
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null;
      if (next === anchor) return;
      close();
      if (!next?.dataset.tooltip) return;
      anchor = next;
      tooltip = document.createElement("div");
      tooltip.id = "workbench-tooltip";
      tooltip.className = "workbench-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.textContent = next.dataset.tooltip;
      oldDescription = next.getAttribute("aria-describedby");
      next.setAttribute("aria-describedby", [oldDescription, tooltip.id].filter(Boolean).join(" "));
      (next.closest("dialog") ?? document.body).append(tooltip);
      cleanup = mountFloatingLayer(tooltip, next);
    };
    const leave = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget;
      if (anchor && related instanceof Node && anchor.contains(related)) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    return () => {
      close();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
    };
  }, []);
}
