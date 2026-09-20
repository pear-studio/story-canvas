import { randomInt } from "node:crypto";

import { normalizeFrozenComparisonLora } from "./comparison-lora-identity.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";

const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const createdAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const maxSeed = 2 ** 31 - 1;
const scalarTypes = new Set(["string", "number", "boolean"]);

export const COMPARISON_EXPERIMENT_VERSION = 1;
export const COMPARISON_AXIS_TYPES = Object.freeze([
  "input",
  "lora_config",
  "character_lora_weight",
  "lora_weight",
  "seed",
  "cfg",
]);
export const COMPARISON_EXPERIMENT_STATUSES = Object.freeze(["queued", "running", "completed", "incomplete"]);
export const COMPARISON_CELL_STATUSES = COMPARISON_EXPERIMENT_STATUSES;
export const COMPARISON_MAX_SEED = maxSeed;

const axisTypeSet = new Set(COMPARISON_AXIS_TYPES);
const statusSet = new Set(COMPARISON_EXPERIMENT_STATUSES);
const terminalCellStatusSet = new Set(["completed", "incomplete"]);

export class ComparisonExperimentError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ComparisonExperimentError";
    this.code = code;
    this.status = 422;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function fail(code, message, details = []) {
  throw new ComparisonExperimentError(code, message, details);
}

function compareAxisOrder(left, right) {
  return COMPARISON_AXIS_TYPES.indexOf(left.type) - COMPARISON_AXIS_TYPES.indexOf(right.type);
}

function assertStableId(value, label) {
  if (typeof value !== "string" || !idPattern.test(value)) {
    fail("invalid_comparison_id", `${label} 必须是小写字母、数字、下划线或连字符组成的稳定 ID`);
  }
  return value;
}

function assertLabel(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200) {
    fail("invalid_comparison_value", `${label} 必须是 1 到 200 个字符且不带首尾空格的非空文本`);
  }
  return value;
}

function assertSafeSeed(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxSeed) {
    fail("invalid_comparison_seed", `${label} 必须是 0 到 ${maxSeed} 之间的安全整数`);
  }
  return value;
}

function assertCreatedAt(value) {
  if (typeof value !== "string" || !createdAtPattern.test(value) || Number.isNaN(Date.parse(value))) {
    fail("invalid_comparison_created_at", "created_at 必须是 UTC ISO-8601 时间");
  }
  return value;
}

