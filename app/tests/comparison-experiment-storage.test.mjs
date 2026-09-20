import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { preflightComparisonExperiment } from "../server/comparison-preflight.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createComparisonExperiment } from "../server/comparison-experiment.mjs";
import {
  claimNextComparisonCell,
  cancelComparisonExperiment,
  completeComparisonCell,
  createComparisonExperimentStorage,
  failComparisonExperiment,
  listComparisonExperimentStorage,
  markComparisonExperimentRunning,
  readComparisonExperimentStorage,
  reconcileComparisonExperimentStatus,
  resolveComparisonCellImagePath,
} from "../server/comparison-experiment-storage.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";
import { listWorkspaceRenderHistory, readWorkspaceTaskResults } from "../server/render-task-workspace.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pageKey = { owner_kind: "story", page_id: "page-001" };
const now = "2026-08-24T00:00:00.000Z";

test("任务历史和图片清单不读取对比执行计划及逐格结果文件", async context => {
  const { root, projectRoot } = await fixture(context);
  const manifest = manifestWithCells();
  const record = await createComparisonExperimentStorage({ projectRoot, manifest, preflight: preflightFor(manifest) });
  const directory = path.join(projectRoot, "Saved", "comparison-results", manifest.id);
  const status = { ...record.status, status: "completed", completed_at: now, cells: record.status.cells.map(cell => ({ ...cell, status: "completed" })) };
  await writeFile(path.join(directory, "result.json"), JSON.stringify(status));
  for (const file of ["preflight.json", "execution.json"]) await writeFile(path.join(directory, file), "不应读取");
  const first = manifest.cells[0];
  await mkdir(path.join(directory, "results", first.id), { recursive: true });
  await writeFile(path.join(directory, "results", first.id, "result.json"), "不应读取");
  await writeFile(path.join(directory, "results", first.id, "image.png"), "image");
  const history = await listWorkspaceRenderHistory(root);
  assert.equal(history.history[0].id, manifest.id);
  assert.equal(history.history[0].item_counts.available, 2);
  const images = await readWorkspaceTaskResults(root, "project", manifest.id, "comparison");
  assert.deepEqual(images, [{ id: first.id, url: `/api/comparison-experiments/${manifest.id}/results/${first.id}.png` }]);
});

function manifestWithCells() {
  return createComparisonExperiment({
    id: "storage-test",
    created_at: now,
    axes: [
      { type: "input", values: [{ value_id: "page", label: "页面", value: "sample" }] },
      { type: "seed", values: [
        { value_id: "seed-a", label: "种子 A", value: 101 },
        { value_id: "seed-b", label: "种子 B", value: 102 },
      ] },
    ],
    randomSeed: () => 99,
  });
}

function preflightFor(manifest) {
  return preflightComparisonExperiment({ manifest, inputs: [{ id: "sample", label: "输入", prompt: { positive: "landscape", negative: "" }, loras: [],
    render: { canvas: "2:3", profile: { id: "test", architecture_family: "anima", prompt: { family: "anima" }, models: {}, operations: { candidates: { routes: { empty_latent: { workflow: "test", recipe: { cfg: 6 } } } } } }, workflows: { test: {} } } }] });
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-storage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = root;
  await mkdir(projectRoot, { recursive: true });
  registerFixtureProjects(root); return { root, projectRoot };
}

async function createStored(context) {
  const target = await fixture(context);
  const manifest = manifestWithCells();
  const preflight = preflightFor(manifest);
  const record = await createComparisonExperimentStorage({ projectRoot: target.projectRoot, manifest, preflight, now });
  return { ...target, manifest, preflight, record };
}

function result(cell) {
  return { image: { relative_path: `results/${cell.id}/image.png` }, completed_at: now, generation: { seed: cell.ordinal + 1 } };
}

async function completeNext(projectRoot, manifest) {
  const cell = await claimNextComparisonCell(projectRoot, manifest.id, now);
  await completeComparisonCell(projectRoot, manifest.id, cell.id, result(cell), now);
  return cell;
}

