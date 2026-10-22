import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';

export type NavigationDragKind = "chapter" | "sequence" | "story-page" | "character-variant" | "character-page" | "scene-variant" | "scene-page" | "collage-layer";

export type NavigationDrop = {
  owner?: string | null;
  kind: NavigationDragKind;
  id: string;
  sourceGroup: string | null;
  targetGroup: string | null;
  targetId: string | null;
  placement: "before" | "after";
};

export type NavigationReorderSource = { kind: NavigationDragKind; id: string; group: string | null; owner?: string; title: string };

export type NavigationReorderPreview = {
  x: number;
  y: number;
  title: string;
  sourceKind: NavigationDragKind;
  sourceId: string;
  targetKind: NavigationDragKind | null;
  targetId: string | null;
  placement: "before" | "after";
};

const navigationGroupHeadingKind: Partial<Record<NavigationDragKind, NavigationDragKind>> = {
  sequence: "chapter",
  "story-page": "sequence",
  "character-page": "character-variant",
  "scene-page": "scene-variant",
};

export type NavigationReorderDrag = NavigationDrop & {
  pointerId: number;
  startX: number;
  startY: number;
  title: string;
  owner: string | null;
  dragging: boolean;
  visualKind: NavigationDragKind | null;
  visualId: string | null;
};

export function useNavigationReorder(onDrop: (drop: NavigationDrop) => void) {
  const drag = useRef<NavigationReorderDrag | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<NavigationReorderPreview | null>(null);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){drag.current=null;setPreview(null);suppressClick.current=false;event.preventDefault();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[]);

  function begin(event: ReactPointerEvent<HTMLButtonElement>, source: NavigationReorderSource) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, kind: source.kind, id: source.id, sourceGroup: source.group, targetGroup: null, targetId: null, placement: "before", startX: event.clientX, startY: event.clientY, title: source.title, owner: source.owner ?? null, dragging: false, visualKind: null, visualId: null };
  }

  function update(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
      current.dragging = true;
      suppressClick.current = true;
    }
    event.preventDefault();
    current.targetGroup = null;
    current.targetId = null;
    current.visualKind = null;
    current.visualId = null;
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-nav-kind]");
    if (element) {
      const kind = element.dataset.navKind as NavigationDragKind | undefined;
      const id = element.dataset.navId ?? "";
      const group = element.dataset.navGroup ?? null;
      const owner = element.dataset.navOwner ?? null;
      if (kind && id && (!current.owner || !owner || owner === current.owner)) {
        if (kind === current.kind) {
          const bounds = element.getBoundingClientRect();
          current.placement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
          current.targetGroup = group;
          current.targetId = id;
          current.visualKind = kind;
          current.visualId = id;
        } else if (navigationGroupHeadingKind[current.kind] === kind) {
          current.placement = "after";
          current.targetGroup = id;
          current.visualKind = kind;
          current.visualId = id;
        }
      }
    }
    setPreview({ x: event.clientX, y: event.clientY, title: current.title, sourceKind: current.kind, sourceId: current.id, targetKind: current.visualKind, targetId: current.visualId, placement: current.placement });
  }

  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setPreview(null);
    if (!current.dragging) return;
    window.requestAnimationFrame(() => { suppressClick.current = false; });
    if (current.visualKind) onDrop({ owner: current.owner, kind: current.kind, id: current.id, sourceGroup: current.sourceGroup, targetGroup: current.targetGroup, targetId: current.targetId, placement: current.placement });
  }

  function cancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setPreview(null);
    if (current.dragging) window.requestAnimationFrame(() => { suppressClick.current = false; });
  }

  return { begin, update, finish, cancel, suppressClick, preview };
}

export type NavigationReorder = ReturnType<typeof useNavigationReorder>;

export function NavigationReorderHandle({ label, source, reorder }: { label: string; source: NavigationReorderSource; reorder: NavigationReorder }) {
  return <button type="button" className="page-reorder-handle" aria-label={`拖动排序：${label}`} title="拖动排序" onPointerDown={(event) => reorder.begin(event, source)} onPointerMove={reorder.update} onPointerUp={reorder.finish} onPointerCancel={reorder.cancel} onClick={(event) => { event.stopPropagation(); if (reorder.suppressClick.current) event.preventDefault(); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}><svg viewBox="0 0 12 18" aria-hidden="true">{[4, 9, 14].flatMap(y => [3, 8].map(x => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.2" />))}</svg></button>;
}

export function navigationDropClass(reorder: NavigationReorder, kind: NavigationDragKind, id: string) {
  const preview = reorder.preview;
  if (!preview || preview.targetKind !== kind || preview.targetId !== id) return "";
  return preview.placement === "before" ? "is-drop-before" : "is-drop-after";
}

export function navigationSourceClass(reorder: NavigationReorder, kind: NavigationDragKind, id: string) {
  const preview = reorder.preview;
  return preview && preview.sourceKind === kind && preview.sourceId === id ? "is-reorder-source" : "";
}

export function NavigationReorderPreviewOverlay({ reorder }: { reorder: NavigationReorder }) {
  const preview = reorder.preview;
  if (!preview) return null;
  return <div className="page-reorder-preview" style={{ left: preview.x + 12, top: preview.y + 12 }} aria-hidden="true"><i>⋮</i><span>{preview.title}</span></div>;
}
