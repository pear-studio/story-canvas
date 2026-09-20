export const LONG_PRESS_DELAY_MS: number;
export const LONG_PRESS_MOVE_TOLERANCE_PX: number;

export type LongPressPointer = {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  target: EventTarget;
};

export type LongPressPoint = { clientX: number; clientY: number };

export function createLongPressContextMenuController(options?: {
  delayMs?: number;
  movementTolerancePx?: number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}): {
  start(pointer: LongPressPointer, onActivate: (point: LongPressPoint) => void): boolean;
  move(pointer: Pick<LongPressPointer, "pointerId" | "clientX" | "clientY">): void;
  finish(pointerId: number): boolean;
  cancel(pointerId?: number): boolean;
  cancelForAdditionalPointer(pointer: Pick<LongPressPointer, "pointerType" | "isPrimary">): void;
  consumeClick(target: EventTarget): boolean;
  consumeContextMenu(target: EventTarget): boolean;
};
