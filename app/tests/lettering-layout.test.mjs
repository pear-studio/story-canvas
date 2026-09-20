import assert from "node:assert/strict";
import test from "node:test";

import { resizeLetteringBox, resolveLetteringLayout } from "../shared/lettering-layout.mjs";

test("横排只把保存宽度作为换行上限并自动收紧实际边框", () => {
  const short = resolveLetteringLayout({ text: "你是谁？", direction: "horizontal", kind: "balloon", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
  const sameWidthDifferentHeight = resolveLetteringLayout({ text: "你是谁？", direction: "horizontal", kind: "balloon", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } });
  assert.deepEqual(short.box, sameWidthDifferentHeight.box);
  assert.ok(short.box.w < 0.24);
  assert.ok(short.box.h < 0.07);
});

test("横排短句从当前可见边界开始缩放", () => {
  const saved = { x: 0.1, y: 0.05, w: 0.9, h: 0.12 };
  const visible = resolveLetteringLayout({ text: "测试文字", direction: "horizontal", kind: "caption", fontSize: 28, canvasWidth: 1024, canvasHeight: 1316, box: saved });
  assert.deepEqual(visible.lines, ["测试文字"]);
  const resized = resizeLetteringBox(saved, visible.box, "horizontal", -0.02, 0);
  assert.ok(resized.w < saved.w - 0.5);
  assert.equal(resized.w, visible.box.w - 0.02);
  assert.ok(resolveLetteringLayout({ text: "测试文字", direction: "horizontal", kind: "caption", fontSize: 28, canvasWidth: 1024, canvasHeight: 1316, box: resized }).lines.length > 1);
});

test("横排缩窄时自动增加行数和高度而不是把文字压出框", () => {
  const wide = resolveLetteringLayout({ text: "把塔里的人交出来。", direction: "horizontal", kind: "balloon", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } });
  const narrow = resolveLetteringLayout({ text: "把塔里的人交出来。", direction: "horizontal", kind: "balloon", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.5 } });
  assert.equal(wide.lines.length, 1);
  assert.ok(narrow.lines.length > 1);
  assert.ok(narrow.box.h > wide.box.h);
  assert.ok(!narrow.overflow);
});

test("只差半个字宽时略微扩框，避免把句末拆成孤立短行", () => {
  const result = resolveLetteringLayout({ text: "把塔里的人交出来。", direction: "horizontal", kind: "balloon", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.39, h: 0.5 } });
  assert.deepEqual(result.lines, ["把塔里的人交出来。"]);
  assert.ok(result.box.w > 0.39 && result.box.w < 0.42);
});

test("形状参数不能把横排压成一字一行的极端细条", () => {
  const result = resolveLetteringLayout({ text: "把塔里的人交出来。", direction: "horizontal", kind: "balloon", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.08, h: 0.5 } });
  assert.ok(Math.max(...result.lines.map((line) => [...line].length)) >= 3);
  assert.ok(result.box.w > 0.14);
});

test("竖排只把保存高度作为列高上限并自动计算列宽", () => {
  const tall = resolveLetteringLayout({ text: "雾沿着石桥漫来", direction: "vertical", kind: "caption", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.9, h: 0.5 } });
  const sameHeightDifferentWidth = resolveLetteringLayout({ text: "雾沿着石桥漫来", direction: "vertical", kind: "caption", fontSize: 42, canvasWidth: 1024, canvasHeight: 1536, box: { x: 0.1, y: 0.1, w: 0.08, h: 0.5 } });
  assert.deepEqual(tall.box, sameHeightDifferentWidth.box);
  assert.ok(tall.box.w < 0.2);
});
