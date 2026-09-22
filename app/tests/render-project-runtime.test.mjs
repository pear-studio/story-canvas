import test from "node:test";
import assert from "node:assert/strict";
import { waitForHistory } from "../server/render-project-runtime.mjs";

function withStubFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => { globalThis.fetch = original; });
}

const completedHistory = { "prompt-1": { status: { status_str: "success" }, outputs: { 9: { images: [{ filename: "a.png" }] } } } };

function jsonResponse(value) {
  return { ok: true, text: async () => JSON.stringify(value) };
}

test("waitForHistory 容忍单个轮询请求超时并继续等待", async () => {
  let calls = 0;
  const result = await withStubFetch(async () => {
    calls += 1;
    if (calls <= 2) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return jsonResponse(completedHistory);
  }, () => waitForHistory("http://127.0.0.1:9", "prompt-1"));
  assert.deepEqual(result, completedHistory["prompt-1"]);
  assert.equal(calls, 3);
});

test("waitForHistory 连续轮询失败后抛出而不是无限重试", async () => {
  let calls = 0;
  await assert.rejects(
    withStubFetch(async () => {
      calls += 1;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }, () => waitForHistory("http://127.0.0.1:9", "prompt-1")),
    /timeout/,
  );
  assert.equal(calls, 10);
}, { timeout: 30000 });

test("waitForHistory 对 ComfyUI 终态错误立即失败", async () => {
  await assert.rejects(
    withStubFetch(async () => jsonResponse({
      "prompt-1": { status: { status_str: "error", messages: [["execution_error", { node_id: "4" }]] } },
    }), () => waitForHistory("http://127.0.0.1:9", "prompt-1")),
    /ComfyUI 任务失败/,
  );
});
