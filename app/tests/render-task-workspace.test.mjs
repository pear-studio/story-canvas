import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { recoverGenerationTasks } from "../server/generation-lifecycle.mjs";
import { enqueueGenerationTask, generationReference, readGenerationQueue, waitForGenerationUnitTurn, generationQueueFile, waitForGenerationQueueDrain } from "../server/generation-queue.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listWorkspaceRenderTasks,
  listWorkspaceRenderHistory,
  readWorkspaceTaskDetail,
  readWorkspaceTaskResults,
} from "../server/render-task-workspace.mjs";
import { createRenderTask, readRenderTaskState, updateRenderTask } from "../server/render-task-storage.mjs";
import { handleRuntimeRequest } from "../server/runtime-http.mjs";

const pageKey = { page_id: "page-001" };

test("任务图片入口只返回本任务已完成且仍存在的图片，保留顺序并排除未完成与已删除结果", async context => {
  const { root, projectDirectory } = await fixture(context);
  const id = "render-20260828T010203Z-77777777";
  const value = task(id);
  value.items = ["first", "deleted", "pending", "last"].map(name => ({ id: name, page_key: pageKey, seed: 7, status: name === "pending" ? "queued" : "available", file: `Outputs/pages/page-001/${name}/image.png` }));
  await createRenderTask(projectDirectory, value, { project_title: "Demo", pages: [] });
  for (const name of ["first", "pending", "last", "another-task"]) {
    const directory = path.join(projectDirectory, "Outputs", "pages", "page-001", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "image.png"), "image bytes");
  }
  const expected = ["first", "last"].map(id => ({ id, url: `/api/projects/demo/media/Outputs/pages/page-001/${id}/image.png` }));
  assert.deepEqual(await readWorkspaceTaskResults(root, "demo", id), expected);
  let body;
  const url = new URL(`http://localhost/api/tasks/demo/${id}/results?purpose=candidate`);
  assert.equal(await handleRuntimeRequest({ request: { method: "GET" }, requestUrl: url, decodedPath: url.pathname, projectRoot: root,
    response: { writeHead(status) { assert.equal(status, 200); }, end(value) { body = JSON.parse(value); } },
  }), true);
  assert.deepEqual(body, { images: expected });
  await rm(path.join(projectDirectory, "Outputs", "pages", "page-001", "first", "image.png"));
  assert.deepEqual(await readWorkspaceTaskResults(root, "demo", id), [expected[1]]);
});

