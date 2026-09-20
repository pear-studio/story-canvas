import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRenderTask,
  listActiveProjectTaskIds,
  listProjectRenderTaskStates,
  readRenderTask,
  readRenderTaskState,
  updateRenderTask,
} from "../server/render-task-storage.mjs";

const taskId = "render-20260828T010203Z-1234abcd";
const pageKey = { page_id: "page-101" };
const candidateId = "candidate-12345678-1234-4123-8123-123456789abc";

function queuedTask() {
  return {
    version: 2,
    id: taskId,
    project: "demo",
    render_profile: "anima-base-v1",
    purpose: "candidate",
    status: "queued",
    created_at: "2026-08-28T01:02:03.000Z",
    snapshot: { frozen: "execution" },
    items: [{
      id: "candidate-001",
      page_key: pageKey,
      candidate_id: candidateId,
      file: `Outputs/pages/page-101/${candidateId}/image.png`,
      seed: 7,
      status: "queued",
      positive_prompt: "ellen",
      negative_prompt: "low quality",
    }],
  };
}

async function fixture(context) {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "render-task-storage-"));
  context.after(() => rm(projectDirectory, { recursive: true, force: true }));
  return projectDirectory;
}

test("渲染状态更新只替换state并保留immutable manifest", async (context) => {
  const projectDirectory = await fixture(context);
  const created = await createRenderTask(projectDirectory, queuedTask(), {
    project_title: "Demo",
    pages: [{ page_key: pageKey, page_id: "page-101", order: 1, title: "基础形象", owner_label: "Ellen" }],
  });
  const manifestFile = path.join(created.task_directory, "manifest.json");
  const before = await readFile(manifestFile, "utf8");
  const waits = [];
  let attempts = 0;

  await updateRenderTask(projectDirectory, taskId, (task) => {
    task.status = "running";
    task.started_at = "2026-08-28T01:02:04.000Z";
    task.items[0].status = "running";
  }, {
    uniqueId: () => "stable-temp",
    renameFile: async (source, destination) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("target is temporarily locked"), { code: "EPERM" });
      await rename(source, destination);
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  const persisted = await readRenderTask(projectDirectory, taskId);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(persisted.task.status, "running");
  assert.equal(persisted.task.items[0].status, "running");
  assert.equal(persisted.state.revision, 2);
  assert.equal(await readFile(manifestFile, "utf8"), before);
  assert.deepEqual(await listActiveProjectTaskIds(projectDirectory), [taskId]);
});

test("终态任务物理移入history且仍可更新候选discard状态", async (context) => {
  const projectDirectory = await fixture(context);
  const created = await createRenderTask(projectDirectory, queuedTask(), { project_title: "Demo", pages: [] });
  const manifestBefore = await readFile(path.join(created.task_directory, "manifest.json"), "utf8");
  const archived = await updateRenderTask(projectDirectory, taskId, (task) => {
    task.status = "completed";
    task.completed_at = "2026-08-28T01:03:00.000Z";
    task.items[0].status = "available";
    task.items[0].generated_at = "2026-08-28T01:02:59.000Z";
  });

  assert.match(archived.task_directory.replaceAll("\\", "/"), /\/Saved\/render\/history\/render-/);
  assert.deepEqual(await readdir(path.join(projectDirectory, "Saved", "render", "active")), []);
  assert.deepEqual((await listProjectRenderTaskStates(projectDirectory, { scope: "history" })).map((state) => state.id), [taskId]);

  await updateRenderTask(projectDirectory, taskId, (task) => {
    task.items[0].status = "discarded";
    task.items[0].discarded_at = "2026-08-28T01:04:00.000Z";
  });
  const persisted = await readRenderTask(projectDirectory, taskId);
  assert.equal(persisted.task.items[0].status, "discarded");
  assert.equal(await readFile(path.join(persisted.task_directory, "manifest.json"), "utf8"), manifestBefore);
  await assert.rejects(updateRenderTask(projectDirectory, taskId, (task) => {
    task.status = "running";
  }), /终态渲染任务不能变更状态/);
});

test("state持续占用时更新有界失败并保留旧revision", async (context) => {
  const projectDirectory = await fixture(context);
  const created = await createRenderTask(projectDirectory, queuedTask(), { project_title: "Demo", pages: [] });
  const waits = [];
  let attempts = 0;

  await assert.rejects(updateRenderTask(projectDirectory, taskId, (task) => {
    task.status = "running";
  }, {
    retryDelays: [5, 15],
    uniqueId: () => "stable-temp",
    renameFile: async () => {
      attempts += 1;
      throw Object.assign(new Error("target remains locked"), { code: "EACCES" });
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  }), (error) => error?.code === "EACCES");

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5, 15]);
  assert.equal((await readRenderTask(projectDirectory, taskId)).state.revision, 1);
  assert.deepEqual((await readdir(created.task_directory)).sort(), ["manifest.json", "state.json"]);
});

