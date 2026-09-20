import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createLongPressContextMenuController, type LongPressPoint } from "./long-press-context-menu.mjs";

function pointer(event: ReactPointerEvent<HTMLElement>) {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    clientX: event.clientX,
    clientY: event.clientY,
    target: event.currentTarget,
  };
}

export function useLongPressContextMenu() {
  const controller = useRef(createLongPressContextMenuController()).current;
  useEffect(() => () => { controller.cancel(); }, [controller]);

  return {
    start(event: ReactPointerEvent<HTMLElement>, onActivate: (point: LongPressPoint) => void) {
      if (controller.start(pointer(event), onActivate)) event.stopPropagation();
    },
    captureProps: {
      onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
        controller.cancelForAdditionalPointer(pointer(event));
      },
      onPointerMoveCapture(event: ReactPointerEvent<HTMLElement>) {
        controller.move(pointer(event));
      },
      onPointerUpCapture(event: ReactPointerEvent<HTMLElement>) {
        controller.finish(event.pointerId);
      },
      onPointerCancelCapture(event: ReactPointerEvent<HTMLElement>) {
        controller.cancel(event.pointerId);
      },
      onClickCapture(event: ReactMouseEvent<HTMLElement>) {
        if (!controller.consumeClick(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onContextMenuCapture(event: ReactMouseEvent<HTMLElement>) {
        if (!controller.consumeContextMenu(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
