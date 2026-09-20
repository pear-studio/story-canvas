import assert from "node:assert/strict";
import test from "node:test";
import { createRenderTaskId } from "../server/render-task-id.mjs";

test("同一时刻创建的渲染任务仍获得不同且可校验的 ID", () => {
  const now = () => new Date("2026-08-14T08:09:10.123Z");
  const first = createRenderTaskId({ now, randomSuffix: () => "a1b2c3d4" });
  const second = createRenderTaskId({ now, randomSuffix: () => "b1c2d3e4" });
  assert.equal(first, "render-20260814T080910Z-a1b2c3d4");
  assert.equal(second, "render-20260814T080910Z-b1c2d3e4");
  assert.notEqual(first, second);
});

