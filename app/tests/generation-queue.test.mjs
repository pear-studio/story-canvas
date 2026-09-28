import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

import { createGenerationScheduler } from "../server/generation-scheduler.mjs";
import {
  controlGenerationQueue,
  enqueueGenerationTask,
  ensureGenerationQueue,
  generationQueueFile,
  generationReference,
  readGenerationQueue,
  recoverGenerationQueue,
  reorderGenerationQueue,
  startGenerationQueueDrain,
  waitForComfyQueueDrain,
  waitForGenerationUnitTurn,
  completeGenerationTask,
} from "../server/generation-queue.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-canvas-generation-queue-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workspace", "story"), { recursive: true });
  await registerFixtureProjects(root);
  return root;
}

test("队列落盘失败不消费 lease，原凭证可以重试释放并让下一任务执行", async context => {
  const root = await fixture(context);
  const first = ref(null, "release-retry", "comparison");
  const next = ref(null, "release-next", "comparison");
  await enqueueGenerationTask(root, first);
  await enqueueGenerationTask(root, next);
  const lease = await waitForGenerationUnitTurn(root, first, "last-cell");
  const rename = fs.rename;
  const failure = Object.assign(new Error("simulated queue rename EPERM"), { code: "EPERM" });
  const mocked = context.mock.method(fs, "rename", async (from, to) => {
    if (to === generationQueueFile(root)) throw failure;
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(lease.release({ completed: true }), error => error === failure);
    assert.equal((await readGenerationQueue(root)).active.lease_token, lease.token);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  await lease.release({ completed: true });
  assert.equal((await readGenerationQueue(root)).active, null);
  const nextLease = await waitForGenerationUnitTurn(root, next, "next-cell");
  await nextLease.release({ completed: true });
  assert.equal((await readGenerationQueue(root)).items.length, 0);
});

function ref(project, task, purpose = "candidate", createdAt = "2026-08-28T01:02:03.000Z") {
  return generationReference(purpose === "comparison" ? null : project, task, purpose, createdAt);
}

test('Windows 短暂队列替换占用在同次写入内恢复，不重复入队', {skip:process.platform!=='win32'}, async context => {
  const root=await fixture(context);await ensureGenerationQueue(root);
  const original=fs.rename;let attempts=0;
  const mocked=context.mock.method(fs,'rename',async(from,to)=>{
    if(to===generationQueueFile(root) && ++attempts<3)throw Object.assign(new Error('temporary busy'),{code:'EPERM'});
    return original(from,to);
  });
  syncBuiltinESMExports();
  try { await enqueueGenerationTask(root,ref(null,'retry-once','comparison')); }
  finally { mocked.mock.restore();syncBuiltinESMExports(); }
  assert.equal(attempts,3);assert.equal((await readGenerationQueue(root)).items.length,1);
});

test("统一队列按提交顺序保持候选和 comparison 的 FIFO，并在用户重排后保留顺序", async (context) => {
  const root = await fixture(context);
  const candidate = ref("story", "render-20260828T010203Z-11111111");
  const comparison = ref("story", "comparison-a", "comparison", "2026-08-28T01:02:04.000Z");
  await enqueueGenerationTask(root, candidate);
  await enqueueGenerationTask(root, comparison);
  assert.deepEqual((await readGenerationQueue(root)).items.map((item) => item.task_id), [candidate.task_id, comparison.task_id]);

  await reorderGenerationQueue(root, [comparison, candidate]);
  await enqueueGenerationTask(root, ref("story", "render-20260828T010205Z-22222222", "candidate", "2026-08-28T01:02:05.000Z"));
  assert.deepEqual((await readGenerationQueue(root)).items.map((item) => item.task_id), [comparison.task_id, candidate.task_id, "render-20260828T010205Z-22222222"]);
});

test("运行任务取消等当前单元结束，等待任务直接移出队列", async context => {
  const root = await fixture(context);
  const first = ref("story", "render-20260828T010203Z-11111111");
  const second = ref("story", "comparison-a", "comparison");
  await enqueueGenerationTask(root, first);
  await enqueueGenerationTask(root, second);
  const lease = await waitForGenerationUnitTurn(root, first, "unit-1");
  await controlGenerationQueue(root, first, "cancel");
  assert.equal((await readGenerationQueue(root)).active.unit_id, "unit-1");
  await controlGenerationQueue(root, second, "cancel");
  assert.deepEqual((await readGenerationQueue(root)).items.map(item => item.task_id), [first.task_id]);
  assert.equal((await lease.release()).action, "cancel");
  assert.deepEqual((await readGenerationQueue(root)).items, []);
});

test("取消队首不阻塞后续任务，且不同 purpose 身份不会互相完成", async (context) => {
  const root = await fixture(context);
  const sharedId = "render-20260828T010203Z-11111111";
  const candidate = ref("story", sharedId, "candidate");
  const comparison = ref("story", sharedId, "comparison", "2026-08-28T01:02:04.000Z");
  await enqueueGenerationTask(root, candidate);
  await enqueueGenerationTask(root, comparison);
  await controlGenerationQueue(root, candidate, "cancel");
  const lease = await waitForGenerationUnitTurn(root, comparison, "cell-1", { pollMs: 1 });
  assert.ok(lease);
  const before = await readGenerationQueue(root);
  await completeGenerationTask(root, candidate);
  const after = await readGenerationQueue(root);
  assert.deepEqual(after.active, before.active);
  assert.equal(after.items.some((item) => item.task_id === candidate.task_id && item.purpose === candidate.purpose), false);
  await lease.release();
  assert.equal((await readGenerationQueue(root)).active, null);
});

test("generic completion 不会清理同一任务的 foreign lease", async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, "workspace", "story"), { recursive: true }); registerFixtureProjects(root);
  await mkdir(path.join(root, "workspace", "story"), { recursive: true }); registerFixtureProjects(root);
  const item = ref("story", "render-20260828T010203Z-22222222");
  await enqueueGenerationTask(root, item);
  const lease = await waitForGenerationUnitTurn(root, item, "unit-owner", { pollMs: 1 });
  assert.ok(lease);
  const foreign = await completeGenerationTask(root, item);
  assert.equal(foreign.active.unit_id, "unit-owner");
  assert.equal((await readGenerationQueue(root)).items.length, 1);
  await lease.release();
});