function task(id) {
  return {
    version: 2,
    id,
    project: "demo",
    render_profile: "anima-base-v1",
    purpose: "candidate",
    status: "queued",
    created_at: "2026-08-28T01:02:03.000Z",
    snapshot: {},
    items: [{ id: "item-001", page_key: pageKey, seed: 7, status: "queued" }],
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-task-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = path.join(root, "workspace", "demo");
  await mkdir(projectDirectory, { recursive: true });
  registerFixtureProjects(root); return { root, projectDirectory };
}

test("workspace投影保持活动摘要轻量并按task id精确追踪被裁掉的历史", async (context) => {
  const { root, projectDirectory } = await fixture(context);
  const activeId = "render-20260828T010203Z-11111111";
  const completedId = "render-20260828T010204Z-22222222";
  await createRenderTask(projectDirectory, task(activeId), {
    project_title: "Demo",
    pages: [{ page_key: pageKey, page_id: "page-001", order: 1, title: "第一页", owner_label: "开场" }],
  });
  await createRenderTask(projectDirectory, task(completedId), { project_title: "Demo", pages: [] });
  await updateRenderTask(projectDirectory, completedId, (current) => {
    current.status = "completed";
    current.completed_at = "2026-08-28T01:03:00.000Z";
    current.items[0].status = "available";
  });

  const result = await listWorkspaceRenderTasks(root, {
    trackedByProject: new Map([["demo", new Set([completedId])]]),
  });

  assert.deepEqual(result.tasks.map((entry) => ({ id: entry.id, title: entry.current_page_title, owner: entry.current_owner_label })), [
    { id: activeId, title: "第一页", owner: "开场" },
  ]);
  assert.deepEqual(result.history, []);
  assert.deepEqual(result.tracked, [{ id: completedId, status: "completed" }]);
  assert.deepEqual(result.missing_tracked_task_ids, []);
});

test("列表只发摘要，独立详情接口返回单任务条目和共享批次阶段，不依赖候选文件", async context => {
  const { root, projectDirectory } = await fixture(context);
  const id = "render-20260828T010203Z-33333333";
  const value = task(id);
  value.items.push({ id: "item-002", page_key: pageKey, seed: 8, status: "queued" });
  value.snapshot.execution_units = [{ id: "unit-001", item_ids: ["item-001", "item-002"] }];
  await createRenderTask(projectDirectory, value, { project_title: "Demo", pages: [{ page_key: pageKey, title: "第一页", order: 1 }] });
  const directory = path.join(projectDirectory, "Saved", "render", "submissions", id);
  await mkdir(directory, { recursive: true });
  const submission = { prompt_id: "comfy-1", stages: [{ phase: "remote_wait", item_id: null, status: "completed", duration_ms: 1200 }] };
  await writeFile(path.join(directory, "unit-001.json"), JSON.stringify(submission));
  const active = (await listWorkspaceRenderTasks(root)).tasks[0];
  assert.equal(Object.hasOwn(active, "items"), false);
  assert.equal(Object.hasOwn(active, "snapshot"), false);
  assert.equal(Object.hasOwn(active.pages[0], "preview_urls"), false);
  await updateRenderTask(projectDirectory, id, current => { current.status = "completed"; for (const item of current.items) item.status = "available"; });
  const summary = (await listWorkspaceRenderHistory(root)).history[0];
  assert.equal(Object.hasOwn(summary, "items"), false);
  assert.equal(summary.item_counts.total, 2);
  let responseBody;
  let responseStatus;
  const url = new URL(`http://localhost/api/tasks/demo/${id}`);
  assert.equal(await handleRuntimeRequest({
    request: { method: "GET" }, requestUrl: url, decodedPath: url.pathname, projectRoot: root,
    response: { writeHead(status) { responseStatus = status; }, end(body) { responseBody = JSON.parse(body); } },
  }), true);
  assert.equal(responseStatus, 200);
  assert.deepEqual(responseBody.task.items.map(item => [item.id, item.seed, item.status]), [["item-001", 7, "available"], ["item-002", 8, "available"]]);
  assert.deepEqual(responseBody.task.execution_units, [{ id: "unit-001", item_ids: ["item-001", "item-002"], submission }]);
  await assert.rejects(readWorkspaceTaskDetail(root, "demo", "render-20260828T010203Z-ffffffff"), { status: 404 });
});

test("列表读取不修补队列，启动恢复重建排队任务且保留存活租约", async (context) => {
  const { root, projectDirectory } = await fixture(context);
  const liveId = "render-20260828T010203Z-11111111";
  const lostId = "render-20260828T010204Z-22222222";
  const activeId = "render-20260828T010205Z-33333333";
  await createRenderTask(projectDirectory, task(liveId), { project_title: "Demo", pages: [] });
  await createRenderTask(projectDirectory, task(lostId), { project_title: "Demo", pages: [] });
  await createRenderTask(projectDirectory, task(activeId), { project_title: "Demo", pages: [] });
  for (const id of [liveId, activeId]) await updateRenderTask(projectDirectory, id, current => {
    current.status = "running";
    current.items[0].status = "running";
  });

  const projectId = path.basename(projectDirectory);
  const reference = generationReference(projectId, activeId, "candidate");
  await enqueueGenerationTask(root, reference);
  const lease = await waitForGenerationUnitTurn(root, reference, "live-unit");
  const before = await readFile(generationQueueFile(root), "utf8");
  await listWorkspaceRenderTasks(root);
  assert.equal(await readFile(generationQueueFile(root), "utf8"), before);
  await recoverGenerationTasks(root);
  assert.equal((await readRenderTaskState(projectDirectory, liveId)).status, "queued");
  assert.equal((await readRenderTaskState(projectDirectory, liveId)).items[0].status, "queued");
  assert.equal((await readRenderTaskState(projectDirectory, activeId)).status, "running");
  assert.equal((await readRenderTaskState(projectDirectory, activeId)).items[0].status, "running");
  assert.equal((await readRenderTaskState(projectDirectory, lostId)).status, "queued");
  assert.deepEqual(new Set((await readGenerationQueue(root)).items.map(item => item.task_id)), new Set([liveId, lostId, activeId]));
  await lease.release();
});

test("回收死租约后终态候选不会重新入队", async context => {
  for (const status of ["completed", "failed", "cancelled"]) await context.test(status, async t => {
    const { root, projectDirectory } = await fixture(t);
    const id = "render-20260828T010203Z-44444444";
    await createRenderTask(projectDirectory, task(id), { project_title: "Demo", pages: [] });
    const reference = generationReference("demo", id, "candidate");
    await enqueueGenerationTask(root, reference);
    await waitForGenerationUnitTurn(root, reference, "unit-1");
    await updateRenderTask(projectDirectory, id, current => {
      current.status = status;
      current.items[0].status = status === "completed" ? "available" : status;
    });
    const queueFile = generationQueueFile(root);
    const queue = JSON.parse(await readFile(queueFile, "utf8"));
    queue.active.owner_pid = 2147483647;
    await writeFile(queueFile, JSON.stringify(queue));
    await recoverGenerationTasks(root, { apiUrl: "http://unused", drainOptions: {
      fetchImpl: async () => ({ ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) }),
    } });
    await waitForGenerationQueueDrain(root);
    const after = await readGenerationQueue(root);
    assert.equal(after.active, null);
    assert.deepEqual(after.items, []);
    assert.equal((await readRenderTaskState(projectDirectory, id)).status, status);
    assert.deepEqual((await listWorkspaceRenderHistory(root)).history.map(item => item.id), [id]);
  });
});

