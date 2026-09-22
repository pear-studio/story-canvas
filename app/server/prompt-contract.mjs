// 自由文本 Prompt 契约的共享常量与来源键；词条分类体系已移除。
export const PAGE_REFERENCE_IMAGE_LIMIT = 10;

export const overrideSourcePattern = /^(character|scene):([a-z0-9-]+):([a-z0-9-]+)$/;

export function characterSource(characterId, variantId) {
  return `character:${characterId}:${variantId}`;
}

export function sceneSource(sceneId, variantId) {
  return `scene:${sceneId}:${variantId}`;
}

export function parseOverrideSource(source) {
  const match = typeof source === "string" ? overrideSourcePattern.exec(source) : null;
  if (!match) return null;
  return { kind: match[1], id: match[2], variant_id: match[3] };
}