test("丢失队列可按活动任务重建，revision 冲突拒绝旧排序", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010203Z-11111111");
  await enqueueGenerationTask(root, item);
  const queueFile = generationQueueFile(root);
  await rm(queueFile, { force: true });
  const rebuilt = await ensureGenerationQueue(root, [generationReference(item.project_id, item.task_id, item.purpose, item.created_at)]);
  assert.equal(rebuilt.items[0].status, "queued");
  const revision = rebuilt.revision;
  await reorderGenerationQueue(root, [item], { expectedRevision: revision });
  await assert.rejects(reorderGenerationQueue(root, [item], { expectedRevision: revision }), (error) => error?.code === "generation_queue_revision_conflict");
});

test("ComfyUI drain gate 等待 running 和 pending 自然归零", async () => {
  const snapshots = [
    { queue_running: [{ id: "old" }], queue_pending: [] },
    { queue_running: [], queue_pending: [{ id: "old-pending" }] },
    { queue_running: [], queue_pending: [] },
  ];
  const calls = [];
  await waitForComfyQueueDrain("http://comfy", {
    pollMs: 1,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, async json() { return snapshots.shift(); } };
    },
  });
  assert.equal(calls.length, 3);
});

test("等待 worker 看到 queued cancel 后按 removed 正常结束信号返回", async (context) => {
  const root = await fixture(context);
  const blocker = ref("story", "render-20260828T010203Z-22222222");
  const item = ref("story", "render-20260828T010203Z-33333333");
  await enqueueGenerationTask(root, blocker);
  await enqueueGenerationTask(root, item);
  const blockerLease = await waitForGenerationUnitTurn(root, blocker, "unit-blocker", { pollMs: 1 });
  const waiting = waitForGenerationUnitTurn(root, item, "unit-waiting", { pollMs: 1 });
  await controlGenerationQueue(root, item, "cancel");
  await assert.rejects(waiting, (error) => error?.code === "generation_task_removed");
  await blockerLease.release();
});

test("重启恢复清除失联 active owner，但不丢失队列引用", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010203Z-11111111");
  await enqueueGenerationTask(root, item);
  const queue = JSON.parse(await readFile(generationQueueFile(root), "utf8"));
  queue.active = { ...item, unit_id: "unit-1", owner_pid: 999999, claimed_at: "2026-08-28T01:02:03.000Z" };
  await mkdir(path.dirname(generationQueueFile(root)), { recursive: true });
  await writeFile(generationQueueFile(root), `${JSON.stringify(queue)}\n`);
  const recovered = await recoverGenerationQueue(root, { isProcessAlive: () => false });
  assert.equal(recovered.active, null);
  assert.deepEqual(recovered.items.map((entry) => entry.task_id), [item.task_id]);
});

test("持久 draining 门禁阻止跨进程 claim，ComfyUI 清空后原子放行", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010203Z-44444444");
  await enqueueGenerationTask(root, item);
  const queueFile = generationQueueFile(root);
  const queue = JSON.parse(await readFile(queueFile, "utf8"));
  queue.active = { ...item, unit_id: "lost-unit", lease_token: "lost-token", owner_pid: 999999, claimed_at: "2026-08-28T01:02:03.000Z" };
  await writeFile(queueFile, `${JSON.stringify(queue)}\n`);
  const recovered = await recoverGenerationQueue(root, { isProcessAlive: () => false });
  assert.equal(recovered.draining, true);
  assert.equal((await readGenerationQueue(root)).draining, true);

  let calls = 0;
  const gate = startGenerationQueueDrain(root, "http://comfy", {
    pollMs: 20,
    retryMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, async json() { return calls === 1 ? { queue_running: [{ id: "old" }], queue_pending: [] } : { queue_running: [], queue_pending: [] }; } };
    },
  });
  const waiting = waitForGenerationUnitTurn(root, item, "new-unit", { pollMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await readGenerationQueue(root)).draining, true);
  await gate;
  const lease = await waiting;
  assert.ok(lease);
  assert.equal((await readGenerationQueue(root)).draining, false);
  await lease.release({ completed: true });
});