test("终态写入后归档中断，启动补归档且不启动生成", async context => {
  const { root, projectDirectory } = await fixture(context);
  const id = "render-20260828T010203Z-55555555";
  const created = await createRenderTask(projectDirectory, task(id), { project_title: "Demo", pages: [] });
  // 模拟终态 state 已写入、active 目录尚未移动时进程退出。
  const state = { ...created.state, status: "completed", items: created.state.items.map(item => ({ ...item, status: "available" })) };
  await writeFile(path.join(created.task_directory, "state.json"), JSON.stringify(state));
  assert.deepEqual((await listWorkspaceRenderHistory(root)).history, []);
  await recoverGenerationTasks(root);
  assert.deepEqual((await listWorkspaceRenderHistory(root)).history.map(item => item.id), [id]);
  assert.equal((await readRenderTaskState(projectDirectory, id)).status, "completed");
  assert.deepEqual((await readGenerationQueue(root)).items, []);
  await assert.rejects(readFile(path.join(created.task_directory, "state.json")), error => error.code === "ENOENT");
});

test("历史按需翻页不设总上限，新任务插入不重复或漏掉旧页", async (context) => {
  const { root, projectDirectory } = await fixture(context);
  const ids = [];
  for (let index = 0; index < 35; index += 1) {
    const id = `render-20260828T010203Z-${index.toString(16).padStart(8, "0")}`;
    ids.push(id);
    await createRenderTask(projectDirectory, task(id), { project_title: "Demo", pages: [] });
    await updateRenderTask(projectDirectory, id, (current) => { current.status = "completed"; current.items[0].status = "available"; });
  }
  const first = await listWorkspaceRenderHistory(root);
  assert.equal(first.history.length, 30);
  assert.ok(first.next_cursor);
  const newId = "render-20260829T010203Z-ffffffff";
  await createRenderTask(projectDirectory, task(newId), { project_title: "Demo", pages: [] });
  await updateRenderTask(projectDirectory, newId, (current) => { current.status = "completed"; current.items[0].status = "available"; });
  const last = await listWorkspaceRenderHistory(root, { before: first.next_cursor });
  assert.equal(last.history.length, 5);
  assert.equal(last.next_cursor, null);
  assert.deepEqual([...first.history, ...last.history].map((entry) => entry.id), ids.reverse());
  assert.equal((await listWorkspaceRenderHistory(root)).history[0].id, newId);
  assert.deepEqual((await listWorkspaceRenderTasks(root)).history, [], "实时轮询不读取历史");
});

test("活动任务轮询不读取终态 comparison 的完整存储", async (context) => {
  const { root, projectDirectory } = await fixture(context);
  // The runtime index is enough to know this task is terminal.  Keep its
  // generated storage deliberately malformed: a full listComparison...
  // implementation would try to validate it and throw on this poll.
  await mkdir(path.join(projectDirectory, "Saved", "comparisons", "finished"), { recursive: true });
  await writeFile(path.join(projectDirectory, "Saved", "comparisons", "finished", "status.json"), JSON.stringify({
    id: "finished", status: "completed", started_at: "2026-08-28T01:02:03.000Z",
  }));
  await mkdir(path.join(projectDirectory, "Saved", "comparison-results", "finished"), { recursive: true });
  await writeFile(path.join(projectDirectory, "Saved", "comparison-results", "finished", "manifest.json"), "not a comparison manifest");

  const result = await listWorkspaceRenderTasks(root);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.history, []);
});
