import { type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isEditingShortcutTarget } from "./workbench-shortcuts";
import { mediaVariantUrl } from "./media-variant";

export type ImageOverlayTarget = { element: HTMLDivElement; canvas: string };
export default function ZoomableImageLightbox({ src, alt, footer, originalVideo = false, fullResolutionOnly = false, hint = "滚轮缩放 · 拖动查看细节", onPrevious, onNext, onClose, onOverlayTarget }: { src: string; alt: string; footer: ReactNode; originalVideo?: boolean; fullResolutionOnly?: boolean; hint?: string; onPrevious?: () => void; onNext?: () => void; onClose: () => void; onOverlayTarget?: (target: ImageOverlayTarget | null) => void }) {
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const clickStart = useRef<{ x: number; y: number } | null>(null);
  const latestClose = useRef(onClose);
  const navigation = useRef({ onPrevious, onNext });
  navigation.current = { onPrevious, onNext };
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);
  const [showOriginal, setShowOriginal] = useState(fullResolutionOnly);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  // 默认显示 1024 压缩变体加快加载；不支持变体的媒体路由会忽略 w 参数回退原图。
  const displaySrc = showOriginal ? src : mediaVariantUrl(src, 1024);
  const playingOriginal = originalVideo && showOriginal;
  useEffect(() => {
    if (overlayElement && natural.width && natural.height) onOverlayTarget?.({ element: overlayElement, canvas: `${natural.width}:${natural.height}` });
    return () => onOverlayTarget?.(null);
  }, [overlayElement, natural.width, natural.height, onOverlayTarget]);
  const fit = natural.width && natural.height ? Math.min(1, stageSize.width / natural.width, stageSize.height / natural.height) : 1;
  const baseWidth = natural.width * fit;
  const baseHeight = natural.height * fit;
  const maxZoom = Math.max(8, 1 / (fit || 1));
  latestClose.current = onClose;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); pointers.current.clear(); pinch.current = null; dragRef.current = null; setDragging(false); setShowOriginal(fullResolutionOnly); setOriginalLoaded(false); setNatural({ width: 0, height: 0 }); }, [src, fullResolutionOnly]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const lightboxes = document.querySelectorAll<HTMLElement>(".image-lightbox");
      const isTopmost = lightboxes[lightboxes.length - 1] === lightboxRef.current;
      if (!isTopmost) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditingShortcutTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        (event.key === "ArrowLeft" ? navigation.current.onPrevious : navigation.current.onNext)?.();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latestClose.current();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  function constrainPan(x: number, y: number, scale: number) {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) return { x, y };
    const maxX = Math.max(0, (baseWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (baseHeight * scale - stage.clientHeight) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  }

  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const next = Math.max(1, Math.min(maxZoom, value));
    if (next === zoom) return;
    const stage = stageRef.current;
    let nextPan = { x: 0, y: 0 };
    if (stage && clientX !== undefined && clientY !== undefined && zoom > 0) {
      const bounds = stage.getBoundingClientRect();
      const pointerX = clientX - (bounds.left + bounds.width / 2);
      const pointerY = clientY - (bounds.top + bounds.height / 2);
      const ratio = next / zoom;
      nextPan = { x: pointerX - (pointerX - pan.x) * ratio, y: pointerY - (pointerY - pan.y) * ratio };
    } else if (next > 1) nextPan = pan;
    setZoom(next);
    setPan(constrainPan(nextPan.x, nextPan.y, next));
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    changeZoom(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY);
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    clickStart.current = { x: event.clientX, y: event.clientY };
    if (event.button !== 0 || (event.pointerType !== "touch" && zoom <= 1)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom };
      dragRef.current = null;
      return;
    }
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  }

  function updateDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      event.preventDefault();
      changeZoom(pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const start = dragRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPan(constrainPan(start.panX + event.clientX - start.x, start.panY + event.clientY - start.y, zoom));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const remaining = [...pointers.current.entries()][0];
    dragRef.current = remaining ? { pointerId: remaining[0], x: remaining[1].x, y: remaining[1].y, panX: pan.x, panY: pan.y } : null;
    setDragging(Boolean(remaining));
  }

  function resetView() { setZoom(1); setPan({ x: 0, y: 0 }); }

  return createPortal(<div ref={lightboxRef} className="image-lightbox image-lightbox--zoomable" role="dialog" aria-modal="true" aria-label={alt} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <button className="image-lightbox__close" onClick={onClose} aria-label="关闭全屏图片">×</button>
    {(onPrevious || onNext) && <>
      <button type="button" className="image-lightbox__arrow image-lightbox__arrow--previous" aria-label="上一张" disabled={!onPrevious} onClick={onPrevious}>‹</button>
      <button type="button" className="image-lightbox__arrow image-lightbox__arrow--next" aria-label="下一张" disabled={!onNext} onClick={onNext}>›</button>
    </>}
    <div ref={stageRef} className={`image-lightbox__media zoomable-image-stage ${playingOriginal ? 'image-lightbox__media--video' : ''} ${dragging ? "is-dragging" : ""}`.trim()} onClick={event => {
      const start = clickStart.current; const bounds = imageRef.current?.getBoundingClientRect();
      if (!start || !bounds || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }} onWheel={playingOriginal ? undefined : handleWheel} onPointerDown={playingOriginal ? undefined : beginDrag} onPointerMove={playingOriginal ? undefined : updateDrag} onPointerUp={playingOriginal ? undefined : endDrag} onPointerCancel={playingOriginal ? undefined : endDrag}>
      {playingOriginal ? <video key={src} className="image-lightbox__original-video" src={src} aria-label="原图视频" controls autoPlay muted loop playsInline preload="metadata" onLoadedMetadata={() => setOriginalLoaded(true)} /> : <img ref={imageRef} src={displaySrc} alt={alt} draggable={false} data-full-resolution={showOriginal ? "true" : undefined} className={natural.width ? undefined : "is-loading"} onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); if (showOriginal && event.currentTarget.getAttribute("src") === src) setOriginalLoaded(true); }} style={natural.width ? { width: baseWidth * zoom, height: baseHeight * zoom, left: Math.round((stageSize.width - baseWidth * zoom) / 2 + pan.x), top: Math.round((stageSize.height - baseHeight * zoom) / 2 + pan.y) } : undefined} />}
      {onOverlayTarget && natural.width > 0 && <div ref={setOverlayElement} className="image-lightbox__lettering" style={{ width: baseWidth * zoom, height: baseHeight * zoom, left: Math.round((stageSize.width - baseWidth * zoom) / 2 + pan.x), top: Math.round((stageSize.height - baseHeight * zoom) / 2 + pan.y) }} />}
    </div>
    <div className="image-lightbox__footer"><div className="image-lightbox__info">{footer}</div><div className="image-lightbox__zoom">
      {!playingOriginal && <><button type="button" disabled={zoom <= 1} onClick={() => changeZoom(zoom / 1.2)} aria-label="缩小图片">−</button><output>{Math.round(zoom * fit * 100)}%</output><button type="button" disabled={zoom >= maxZoom} onClick={() => changeZoom(zoom * 1.2)} aria-label="放大图片">＋</button><button type="button" onClick={() => changeZoom(1 / (fit || 1))}>原始大小（1:1）</button><button type="button" disabled={zoom === 1 && pan.x === 0 && pan.y === 0} onClick={resetView}>适合窗口</button></>}
      {fullResolutionOnly ? <span>完整像素</span> : <button type="button" title={showOriginal ? "再次点击返回压缩图" : undefined} onClick={() => { setOriginalLoaded(false); setShowOriginal(!showOriginal); }}>{showOriginal ? (originalLoaded ? (originalVideo ? "返回动图预览" : "已显示原图") : "原图加载中…") : "查看原图"}</button>}
    </div><small className="image-lightbox__desktop-hint">Esc 退出 · {(onPrevious || onNext) && "← → 翻页 · "}{playingOriginal ? '暂停或拖动进度条查看原图' : hint}</small></div>
  </div>, document.body);
}