test("等待循环回收死进程持有的租约，kick drain 后放行", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010203Z-77777777");
  await enqueueGenerationTask(root, item);
  const queueFile = generationQueueFile(root);
  const queue = JSON.parse(await readFile(queueFile, "utf8"));
  queue.active = { ...item, unit_id: "lost-unit", lease_token: "lost-token", owner_pid: 999999, claimed_at: "2026-08-28T01:02:03.000Z" };
  await writeFile(queueFile, `${JSON.stringify(queue)}\n`);
  let calls = 0;
  const lease = await waitForGenerationUnitTurn(root, item, "new-unit", {
    pollMs: 1,
    isProcessAlive: () => false,
    drainApiUrl: "http://comfy",
    drainOptions: {
      pollMs: 1,
      retryMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, async json() { return { queue_running: [], queue_pending: [] }; } };
      },
    },
  });
  assert.ok(lease);
  assert.ok(calls > 0);
  const queueAfter = await readGenerationQueue(root);
  assert.equal(queueAfter.draining, false);
  assert.equal(queueAfter.active?.unit_id, "new-unit");
  await lease.release({ completed: true });
});

test("等待循环不回收活进程持有的租约", async (context) => {
  const root = await fixture(context);
  const blocker = ref("story", "render-20260828T010203Z-88888888");
  const item = ref("story", "render-20260828T010203Z-99999999");
  await enqueueGenerationTask(root, blocker);
  await enqueueGenerationTask(root, item);
  const blockerLease = await waitForGenerationUnitTurn(root, blocker, "unit-blocker", { pollMs: 1 });
  const waiting = waitForGenerationUnitTurn(root, item, "unit-waiting", { pollMs: 1, isProcessAlive: () => true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readGenerationQueue(root)).active?.unit_id, "unit-blocker");
  await blockerLease.release({ completed: true });
  const lease = await waiting;
  assert.ok(lease);
  await lease.release({ completed: true });
});

test("最后 Unit 已完成时，pending cancel 不会覆盖 completed 决策", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010203Z-55555555");
  await enqueueGenerationTask(root, item);
  const lease = await waitForGenerationUnitTurn(root, item, "last-unit", { pollMs: 1 });
  await controlGenerationQueue(root, item, "cancel");
  const released = await lease.release({ completed: true, domainCompleted: true });
  assert.equal(released.action, null);
  assert.equal((await readGenerationQueue(root)).items.length, 0);
  assert.equal((await readGenerationQueue(root)).active, null);
});

test("scheduler startQueued 只 dispatch，不等待 worker，并跳过 live active owner", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010206Z-66666666");
  await enqueueGenerationTask(root, item);
  let resolveWorker;
  const workerDone = new Promise((resolve) => { resolveWorker = resolve; });
  let calls = 0;
  const scheduler = createGenerationScheduler({
    repositoryRoot: root,
    runCandidate: async () => { calls += 1; return workerDone; },
  });
  const startResult = await Promise.race([
    scheduler.startQueued().then(() => "dispatched"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.equal(startResult, "dispatched");
  assert.equal(scheduler.size(), 1);
  resolveWorker();

  const activeFile = generationQueueFile(root);
  const queue = JSON.parse(await readFile(activeFile, "utf8"));
  queue.active = { ...item, unit_id: "foreign-unit", lease_token: "foreign-token", owner_pid: process.pid, claimed_at: new Date().toISOString() };
  await writeFile(activeFile, `${JSON.stringify(queue)}\n`);
  const second = createGenerationScheduler({
    repositoryRoot: root,
    runCandidate: async () => { throw new Error("live active must not be duplicated"); },
  });
  await second.startQueued();
  assert.equal(calls, 1);
  assert.equal(second.size(), 0);
});

test("lease 对已接受但终态未知的 ComfyUI prompt 持久化 draining", async (context) => {
  const root = await fixture(context);
  const item = ref("story", "render-20260828T010207Z-77777777");
  await enqueueGenerationTask(root, item);
  const lease = await waitForGenerationUnitTurn(root, item, "unknown-prompt", { pollMs: 1 });
  await lease.release({ draining: true });
  const queue = await readGenerationQueue(root);
  assert.equal(queue.draining, true);
  assert.equal(queue.active, null);
  assert.equal(queue.items.length, 1);
});
