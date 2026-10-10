import { useEffect, useState } from 'react';
// @ts-expect-error 浏览器和 Node 共用的确定性装饰排版。
import { createHeartComposition, orientHeartComposition, heartBounds, heartDefaults, heartColor } from '../shared/heart-lettering.mjs';
import type { LetteringItem } from './lettering';
import './HeartLettering.css';

export type HeartSettings = NonNullable<LetteringItem['heart']>;
type Heart = { x: number; y: number; r: number; scale: number; angle: number; asset: { id: string; d: string } };
type Box = { l: number; t: number; r: number; b: number };
/** 已存条目沿用自身字号；未存的按项目字号 × `heartFontScale` 推导。 */
export function heartSettings(item: LetteringItem, styleFontSize?: number): HeartSettings { return item.heart ?? heartDefaults(item.dialogue_id, styleFontSize); }
let measure: CanvasRenderingContext2D | null = null;
const cache = new Map<string, { boxes: Box[]; hearts: Heart[]; glyphs: { text: string; x: number }[] }>();
let fontReady: Promise<void> | undefined;
export function useHeartFont() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    fontReady ??= document.fonts.load('100px SVHeart').then(() => { cache.clear(); });
    void fontReady.then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);
  return ready;
}
export function resolveHeart(text: string, item: LetteringItem, dimensions: { width: number; height: number }, styleFontSize?: number, fontFamily='SVHeart', decorationText=text) {
  const settings = heartSettings(item, styleFontSize), key = JSON.stringify([text, settings.seed,fontFamily,decorationText,document.fonts.check(`100px ${fontFamily}`,text)]);
  let composition = cache.get(key);
  if (!composition) {
    measure ??= document.createElement('canvas').getContext('2d')!;
    measure.font = `100px ${fontFamily}`; measure.textAlign = 'left';
    let prefix = '';
    const glyphs: { text: string; x: number }[] = [];
    const boxes = [...text].map(ch => {
      const x = measure!.measureText(prefix).width, m = measure!.measureText(ch); prefix += ch;
      glyphs.push({ text: ch, x });
      return { l: x - m.actualBoundingBoxLeft - 4, r: x + m.actualBoundingBoxRight + 4, t: -m.actualBoundingBoxAscent - 4, b: m.actualBoundingBoxDescent + 4 };
    });
    composition = { boxes, glyphs, hearts: createHeartComposition(text, boxes, settings.seed,decorationText) as Heart[] };
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, composition);
  }
  const oriented = orientHeartComposition(composition.boxes, composition.hearts, settings.rotation) as { boxes: Box[]; hearts: Heart[]; offsets: { x: number; y: number }[] };
  const glyphs = composition.glyphs.map((g, i) => ({ ...g, x: g.x + oriented.offsets[i].x, y: oriented.offsets[i].y }));
  const viewBox: number[] = heartBounds(oriented.boxes, oriented.hearts);
  const factor = settings.font_size / 100;
  return { ...oriented, glyphs, viewBox, settings,fontFamily, lines: [text], columns: [], overflow: false, box: { ...item.box, w: viewBox[2] * factor / dimensions.width, h: viewBox[3] * factor / dimensions.height } };
}
export function HeartLettering({ layout }: { text: string; layout: ReturnType<typeof resolveHeart> }) {
  return <svg className="heart-lettering" viewBox={layout.viewBox.join(' ')} aria-hidden="true">
    <g>
      {layout.glyphs.map((glyph, i) => <text key={i} x={glyph.x} y={glyph.y} fontFamily={layout.fontFamily} fontSize="100" fill={heartColor} stroke="white" strokeWidth="6.4" strokeLinejoin="round" paintOrder="stroke fill">{glyph.text}</text>)}
      {layout.hearts.map((h, i) => <g key={i} data-heart-asset={h.asset.id} transform={`translate(${h.x} ${h.y}) scale(${h.scale})`}><path d={h.asset.d} fill={heartColor} fillRule="evenodd" stroke="white" strokeWidth="3.4" strokeLinejoin="round" paintOrder="stroke fill" /></g>)}
    </g>
  </svg>;
}
export function DiceIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.6" />{[[8,8],[16,8],[12,12],[8,16],[16,16]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" fill="currentColor" />)}</svg>;
}
