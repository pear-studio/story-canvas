import assert from "node:assert/strict";
import test from "node:test";

import { layerClosesOnResize } from "../src/use-dismissable-layer.ts";

test("视口高度变化（虚拟键盘弹出/收起、移动端地址栏显隐）不关闭浮层", () => {
  assert.equal(layerClosesOnResize(980, 980), false);
});

test("视口宽度变化（设备旋转、桌面窗口调整）关闭浮层", () => {
  assert.equal(layerClosesOnResize(980, 640), true);
  assert.equal(layerClosesOnResize(640, 980), true);
});
