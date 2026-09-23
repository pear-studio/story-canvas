import { assertComparisonExperimentManifest } from "./comparison-experiment.mjs";
import { assertComparisonPreflightPlan } from "./comparison-preflight.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";

export const COMPARISON_EXECUTION_PLAN_VERSION = 1;

const planFields = new Set([
  "version", "kind", "experiment_id", "manifest_sha256", "preflight_sha256",
  "cells", "canonical_sha256",
]);
const cellFields = new Set([
  "id", "ordinal", "axis_values", "input_id", "seed", "cfg",
  "prompt", "loras", "reference_images", "workflow", "extra_data", "outputs",
]);
const hashPattern = /^[a-f0-9]{64}$/;

export class ComparisonExecutionPlanError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ComparisonExecutionPlanError";
    this.code = code;
    this.status = 422;
    this.details = details;
  }
}

const clone = (value) => structuredClone(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code, message, details = []) { throw new ComparisonExecutionPlanError(code, message, details); }
function keys(value, allowed, label) {
  if (!isRecord(value)) fail("invalid_comparison_execution_plan", `${label} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail("invalid_comparison_execution_plan", `${label} 包含未知字段：${unknown.join("、")}`);
}
function hash(value, label) {
  if (typeof value !== "string" || !hashPattern.test(value)) fail("invalid_comparison_execution_plan", `${label} 必须是 SHA-256`);
}
function planIdentity(plan) {
  const { canonical_sha256: _ignored, ...content } = plan;
  return content;
}

function assertWorkflow(workflow, label) {
  keys(workflow, new Set(["source_id", "api"]), label);
  if (typeof workflow.source_id !== "string" || !workflow.source_id || !isRecord(workflow.api)) {
    fail("invalid_comparison_execution_plan", `${label} 缺少 workflow source_id/api`);
  }
}

function assertOutput(output, cellId, label) {
  keys(output, new Set(["node_id", "image_index", "cell_id", "relative_path"]), label);
  if (typeof output.node_id !== "string" || output.cell_id !== cellId || output.image_index !== 0
    || output.relative_path !== `results/${cellId}/image.png`) {
    fail("comparison_execution_output_changed", `${label} 输出映射无效`);
  }
}

function assertCell(cell, source, input, index) {
  const label = `cells[${index}]`;
  keys(cell, cellFields, label);
  if (cell.id !== source.id || cell.ordinal !== source.ordinal) {
    fail("comparison_execution_cells_changed", `${label} 与 manifest cell 不一致`);
  }
  if (!Array.isArray(cell.outputs) || cell.outputs.length !== 1) {
    fail("invalid_comparison_execution_plan", `${label} 缺少 outputs`);
  }
  assertWorkflow(cell.workflow, `${label}.workflow`);
  if (hashCanonicalJson(cell.reference_images ?? []) !== hashCanonicalJson(input.reference_images ?? [])) {
    fail("comparison_execution_reference_changed", `${label} 参考图与冻结输入不一致`);
  }
  assertOutput(cell.outputs[0], cell.id, `${label}.outputs[0]`);
  if (!isRecord(cell.extra_data)) fail("invalid_comparison_execution_plan", `${label}.extra_data 必须是对象`);
}

function validateInternal(plan, { manifest, preflight } = {}) {
  if (!isRecord(manifest) || !isRecord(preflight)) {
    fail("comparison_execution_context_required", "校验 comparison execution plan 必须同时提供 manifest 与 preflight");
  }
  keys(plan, planFields, "comparison execution plan");
  if (plan.version !== COMPARISON_EXECUTION_PLAN_VERSION || plan.kind !== "comparison_execution_plan") {
    fail("invalid_comparison_execution_plan", "执行计划版本或 kind 无效");
  }
  hash(plan.manifest_sha256, "manifest_sha256");
  hash(plan.preflight_sha256, "preflight_sha256");
  hash(plan.canonical_sha256, "canonical_sha256");
  if (typeof plan.experiment_id !== "string" || !Array.isArray(plan.cells) || !plan.cells.length) {
    fail("invalid_comparison_execution_plan", "执行计划缺少 experiment_id/cells");
  }
  const verifiedManifest = assertComparisonExperimentManifest(manifest);
  const verifiedPreflight = assertComparisonPreflightPlan(preflight);
  if (plan.experiment_id !== verifiedManifest.id
    || plan.manifest_sha256 !== verifiedManifest.canonical_sha256
    || plan.preflight_sha256 !== verifiedPreflight.canonical_sha256
    || verifiedPreflight.manifest_id !== plan.experiment_id) {
    fail("comparison_execution_identity_mismatch", "执行计划与 manifest/preflight 身份不一致");
  }
  if (plan.cells.length !== verifiedManifest.cells.length || plan.cells.length !== verifiedPreflight.cells.length) {
    fail("comparison_execution_cells_changed", "执行计划 cell 数量不一致");
  }
  plan.cells.forEach((cell, index) => assertCell(cell, verifiedManifest.cells[index], verifiedPreflight.inputs.find(input => input.id === cell.input_id), index));
  if (plan.canonical_sha256 !== hashCanonicalJson(planIdentity(plan))) {
    fail("comparison_execution_plan_tampered", "执行计划 canonical_sha256 无效");
  }
  return plan;
}

export function validateComparisonExecutionPlan(plan, options) {
  try { validateInternal(plan, options); return []; }
  catch (error) { return [error instanceof ComparisonExecutionPlanError ? error.message : String(error)]; }
}

export function assertComparisonExecutionPlan(plan, options) {
  try { return clone(validateInternal(plan, options)); }
  catch (error) {
    if (error instanceof ComparisonExecutionPlanError) throw error;
    throw new ComparisonExecutionPlanError("invalid_comparison_execution_plan", error.message);
  }
}
