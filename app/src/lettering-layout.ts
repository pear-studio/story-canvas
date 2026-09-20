// @ts-expect-error 共享的确定性排版实现由 Node 与浏览器共同加载，类型在本文件收窄。
import { canvasDimensions as resolveCanvasDimensions, resizeLetteringBox as resizeBox, resolveLetteringLayout as resolveLayout } from "../shared/lettering-layout.mjs";

export type ResolvedLetteringLayout = {
  box: { x: number; y: number; w: number; h: number };
  lines: string[];
  columns: string[][];
  overflow: boolean;
};

export const canvasDimensions = resolveCanvasDimensions as (canvas?: string) => { width: number; height: number };
export const resolveLetteringLayout = resolveLayout as (input: {
  text: string;
  direction: "horizontal" | "vertical";
  kind: "plain" | "balloon" | "caption" | "float";
  fontSize: number;
  canvasWidth: number;
  canvasHeight: number;
  box: { x: number; y: number; w: number; h: number };
}) => ResolvedLetteringLayout;

export const resizeLetteringBox = resizeBox as (
  box: ResolvedLetteringLayout["box"],
  renderedBox: ResolvedLetteringLayout["box"],
  direction: "horizontal" | "vertical",
  dx: number,
  dy: number,
) => ResolvedLetteringLayout["box"];
