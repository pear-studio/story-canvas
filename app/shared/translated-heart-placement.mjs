const overlap = (a, b) => {
  const area = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return area / Math.max(1e-12, Math.min(a.w * a.h, b.w * b.h));
};

/** 输入整页归一化边界；只派生外语位置，不修改中文布局。优先保留原靠边关系。 */
export function placeTranslatedHeart(box, source, obstacles = [], bounds = {x: 0, y: 0, w: 1, h: 1}) {
  const right = bounds.x + bounds.w, bottom = bounds.y + bounds.h;
  const inside = b => b.x >= bounds.x && b.y >= bounds.y && b.x + b.w <= right && b.y + b.h <= bottom;
  if (inside(box)) return box;
  const margin = .005, maxCorrection = .02;
  const anchor = (start, size, translatedSize, low, high) => {
    // 中文通常会留出几百分点的页边距，不应仅因未紧贴边缘而失去靠边关系。
    // 两侧都近时采用较近的一侧，避免大框无条件偏向右/下。
    const leading = start - low, trailing = high - start - size;
    const edgeZone = (high - low) * .08;
    if (trailing <= edgeZone && trailing < leading) return start + size - translatedSize;
    if (leading <= edgeZone && leading < trailing) return start;
    return start + (size - translatedSize) / 2;
  };
  const anchored = {...box,
    x: anchor(source.x, source.w, box.w, bounds.x, right),
    y: anchor(source.y, source.h, box.h, bounds.y, bottom)};
  // 单轴能解决时保留另一轴的位置，避免无关移动碰到邻近文字。
  for (const candidate of [box, {...box, x: anchored.x}, {...box, y: anchored.y}, anchored]) {
    const x = Math.max(bounds.x + margin, Math.min(candidate.x, right - margin - box.w));
    const y = Math.max(bounds.y + margin, Math.min(candidate.y, bottom - margin - box.h));
    const next = {...box, x, y};
    if (!inside(next) || Math.abs(x - candidate.x) > maxCorrection || Math.abs(y - candidate.y) > maxCorrection) continue;
    // 已存在的交叠不扩大；不为消除越界而引入新的明显遮挡。
    if (obstacles.some(other => overlap(next, other) >= .18 && overlap(next, other) > overlap(box, other) + 1e-8)) continue;
    return next;
  }
  return box;
}
