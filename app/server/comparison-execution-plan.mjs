
import {
  assertComparisonExperimentManifest,
} from "./comparison-experiment.mjs";
import {
  assertComparisonPreflightPlan,
} from "./comparison-preflight.mjs";
import {
  freezeComparisonLoraSources,
} from "./comparison-lora-identity.mjs";
import {
  createComparisonExperimentExecution,
  readComparisonExperimentStorage,
} from "./comparison-experiment-storage.mjs";
import {
  assertComparisonExecutionPlan,
  COMPARISON_EXECUTION_PLAN_VERSION,
} from "./comparison-execution-contract.mjs";
import {buildComparisonCell} from "./comparison-cell.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { referenceImageFilename } from "./reference-image.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export class ComparisonExecutionPreparationError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ComparisonExecutionPreparationError";
    this.code = code;
    this.status = 422;
    this.details = details;
  }
}

function fail(code, message, details = []) { throw new ComparisonExecutionPreparationError(code, message, details); }

async function recheckLoraFiles({ repositoryRoot, localConfig, manifest, inputs }) {
  const entries=[...manifest.registries.loras,...inputs.flatMap(input=>input.loras)];
  if(!entries.length)return;
  const sources=entries.map((entry,index)=>({id:`check-${index}`,kind:'raw',relative_path:entry.relative_path??`loras/${entry.filename}`}));
  const actual=await freezeComparisonLoraSources({repositoryRoot,config:localConfig,sources});
  if (actual.some((entry, index) => entry.sha256 !== entries[index].sha256 || entry.size_bytes !== entries[index].size_bytes)) {
    fail("comparison_lora_changed", "Start 前复核发现比较 LoRA 文件或正式资源身份已变化");
  }
}

/**
 * Start 前的唯一执行计划入口：读取 immutable manifest/preflight，重新复核所有输入，
 * 再按 manifest ordinal 生成一 cell 一 workflow 的 comparison plan。失败时不写 execution.json。
 */
export async function prepareComparisonExperimentExecution({ repositoryRoot, projectRoot, localConfig, experimentId } = {}) {
  try {
    const stored = await readComparisonExperimentStorage(projectRoot, experimentId);
    if (stored.status.status !== "queued") fail("comparison_execution_order", "只有 queued 比较实验可以 Start");
    if (stored.execution !== null) fail("comparison_execution_exists", "比较实验已经存在 execution plan");
    const manifest = assertComparisonExperimentManifest(stored.manifest);
    const storedPreflight = assertComparisonPreflightPlan(stored.preflight);
    if(manifest.version!==2||storedPreflight.version!==3)fail('comparison_legacy_requires_reimport','旧版实验未冻结执行计划，请重新导入创建；不会自动升级旧输入');
    for (const input of storedPreflight.inputs) for (const reference of input.reference_images ?? []) {
      referenceImageFilename(reference);
      let bytes;
      try { bytes = await readFile(path.join(stored.directory, "inputs", `${reference.sha256}.png`)); }
      catch (error) { if (error.code === "ENOENT") fail("comparison_reference_missing", "冻结参考图已丢失，请重新创建实验"); throw error; }
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) fail("comparison_reference_changed", "冻结参考图内容已变化，请重新创建实验");
    }
    await recheckLoraFiles({ repositoryRoot, localConfig, manifest, inputs:storedPreflight.inputs });
    const cells = storedPreflight.cells.map((cell, index) => {
      const input = storedPreflight.inputs.find(input => input.id === cell.input_id);
      return buildComparisonCell({ experimentId: manifest.id, manifest, input, sourceCell: manifest.cells[index] }).cell;
    });
    const plan = {
      version: COMPARISON_EXECUTION_PLAN_VERSION,
      kind: "comparison_execution_plan",
      experiment_id: manifest.id,
      manifest_sha256: manifest.canonical_sha256,
      preflight_sha256: storedPreflight.canonical_sha256,
      cells,
    };
    plan.canonical_sha256 = hashCanonicalJson(plan);
    const verified = assertComparisonExecutionPlan(plan, { manifest, preflight: storedPreflight });
    return createComparisonExperimentExecution(projectRoot, manifest.id, verified);
  } catch (error) {
    if (error instanceof ComparisonExecutionPreparationError) throw error;
    throw new ComparisonExecutionPreparationError(error?.code ?? "comparison_execution_prepare_failed", error?.message ?? String(error), error?.details ?? []);
  }
}
