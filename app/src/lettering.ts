// @ts-expect-error 与服务端共用的默认爱心参数。
import { heartDefaults } from "../shared/heart-lettering.mjs";
export type LetteringKind = "plain" | "balloon" | "caption" | "float";
export type LetteringDirection = "horizontal" | "vertical";
export type DialogueMode = "narration" | "speech" | "thought" | "heart";
export type NarrationPosition = "top" | "bottom";
export type DialogueLine = { id: string; speaker?: string; mode: DialogueMode; text: string; position?: NarrationPosition };
export type LetteringPreset = { direction: LetteringDirection; kind: LetteringKind };
export type LetteringStyle = {
  font_family: string;
  font_size: number;
  character_speech: LetteringPreset;
  character_thought: LetteringPreset;
  npc_speech: LetteringPreset;
};
export type LetteringSettings = LetteringStyle & {
  $schema: "https://storyvisualizer.local/schemas/lettering-settings.schema.json";
  character_colors: Record<string, string>;
};
export const defaultCharacterDisplayColor = "#26322D";
export type LetteringItem = {
  dialogue_id: string;
  box: { x: number; y: number; w: number; h: number };
  heart?: { font_size: number; rotation: number; seed: number };
};
export type LetteringIssue = "overflow" | "outside" | "edge" | "overlap";

export const neutralLetteringColor = "#303532";

export const letteringLogicalCanvasWidth = 1024;

export function letteringTypographyVariables(style: Pick<LetteringStyle, "font_family" | "font_size">, scale: number | "canvas") {
  return {
    "--lettering-font-family": `"${style.font_family.replaceAll('"', "")}", "Microsoft YaHei", sans-serif`,
    "--lettering-font-size": scale === "canvas" ? `${style.font_size / 10.24}cqw` : `${style.font_size * scale}px`,
    "--lettering-canvas-unit": scale === "canvas" ? "1cqw" : `${Number((10.24 * scale).toFixed(6))}px`,
  };
}

export function letteringPreset(line: DialogueLine, style: LetteringStyle) {
  // 爱心与旁白都是特殊格式，不使用可配置预设；旁白由通栏字幕条固定渲染（position 选择顶部或底部）。
  if (line.mode === "heart" || line.mode === "narration") return { direction: "horizontal", kind: "plain" } as const;
  if (line.speaker === "npc") return style.npc_speech;
  return line.mode === "thought" ? style.character_thought : style.character_speech;
}

export function darkenDisplayColor(color = "#89938e") {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return neutralLetteringColor;
  const value = Number.parseInt(match[1], 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const sourceLightness = (maximum + minimum) / 2;
  const sourceSaturation = delta ? delta / (1 - Math.abs(2 * sourceLightness - 1)) : 0;
  const saturation = sourceSaturation < 0.04 ? 0 : Math.min(0.62, Math.max(0.24, sourceSaturation));
  const lightness = Math.min(0.34, Math.max(0.18, sourceLightness));
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  let rgb = [0, 0, 0];
  if (segment < 1) rgb = [chroma, secondary, 0];
  else if (segment < 2) rgb = [secondary, chroma, 0];
  else if (segment < 3) rgb = [0, chroma, secondary];
  else if (segment < 4) rgb = [0, secondary, chroma];
  else if (segment < 5) rgb = [secondary, 0, chroma];
  else rgb = [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return `#${rgb.map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** 与 darkenDisplayColor 相反方向：深底叙述框内的文字色,保色相、提到高明度并保留可辨识的饱和度。 */
export function lightenDisplayColor(color = "#89938e") {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return "#f2eee3";
  const value = Number.parseInt(match[1], 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const sourceLightness = (maximum + minimum) / 2;
  const sourceSaturation = delta ? delta / (1 - Math.abs(2 * sourceLightness - 1)) : 0;
  const saturation = sourceSaturation < 0.04 ? 0.12 : Math.min(0.72, Math.max(0.4, sourceSaturation));
  const lightness = Math.min(0.85, Math.max(0.78, sourceLightness + 0.45));
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  let rgb = [0, 0, 0];
  if (segment < 1) rgb = [chroma, secondary, 0];
  else if (segment < 2) rgb = [secondary, chroma, 0];
  else if (segment < 3) rgb = [0, chroma, secondary];
  else if (segment < 4) rgb = [0, secondary, chroma];
  else if (segment < 5) rgb = [secondary, 0, chroma];
  else rgb = [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return `#${rgb.map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function geometryIssues(items: LetteringItem[]) {
  const result = new Map<string, Set<LetteringIssue>>(items.map((item) => [item.dialogue_id, new Set()]));
  for (const item of items) {
    const issues = result.get(item.dialogue_id)!;
    const box = item.box;
    if (box.x < 0 || box.y < 0 || box.x + box.w > 1 || box.y + box.h > 1) issues.add("outside");
    if (box.x < 0.025 || box.y < 0.025 || 1 - box.x - box.w < 0.025 || 1 - box.y - box.h < 0.025) issues.add("edge");
  }
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex]; const right = items[rightIndex];
      const width = Math.max(0, Math.min(left.box.x + left.box.w, right.box.x + right.box.w) - Math.max(left.box.x, right.box.x));
      const height = Math.max(0, Math.min(left.box.y + left.box.h, right.box.y + right.box.h) - Math.max(left.box.y, right.box.y));
      const intersection = width * height;
      const smaller = Math.min(left.box.w * left.box.h, right.box.w * right.box.h);
      if (smaller > 0 && intersection / smaller >= 0.18) {
        result.get(left.dialogue_id)!.add("overlap");
        result.get(right.dialogue_id)!.add("overlap");
      }
    }
  }
  return result;
}

export const letteringIssueLabels: Record<LetteringIssue, string> = {
  overflow: "文字超出框体",
  outside: "框体超出画面",
  edge: "框体距离画面边缘过近",
  overlap: "与其他文字框明显重叠",
};

/** 未手动放置的已保存文案使用默认位置，仅用于预览，不隐式写入项目。旁白由通栏字幕条渲染，不产生布局项。 */
export function previewLetteringItems(
  dialogue: Array<Omit<DialogueLine, "id"> & { id?: string }>,
  items: LetteringItem[],
  style: LetteringStyle,
): LetteringItem[] {
  const saved = new Map(items.map((item) => [item.dialogue_id, item]));
  return dialogue.flatMap((line, index) => {
    if (!line.id || line.mode === "narration") return [];
    const existing = saved.get(line.id);
    if (existing) return [line.mode === "heart" && !existing.heart ? { ...existing, heart: heartDefaults(line.id, style.font_size) } : existing];
    const preset = letteringPreset({ ...line, id: line.id }, style);
    const box = preset.direction === "vertical"
      ? { x: Math.min(0.78, 0.06 + (index % 4) * 0.22), y: 0.08, w: 0.16, h: 0.4 }
      : preset.kind === "caption"
        ? { x: 0.12, y: Math.min(0.82, 0.06 + index * 0.14), w: 0.76, h: 0.12 }
        : { x: 0.06 + (index % 2) * 0.48, y: Math.min(0.78, 0.06 + Math.floor(index / 2) * 0.2), w: 0.4, h: 0.16 };
    return [{ dialogue_id: line.id, box, ...(line.mode === "heart" ? { heart: heartDefaults(line.id, style.font_size) } : {}) }];
  });
}
