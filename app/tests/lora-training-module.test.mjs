import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as runtimeImplementation from "../server/lora-training-runtime.mjs";
import { createLoraTrainingCoordination, loraTrainingModule } from "../server/lora-training-module.mjs";

function assertCallableLeaves(value, label) {
  if (typeof value === "function") return;
  assert.equal(value !== null && typeof value === "object", true, `${label} 必须是对象或函数`);
  for (const [key, child] of Object.entries(value)) assertCallableLeaves(child, `${label}.${key}`);
}

test("LoRA 顶层 Module 暴露深 Interface，Adapter 不直接依赖实现文件", async () => {
  assert.equal(Object.isFrozen(loraTrainingModule), true);
  assert.equal(Object.isFrozen(loraTrainingModule.facts), true);
  assert.equal(Object.isFrozen(loraTrainingModule.plan), true);
  assert.equal(Object.isFrozen(loraTrainingModule.runtime), true);
  assert.equal(Object.isFrozen(loraTrainingModule.media), true);
  assert.equal(typeof loraTrainingModule.facts.datasets.read, "function");
  assert.equal(typeof loraTrainingModule.facts.captions.run, "function");
  assert.equal(typeof loraTrainingModule.plan.freeze, "function");
  assert.equal(typeof loraTrainingModule.runtime.startManifest, "function");
  assert.equal(typeof loraTrainingModule.media.postprocess.apply, "function");
  assert.equal(typeof loraTrainingModule.coordination.startRun, "function");

  const [httpSource, indexSource, facadeSource] = await Promise.all([
    readFile(new URL("../server/lora-training-http.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/lora-training.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(httpSource, /from "\.\/lora-training-module\.mjs"/);
  assert.doesNotMatch(httpSource, /from "\.\/lora-training\.mjs"/);
  assert.doesNotMatch(indexSource, /import \{[^}]*LoraTrainingError[^}]*\} from "\.\/lora-training-module\.mjs"/s);
  assert.doesNotMatch(httpSource, /lora-training\/migrate/);
  assert.doesNotMatch(facadeSource, /migrateLoraTrainingProject|lora-training\/migrate/);
});

test("LoRA Module 的所有 Interface 叶节点都可调用", () => {
  assertCallableLeaves(loraTrainingModule, "loraTrainingModule");
});

test("coordination.startRun 在顶层冻结 manifest 后才交给 runtime", async () => {
  const manifest = { id: "run-frozen", task_id: "lora-task", marker: "frozen" };
  const calls = [];
  const coordination = createLoraTrainingCoordination({
    isActive: () => false,
    freeze: async (...args) => {
      calls.push({ kind: "freeze", args });
      return { manifest };
    },
    startManifest: async (...args) => {
      calls.push({ kind: "startManifest", args });
      return { id: manifest.id, status: "running" };
    },
  });
  const options = { projectId: "rain-protocol", mutateDerived: () => undefined, runSettings: { seed: 7 } };
  const result = await coordination.startRun("root", "project", "lora-task", { models_root: "models" }, options);
  assert.deepEqual(result, { run: { id: manifest.id, status: "running" }, manifest });
  assert.equal(calls[0].kind, "freeze");
  assert.deepEqual(calls[0].args, ["root", "project", "lora-task", { models_root: "models" }, { runSettings: options.runSettings }]);
  assert.equal(calls[1].kind, "startManifest");
  assert.deepEqual(calls[1].args, ["project", manifest, { projectId: options.projectId, mutateDerived: options.mutateDerived }]);

  const runtimeSource = await readFile(new URL("../server/lora-training-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runtimeSource, /freezeLoraTrainingRun/);
  assert.doesNotMatch(runtimeSource, /export async function startLoraTrainingRun/);
  assert.equal(Object.hasOwn(runtimeImplementation, "startLoraTrainingRun"), false);
});

test("coordination.resumeRun 冻结续训 run 后才交给 runtime", async () => {
  const manifest = { id: "run-resumed", task_id: "dataset-task", resume: { parent_run_id: "run-parent" } };
  const calls = [];
  const coordination = createLoraTrainingCoordination({
    isActive: () => false,
    freeze: async () => assert.fail("续训不走全新冻结"),
    freezeResume: async (...args) => {
      calls.push({ kind: "freezeResume", args });
      return { manifest };
    },
    startManifest: async (...args) => {
      calls.push({ kind: "startManifest", args });
      return { id: manifest.id, status: "running" };
    },
  });
  const request = { max_train_steps: 4000, note: "追加", source_snapshot_id: "step-002000", source_sha256: "a".repeat(64) };
  const result = await coordination.resumeRun("root", "project", "dataset-task", "run-parent000000", {}, request);
  assert.deepEqual(result, { run: { id: manifest.id, status: "running" }, manifest });
  assert.deepEqual(calls[0], { kind: "freezeResume", args: ["root", "project", "dataset-task", "run-parent000000", {}, request] });
  assert.equal(calls[1].kind, "startManifest");
  assert.deepEqual(calls[1].args, ["project", manifest, { projectId: undefined, mutateDerived: undefined }]);
});

test("LoRA coordination用领域状态阻止第二个训练同时启动", async () => {
  let releaseFreeze;
  const freezePending = new Promise((resolve) => { releaseFreeze = resolve; });
  const coordination = createLoraTrainingCoordination({
    isActive: () => false,
    freeze: async () => {
      await freezePending;
      return { manifest: { id: "run-one", task_id: "task-one" } };
    },
    startManifest: async () => ({ id: "run-one", status: "running" }),
  });

  const first = coordination.startRun("root", "project", "task-one", {});
  await assert.rejects(
    () => coordination.startRun("root", "project", "task-two", {}),
    (error) => error.code === "lora_training_active" && error.status === 409,
  );
  releaseFreeze();
  await first;
});