function assertScalar(value, label) {
  if (value === null) return value;
  if (!scalarTypes.has(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
    fail("invalid_comparison_value", `${label} 必须是字符串、有限数值、布尔值或 null`);
  }
  if (typeof value === "string" && (!value.trim() || value !== value.trim() || value.length > 2000)) {
    fail("invalid_comparison_value", `${label} 必须是 1 到 2000 个字符且不带首尾空格的非空文本`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) fail("invalid_comparison_manifest", `${label} 必须是对象`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail("invalid_comparison_manifest", `${label} 包含未知字段：${unknown.join("、")}`);
}

function normalizeScalarValue(value, axisType, label) {
  assertExactKeys(value, ["value_id", "label", "value"], label);
  const valueId = assertStableId(value.value_id, `${label}.value_id`);
  const labelText = assertLabel(value.label, `${label}.label`);
  const payload = assertScalar(value.value, `${label}.value`);
  if (["lora_config", "input"].includes(axisType)
    && (typeof payload !== "string" || !idPattern.test(payload))) {
    fail("invalid_comparison_value", `${label}.value 必须是 registry 稳定 ID`);
  }
  if (["character_lora_weight", "lora_weight", "cfg"].includes(axisType) && (typeof payload !== "number" || !Number.isFinite(payload))) {
    fail("invalid_comparison_value", `${label}.value 必须是有限数值`);
  }
  if (["character_lora_weight", "lora_weight"].includes(axisType) && (payload < -2 || payload > 2)) {
    fail("invalid_comparison_value", `${label}.value 的 ${axisType} 必须在 -2 到 2 之间`);
  }
  if (axisType === "cfg" && (payload <= 0 || payload > 30)) {
    fail("invalid_comparison_value", `${label}.value 的 cfg 必须大于 0 且不超过 30`);
  }
  if (axisType === "seed") assertSafeSeed(payload, `${label}.value`);
  return { value_id: valueId, label: labelText, value: payload };
}

function normalizeLoraConfigRegistry(registry) {
  assertExactKeys(registry, ["id", "label", "lora_ref", "application"], "registries.lora_configs 条目");
  const id = assertStableId(registry.id, "registries.lora_configs.id");
  const label = assertLabel(registry.label, "registries.lora_configs.label");
  if (registry.lora_ref !== null && (typeof registry.lora_ref !== "string" || !idPattern.test(registry.lora_ref))) {
    fail("invalid_comparison_registry", "registries.lora_configs.lora_ref 必须为 null 或稳定 ID");
  }
  if (registry.application === undefined) return { id, label, lora_ref: registry.lora_ref };
  assertExactKeys(registry.application, ["mode", "target_character_id"], "registries.lora_configs.application");
  if (registry.application.mode !== "replace_character") {
    fail("invalid_comparison_registry", "registries.lora_configs.application.mode 只支持 replace_character");
  }
  const targetCharacterId = assertStableId(registry.application.target_character_id, "registries.lora_configs.application.target_character_id");
  return {
    id,
    label,
    lora_ref: registry.lora_ref,
    application: { mode: "replace_character", target_character_id: targetCharacterId },
  };
}

function normalizeLoraRegistry(registry, index) {
  try {
    return normalizeFrozenComparisonLora(registry, `registries.loras[${index}]`);
  } catch (error) {
    fail("invalid_comparison_registry", error.message);
  }
}

function normalizeRegistries(registries, axes = null) {
  assertExactKeys(registries, ["loras", "lora_configs"], "registries");
  if (!Array.isArray(registries.loras) || !Array.isArray(registries.lora_configs)) {
    fail("invalid_comparison_registry", "registries.loras、lora_configs 必须是数组");
  }
  const loras = registries.loras.map(normalizeLoraRegistry);
  const loraConfigs = registries.lora_configs.map(normalizeLoraConfigRegistry);
  const frozenLoraIds = new Set();
  for (const entry of loras) {
    if (frozenLoraIds.has(entry.id)) fail("duplicate_comparison_registry_entry", `loras 的 id 重复：${entry.id}`);
    frozenLoraIds.add(entry.id);
  }
  const loraIds = new Set();
  for (const entry of loraConfigs) {
    if (loraIds.has(entry.id)) fail("duplicate_comparison_registry_entry", `lora_configs 的 id 重复：${entry.id}`);
    loraIds.add(entry.id);
  }
  const referencedLoraIds = new Set(loraConfigs.filter((entry) => entry.lora_ref !== null).map((entry) => entry.lora_ref));
  for (const entry of loraConfigs) {
    if (entry.lora_ref !== null && !frozenLoraIds.has(entry.lora_ref)) {
      fail("invalid_comparison_registry", `lora_configs.${entry.id}.lora_ref 引用了不存在的 loras 条目`);
    }
  }
  if (referencedLoraIds.size !== frozenLoraIds.size || [...frozenLoraIds].some((id) => !referencedLoraIds.has(id))) {
    fail("invalid_comparison_registry", "loras 必须与 lora_configs 的非 null lora_ref 双向恰好一致");
  }

  if (axes) {
    const axisByType = new Map(axes.map((axis) => [axis.type, axis]));
    const loraAxis = axisByType.get("lora_config");
    const weightAxis = axisByType.get("lora_weight");
    if (!loraAxis && weightAxis) fail("invalid_comparison_axis", "lora_weight 轴必须与 lora_config 轴同时存在");
    if (loraAxis) {
      const selectedIds = new Set(loraAxis.values.map((value) => value.value));
      if (selectedIds.size !== loraConfigs.length || [...loraIds].some((id) => !selectedIds.has(id))) {
        fail("invalid_comparison_registry", "lora_configs 必须恰好覆盖 lora_config 轴引用的条目");
      }
      if ([...selectedIds].some((id) => !loraIds.has(id))) fail("invalid_comparison_registry", "lora_config 轴引用了不存在的 lora_configs 条目");
      if (loraConfigs.some((entry) => entry.lora_ref !== null) && !weightAxis) {
        fail("invalid_comparison_axis", "选择测试 LoRA 时必须提供 lora_weight 轴；baseline-only 可以省略");
      }
    } else if (loraConfigs.length || loras.length) {
      fail("invalid_comparison_registry", "没有 lora_config 轴时不允许冻结 lora_configs 条目");
    }
  }
  return { loras, lora_configs: loraConfigs };
}

function normalizeAxis(axis, index) {
  const label = `axes[${index}]`;
  assertExactKeys(axis, ["type", "values"], label);
  if (!axisTypeSet.has(axis.type)) fail("invalid_comparison_axis", `${label}.type 不是受支持的比较轴`);
  if (!Array.isArray(axis.values) || axis.values.length === 0) fail("invalid_comparison_axis", `${label}.values 必须是非空数组`);
  const values = axis.values.map((value, valueIndex) => normalizeScalarValue(value, axis.type, `${label}.values[${valueIndex}]`));
  const ids = new Set();
  for (const value of values) {
    if (ids.has(value.value_id)) fail("duplicate_comparison_value", `${label}.values 的 value_id 重复：${value.value_id}`);
    ids.add(value.value_id);
  }
  return { type: axis.type, values };
}

function normalizeAxes(axes) {
  if (!Array.isArray(axes) || axes.length === 0) fail("invalid_comparison_axes", "axes 必须是非空数组");
  const normalized = axes.map(normalizeAxis);
  const types = new Set();
  for (const axis of normalized) {
    if (types.has(axis.type)) fail("duplicate_comparison_axis", `比较轴重复：${axis.type}`);
    types.add(axis.type);
  }
  if (!types.has("input")) fail("missing_comparison_input_axis", "比较实验必须包含 input 轴");
  if (types.has("lora_weight") && !types.has("lora_config")) {
    fail("invalid_comparison_axis", "lora_weight 轴必须与 lora_config 轴同时存在");
  }
  return normalized.sort(compareAxisOrder);
}

function axisIdentity(axis) {
  return {
    type: axis.type,
    values: axis.values.map((value) => ({ value_id: value.value_id, label: value.label, value: value.value })),
  };
}

function valueIdentity(axis, value) {
  return {
    axis_type: axis.type,
    value_id: value.value_id,
  };
}

function expandCells(axes, sharedSeed) {
  const cells = [];
  const selections = [];
  const visit = (axisIndex) => {
    if (axisIndex === axes.length) {
      const axisValues = Object.fromEntries(selections.map(({ axis, value }) => [axis.type, value.value_id]));
      const seedAxis = axes.find((axis) => axis.type === "seed");
      const effectiveSeed = seedAxis
        ? seedAxis.values.find((value) => value.value_id === axisValues.seed)?.value
        : sharedSeed;
      const identity = selections.map(({ axis, value }) => valueIdentity(axis, value));
      const cellHash = hashCanonicalJson(identity);
      cells.push({
        id: `cell-${cellHash}`,
        ordinal: cells.length,
        axis_values: axisValues,
        effective_seed: assertSafeSeed(effectiveSeed, "cell.effective_seed"),
        status: "queued",
      });
      return;
    }
    const axis = axes[axisIndex];
    for (const value of axis.values) {
      selections.push({ axis, value });
      visit(axisIndex + 1);
      selections.pop();
    }
  };
  visit(0);
  return cells;
}

function canonicalIdentityFor({ version, id, created_at, shared_seed, axes, registries, cells }) {
  return {
    version,
    id,
    created_at,
    shared_seed,
    axes: axes.map(axisIdentity),
    registries: clone(registries),
    cells: cells.map((cell) => ({
      id: cell.id,
      ordinal: cell.ordinal,
      axis_values: { ...cell.axis_values },
      effective_seed: cell.effective_seed,
    })),
  };
}

function randomSeedOnce(randomSeed) {
  if (typeof randomSeed !== "function") fail("invalid_comparison_seed_factory", "randomSeed 必须是可调用的随机种子工厂");
  const value = randomSeed();
  return assertSafeSeed(value, "随机种子工厂返回值");
}

function normalizeCreateInput(input) {
  if (!isRecord(input)) fail("invalid_comparison_input", "比较实验创建输入必须是对象");
  assertExactKeys(input, ["id", "created_at", "axes", "registries", "randomSeed"], "比较实验创建输入");
  if (input.created_at !== undefined && typeof input.created_at !== "string") fail("invalid_comparison_input", "created_at 必须是字符串");
  return {
    id: assertStableId(input.id, "id"),
    created_at: input.created_at ?? new Date().toISOString(),
    axes: input.axes,
    registries: input.registries ?? { loras: [], lora_configs: [] },
    randomSeed: input.randomSeed ?? (() => randomInt(0, maxSeed + 1)),
  };
}

/**
 * 创建只包含比较实验领域事实的冻结 manifest。
 * seed 轴存在时不会调用 randomSeed，shared_seed 为 null；否则 randomSeed 只调用一次。
 */
export function createComparisonExperiment(input) {
  const normalizedInput = normalizeCreateInput(input);
  const createdAt = assertCreatedAt(normalizedInput.created_at);
  const axes = normalizeAxes(normalizedInput.axes);
  const registries = normalizeRegistries(normalizedInput.registries, axes);
  const seedAxis = axes.find((axis) => axis.type === "seed");
  const sharedSeed = seedAxis ? null : randomSeedOnce(normalizedInput.randomSeed);
  const cells = expandCells(axes, sharedSeed);
  const canonicalIdentity = canonicalIdentityFor({
    version: COMPARISON_EXPERIMENT_VERSION,
    id: normalizedInput.id,
    created_at: createdAt,
    shared_seed: sharedSeed,
    axes,
    registries,
    cells,
  });
  const manifest = {
    version: COMPARISON_EXPERIMENT_VERSION,
    kind: "comparison_experiment",
    id: normalizedInput.id,
    created_at: createdAt,
    status: "queued",
    shared_seed: sharedSeed,
    axes,
    registries,
    cells,
    canonical_sha256: hashCanonicalJson(canonicalIdentity),
  };
  const errors = collectComparisonExperimentErrors(manifest);
  if (errors.length) fail("invalid_comparison_manifest", "无法建立比较实验 manifest", errors);
  return manifest;
}

function collectComparisonStatusErrors(value) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!isRecord(value)) return ["manifest 必须是 JSON 对象"];
  if (!statusSet.has(value.status)) add("manifest.status 无效");
  if (!Array.isArray(value.cells) || value.cells.length === 0) {
    errors.push("manifest.cells 必须是非空数组");
    return errors;
  }
  const cellStatuses = value.cells.map((cell, index) => {
    const status = isRecord(cell) ? cell.status : undefined;
    if (!statusSet.has(status)) add(`manifest.cells[${index}].status 无效`);
    return status;
  });
  if (!statusSet.has(value.status) || cellStatuses.some((status) => !statusSet.has(status))) return errors;
  if (value.status === "queued" && cellStatuses.some((status) => status !== "queued")) {
    add("queued 实验的 cell 必须全部 queued");
  }
  if (value.status === "running" && cellStatuses.some((status) => !["queued", "running", "completed"].includes(status))) {
    add("running 实验的 cell 不能处于 incomplete");
  }
  if (value.status === "running" && cellStatuses.every((status) => status === "completed")) {
    add("全部 cell 已完成时实验必须为 completed");
  }
  if (value.status === "completed" && cellStatuses.some((status) => status !== "completed")) {
    add("completed 实验的 cell 必须全部 completed");
  }
  if (value.status === "incomplete" && (cellStatuses.some((status) => !terminalCellStatusSet.has(status)) || !cellStatuses.includes("incomplete"))) {
    add("incomplete 实验必须全部为终态且至少有一个 incomplete cell");
  }
  return errors;
}

function collectComparisonExperimentErrors(value) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!isRecord(value)) return ["manifest 必须是 JSON 对象"];
  const allowed = new Set(["version", "kind", "id", "created_at", "status", "shared_seed", "axes", "registries", "cells", "canonical_sha256"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(`manifest 包含未知字段：${key}`);
  if (value.version !== COMPARISON_EXPERIMENT_VERSION) add(`manifest.version 必须为 ${COMPARISON_EXPERIMENT_VERSION}`);
  if (value.kind !== "comparison_experiment") add("manifest.kind 必须为 comparison_experiment");
  if (typeof value.id !== "string" || !idPattern.test(value.id)) add("manifest.id 无效");
  if (typeof value.created_at !== "string" || !createdAtPattern.test(value.created_at) || Number.isNaN(Date.parse(value.created_at))) add("manifest.created_at 无效");
  if (!statusSet.has(value.status)) add("manifest.status 无效");
  if (value.shared_seed !== null && (!Number.isSafeInteger(value.shared_seed) || value.shared_seed < 0 || value.shared_seed > maxSeed)) add("manifest.shared_seed 无效");

  let axes = null;
  try { axes = normalizeAxes(value.axes); }
  catch (error) { add(error.message); }

  let registries = null;
  try { registries = normalizeRegistries(value.registries, axes); }
  catch (error) { add(error.message); }

  if (axes && ((axes.some((axis) => axis.type === "seed") && value.shared_seed !== null)
    || (!axes.some((axis) => axis.type === "seed") && !Number.isSafeInteger(value.shared_seed)))) {
    add("manifest.shared_seed 必须与 seed 轴存在性一致");
  }

  let cells = null;
  if (!Array.isArray(value.cells) || value.cells.length === 0) add("manifest.cells 必须是非空数组");
  else {
    cells = value.cells;
    const ids = new Set();
    const ordinals = new Set();
    const expectedKeys = new Set(axes?.map((axis) => axis.type) ?? []);
    for (const [index, cell] of cells.entries()) {
      const label = `manifest.cells[${index}]`;
      if (!isRecord(cell)) { add(`${label} 必须是对象`); continue; }
      const unknown = Object.keys(cell).filter((key) => !["id", "ordinal", "axis_values", "effective_seed", "status"].includes(key));
      unknown.forEach((key) => add(`${label} 包含未知字段：${key}`));
      if (typeof cell.id !== "string" || !/^cell-[a-f0-9]{64}$/.test(cell.id)) add(`${label}.id 无效`);
      else if (ids.has(cell.id)) add(`${label}.id 重复：${cell.id}`);
      else ids.add(cell.id);
      if (!Number.isSafeInteger(cell.ordinal) || cell.ordinal !== index || ordinals.has(cell.ordinal)) add(`${label}.ordinal 必须按 0 开始连续排列`);
      ordinals.add(cell.ordinal);
      if (!isRecord(cell.axis_values)) add(`${label}.axis_values 必须是对象`);
      else {
        const actualKeys = Object.keys(cell.axis_values);
        if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) add(`${label}.axis_values 必须恰好覆盖每个比较轴`);
        for (const axis of axes ?? []) {
          const valueId = cell.axis_values[axis.type];
          if (typeof valueId !== "string" || !axis.values.some((value) => value.value_id === valueId)) add(`${label}.axis_values.${axis.type} 不是该轴的 value_id`);
        }
      }
      if (!Number.isSafeInteger(cell.effective_seed) || cell.effective_seed < 0 || cell.effective_seed > maxSeed) add(`${label}.effective_seed 无效`);
    }
    if (axes) {
      try {
        const expectedCells = expandCells(axes, value.shared_seed);
        if (expectedCells.length !== cells.length) add("manifest.cells 不是完整笛卡尔积");
        else {
          for (let index = 0; index < cells.length; index += 1) {
            const actual = cells[index];
            const expected = expectedCells[index];
            if (!isRecord(actual)) continue;
            if (actual.id !== expected.id || actual.ordinal !== expected.ordinal
              || hashCanonicalJson(actual.axis_values) !== hashCanonicalJson(expected.axis_values)
              || actual.effective_seed !== expected.effective_seed) {
              add(`manifest.cells[${index}] 与轴值展开结果不一致`);
            }
          }
        }
      } catch (error) { add(error.message); }
    }
  }

  errors.push(...collectComparisonStatusErrors(value));

  if (axes && registries && cells && cells.every((cell) => isRecord(cell))) {
    try {
      const expectedIdentity = canonicalIdentityFor({
        version: value.version,
        id: value.id,
        created_at: value.created_at,
        shared_seed: value.shared_seed,
        axes,
        registries,
        cells,
      });
      if (value.canonical_sha256 !== hashCanonicalJson(expectedIdentity)) add("manifest.canonical_sha256 无效");
    } catch (error) {
      add(`manifest.canonical_sha256 无法重算：${error.message}`);
    }
  }

  return [...new Set(errors)];
}