test("状态更新拒绝改写manifest中的冻结执行内容", async (context) => {
  const projectDirectory = await fixture(context);
  await createRenderTask(projectDirectory, queuedTask(), { project_title: "Demo", pages: [] });

  await assert.rejects(
    updateRenderTask(projectDirectory, taskId, (task) => {
      task.status = "running";
      task.items[0].seed = 99;
    }),
    /不可变内容不能在状态更新时改变/,
  );
  assert.equal((await readRenderTask(projectDirectory, taskId)).state.revision, 1);
});

test("并发窄mutation在锁内重读state且不会丢失另一候选的discarded", async (context) => {
  const projectDirectory = await fixture(context);
  const task = queuedTask();
  const secondCandidateId = "candidate-abcdefab-cdef-4abc-8def-abcdefabcdef";
  task.items.push({
    ...structuredClone(task.items[0]),
    id: "candidate-002",
    candidate_id: secondCandidateId,
    file: `Outputs/pages/page-101/${secondCandidateId}/image.png`,
    seed: 8,
  });
  await createRenderTask(projectDirectory, task, { project_title: "Demo", pages: [] });
  let releaseFirst;
  let firstEntered;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const first = updateRenderTask(projectDirectory, taskId, async (current) => {
    firstEntered();
    await firstGate;
    current.items[0].status = "discarded";
    current.items[0].discarded_at = "2026-08-28T01:03:00.000Z";
  });
  await entered;
  const second = updateRenderTask(projectDirectory, taskId, (current) => {
    current.items[1].status = "discarded";
    current.items[1].discarded_at = "2026-08-28T01:03:01.000Z";
  });
  releaseFirst();
  await Promise.all([first, second]);

  const persisted = await readRenderTask(projectDirectory, taskId);
  assert.deepEqual(persisted.task.items.map((item) => item.status), ["discarded", "discarded"]);
  assert.equal(persisted.state.revision, 3);
});

test("归档与并发writer串行后只保留完整history目录", async (context) => {
  const projectDirectory = await fixture(context);
  await createRenderTask(projectDirectory, queuedTask(), { project_title: "Demo", pages: [] });
  let releaseArchive;
  let archiveEntered;
  const archiveGate = new Promise((resolve) => { releaseArchive = resolve; });
  const entered = new Promise((resolve) => { archiveEntered = resolve; });
  const archive = updateRenderTask(projectDirectory, taskId, async (current) => {
    archiveEntered();
    await archiveGate;
    current.status = "completed";
    current.completed_at = "2026-08-28T01:04:00.000Z";
    current.items[0].status = "available";
  });
  await entered;
  const discard = updateRenderTask(projectDirectory, taskId, (current) => {
    current.items[0].status = "discarded";
    current.items[0].discarded_at = "2026-08-28T01:04:01.000Z";
  });
  releaseArchive();
  const reads = Array.from({ length: 20 }, async () => {
    for (let index = 0; index < 5; index += 1) {
      const state = await readRenderTaskState(projectDirectory, taskId);
      const record = await readRenderTask(projectDirectory, taskId);
      assert.equal(state.id, taskId);
      assert.equal(record.task.id, taskId);
      assert.ok(["queued", "completed"].includes(state.status));
      assert.equal(record.task.snapshot.frozen, "execution");
    }
  });
  await Promise.all([archive, discard, ...reads]);

  const store = path.join(projectDirectory, "Saved", "render");
  assert.deepEqual(await readdir(path.join(store, "active")), []);
  assert.deepEqual((await readdir(path.join(store, "history", taskId))).sort(), ["manifest.json", "state.json"]);
  assert.equal((await readRenderTaskState(projectDirectory, taskId)).items[0].status, "discarded");
});

test("strict活动门禁在active state损坏时fail closed", async (context) => {
  const projectDirectory = await fixture(context);
  const created = await createRenderTask(projectDirectory, queuedTask(), { project_title: "Demo", pages: [] });
  await writeFile(path.join(created.task_directory, "state.json"), "{broken", "utf8");

  assert.deepEqual(await listProjectRenderTaskStates(projectDirectory, { scope: "active" }), []);
  await assert.rejects(
    listActiveProjectTaskIds(projectDirectory),
    (error) => error?.code === "render_task_state_invalid",
  );
  await assert.rejects(readRenderTaskState(projectDirectory, taskId), SyntaxError);

  await writeFile(path.join(created.task_directory, "state.json"), `${JSON.stringify({ ...created.state, status: "runing" }, null, 2)}\n`, "utf8");
  assert.deepEqual(await listProjectRenderTaskStates(projectDirectory, { scope: "active" }), []);
  await assert.rejects(
    listActiveProjectTaskIds(projectDirectory),
    (error) => error?.code === "render_task_state_invalid",
  );
});

test("tasks父链为链接时create拒绝且不向项目外写入", async (context) => {
  const projectDirectory = await fixture(context);
  const external = await mkdtemp(path.join(os.tmpdir(), "render-task-external-"));
  context.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, path.join(projectDirectory, "Saved"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(createRenderTask(projectDirectory, queuedTask(), { project_title: "Demo", pages: [] }), /目录无效|目录越界/);
  assert.deepEqual(await readdir(external), []);
});
