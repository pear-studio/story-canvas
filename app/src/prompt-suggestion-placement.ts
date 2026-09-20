type Viewport = { top: number; left: number; width: number; height: number };
type Anchor = { top: number; bottom: number; left: number; right: number };

/** 输入框和可见视口均使用布局视口坐标，适用于键盘弹出和页面缩放。 */
export function placePromptSuggestions(anchor: Anchor, viewport: Viewport) {
  const gutter = 8;
  const gap = 4;
  const topEdge = viewport.top + gutter;
  const bottomEdge = viewport.top + viewport.height - gutter;
  const leftEdge = viewport.left + gutter;
  const rightEdge = viewport.left + viewport.width - gutter;
  if (anchor.bottom <= topEdge || anchor.top >= bottomEdge || anchor.right <= leftEdge || anchor.left >= rightEdge) return null;
  const belowSpace = Math.max(0, bottomEdge - anchor.bottom - gap);
  const aboveSpace = Math.max(0, anchor.top - topEdge - gap);
  if (Math.max(aboveSpace, belowSpace) < 80 || rightEdge <= leftEdge) return null;
  const openAbove = belowSpace < 280 && aboveSpace > belowSpace;
  const width = Math.min(420, rightEdge - leftEdge);
  return {
    // 向上展开时以实际列表底边贴住输入框，不以 maxHeight 推算顶部。
    top: openAbove ? anchor.top - gap : anchor.bottom + gap,
    left: Math.min(Math.max(leftEdge, anchor.left), rightEdge - width),
    width,
    maxHeight: Math.min(280, openAbove ? aboveSpace : belowSpace),
    openAbove,
  };
}
