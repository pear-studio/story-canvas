
import {
  assertComparisonExperimentManifest,
  resolveComparisonCellSelection,
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
import { buildWorkflow, resolveRenderRecipe } from "./render-task-contract.mjs";
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

function clone(value) { return structuredClone(value); }
function fail(code, message, details = []) { throw new ComparisonExecutionPreparationError(code, message, details); }

function outputNodeId(definition) {
  const binding = definition?.manifest?.bindings?.filename_prefix;
  const match = typeof binding === "string" ? /^(\d+)\.inputs\.filename_prefix$/.exec(binding) : null;
  if (!match) fail("comparison_execution_workflow_changed", `${definition?.id ?? "工作流"} 缺少可冻结的输出节点绑定`);
  return match[1];
}

function comfyLoraName(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.startsWith("loras/")) fail("comparison_execution_lora_path", `LoRA 路径不是 models_root/loras 相对路径：${relativePath}`);
  const name = relativePath.slice("loras/".length);
  if (!name || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) fail("comparison_execution_lora_path", `LoRA ComfyUI 名称无效：${relativePath}`);
  return name;
}


function loraForWorkflow(entry, weight, { kind = "comparison", owner = entry.id } = {}) {
  return {
    kind,
    owner,
    source_id: entry.id,
    relative_path: entry.relative_path,
    filename: comfyLoraName(entry.relative_path),
    sha256: entry.sha256,
    size_bytes: entry.size_bytes,
    weight,
  };
}

function promptForSelection(input, selection) {
  const original = input.prompt.positive;
  if (!selection.test_lora || selection.application?.mode !== "replace_character") return { positive_prompt: original, prompt_parts: { positive: [{ text: input.prompt.positive }], negative: [{ text: input.prompt.negative }] } };
  const target = selection.application.target_character_id;
  const triggers = input.loras.filter(lora => lora.kind === "character" && lora.owner === target).flatMap(lora => lora.trigger_words ?? []).map(text => text.trim()).filter(Boolean);
  // 只移除完整触发词，保留自由文本的其他字符和段落，包括触发词内部的逗号。
  const patternFor = text => new RegExp(`(^|[,\\n][ \\t]*)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[ \\t]*(?:[,\\n]|$))`, "gim");
  let positive = original;
  for (const trigger of triggers.sort((a, b) => b.length - a.length)) positive = positive.replace(patternFor(trigger), "$1");
  if (selection.test_lora.kind === "resource") for (const trigger of selection.test_lora.activation.trigger_words) {
    if (!patternFor(trigger).test(positive)) positive += `${positive.includes("\n") ? "\n" : ", "}${trigger}`;
  }
  return { positive_prompt: positive, prompt_parts: { positive: [{ text: positive }], negative: [{ text: input.prompt.negative }] } };
}

function applyCharacterLoraWeight(baseLoras, selection) {
  if (selection.character_lora_weight === null) return baseLoras;
  const targets = baseLoras.filter((lora) => lora.kind === "character");
  if (targets.length !== 1) {
    fail("comparison_character_lora_weight_target_ambiguous", "character_lora_weight 轴要求页面恰好包含一个角色 LoRA");
  }
  const target = targets[0];
  return baseLoras.map((lora) => lora === target ? { ...lora, weight: selection.character_lora_weight } : lora);
}

function sourceEntries(manifest) {
  return manifest.registries.loras.map(entry => ({ id: entry.id, kind: "raw", relative_path: entry.relative_path }));
}

async function recheckLoraRegistry({ repositoryRoot, localConfig, manifest }) {
  if (!manifest.registries.loras.length) return;
  const actual = await freezeComparisonLoraSources({ repositoryRoot, config: localConfig, sources: sourceEntries(manifest) });
  if (actual.some((entry, index) => entry.sha256 !== manifest.registries.loras[index].sha256 || entry.size_bytes !== manifest.registries.loras[index].size_bytes)) {
    fail("comparison_lora_changed", "Start 前复核发现比较 LoRA 文件或正式资源身份已变化");
  }
}

