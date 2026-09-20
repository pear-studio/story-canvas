import assert from "node:assert/strict";
import test from "node:test";

import { createPageMediaRequestGuard } from "../src/page-media-request.ts";

test("page media只接受当前页面最后一次请求", () => {
  const guard = createPageMediaRequestGuard();
  const initial = guard.begin("project-a:v3/page-001");
  const refreshed = guard.begin("project-a:v3/page-001");

  assert.equal(initial.signal.aborted, true);
  assert.equal(guard.isCurrent(initial), false, "同页较早响应不能覆盖较新刷新");
  assert.equal(guard.isCurrent(refreshed), true);

  const nextPage = guard.begin("project-a:v3/page-002");
  assert.equal(refreshed.signal.aborted, true);
  assert.equal(guard.isCurrent(refreshed), false, "切页后旧页面响应不能落入新页面");
  assert.equal(guard.isCurrent(nextPage), true);

  guard.cancel();
  assert.equal(nextPage.signal.aborted, true);
  assert.equal(guard.isCurrent(nextPage), false);
});
