import assert from "node:assert/strict";
import test from "node:test";

import { handleComparisonRequest, publicComparisonRecord } from "../server/comparison-http.mjs";

test("对比实验 HTTP 投影只返回网格所需事实并隐藏冻结执行大对象", () => {
  const projected = publicComparisonRecord({
    id: "demo",
    directory: "Saved/comparison-results/demo",
    manifest: { id: "demo", axes: [], cells: [] },
    preflight: { large: "preflight" },
    execution: { large: "execution" },
    status: {
      status: "incomplete",
      cells: [{ id: "cell-a", status: "incomplete" }],
    },
  });

  assert.deepEqual(projected, {
    id: "demo",
    manifest: { id: "demo", axes: [], cells: [] },
    status: {
      status: "failed",
      cells: [{ id: "cell-a", status: "failed" }],
    },
  });
});

test("远程 ComfyUI 不能启动只支持本机模型身份的对比实验", async () => {
  let mutated = false;
  await assert.rejects(
    handleComparisonRequest({
      request: { method: "POST" },
      decodedPath: "/api/comparison-experiments/experiment/start",
      projectRoot: "repository",
      config: { comfyui_urls: ["http://windows-gpu:8188"] },
      mutateDerived: async () => { mutated = true; },
      activeComparisonProcesses: new Map(),
    }),
    (error) => error?.status === 422 && error?.code === "comparison_remote_comfyui_unsupported",
  );
  assert.equal(mutated, false, "拒绝必须发生在实验状态和生成队列发生变化之前");
});


test("全局实验取消与批量清理不读取项目，活动任务不能删除，删除同时移除关联拼图", async t => {
  const { mkdtemp, mkdir, writeFile, rm, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createComparisonExperiment } = await import("../server/comparison-experiment.mjs");
  const { preflightComparisonExperiment } = await import("../server/comparison-preflight.mjs");
  const { createComparisonExperimentStorage } = await import("../server/comparison-experiment-storage.mjs");
  const { handleRuntimeRequest } = await import("../server/runtime-http.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "global-comparison-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { id: "sample", label: "测试", prompt: { positive: "landscape", negative: "" }, loras: [], render: { canvas: "2:3", profile: { id: "test", architecture_family: "anima", prompt: { family: "anima" }, models: {}, operations: { candidates: { routes: { empty_latent: { workflow: "test", recipe: { cfg: 6 } } } } } }, workflows: { test: {} } } };
  for (const id of ["first", "second"]) {
    const manifest = createComparisonExperiment({ id, axes: [{ type: "input", values: [{ value_id: "sample", label: "测试", value: "sample" }] }] });
    await createComparisonExperimentStorage({ projectRoot: root, manifest, preflight: preflightComparisonExperiment({ manifest, inputs: [input] }) });
  }
  const request = (method, body) => ({ method, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } });
  let body;
  const response = { writeHead() {}, end(text) { body = JSON.parse(text); } };
  const workers = new Map([[`${path.resolve(root)}:first`, true]]);
  const args = { projectRoot: root, response, activeComparisonProcesses: workers, readFacts: () => { throw new Error("不应读取项目"); } };
  await assert.rejects(handleComparisonRequest({ ...args, request: request("DELETE", { ids: ["second", "first"] }), decodedPath: "/api/comparison-experiments" }), { code: "comparison_running" });
  await access(path.join(root, "Saved/comparison-results/second/manifest.json"));
  workers.clear();
  await handleRuntimeRequest({ ...args, request: request("POST", { action: "cancel", purpose: "comparison" }), decodedPath: "/api/tasks/global/first/control", requestUrl: new URL("http://localhost/api/tasks/global/first/control") });
  assert.equal(body.task.status, "cancelled");
  const review = path.join(root, "Saved/comparison-reviews/sheet");
  await mkdir(review, { recursive: true });
  await writeFile(path.join(review, "index.json"), JSON.stringify({ experiments: [{ id: "first" }] }));
  await handleComparisonRequest({ ...args, request: request("DELETE", { ids: ["first", "second"] }), decodedPath: "/api/comparison-experiments" });
  assert.deepEqual(body.deleted, ["first", "second"]);
  await assert.rejects(access(review), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "Saved/comparisons/first")), { code: "ENOENT" });
  await handleComparisonRequest({ ...args, request: { method: "GET" }, decodedPath: "/api/comparison-experiments" });
  assert.deepEqual(body.experiments, []);
});
