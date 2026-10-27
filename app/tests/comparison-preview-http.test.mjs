import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { handleComparisonRequest } from "../server/comparison-http.mjs";
import { createBlankComparisonInput } from "../server/comparison-inputs.mjs";
import { prepareComparisonExperimentExecution } from "../server/comparison-execution-plan.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
async function fixture(t) {
  const parent = path.join(repositoryRoot, "Saved", "Tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "comparison-preview-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await createBlankComparisonInput(repositoryRoot, "anima-base-v1", "3:4");
  input.prompt = { positive: "A sunlit courtyard.", negative: "text" };
  input.label = "庭院";
  async function request(method, url, body) {
    let result;
    let status;
    const handled = await handleComparisonRequest({
      projectRoot: root, config: {}, activeComparisonProcesses: new Map(),
      decodedPath: new URL(url, "http://localhost").pathname,
      request: { method, url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } },
      response: { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } },
      readFacts() { throw new Error("显式输入不应重新读取项目"); },
    });
    assert.equal(handled, true);
    return { status, ...result };
  }
  return { root, input, request };
}

test("preview 编译实际逐格输入，不创建实验；create 与 inspect 保留同一冻结内容", async t => {
  const { root, input, request } = await fixture(t);
  const before = structuredClone(input);
  const body = { id: "preview-create", inputs: [input], axes: [{ type: "seed", values: [
    { value_id: "seed-a", label: "7", value: 7 }, { value_id: "seed-b", label: "11", value: 11 },
  ] }] };
  const preview = await request("POST", "/api/comparison-experiments/preview", body);
  assert.equal(preview.status, 200);
  assert.equal(preview.preflight.version, 3);
  assert.equal(preview.cells.length, 2);
  assert.deepEqual(preview.cells.map(cell => cell.seed), [7, 11]);
  assert.equal(preview.cells[0].prompt.positive, before.prompt.positive);
  assert.equal(preview.cells[0].prompt.negative, before.prompt.negative);
  assert.ok(preview.cells[0].dimensions.width > 0);
  assert.ok(preview.cells[0].dimensions.height > 0);
  assert.deepEqual(input, before);
  await assert.rejects(access(path.join(root, "Saved", "comparison-results")), { code: "ENOENT" });
  const created = await request("POST", "/api/comparison-experiments", body);
  assert.equal(created.status, 201);
  assert.equal(created.experiment.manifest.version, 2);
  assert.equal(created.experiment.can_start, true);
  const inspected = await request("GET", "/api/comparison-experiments/preview-create?include_inputs=true");
  assert.deepEqual(inspected.experiment.inputs, preview.preflight.inputs);
  assert.equal(inspected.experiment.preflight.version, 3);
  assert.deepEqual(inspected.experiment.preflight.compatibility, preview.preflight.compatibility);
  const compact = await request("GET", "/api/comparison-experiments/preview-create");
  assert.equal(compact.experiment.inputs, undefined);
  const unstarted = await request("GET", "/api/comparison-experiments/preview-create?include_execution=true");
  assert.equal(unstarted.experiment.execution, null);
  await prepareComparisonExperimentExecution({ repositoryRoot, projectRoot: root, localConfig: {}, experimentId: "preview-create" });
  const execution = await request("GET", "/api/comparison-experiments/preview-create?include_execution=true");
  assert.equal(execution.experiment.execution.cells[0].prompt.positive, before.prompt.positive);
  assert.deepEqual(execution.experiment.execution.cells[0].dimensions, preview.cells[0].dimensions);
  assert.equal(execution.experiment.execution.cells[0].workflow, undefined, "详情只投影冻结执行的展示字段");
});

test("混合模型输入在 preview 和 create 均拒绝，不留下半成品实验", async t => {
  const { root, input, request } = await fixture(t);
  const other = structuredClone(input);
  other.id = "foreign-input";
  other.render.profile.architecture_family = "qwen-image";
  const body = { id: "mixed", inputs: [input, other] };
  for (const route of ["/api/comparison-experiments/preview", "/api/comparison-experiments"]) {
    await assert.rejects(request("POST", route, body), error => /同一|家族|混合|单.*模型/.test(error.message));
  }
  await assert.rejects(access(path.join(root, "Saved", "comparison-results")), { code: "ENOENT" });
});
