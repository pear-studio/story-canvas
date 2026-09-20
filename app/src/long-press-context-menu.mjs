export const LONG_PRESS_DELAY_MS = 700;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

function contains(container, target) {
  return container === target || Boolean(container?.contains?.(target));
}

export function createLongPressContextMenuController({
  delayMs = LONG_PRESS_DELAY_MS,
  movementTolerancePx = LONG_PRESS_MOVE_TOLERANCE_PX,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (timer) => clearTimeout(timer),
  now = () => Date.now(),
} = {}) {
  let active = null;
  let suppression = null;

  function rememberSuppression(target) {
    suppression = { target, click: true, contextMenu: true, expiresAt: now() + 1_000 };
  }

  function clearActive(remember = false) {
    if (!active) return false;
    if (active.timer !== null) cancelSchedule(active.timer);
    if (remember && active.activated) rememberSuppression(active.target);
    const activated = active.activated;
    active = null;
    return activated;
  }

  function validSuppression(target) {
    if (!suppression || suppression.expiresAt < now() || !contains(suppression.target, target)) {
      if (suppression?.expiresAt < now()) suppression = null;
      return null;
    }
    return suppression;
  }

  return {
    start(pointer, onActivate) {
      if (pointer.pointerType !== "touch" || !pointer.isPrimary) return false;
      clearActive();
      const gesture = {
        pointerId: pointer.pointerId,
        x: pointer.clientX,
        y: pointer.clientY,
        target: pointer.target,
        activated: false,
        timer: null,
      };
      gesture.timer = schedule(() => {
        if (active !== gesture) return;
        gesture.timer = null;
        gesture.activated = true;
        onActivate({ clientX: gesture.x, clientY: gesture.y });
      }, delayMs);
      active = gesture;
      return true;
    },
    move(pointer) {
      if (!active || active.pointerId !== pointer.pointerId || active.activated) return;
      if (Math.hypot(pointer.clientX - active.x, pointer.clientY - active.y) >= movementTolerancePx) clearActive();
    },
    finish(pointerId) {
      if (!active || active.pointerId !== pointerId) return false;
      return clearActive(true);
    },
    cancel(pointerId) {
      if (pointerId !== undefined && active?.pointerId !== pointerId) return false;
      return clearActive(true);
    },
    cancelForAdditionalPointer(pointer) {
      if (pointer.pointerType === "touch" && !pointer.isPrimary) clearActive(true);
    },
    consumeClick(target) {
      const remembered = validSuppression(target);
      if (!remembered?.click) return false;
      remembered.click = false;
      return true;
    },
    consumeContextMenu(target) {
      if (active && contains(active.target, target)) {
        if (active.activated) return true;
        clearActive();
        return false;
      }
      const remembered = validSuppression(target);
      if (!remembered?.contextMenu) return false;
      remembered.contextMenu = false;
      return true;
    },
  };
}
