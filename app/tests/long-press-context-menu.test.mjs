import assert from "node:assert/strict";
import test from "node:test";
import { createLongPressContextMenuController } from "../src/long-press-context-menu.mjs";

function harness() {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const controller = createLongPressContextMenuController({
    schedule(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    cancelSchedule(timer) { timers.delete(timer); },
    now: () => clock,
  });
  return {
    controller,
    advance(ms) { clock += ms; const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
  };
}

function touch(target, overrides = {}) {
  return { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 40, clientY: 80, target, ...overrides };
}

test("静止长按打开菜单，并吞掉随后由同一次触摸产生的单击和原生菜单", () => {
  const { controller, advance } = harness();
  const target = { contains: (value) => value === target };
  const opened = [];

  assert.equal(controller.start(touch(target), (point) => opened.push(point)), true);
  advance(700);
  assert.deepEqual(opened, [{ clientX: 40, clientY: 80 }]);
  assert.equal(controller.consumeContextMenu(target), true);
  assert.equal(controller.finish(1), true);
  assert.equal(controller.consumeClick(target), true);
  assert.equal(controller.consumeClick(target), false);
});

test("滑动或第二根手指介入会取消尚未触发的长按", () => {
  for (const cancel of [
    (controller, target) => controller.move(touch(target, { clientX: 52 })),
    (controller) => controller.cancelForAdditionalPointer({ pointerType: "touch", isPrimary: false }),
  ]) {
    const { controller, advance } = harness();
    const target = { contains: (value) => value === target };
    let opened = false;
    controller.start(touch(target), () => { opened = true; });
    cancel(controller, target);
    advance(700);
    assert.equal(opened, false);
  }
});

test("浏览器先产生原生 contextmenu 时沿用原有右键入口且不再重复触发长按", () => {
  const { controller, advance } = harness();
  const target = { contains: (value) => value === target };
  let opened = false;
  controller.start(touch(target), () => { opened = true; });

  assert.equal(controller.consumeContextMenu(target), false);
  advance(700);
  assert.equal(opened, false);
});
