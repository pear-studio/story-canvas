import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { constrainCropRect, fitCropToAspect, resizeCropRect, type CropHandle } from "./lora-crop-geometry.mjs";

export type LoraCropRect = { x: number; y: number; width: number; height: number };
type PostprocessDraft = LoraCropRect & { cropEnabled?: boolean; upscale?: boolean; outputScale?: 1 | 2 | 4 };
type Point = { x: number; y: number };
type ViewTransform = { zoom: number; panX: number; panY: number };
type Gesture =
  | { pointerId: number; kind: "pan"; start: Point; view: ViewTransform }
  | { pointerId: number; kind: "move" | "resize"; handle?: CropHandle; start: Point; rect: LoraCropRect; aspectRatio: number };

const MIN_ZOOM = 0.03;
const MAX_ZOOM = 16;
const CROP_ASPECT_RATIOS = [
  { label: "当前", value: null },
  { label: "1:1", value: 1 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function imageSize(width: number | null, height: number | null) {
  const fallbackWidth = width ?? 1200;
  return { width: fallbackWidth, height: height ?? Math.round(fallbackWidth / (width && height ? width / height : 4 / 3)) };
}

function quality(shortSide: number) {
  if (shortSide >= 768) return { className: "is-good", text: "像素尺寸充足；仍需检查实际清晰度" };
  if (shortSide >= 512) return { className: "is-caution", text: "可以使用；建议检查主体细节" };
  return { className: "is-warning", text: "短边低于 512 像素，建议换源或谨慎超分" };
}

export default function LoraCropEditor({
  src,
  comparisonSrc,
  comparisonMatches = false,
  comparisonWidth,
  comparisonHeight,
  applyReady = false,
  errorMessage,
  alt,
  imageWidth,
  imageHeight,
  initial,
  busy,
  hasProcessing = false,
  upscaleAvailable = true,
  upscaleDisabledReason,
  onCancel,
  onDraftChange,
  onConfirm,
  onRestore,
}: {
  src: string;
  comparisonSrc?: string;
  comparisonMatches?: boolean;
  comparisonWidth?: number;
  comparisonHeight?: number;
  applyReady?: boolean;
  errorMessage?: string;
  alt: string;
  imageWidth: number | null;
  imageHeight: number | null;
  initial: PostprocessDraft;
  busy: boolean;
  hasProcessing?: boolean;
  upscaleAvailable?: boolean;
  upscaleDisabledReason?: string;
  onCancel: () => void;
  onDraftChange?: (draft: PostprocessDraft) => void;
  onConfirm: (rect: LoraCropRect, cropEnabled: boolean, upscale: boolean, outputScale: 1 | 2 | 4) => void;
  onRestore?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const fittedRef = useRef(false);
  const openedDraftRef = useRef({ ...initial });
  const [rect, setRect] = useState(() => constrainCropRect(initial));
  const [sourceSize, setSourceSize] = useState(() => imageSize(imageWidth, imageHeight));
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const [view, setView] = useState<ViewTransform>({ zoom: 1, panX: 0, panY: 0 });
  const [dragging, setDragging] = useState<Gesture["kind"] | null>(null);
  const [cropEnabled, setCropEnabled] = useState(initial.cropEnabled === true);
  const [selectedRatio, setSelectedRatio] = useState<number | null>(null);
  const [upscale, setUpscale] = useState(initial.upscale === true);
  const [outputScale, setOutputScale] = useState<1 | 2 | 4>(initial.outputScale ?? 2);
  const [viewMode, setViewMode] = useState<"original" | "processed">("original");

  function fit(nextViewport = viewportSize, nextImage = sourceSize) {
    const zoom = Math.min(nextViewport.width / nextImage.width, nextViewport.height / nextImage.height, 1);
    setView({ zoom, panX: (nextViewport.width - nextImage.width * zoom) / 2, panY: (nextViewport.height - nextImage.height * zoom) / 2 });
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const next = { width: Math.max(1, viewport.clientWidth), height: Math.max(1, viewport.clientHeight) };
      setViewportSize(next);
      if (!fittedRef.current) { fittedRef.current = true; fit(next, sourceSize); }
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [sourceSize.width, sourceSize.height]);

  useEffect(() => { onDraftChange?.({ ...rect, cropEnabled, upscale, outputScale }); }, [cropEnabled, rect, upscale, outputScale, onDraftChange]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
      if (event.key === "ArrowLeft") { event.preventDefault(); setViewMode("original"); }
      if (event.key === "ArrowRight" && comparisonSrc && comparisonMatches) { event.preventDefault(); setViewMode("processed"); }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); };
  }, [busy, comparisonMatches, comparisonSrc, onCancel]);

  useEffect(() => { if (!comparisonSrc || !comparisonMatches) setViewMode("original"); }, [comparisonMatches, comparisonSrc]);

  function screenPoint(event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">): Point {
    const bounds = viewportRef.current?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  }

  function normalizedPoint(event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">): Point {
    const point = screenPoint(event);
    return { x: clamp((point.x - view.panX) / view.zoom / sourceSize.width, 0, 1), y: clamp((point.y - view.panY) / view.zoom / sourceSize.height, 0, 1) };
  }

  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || busy || event.target !== event.currentTarget) return;
    gestureRef.current = { pointerId: event.pointerId, kind: "pan", start: screenPoint(event), view };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging("pan");
  }

  function beginCrop(event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize", handle?: CropHandle) {
    if (event.button !== 0 || busy || !cropEnabled || viewMode !== "original" || !viewportRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const aspectRatio = selectedRatio ?? (rect.width * sourceSize.width) / (rect.height * sourceSize.height);
    gestureRef.current = { pointerId: event.pointerId, kind, handle, start: normalizedPoint(event), rect, aspectRatio };
    viewportRef.current.setPointerCapture(event.pointerId);
    setDragging(kind);
  }

  function updateGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (gesture.kind === "pan") {
      const point = screenPoint(event);
      setView({ ...gesture.view, panX: gesture.view.panX + point.x - gesture.start.x, panY: gesture.view.panY + point.y - gesture.start.y });
      return;
    }
    const point = normalizedPoint(event);
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (gesture.kind === "move") { setRect(constrainCropRect({ ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy })); return; }
    if (!gesture.handle) return;
    const lockAspect = gesture.handle.length === 2 && !event.shiftKey;
    if (!lockAspect) setSelectedRatio(null);
    setRect(resizeCropRect(gesture.rect, gesture.handle, point, sourceSize, lockAspect, gesture.aspectRatio));
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
    setDragging(null);
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const point = screenPoint(event);
    const world = { x: (point.x - view.panX) / view.zoom, y: (point.y - view.panY) / view.zoom };
    const zoom = clamp(view.zoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
    setView({ zoom, panX: point.x - world.x * zoom, panY: point.y - world.y * zoom });
  }

  function reset() {
    if (busy) return;
    const opened = openedDraftRef.current;
    setRect(constrainCropRect(opened));
    setCropEnabled(opened.cropEnabled === true);
    setSelectedRatio(null);
    setUpscale(opened.upscale === true);
    setOutputScale(opened.outputScale ?? 2);
    fit();
  }

  function applyAspectRatio(ratio: number | null) {
    if (busy || !cropEnabled) return;
    setSelectedRatio(ratio);
    if (ratio) setRect((current) => fitCropToAspect(current, ratio, sourceSize));
  }

  function onImageLoad(event: React.SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    if (!image.naturalWidth || !image.naturalHeight || (image.naturalWidth === sourceSize.width && image.naturalHeight === sourceSize.height)) return;
    const next = { width: image.naturalWidth, height: image.naturalHeight };
    setSourceSize(next);
    fittedRef.current = true;
    fit(viewportSize, next);
  }

  const effectiveRect = cropEnabled ? rect : { x: 0, y: 0, width: 1, height: 1 };
  const cropWidth = Math.max(1, Math.round(effectiveRect.width * sourceSize.width));
  const cropHeight = Math.max(1, Math.round(effectiveRect.height * sourceSize.height));
  const cropLeft = Math.round(effectiveRect.x * sourceSize.width);
  const cropTop = Math.round(effectiveRect.y * sourceSize.height);
  const cropRight = Math.round((effectiveRect.x + effectiveRect.width) * sourceSize.width);
  const cropBottom = Math.round((effectiveRect.y + effectiveRect.height) * sourceSize.height);
  const hasCrop = cropEnabled && (cropLeft !== 0 || cropTop !== 0 || cropRight !== sourceSize.width || cropBottom !== sourceSize.height);
  const hasOperation = hasCrop || upscale;
  const finalWidth = upscale ? cropWidth * outputScale : cropWidth;
  const finalHeight = upscale ? cropHeight * outputScale : cropHeight;
  const qualityState = quality(Math.min(cropWidth, cropHeight));
  const worldStyle = useMemo(() => ({ width: sourceSize.width, height: sourceSize.height, transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }), [sourceSize, view]);
  const cropStyle = { left: effectiveRect.x * sourceSize.width, top: effectiveRect.y * sourceSize.height, width: effectiveRect.width * sourceSize.width, height: effectiveRect.height * sourceSize.height };
  const handleLabels: Record<CropHandle, string> = { n: "调整上边", ne: "调整右上角", e: "调整右边", se: "调整右下角", s: "调整下边", sw: "调整左下角", w: "调整左边", nw: "调整左上角" };

  return createPortal(
    <div className="lora-crop-backdrop" role="presentation">
      <section className="lora-crop-dialog" role="dialog" aria-modal="true" aria-label="图片后处理">
        <header><div><b>图片后处理</b><span>滚轮缩放 · 拖动空白处平移{cropEnabled ? " · 角点等比缩放，Shift 临时自由缩放，边中点单向缩放" : " · 启用裁剪后显示选区"} · ←/→ 对比</span></div><button type="button" onClick={onCancel} disabled={busy} aria-label="关闭图片后处理">×</button></header>
        <div className="lora-crop-body">
          <div ref={viewportRef} className={`lora-crop-stage ${dragging ? "is-dragging" : ""}`.trim()} onPointerDown={beginPan} onPointerMove={updateGesture} onPointerUp={endGesture} onPointerCancel={endGesture} onWheel={onWheel}>
            <div className="lora-crop-world" style={worldStyle}>
              {viewMode === "processed" && comparisonSrc && comparisonMatches
                ? <><img className="lora-crop-source-image" src={src} alt={alt} draggable={false} onLoad={onImageLoad} /><div className="lora-crop-comparison-mask" style={cropStyle} /><div className="lora-crop-processed-backdrop" style={cropStyle} /><img className="lora-crop-processed-image" src={comparisonSrc} alt="处理结果" draggable={false} style={cropStyle} /></>
                : <><img className="lora-crop-source-image" src={src} alt={alt} draggable={false} onLoad={onImageLoad} />{cropEnabled && <div className="lora-crop-selection" style={cropStyle} onPointerDown={(event) => beginCrop(event, "move")}>{(Object.keys(handleLabels) as CropHandle[]).map((handle) => <span key={handle} className={`lora-crop-handle lora-crop-handle--${handle}`} role="button" tabIndex={0} aria-label={handleLabels[handle]} onPointerDown={(event) => beginCrop(event, "resize", handle)} />)}</div>}</>}
            </div>
          </div>
        </div>
        <footer>
          <div className={`lora-crop-resolution ${qualityState.className}`} aria-live="polite"><span>{hasCrop ? "裁剪输入" : "原图输入"}</span><strong>{cropWidth}×{cropHeight}</strong><span>最终输出</span><strong>{comparisonMatches && comparisonWidth && comparisonHeight ? `${comparisonWidth}×${comparisonHeight}` : `${finalWidth}×${finalHeight}`}</strong><small>{qualityState.text}{upscale ? "；增强可能改变细节，请对比确认，不保证还原真实细节" : ""}</small></div>
          <div className="lora-postprocess-controls">
            <div className="lora-postprocess-control-row"><span>处理</span><div className="lora-postprocess-segments"><button type="button" aria-pressed={cropEnabled} className={cropEnabled ? "is-active" : ""} onClick={() => setCropEnabled((current) => !current)} disabled={busy}>裁剪</button><button type="button" aria-pressed={upscale} className={upscale ? "is-active" : ""} title={!upscaleAvailable ? upscaleDisabledReason : undefined} onClick={() => setUpscale((current) => !current)} disabled={busy || !upscaleAvailable}>超分增强</button></div></div>
            <div className={`lora-postprocess-control-row ${cropEnabled ? "" : "is-disabled"}`.trim()}><span>比例</span><div className="lora-postprocess-ratios">{CROP_ASPECT_RATIOS.map((option) => <button type="button" key={option.label} aria-pressed={selectedRatio === option.value} className={selectedRatio === option.value ? "is-active" : ""} onClick={() => applyAspectRatio(option.value)} disabled={busy || !cropEnabled}>{option.label}</button>)}</div></div>
            <div className={`lora-postprocess-control-row ${upscale ? "" : "is-disabled"}`.trim()}><span>尺寸</span><div className="lora-postprocess-segments"><button type="button" aria-pressed={outputScale === 1} className={outputScale === 1 ? "is-active" : ""} onClick={() => setOutputScale(1)} disabled={busy || !upscale}>原尺寸 1×</button><button type="button" aria-pressed={outputScale === 2} className={outputScale === 2 ? "is-active" : ""} onClick={() => setOutputScale(2)} disabled={busy || !upscale}>2×</button><button type="button" aria-pressed={outputScale === 4} className={outputScale === 4 ? "is-active" : ""} onClick={() => setOutputScale(4)} disabled={busy || !upscale}>4×</button></div></div>
          </div>
          <div className="lora-crop-footer-actions">
            {errorMessage && <p className="lora-crop-error" role="alert">{errorMessage}</p>}
            <small className="lora-crop-view-state">{comparisonSrc && comparisonMatches ? `当前：${viewMode === "original" ? "原图" : "处理结果"} · 两种视图共享缩放和位置` : upscaleAvailable ? "生成预览后可用方向键对比" : (upscaleDisabledReason ?? "超分模型不可用")}{upscale && "；透明区域自动填充白色，原图保留"}</small>
            <div className="lora-crop-footer-buttons">{hasProcessing && onRestore && <button type="button" onClick={onRestore} disabled={busy}>恢复原图</button>}<button type="button" onClick={reset} disabled={busy}>重置</button><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className={hasOperation ? "is-primary" : undefined} title={!hasOperation ? "启用裁剪并调整选区，或启用超分后可生成预览" : undefined} onClick={() => onConfirm(rect, cropEnabled, upscale, outputScale)} disabled={busy || !hasOperation}>{applyReady ? "应用预览" : "生成预览"}</button></div>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