test("创建、读取、列表与忽略规则", async (context) => {
  const { projectRoot, manifest, preflight, record } = await createStored(context);
  assert.equal(await readFile(path.join(record.directory, "manifest.json"), "utf8") !== "", true);
  assert.equal(path.relative(projectRoot, record.directory), path.join("Saved", "comparison-results", manifest.id));
  assert.deepEqual((await listComparisonExperimentStorage(projectRoot)).map((entry) => entry.id), [manifest.id]);
  const read = await readComparisonExperimentStorage(projectRoot, manifest.id);
  read.status.cells[0].status = "completed";
  assert.equal((await readComparisonExperimentStorage(projectRoot, manifest.id)).status.cells[0].status, "queued");
  await assert.rejects(createComparisonExperimentStorage({ projectRoot, manifest, preflight, now }), /已存在/);

  async function ignored(relativePath) {
    try {
      await execFileAsync("git", ["check-ignore", "--no-index", "--quiet", relativePath], { cwd: repositoryRoot });
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  }
  for (const relativePath of [
    "workspace/private-story/Saved/comparison-results/demo/manifest.json",
    "workspace/private-story/Saved/comparison-results/demo/results/cell.png",
  ]) {
    assert.equal(await ignored(relativePath), true, relativePath);
  }
});

test("按 ordinal 顺序领取和完成 cell，最后完成实验", async (context) => {
  const { projectRoot, manifest } = await createStored(context);
  await markComparisonExperimentRunning(projectRoot, manifest.id, now);
  const first = await completeNext(projectRoot, manifest);
  assert.equal(first.id, manifest.cells[0].id);
  const second = await completeNext(projectRoot, manifest);
  assert.equal(second.id, manifest.cells[1].id);
  const final = await readComparisonExperimentStorage(projectRoot, manifest.id);
  assert.equal(final.status.status, "completed");
  assert.ok(final.status.cells.every((cell) => cell.status === "completed"));
  const target = await resolveComparisonCellImagePath(projectRoot, manifest.id, first.id);
  assert.equal(target, path.join(final.directory, "results", first.id, "image.png"));
});

test("取消比较实验会归档 cancelled，删除 runtime 后仍可读取", async (context) => {
  const { projectRoot, manifest, record } = await createStored(context);
  const cancelled = await cancelComparisonExperiment(projectRoot, manifest.id, now);
  assert.equal(cancelled.status.status, "cancelled");
  await rm(path.join(projectRoot, "Saved", "comparisons", manifest.id), { recursive: true, force: true });
  const read = await readComparisonExperimentStorage(projectRoot, manifest.id);
  assert.equal(read.status.status, "cancelled");
  assert.equal(JSON.parse(await readFile(path.join(record.directory, "result.json"))).status, "cancelled");
});

test("失败保留已完成结果，重启把未完成 cell 收束为 incomplete", async (context) => {
  const { projectRoot, manifest } = await createStored(context);
  const first = await completeNext(projectRoot, manifest);
  const second = await claimNextComparisonCell(projectRoot, manifest.id, now);
  assert.equal(second.id, manifest.cells[1].id);
  const failed = await failComparisonExperiment(projectRoot, manifest.id, { code: "comfy_failed", message: "ComfyUI 失败" }, now);
  assert.equal(failed.status.status, "incomplete");
  assert.equal(failed.status.cells[0].status, "completed");
  assert.equal(failed.status.cells[1].status, "incomplete");
  assert.equal(failed.status.cells[0].result.image.relative_path, `results/${first.id}/image.png`);

  const running = structuredClone(failed.status);
  running.status = "running";
  running.incomplete_at = null;
  running.cells[1].status = "queued";
  running.cells[1].error = null;
  const reconciled = reconcileComparisonExperimentStatus(running, now);
  assert.equal(reconciled.status, "incomplete");
  assert.equal(reconciled.cells[0].status, "completed");
  assert.equal(reconciled.cells[1].status, "incomplete");
});
