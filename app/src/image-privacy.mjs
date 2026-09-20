export const IMAGE_PRIVACY_STORAGE_KEY = "story-canvas:image-privacy:v1";

export function applyImagePrivacy(root, state) {
  root.dataset.imagePrivacy = state;
}

export function initializeImagePrivacy(storage, root) {
  let hidden = false;
  try {
    hidden = storage?.getItem(IMAGE_PRIVACY_STORAGE_KEY) === "hidden";
  } catch {
    // 存储不可用时保持默认显示，开关仍可在当前页面工作。
  }
  applyImagePrivacy(root, hidden ? "hidden" : "visible");
  return hidden;
}

export function persistImagePrivacy(storage, root, hidden) {
  applyImagePrivacy(root, hidden ? "hidden" : "visible");
  try {
    storage?.setItem(IMAGE_PRIVACY_STORAGE_KEY, hidden ? "hidden" : "visible");
  } catch {
    // 存储不可用只影响刷新后的恢复，不影响当前页面的隐私状态。
  }
}
