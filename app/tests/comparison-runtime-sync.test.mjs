import assert from "node:assert/strict";
import test from "node:test";

import { comparisonRuntimeSyncPlan } from "../src/comparison-runtime-sync.ts";

function task(id, projectId = "story") {
  return { id, project_id: projectId, purpose: "comparison" };
}

test("比较页同步计划覆盖当前项目全部任务、未知任务和消失终态", () => {
  const plan = comparisonRuntimeSyncPlan(
    [{ id: "known" }],
    { tasks: [task("known"), task("unknown"), task("other", "other-story")], history: [] },
    "story",
    ["known", "finished"],
  );
  assert.deepEqual(plan.currentIds, ["known", "unknown"]);
  assert.deepEqual(plan.unknownIds, ["unknown"]);
  assert.deepEqual(plan.disappearedIds, ["finished"]);
});
