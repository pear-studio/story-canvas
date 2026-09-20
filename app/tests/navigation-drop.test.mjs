import assert from "node:assert/strict";
import test from "node:test";

import { navigationDropBeforeId } from "../src/navigation-drop.ts";

test("同组 before 落点换算为锚点自身", () => {
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "a", true, "c", "before"), "c");
});

test("同组 after 落点换算为下一兄弟的 before", () => {
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "a", true, "b", "after"), "c");
});

test("同组移到末尾时锚点为 null", () => {
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "a", true, "c", "after"), null);
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "a", true, null, "before"), null);
});

test("同组位置不变时不发请求", () => {
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "b", true, "b", "before"), undefined);
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "b", true, "a", "after"), undefined);
  assert.equal(navigationDropBeforeId(["a", "b", "c"], "b", true, "c", "before"), undefined);
});

test("跨组移动不做顺序不变检查，只换算锚点", () => {
  assert.equal(navigationDropBeforeId(["x", "y"], "a", false, "y", "before"), "y");
  assert.equal(navigationDropBeforeId(["x", "y"], "a", false, "y", "after"), null);
  assert.equal(navigationDropBeforeId(["x", "y"], "a", false, null, "before"), null);
});

test("落点目标不在组内时不发请求", () => {
  assert.equal(navigationDropBeforeId(["a", "b"], "a", true, "z", "before"), undefined);
  assert.equal(navigationDropBeforeId(["a", "b"], "z", true, "a", "before"), undefined);
});
