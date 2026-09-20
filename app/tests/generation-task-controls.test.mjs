import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { handleRuntimeRequest } from "../server/runtime-http.mjs";
import { listWorkspaceRenderTasks } from "../server/render-task-workspace.mjs";

import { controlGenerationTask, recoverGenerationTasks, executeGenerationTask } from "../server/generation-lifecycle.mjs";
import { enqueueGenerationTask, generationReference, readGenerationQueue, waitForGenerationUnitTurn, generationQueueFile, waitForGenerationQueueDrain } from "../server/generation-queue.mjs";
import { runPersistedRenderTask } from "../server/render-project-runtime.mjs";
import { createRenderTask, readRenderTaskState, updateRenderTask } from "../server/render-task-storage.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-canvas-generation-control-"));
  const project = path.join(root, "workspace", "demo");
  await mkdir(project, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  registerFixtureProjects(root); return { root, project };
}

test("候选任务控制只改变轻量状态并与统一队列同步", async (context) => {
  const { root, project } = await fixture(context);
  const task = {
    version: 2,
    id: "render-20260828T010203Z-11111111",
    project: "demo",
    purpose: "candidate",
    render_profile: "anima-base-v1",
    status: "queued",
    created_at: "2026-08-28T01:02:03.000Z",
    snapshot: {},
    items: [{ id: "item-1", page_key: { owner_kind: "story", page_id: "page-1" }, seed: 1, status: "queued" }],
  };
  await createRenderTask(project, task, { project_title: "Demo", pages: [] });
  await enqueueGenerationTask(root, generationReference("demo", task.id, "candidate", task.created_at));
  for (const action of ["pause", "resume"]) {
    await assert.rejects(controlGenerationTask(root, "demo", task.id, action), error => error.code === "invalid_task_control");
  }
  const lease = await waitForGenerationUnitTurn(root, generationReference("demo", task.id, "candidate", task.created_at), "unit-1");
  await updateRenderTask(project, task.id, current => { current.status = "running"; current.items[0].status = "running"; });
  for (const action of ["cancel"]) {
    const request = Readable.from([Buffer.from(JSON.stringify({ action, purpose: "candidate" }))]);
    request.method = "POST"; request.headers = { "content-type": "application/json" };
    const url = new URL(`http://localhost/api/tasks/demo/${task.id}/control`);
    let body;
    await handleRuntimeRequest({ request, requestUrl: url, decodedPath: url.pathname, projectRoot: root,
      mutateDerivedState: async (_project, operation) => ({ value: await operation() }),
      response: { writeHead(status) { assert.equal(status, 200); }, end(value) { body = JSON.parse(value); } },
    });
    assert.deepEqual(body.task, { id: task.id, project_id: "demo", purpose: "candidate", status: "running", pending_control: action });
    assert.equal(body.queue_revision, (await readGenerationQueue(root)).revision);
    assert.equal((await listWorkspaceRenderTasks(root)).tasks[0].pending_control, action);
  }
  await lease.release();
  await controlGenerationTask(root, "demo", task.id, "cancel");
  const cancelled = await readRenderTaskState(project, task.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await readGenerationQueue(root)).items.length, 0);
  await assert.rejects(controlGenerationTask(root, "demo", task.id, "cancel"), (error) => error?.code === "task_terminal");
  assert.equal((await readGenerationQueue(root)).items.length, 0);
});

test("重启保留尚未生效的取消，冻结任务预检失败也不会留下排队项", async context => {
  const { root, project } = await fixture(context);
  const id = "render-20260828T010203Z-22222222";
  const task = { version: 2, id, project: "demo", purpose: "candidate", render_profile: "anima-base-v1",
    status: "running", created_at: "2026-08-28T01:02:03.000Z", snapshot: {},
    items: [{ id: "done", page_key: { owner_kind: "story", page_id: "page-1" }, seed: 1, status: "available" },
      { id: "remaining", page_key: { owner_kind: "story", page_id: "page-1" }, seed: 2, status: "running" }] };
  await createRenderTask(project, task, { project_title: "Demo", pages: [] });
  const reference = generationReference("demo", id, "candidate", task.created_at);
  await enqueueGenerationTask(root, reference);
  await waitForGenerationUnitTurn(root, reference, "unit-1");
  await controlGenerationTask(root, "demo", id, "cancel");
  const queueFile = generationQueueFile(root);
  const queue = JSON.parse(await readFile(queueFile, "utf8"));
  queue.active.owner_pid = 2147483647;
  await writeFile(queueFile, JSON.stringify(queue));
  await recoverGenerationTasks(root, { apiUrl: "http://unused", drainOptions: {
    fetchImpl: async () => ({ ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) }),
  } });
  await waitForGenerationQueueDrain(root);
  const cancelled = await readRenderTaskState(project, id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.items.map(item => item.status), ["available", "cancelled"]);
  assert.deepEqual((await readGenerationQueue(root)).items, []);

  const invalidId = "render-20260828T010204Z-33333333";
  await createRenderTask(project, { ...task, id: invalidId, status: "queued" }, { project_title: "Demo", pages: [] });
  const invalidReference = generationReference("demo", invalidId, "candidate", task.created_at);
  await enqueueGenerationTask(root, invalidReference);
  await assert.rejects(runPersistedRenderTask({ projectRoot: project, repositoryRoot: root, taskId: invalidId,
    generationQueue: { repositoryRoot: root, reference: invalidReference } }), /冻结/);
  assert.equal((await readRenderTaskState(project, invalidId)).status, "failed");
  await listWorkspaceRenderTasks(root);
  await recoverGenerationTasks(root);
  assert.deepEqual((await readGenerationQueue(root)).items, []);
});


test("失败收尾再次出错仍保留最初的执行错误", async context => {
  const { root, project } = await fixture(context);
  const error = Object.assign(new Error("original rename failure"), { code: "EPERM" });
  const reference = generationReference(null, "missing-comparison", "comparison");
  await enqueueGenerationTask(root, reference);
  await assert.rejects(executeGenerationTask({ projectRoot: project, taskId: reference.task_id, purpose: "comparison",
    generationQueue: { repositoryRoot: root, reference } }, async () => { throw error; }), value => value === error);
  assert.equal(error.cleanupErrors.length, 1);
  assert.equal(error.cleanupErrors[0].code, "invalid_comparison_manifest_file");
  assert.equal((await readGenerationQueue(root)).items.length, 0);
});
