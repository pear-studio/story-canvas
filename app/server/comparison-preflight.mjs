import { assertComparisonExperimentManifest, resolveComparisonCellSelection } from "./comparison-experiment.mjs";
import { assertComparisonInput, comparisonRenderIdentity } from "./comparison-inputs.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";

export const COMPARISON_PREFLIGHT_VERSION = 2;
export class ComparisonPreflightError extends Error {
  constructor(code, message, details = []) { super(message); this.code = code; this.details = details; this.status = 422; }
}
const fail = message => { throw new ComparisonPreflightError("invalid_comparison_preflight_plan", message); };
function identity({ canonical_sha256, ...value }) { return value; }

export function preflightComparisonExperiment({ manifest, inputs } = {}) {
  const verified = assertComparisonExperimentManifest(manifest);
  if (!Array.isArray(inputs) || !inputs.length) fail("实验需要测试输入");
  const frozen = inputs.map(assertComparisonInput);
  const byId = new Map(frozen.map(input => [input.id, input]));
  const axis = verified.axes.find(axis => axis.type === "input");
  if (byId.size !== frozen.length || new Set(axis.values.map(value => value.value)).size !== frozen.length || axis.values.some(value => !byId.has(value.value))) fail("测试输入必须恰好覆盖 input 轴");
  const cells = verified.cells.map(cell => {
    const selection = resolveComparisonCellSelection(verified, cell);
    const input = byId.get(selection.input_id);
    const renderIdentity = comparisonRenderIdentity(input);
    const lora = selection.test_lora;
    if (lora?.kind === "resource") {
      if (lora.architecture.family !== renderIdentity.architecture_family || lora.architecture.prompt_family !== renderIdentity.prompt_family) fail("比较 LoRA 与测试输入的模型家族不一致");
      const modelShas = new Set(Object.values(renderIdentity.models).map(model => model.sha256));
      if (lora.base_models.some(model => model.sha256 && !modelShas.has(model.sha256))) fail("比较 LoRA 的底座模型不一致");
    }
    if (selection.character_lora_weight !== null && input.loras.filter(lora => lora.kind === "character").length !== 1) fail("角色权重轴要求测试输入恰好包含一个角色 LoRA");
    if (selection.application?.mode === "replace_character" && !input.loras.some(lora => lora.kind === "character" && lora.owner === selection.application.target_character_id)) fail("测试输入不包含要替换的角色 LoRA");
    return { id: cell.id, ordinal: cell.ordinal, input_id: input.id, cfg: selection.cfg ?? input.render.profile.operations.candidates.routes.empty_latent.recipe.cfg };
  });
  const plan = { version: COMPARISON_PREFLIGHT_VERSION, kind: "comparison_preflight", manifest_id: verified.id,
    manifest_sha256: verified.canonical_sha256, manifest: verified, inputs: frozen, cells };
  return { ...plan, canonical_sha256: hashCanonicalJson(plan) };
}
export function assertComparisonPreflightPlan(plan) {
  if (plan?.version !== COMPARISON_PREFLIGHT_VERSION || plan.kind !== "comparison_preflight") fail("预检版本无效");
  const expected = preflightComparisonExperiment({ manifest: plan.manifest, inputs: plan.inputs });
  if (hashCanonicalJson(identity(plan)) !== expected.canonical_sha256 || plan.canonical_sha256 !== expected.canonical_sha256) fail("预检输入身份不一致");
  return structuredClone(plan);
}
export function validateComparisonPreflightPlan(plan) { try { assertComparisonPreflightPlan(plan); return []; } catch (error) { return [error.message]; } }
export const createComparisonPreflightPlan = preflightComparisonExperiment;
