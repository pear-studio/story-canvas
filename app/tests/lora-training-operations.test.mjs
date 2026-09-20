import { createLoraTrainingDataset } from "./training-project-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLoraTrainingOperations } from "../server/lora-training-operations.mjs";
import { handleLoraTrainingRequest } from "../server/lora-training-http.mjs";
import { sendJson } from "../server/http-support.mjs";
import {  createLoraTrainingTask, readLoraTrainingTask, updateLoraTrainingDataset, updateLoraTrainingTask } from "../server/lora-training-facts.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("任务版本包含引用的数据集：无关数据集不冲突，训练集改变后旧操作被拒绝", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "training-dependency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = await createLoraTrainingDataset(root, { name: "训练素材" });
  const task = await createLoraTrainingTask(repositoryRoot, root, { name: "训练任务", dataset_id: dataset.id });
  const operations = createLoraTrainingOperations(root);
  const scope = `/api/lora-training/tasks/${task.id}`;
  const snapshot = await operations.execute(scope, undefined, false, () => readLoraTrainingTask(root, task.id));

  await createLoraTrainingDataset(root, { name: "无关素材" });
  const unchanged = await operations.execute(scope, snapshot.revision, true, () => readLoraTrainingTask(root, task.id));
  assert.equal(unchanged.revision, snapshot.revision);

  await updateLoraTrainingDataset(root, dataset.id, { ...dataset.dataset, activation_terms: ["new_training_concept"] });
  await assert.rejects(
    operations.execute(scope, snapshot.revision, true, () => updateLoraTrainingTask(repositoryRoot, root, task.id, { ...task.task, name: "旧窗口保存" })),
    { status: 409, code: "training_revision_conflict" },
  );
  const current = await readLoraTrainingTask(root, task.id);
  assert.equal(current.task.name, "训练素材");
  assert.deepEqual(current.dataset.activation_terms, ["new_training_concept"]);
});

test("事实操作未结束时停止请求仍立即交给运行时处理", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "training-stop-"));
  const operations = createLoraTrainingOperations(root);
  let unblock;
  let started;
  const hold = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = operations.execute("/api/lora-training/datasets", undefined, true, async () => {
    started();
    await hold;
  });
  const server = createServer(async (request, response) => {
    try {
      await handleLoraTrainingRequest({ request, response, decodedPath: new URL(request.url, "http://localhost").pathname, resolvedProjectRoot: root, trainingOperations: operations });
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.code ?? error.message });
    }
  });
  t.after(async () => {
    unblock();
    await blocked;
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await entered;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  // 使用不存在的运行，不启动训练或终止进程；领域错误证明停止请求已越过事实队列。
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lora-training/tasks/lora-000000000000/runs/run-000000000000/stop`, { method: "POST", signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "training_project_not_found" });
});
