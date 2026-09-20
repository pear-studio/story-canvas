import assert from "node:assert/strict";
import test from "node:test";

import { loraRunControls } from "../src/lora-run-controls.ts";

test("训练 Run 只保留运行中的停止和终态删除", () => {
  assert.deepEqual(loraRunControls("running"), { showStop: true, showDelete: false });
  assert.deepEqual(loraRunControls("interrupted"), { showStop: false, showDelete: true });
  assert.deepEqual(loraRunControls("failed"), { showStop: false, showDelete: true });
  assert.deepEqual(loraRunControls("completed"), { showStop: false, showDelete: true });
});
