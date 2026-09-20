import type { CSSProperties } from "react";
import { FinishedOutputButton } from "./FinishedOutputButton";
import type { FinishedJob } from "./finished-client";

/** 文字页右侧工作区：黑底预览（文字由编辑器经 letteringTarget 门户渲染进来）+ 成品输出。 */
export function TextPageWorkspace({ projectId, pageId, canvas, dimensionError, dirty, disabled, onLetteringTarget, onOutput }: {
  projectId: string;
  pageId: string;
  canvas: string;
  dimensionError?: string | null;
  dirty: boolean;
  disabled: boolean;
  onLetteringTarget: (element: HTMLSpanElement | null) => void;
  onOutput: () => Promise<FinishedJob | null>;
}) {
  const [width, height] = canvas.split(":").map(Number);
  return <aside className="page-images">
    <div className="current-media-stack">
      <div className="current-image current-image--lettering" style={{ "--preview-aspect": `${width} / ${height}` } as CSSProperties}>
        <span className="current-image__media">
          <span className="current-image__lettering-target" ref={onLetteringTarget} />
        </span>
      </div>
      {dimensionError && <p className="prompt-save-error" role="alert">{dimensionError}（当前仅显示排版草稿）</p>}
      <FinishedOutputButton projectId={projectId} pageId={pageId} dirty={dirty} disabled={disabled || Boolean(dimensionError)} onOutput={onOutput} />
    </div>
  </aside>;
}
