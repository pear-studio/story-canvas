export const MIN_CROP_SELECTION = 0.04;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function constrainCropRect(rect) {
  const width = clamp(finite(rect.width, 1), MIN_CROP_SELECTION, 1);
  const height = clamp(finite(rect.height, 1), MIN_CROP_SELECTION, 1);
  return {
    x: clamp(finite(rect.x, 0), 0, 1 - width),
    y: clamp(finite(rect.y, 0), 0, 1 - height),
    width,
    height,
  };
}

export function fitCropToAspect(rect, pixelRatio, sourceSize) {
  const current = constrainCropRect(rect);
  const normalizedRatio = pixelRatio * sourceSize.height / sourceSize.width;
  let width = current.width;
  let height = current.height;
  if (width / height > normalizedRatio) width = height * normalizedRatio;
  else height = width / normalizedRatio;
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  return constrainCropRect({ x: centerX - width / 2, y: centerY - height / 2, width, height });
}

function resizeFreeform(rect, handle, point) {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  let next = rect;
  if (handle.includes("w")) {
    const x = clamp(point.x, 0, right - MIN_CROP_SELECTION);
    next = { ...next, x, width: right - x };
  }
  if (handle.includes("e")) {
    const nextRight = clamp(point.x, rect.x + MIN_CROP_SELECTION, 1);
    next = { ...next, width: nextRight - rect.x };
  }
  if (handle.includes("n")) {
    const y = clamp(point.y, 0, bottom - MIN_CROP_SELECTION);
    next = { ...next, y, height: bottom - y };
  }
  if (handle.includes("s")) {
    const nextBottom = clamp(point.y, rect.y + MIN_CROP_SELECTION, 1);
    next = { ...next, height: nextBottom - rect.y };
  }
  return constrainCropRect(next);
}

export function resizeCropRect(rect, handle, point, sourceSize, lockAspect, pixelRatio) {
  const current = constrainCropRect(rect);
  if (!lockAspect || handle.length === 1) return resizeFreeform(current, handle, point);
  const anchorX = handle.includes("w") ? current.x + current.width : current.x;
  const anchorY = handle.includes("n") ? current.y + current.height : current.y;
  const normalizedRatio = pixelRatio * sourceSize.height / sourceSize.width;
  const rawWidth = Math.abs(point.x - anchorX);
  const rawHeight = Math.abs(point.y - anchorY);
  const maxWidth = handle.includes("w") ? anchorX : 1 - anchorX;
  const maxHeight = handle.includes("n") ? anchorY : 1 - anchorY;
  const maxRatioHeight = Math.min(maxHeight, maxWidth / normalizedRatio);
  const minimumRatioHeight = Math.max(MIN_CROP_SELECTION, MIN_CROP_SELECTION / normalizedRatio);
  const desiredHeight = Math.max(rawHeight, rawWidth / normalizedRatio);
  const height = clamp(desiredHeight, Math.min(minimumRatioHeight, maxRatioHeight), maxRatioHeight);
  const width = height * normalizedRatio;
  return constrainCropRect({
    x: handle.includes("w") ? anchorX - width : anchorX,
    y: handle.includes("n") ? anchorY - height : anchorY,
    width,
    height,
  });
}