/** 返回 manifest 的全部契约错误；合法 manifest 返回空数组。 */
export function validateComparisonExperimentManifest(value) {
  return collectComparisonExperimentErrors(value);
}

/** 校验并返回原 manifest；适合 API 或未来执行器作为冻结边界。 */
export function assertComparisonExperimentManifest(value) {
  const errors = collectComparisonExperimentErrors(value);
  if (errors.length) fail("invalid_comparison_manifest", "比较实验 manifest 校验失败", errors);
  return value;
}

export function validateComparisonExperimentStatus(value) {
  return collectComparisonStatusErrors(value);
}

/**
 * 从已校验 manifest 解析单个 cell 的最小执行选择。
 * 页面原有 LoRA 仍由后续页面编译作为 frozen base；这里仅返回独立 test layer。
 */
export function resolveComparisonCellSelection(manifest, cellOrId) {
  const verified = assertComparisonExperimentManifest(manifest);
  const cellId = typeof cellOrId === "string" ? cellOrId : cellOrId?.id;
  if (typeof cellId !== "string") fail("invalid_comparison_cell", "cellId 或 cell.id 必须是字符串");
  const cell = verified.cells.find((candidate) => candidate.id === cellId);
  if (!cell) fail("comparison_cell_not_found", `找不到比较实验 cell：${cellId}`);

  const axisByType = new Map(verified.axes.map((axis) => [axis.type, axis]));
  const pageAxis = axisByType.get("input");
  const pageValue = pageAxis.values.find((value) => value.value_id === cell.axis_values.input);
  const inputId = pageValue.value;

  const loraAxis = axisByType.get("lora_config");
  const weightAxis = axisByType.get("lora_weight");
  const characterWeightAxis = axisByType.get("character_lora_weight");
  const selectedLoraConfig = loraAxis
    ? verified.registries.lora_configs.find((entry) => entry.id === loraAxis.values.find((value) => value.value_id === cell.axis_values.lora_config)?.value)
    : null;
  const testLoraRef = selectedLoraConfig?.lora_ref ?? null;
  const testLora = testLoraRef === null
    ? null
    : verified.registries.loras.find((entry) => entry.id === testLoraRef) ?? null;
  const testLoraWeight = testLoraRef === null
    ? null
    : weightAxis.values.find((value) => value.value_id === cell.axis_values.lora_weight)?.value ?? null;
  const characterLoraWeight = characterWeightAxis
    ? characterWeightAxis.values.find((value) => value.value_id === cell.axis_values.character_lora_weight)?.value ?? null
    : null;

  const cfgAxis = axisByType.get("cfg");
  const cfg = cfgAxis
    ? cfgAxis.values.find((value) => value.value_id === cell.axis_values.cfg)?.value ?? null
    : null;
  const selection = {
    input_id: inputId,
    test_lora: testLora,
    test_lora_weight: testLoraWeight,
    character_lora_weight: characterLoraWeight,
    cfg,
    effective_seed: cell.effective_seed,
  };
  if (selectedLoraConfig?.application !== undefined) selection.application = clone(selectedLoraConfig.application);
  return clone(selection);
}

export function expandComparisonCells(axes, { sharedSeed = null } = {}) {
  const normalizedAxes = normalizeAxes(axes);
  const seedAxis = normalizedAxes.find((axis) => axis.type === "seed");
  if (!seedAxis && sharedSeed === null) fail("invalid_comparison_seed", "没有 seed 轴时必须提供 sharedSeed");
  if (seedAxis && sharedSeed !== null) fail("invalid_comparison_seed", "存在 seed 轴时 sharedSeed 必须为 null");
  return expandCells(normalizedAxes, sharedSeed);
}
