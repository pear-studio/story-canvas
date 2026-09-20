import assert from "node:assert/strict";
import test from "node:test";
import { createTaskStageRecorder } from "../server/task-stage-recorder.mjs";

test("阶段先记录开始，再记录实际耗时；失败保留阶段和原始错误", async () => {
  const record = {};
  const saved = [];
  let time = 0;
  const recorder = createTaskStageRecorder(record, async value => saved.push(structuredClone(value)), {
    now: () => new Date(time).toISOString(), clock: () => time,
  });
  assert.equal(await recorder.measure("submit", async () => { time = 120; return "prompt-1"; }), "prompt-1");
  const error = new Error("下载连接中断");
  await assert.rejects(recorder.measure("download", async () => { time = 450; throw error; }, "image-1"), value => value === error);
  assert.deepEqual(saved[0].stages, [{ phase: "submit", item_id: null, started_at: "1970-01-01T00:00:00.000Z", ended_at: null, duration_ms: null, status: "running" }]);
  assert.deepEqual(saved.at(-1).stages, [
    { phase: "submit", item_id: null, started_at: "1970-01-01T00:00:00.000Z", ended_at: "1970-01-01T00:00:00.120Z", duration_ms: 120, status: "completed" },
    { phase: "download", item_id: "image-1", started_at: "1970-01-01T00:00:00.120Z", ended_at: "1970-01-01T00:00:00.450Z", duration_ms: 330, status: "failed", error: "下载连接中断" },
  ]);
});
