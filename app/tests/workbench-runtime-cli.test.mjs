import assert from "node:assert/strict";
import test from "node:test";

import { probeWorkbench } from "../scripts/workbench-runtime-cli.mjs";

function response(value, { ok = true } = {}) {
  return { ok, json: async () => value };
}

test("工作台启动探针区分已有实例、其他 HTTP 服务和空闲端口", async () => {
  assert.deepEqual(await probeWorkbench({
    port: 3000,
    fetchImpl: async () => response({ ok: true, service: "story-canvas" }),
  }), { status: "running" });
  assert.deepEqual(await probeWorkbench({
    port: 3000,
    fetchImpl: async () => response({ ok: true, service: "another-service" }),
  }), { status: "occupied" });
  assert.deepEqual(await probeWorkbench({
    port: 3000,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("invalid json"); } }),
  }), { status: "occupied" });
  assert.deepEqual(await probeWorkbench({
    port: 3000,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  }), { status: "stopped" });
});
