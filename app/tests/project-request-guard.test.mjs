import assert from "node:assert/strict";
import test from "node:test";

import { createProjectRequestGuard } from "../src/project-request-guard.ts";

test("project switch invalidates every response captured by the previous project generation", () => {
  const guard = createProjectRequestGuard("project-a");
  const oldProject = guard.scope("project-a");
  const oldLoad = guard.beginLoad("project-a");

  guard.activate("project-b");

  assert.equal(guard.isProjectCurrent(oldProject), false);
  assert.equal(guard.isLoadCurrent(oldLoad), false);
  assert.equal(guard.isProjectCurrent(guard.scope("project-b")), true);

  guard.activate("project-a");
  assert.equal(guard.isProjectCurrent(oldProject), false, "switching back must not revive an old response");
});

test("only the latest workbench load may replace the current project view", () => {
  const guard = createProjectRequestGuard("project-a");
  const first = guard.beginLoad("project-a");
  const second = guard.beginLoad("project-a");

  assert.equal(guard.isLoadCurrent(first), false);
  assert.equal(guard.isLoadCurrent(second), true);
});
