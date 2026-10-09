import assert from "node:assert/strict";
import test from "node:test";

import { areTrackedTasksTerminal, createSerialPoller, mergeTaskHistory } from "../src/runtime-status.ts";
import {taskHistoryMoment} from '../shared/task-history.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test("serial polling waits for a slow request to finish before scheduling the next request", async () => {
  const requests = [];
  const scheduled = [];
  let active = 0;
  let maximumActive = 0;
  const poller = createSerialPoller({
    intervalMs: 2500,
    poll: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const request = deferred();
      requests.push(request);
      await request.promise;
      active -= 1;
    },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancelSchedule: () => undefined,
  });

  poller.start();
  await flushPromises();
  assert.equal(requests.length, 1);
  assert.equal(scheduled.length, 0, "a pending request must not leave an interval callback behind");

  requests[0].resolve();
  await flushPromises();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 2500);

  scheduled[0].callback();
  await flushPromises();
  assert.equal(requests.length, 2);
  assert.equal(maximumActive, 1);
  poller.stop();
});

test("stopping a poller aborts its pending request and does not schedule another poll", async () => {
  const scheduled = [];
  let requestSignal;
  let reportedErrors = 0;
  const poller = createSerialPoller({
    intervalMs: 2500,
    poll: (signal) => {
      requestSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    onError: () => { reportedErrors += 1; },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancelSchedule: () => undefined,
  });

  poller.start();
  await flushPromises();
  poller.stop();
  await flushPromises();

  assert.equal(requestSignal.aborted, true);
  assert.equal(reportedErrors, 0, "an intentional abort is not a polling failure");
  assert.equal(scheduled.length, 0);
});

test("tracked tasks complete only after every requested id appears with a terminal status", () => {
  const task = (id, status) => ({ id, status });

  assert.equal(areTrackedTasksTerminal({ tasks: [task("a", "running")], history: [] }, ["a"]), false);
  assert.equal(areTrackedTasksTerminal({ tasks: [], history: [task("a", "completed")] }, ["a", "b"]), false, "an absent task may not be mistaken for a completed task");
  assert.equal(areTrackedTasksTerminal({ tasks: [task("b", "failed")], history: [task("a", "completed")] }, ["a", "b"]), true);
  assert.equal(areTrackedTasksTerminal({ tasks: [], history: [], tracked: [task("old", "completed")] }, ["old"]), true, "exact tracked results are independent of the recent history window");
  assert.equal(areTrackedTasksTerminal({ tasks: [], history: [], missing_tracked_task_ids: ["gone"] }, ["gone"]), true, "a task confirmed missing after exact lookup must not leave the page permanently busy");
});

test("历史翻页合并按项目和任务去重，保留早期记录并更新已展示摘要", () => {
  const old = { id: "render-001", project_id: "demo", status: "failed" };
  const other = { ...old, project_id: "other" };
  const newer = { ...old, id: "render-002" };
  const result = mergeTaskHistory([old, other], [newer, { ...old, status: "completed" }]);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, newer.id);
  assert.equal(result.find((task) => task.project_id === "demo" && task.id === old.id).status, "completed");
});

test("历史合并保留同项目同 ID 的不同任务用途", () => {
  const candidate = { id: "shared", project_id: "demo", purpose: "candidate", status: "completed" };
  const comparison = { id: "shared", project_id: "demo", purpose: "comparison", status: "cancelled" };
  assert.equal(mergeTaskHistory([candidate], [comparison]).length, 2);
});

test('加载更多仍按结束时间合并，显示时间与排序保持一致',()=>{
  const slow={id:'render-old',project_id:'demo',purpose:'candidate',status:'completed',created_at:'2026-10-05T01:00:00Z',completed_at:'2026-10-05T03:00:00Z'};
  const fast={...slow,id:'render-new',created_at:'2026-10-05T02:00:00Z',completed_at:'2026-10-05T02:30:00Z'};
  const output={...slow,id:'finished-one',purpose:'finished',completed_at:'2026-10-05T02:45:00Z'};
  assert.deepEqual(mergeTaskHistory([fast],[slow,output]).map(x=>x.id),[slow.id,output.id,fast.id]);
  assert.equal(taskHistoryMoment(slow),slow.completed_at);
  assert.equal(taskHistoryMoment({...slow,status:'running'}),slow.created_at);
  assert.equal(taskHistoryMoment({...slow,status:'failed',completed_at:null,failed_at:'2026-10-05T02:15:00Z'}),'2026-10-05T02:15:00Z');
  assert.equal(taskHistoryMoment({...slow,status:'failed',failed_at:'2026-10-05T02:15:00Z'}),'2026-10-05T02:15:00Z');
});
