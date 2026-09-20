import assert from "node:assert/strict";
import test from "node:test";

import { applyRecoveredRenderItemStatuses } from "../server/render-task-state.mjs";

test("恢复已有输出不会覆盖锁内最新的discarded状态", () => {
  const items = [
    { id: "a", status: "discarded" },
    { id: "b", status: "queued" },
  ];
  applyRecoveredRenderItemStatuses(items, new Map([
    ["a", "available"],
    ["b", "available"],
  ]));
  assert.deepEqual(items, [
    { id: "a", status: "discarded" },
    { id: "b", status: "available" },
  ]);
});