function buildCell({ experimentId, manifest, input, sourceCell }) {
  const { profile, canvas, workflows } = input.render;
  const route = profile.operations.candidates.routes[input.reference_images?.length ? "reference_image" : "empty_latent"];
  const selection = resolveComparisonCellSelection(manifest, sourceCell);
  const cfg = selection.cfg ?? route.recipe.cfg;
  const definition = workflows[route.workflow];
  const testEntry = selection.test_lora;
  const baseLoras = applyCharacterLoraWeight(clone(input.loras), selection);
  const replacingCharacter = Boolean(testEntry && selection.application?.mode === "replace_character");
  const testLora = testEntry
    ? loraForWorkflow(testEntry, selection.test_lora_weight, replacingCharacter
      ? { kind: "character", owner: selection.application.target_character_id }
      : undefined)
    : null;
  const loras = replacingCharacter
    ? [...baseLoras.filter((lora) => !(lora.kind === "character" && lora.owner === selection.application.target_character_id)), ...(testLora ? [testLora] : [])]
    : [...baseLoras, ...(testLora ? [testLora] : [])];
  const prompt = promptForSelection(input, selection);
  const recipeParameters = clone(route.recipe);
  recipeParameters.cfg = cfg;
  const recipe = resolveRenderRecipe(recipeParameters, canvas);
  const item = {
    id: `comparison.${sourceCell.id}`,
    task: `comparison-${experimentId}`,
    input_id: input.id,
    output_prefix: `StoryCanvas/comparisons/${experimentId}/${sourceCell.id}`,
    seed: sourceCell.effective_seed,
    positive_prompt: prompt.positive_prompt,
    negative_prompt: input.prompt.negative,
    prompt_parts: prompt.prompt_parts,
    loras: clone(loras),
    reference_images: clone(input.reference_images ?? []),
  };
  const workflow = buildWorkflow(definition, profile, recipe, item);
  const output = {
    node_id: outputNodeId(definition),
    image_index: 0,
    cell_id: sourceCell.id,
    relative_path: `results/${sourceCell.id}/image.png`,
  };
  const extraData = {
    extra_pnginfo: {
      storyvisualizer: {
        version: 1,
        kind: "comparison",
        experiment_id: experimentId,
        cell_id: sourceCell.id,
        ordinal: sourceCell.ordinal,
        input_id: input.id,
        axis_values: clone(sourceCell.axis_values),
        seed: sourceCell.effective_seed,
        cfg,
        outputs: [clone(output)],
      },
    },
  };
  const unit = {
    id: sourceCell.id,
    ordinal: sourceCell.ordinal,
    axis_values: clone(sourceCell.axis_values),
    input_id: input.id,
    seed: sourceCell.effective_seed,
    cfg,
    prompt: {
      positive: prompt.positive_prompt,
      negative: input.prompt.negative,
      parts: clone(prompt.prompt_parts),
    },
    loras,
    reference_images: clone(input.reference_images ?? []),
    workflow: {
      source_id: definition.id,
      api: workflow,
    },
    extra_data: extraData,
    outputs: [output],
  };
  return unit;
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
    for (const input of storedPreflight.inputs) for (const reference of input.reference_images ?? []) {
      referenceImageFilename(reference);
      let bytes;
      try { bytes = await readFile(path.join(stored.directory, "inputs", `${reference.sha256}.png`)); }
      catch (error) { if (error.code === "ENOENT") fail("comparison_reference_missing", "冻结参考图已丢失，请重新创建实验"); throw error; }
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) fail("comparison_reference_changed", "冻结参考图内容已变化，请重新创建实验");
    }
    await recheckLoraRegistry({ repositoryRoot, localConfig, manifest });
    const cells = storedPreflight.cells.map((cell, index) => {
      const input = storedPreflight.inputs.find(input => input.id === cell.input_id);
      return buildCell({ experimentId: manifest.id, manifest, input, sourceCell: manifest.cells[index] });
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
