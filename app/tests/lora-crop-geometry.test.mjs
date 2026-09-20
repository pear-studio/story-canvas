import assert from "node:assert/strict";
import test from "node:test";

import { fitCropToAspect, resizeCropRect } from "../src/lora-crop-geometry.mjs";

test("比例模板在原图范围内生成居中的目标比例", () => {
  const rect = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, 1, { width: 1200, height: 800 });
  assert.ok(Math.abs(rect.x - 1 / 6) < 1e-9);
  assert.equal(rect.y, 0);
  assert.ok(Math.abs(rect.width - 2 / 3) < 1e-9);
  assert.equal(rect.height, 1);
});

test("角点默认保持像素宽高比，Shift 模式允许自由缩放", () => {
  const source = { width: 1000, height: 500 };
  const initial = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  const locked = resizeCropRect(initial, "se", { x: 0.9, y: 0.85 }, source, true, 2);
  assert.ok(Math.abs((locked.width * source.width) / (locked.height * source.height) - 2) < 1e-9);
  const free = resizeCropRect(initial, "se", { x: 0.9, y: 0.85 }, source, false, 2);
  assert.notEqual((free.width * source.width) / (free.height * source.height), 2);
});

test("边中点只修改对应方向，不强制保持比例", () => {
  const initial = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  const resized = resizeCropRect(initial, "e", { x: 0.9, y: 0.1 }, { width: 1000, height: 1000 }, false, 1);
  assert.deepEqual(resized, { x: 0.2, y: 0.2, width: 0.7, height: 0.5 });
});
