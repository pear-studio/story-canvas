export const WORKBENCH_MODAL_SELECTOR = 'dialog[open], [aria-modal="true"], [role="menu"], details[name="workbench-popover"][open]';

// 选择器会命中常驻挂载但当前不可见的浮层（如关闭状态 details 里的菜单内容），
// 需要可见性过滤。Chrome 用 content-visibility 隐藏关闭的 details 内容，此时布局盒仍在，
// getClientRects 不可靠；checkVisibility 能正确识别 display/visibility/content-visibility 隐藏。
export function isWorkbenchModalOpen() {
  return Array.from(document.querySelectorAll(WORKBENCH_MODAL_SELECTOR)).some((element) => element.checkVisibility());
}

export function isEditingShortcutTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable
    || Boolean(target.closest("input, textarea, select, [role='textbox'], .lettering-object")));
}

export function canUseWorkbenchShortcut(event: KeyboardEvent) {
  return !event.defaultPrevented && !event.isComposing
    && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    && !isEditingShortcutTarget(event.target)
    && !isWorkbenchModalOpen();
}
