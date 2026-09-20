import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARISON_AXIS_TYPES,
  COMPARISON_EXPERIMENT_STATUSES,
  assertComparisonExperimentManifest,
  createComparisonExperiment,
  resolveComparisonCellSelection,
  validateComparisonExperimentManifest,
  validateComparisonExperimentStatus,
} from "../server/comparison-experiment.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";

const storyPage = "sample-story";
const characterPage = "sample-character";
const frozenResourceOne = {
  id: "resource-one",
  kind: "raw",
  relative_path: "loras/comparison/one.safetensors",
  sha256: "1".repeat(64),
  size_bytes: 101,
  metadata: { format: "pt" },
};
const frozenResourceTwo = {
  id: "resource-two",
  kind: "raw",
  relative_path: "loras/comparison/two.safetensors",
  sha256: "2".repeat(64),
  size_bytes: 202,
  metadata: { format: "pt" },
};

function axesWithoutSeed() {
  return [
    {
      type: "cfg",
      values: [
        { value_id: "cfg-4", label: "CFG 4", value: 4 },
        { value_id: "cfg-6", label: "CFG 6", value: 6 },
      ],
    },
    {
      type: "input",
      values: [
        { value_id: "story-page", label: "剧情页", value: storyPage },
        { value_id: "character-page", label: "角色页", value: characterPage },
      ],
    },
    {
      type: "lora_config",
      values: [{ value_id: "baseline-config", label: "基线", value: "baseline" }],
    },
    {
      type: "lora_weight",
      values: [{ value_id: "weight-0", label: "不使用", value: 0 }],
    },
  ];
}

function create(input = {}) {
  return createComparisonExperiment({
    id: "comparison-111111111111",
    created_at: "2026-08-24T00:00:00.000Z",
    axes: axesWithoutSeed(),
    registries: { loras: [], lora_configs: [{ id: "baseline", label: "基线", lora_ref: null }] },
    randomSeed: () => 42,
    ...input,
  });
}

function registryExperiment({ loraOneLabel = "LoRA 一" } = {}) {
  return create({
    axes: [
      {
        type: "input",
        values: [
          { value_id: "story-page", label: "剧情页", value: storyPage },
          { value_id: "character-page", label: "角色页", value: characterPage },
        ],
      },
      {
        type: "lora_config",
        values: [
          { value_id: "baseline-config", label: "基线", value: "baseline" },
          { value_id: "lora-one-config", label: "LoRA 一", value: "lora-one" },
          { value_id: "lora-two-config", label: "LoRA 二", value: "lora-two" },
        ],
      },
      {
        type: "lora_weight",
        values: [
          { value_id: "weight-00", label: "0", value: 0 },
          { value_id: "weight-08", label: "0.8", value: 0.8 },
        ],
      },
      { type: "cfg", values: [{ value_id: "cfg-7", label: "CFG 7", value: 7 }] },
    ],
    registries: {
      loras: [frozenResourceOne, frozenResourceTwo],
      lora_configs: [
        { id: "baseline", label: "基线", lora_ref: null },
        { id: "lora-one", label: loraOneLabel, lora_ref: "resource-one" },
        { id: "lora-two", label: "LoRA 二", lora_ref: "resource-two" },
      ],
    },
  });
}

test("比较实验固定轴顺序并展开完整笛卡尔积，混合冻结剧情与角色 PageKey", () => {
  const manifest = create();
  assert.deepEqual(manifest.axes.map((axis) => axis.type), ["input", "lora_config", "lora_weight", "cfg"]);
  assert.equal(manifest.cells.length, 4);
  assert.deepEqual(manifest.cells.map((cell) => cell.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(manifest.cells.map((cell) => cell.axis_values), [
    { input: "story-page", lora_config: "baseline-config", lora_weight: "weight-0", cfg: "cfg-4" },
    { input: "story-page", lora_config: "baseline-config", lora_weight: "weight-0", cfg: "cfg-6" },
    { input: "character-page", lora_config: "baseline-config", lora_weight: "weight-0", cfg: "cfg-4" },
    { input: "character-page", lora_config: "baseline-config", lora_weight: "weight-0", cfg: "cfg-6" },
  ]);
  assert.deepEqual(manifest.axes[0].values.map((value) => value.value), [storyPage, characterPage]);
  assert.equal(manifest.cells.every((cell) => cell.effective_seed === 42), true);
  assert.deepEqual(validateComparisonExperimentManifest(manifest), []);
});

test("同一冻结输入产生稳定 cell ID 与 canonical hash，篡改会被 validator 拒绝", () => {
  const first = create();
  const second = create();
  assert.deepEqual(first.cells.map((cell) => cell.id), second.cells.map((cell) => cell.id));
  assert.equal(first.canonical_sha256, second.canonical_sha256);
  assert.equal(first.cells.every((cell) => /^cell-[a-f0-9]{64}$/.test(cell.id)), true);
  assert.equal(first.canonical_sha256, hashCanonicalJson({
    version: first.version,
    id: first.id,
    created_at: first.created_at,
    shared_seed: first.shared_seed,
    axes: first.axes,
    registries: first.registries,
    cells: first.cells.map(({ id, ordinal, axis_values, effective_seed }) => ({ id, ordinal, axis_values, effective_seed })),
  }));

  const tampered = structuredClone(first);
  tampered.cells[0].effective_seed = 43;
  assert.notDeepEqual(validateComparisonExperimentManifest(tampered), []);
  assert.throws(() => assertComparisonExperimentManifest(tampered), /校验失败/);

  const tamperedHash = structuredClone(first);
  tamperedHash.id = "comparison-222222222222";
  assert.notDeepEqual(validateComparisonExperimentManifest(tamperedHash), []);

  const statusChanged = structuredClone(first);
  statusChanged.status = "running";
  statusChanged.cells[0].status = "running";
  assert.equal(statusChanged.canonical_sha256, first.canonical_sha256);
});

test("没有 seed 轴时随机种子工厂只调用一次，并作为所有 cell 的共享 seed", () => {
  let calls = 0;
  const manifest = create({ randomSeed: () => { calls += 1; return 2 ** 31 - 1; } });
  assert.equal(calls, 1);
  assert.equal(manifest.shared_seed, 2 ** 31 - 1);
  assert.equal(new Set(manifest.cells.map((cell) => cell.effective_seed)).size, 1);
});

test("有 seed 轴时不调用随机工厂，seed value 覆盖共享 seed", () => {
  let calls = 0;
  const manifest = create({
    randomSeed: () => { calls += 1; return 19; },
    axes: [
      ...axesWithoutSeed(),
      { type: "seed", values: [
        { value_id: "seed-7", label: "Seed 7", value: 7 },
        { value_id: "seed-8", label: "Seed 8", value: 8 },
      ] },
    ],
  });
  assert.equal(calls, 0);
  assert.equal(manifest.shared_seed, null);
  assert.deepEqual([...new Set(manifest.cells.map((cell) => cell.effective_seed))], [7, 8]);
});

test("严格拒绝重复轴、重复值、空轴、非法 PageKey、非法 seed 与未验证深 payload", () => {
  const cases = [
    ["重复轴", { axes: [...axesWithoutSeed(), { type: "input", values: [{ value_id: "another", label: "另一个", value: storyPage }] }] }],
    ["重复值", { axes: axesWithoutSeed().map((axis) => axis.type === "cfg" ? { ...axis, values: [axis.values[0], axis.values[0]] } : axis) }],
    ["空轴", { axes: axesWithoutSeed().map((axis) => axis.type === "input" ? { ...axis, values: [] } : axis) }],
    ["非法 PageKey", { axes: axesWithoutSeed().map((axis) => axis.type === "input" ? { ...axis, values: [{ value_id: "bad", label: "坏页面", page_key: { owner_kind: "story", owner_id: "not-story", page_id: "page-001" } }] } : axis) }],
    ["越界 seed", { axes: [...axesWithoutSeed(), { type: "seed", values: [{ value_id: "bad-seed", label: "坏 seed", value: 2 ** 31 }] }] }],
    ["深 payload", { axes: axesWithoutSeed().map((axis) => axis.type === "cfg" ? { ...axis, values: [{ ...axis.values[0], value: { nested: true } }] } : axis) }],
  ];
  for (const [label, input] of cases) assert.throws(() => create(input), label);
});

test("状态只允许 queued/running/completed/incomplete，且终态与 cell 状态自洽", () => {
  assert.deepEqual(COMPARISON_EXPERIMENT_STATUSES, ["queued", "running", "completed", "incomplete"]);
  assert.deepEqual(COMPARISON_AXIS_TYPES, ["input", "lora_config", "character_lora_weight", "lora_weight", "seed", "cfg"]);
  const running = create();
  running.status = "running";
  running.cells[0].status = "running";
  assert.deepEqual(validateComparisonExperimentManifest(running), []);

  const completed = create();
  completed.status = "completed";
  completed.cells.forEach((cell) => { cell.status = "completed"; });
  assert.deepEqual(validateComparisonExperimentManifest(completed), []);

  const incomplete = create();
  incomplete.status = "incomplete";
  incomplete.cells.forEach((cell, index) => { cell.status = index === 0 ? "incomplete" : "completed"; });
  assert.deepEqual(validateComparisonExperimentManifest(incomplete), []);

  const invalid = create();
  invalid.status = "paused";
  assert.notDeepEqual(validateComparisonExperimentManifest(invalid), []);
  assert.notDeepEqual(validateComparisonExperimentStatus(invalid), []);
  for (const malformed of [
    (() => { const value = create(); delete value.cells; return value; })(),
    { ...create(), cells: null },
    { ...create(), cells: [] },
  ]) assert.notDeepEqual(validateComparisonExperimentStatus(malformed), []);
  const invalidTerminal = create();
  invalidTerminal.status = "completed";
  invalidTerminal.cells[0].status = "running";
  assert.notDeepEqual(validateComparisonExperimentManifest(invalidTerminal), []);
});

test("cfg 轴遵循 render recipe 边界，registry reference 只接受稳定 ID", () => {
  for (const cfg of [0, 30.1]) {
    assert.throws(() => create({ axes: axesWithoutSeed().map((axis) => axis.type === "cfg"
      ? { ...axis, values: [{ ...axis.values[0], value: cfg }] }
      : axis) }));
  }
  assert.doesNotThrow(() => create({ axes: axesWithoutSeed().map((axis) => axis.type === "cfg"
    ? { ...axis, values: [{ ...axis.values[0], value: 30 }] }
    : axis) }));
  assert.throws(() => create({ axes: [...axesWithoutSeed(), { type: "lora_config", values: [{ value_id: "bad", label: "坏引用", value: "任意文本/不是 ID" }] }] }));
});

test("registry 支持 baseline 与多个测试 LoRA，weight 只解析到 test layer", () => {
  const manifest = registryExperiment();
  assert.equal(manifest.registries.lora_configs.length, 3);
  const baselineCell = manifest.cells.find((cell) => cell.axis_values.lora_config === "baseline-config");
  const testCell = manifest.cells.find((cell) => cell.axis_values.lora_config === "lora-two-config"
    && cell.axis_values.lora_weight === "weight-08");
  assert.deepEqual(resolveComparisonCellSelection(manifest, baselineCell.id), {
    input_id: storyPage,
    test_lora: null,
    test_lora_weight: null,
    character_lora_weight: null,
    cfg: 7,
    effective_seed: 42,
  });
  const testSelection = resolveComparisonCellSelection(manifest, testCell);
  assert.deepEqual(testSelection.test_lora, frozenResourceTwo);
  testSelection.test_lora.metadata.format = "tampered";
  assert.equal(resolveComparisonCellSelection(manifest, testCell).test_lora.metadata.format, "pt");
  assert.equal(resolveComparisonCellSelection(manifest, testCell).test_lora_weight, 0.8);
  const baselineCells = manifest.cells.filter((cell) => cell.axis_values.lora_config === "baseline-config");
  assert.equal(baselineCells.length > 1, true);
  for (const cell of baselineCells) {
    const selection = resolveComparisonCellSelection(manifest, cell);
    assert.equal(selection.test_lora, null);
    assert.equal(selection.test_lora_weight, null);
  }
});

test("角色 LoRA 权重轴与测试 LoRA 权重轴分别解析", () => {
  const manifest = create({
    axes: [
      { type: "input", values: [{ value_id: "input", label: "角色页", value: characterPage }] },
      { type: "lora_config", values: [{ value_id: "style", label: "画风", value: "style" }] },
      { type: "character_lora_weight", values: [{ value_id: "character-05", label: "角色 0.5", value: 0.5 }] },
      { type: "lora_weight", values: [{ value_id: "style-10", label: "画风 1.0", value: 1 }] },
    ],
    registries: {
      loras: [frozenResourceOne],
      lora_configs: [{ id: "style", label: "画风", lora_ref: "resource-one" }],
    },
  });
  assert.deepEqual(manifest.axes.map((axis) => axis.type), ["input", "lora_config", "character_lora_weight", "lora_weight"]);
  const selection = resolveComparisonCellSelection(manifest, manifest.cells[0]);
  assert.equal(selection.character_lora_weight, 0.5);
  assert.equal(selection.test_lora_weight, 1);
  assert.equal(selection.test_lora.id, "resource-one");
});

test("registry 交叉引用和轴关系严格校验", () => {
  const baseAxes = [
    { type: "input", values: [{ value_id: "story-page", label: "剧情页", value: storyPage }] },
    { type: "lora_config", values: [{ value_id: "baseline-config", label: "基线", value: "baseline" }] },
  ];
  assert.throws(() => create({
    axes: baseAxes,
    registries: { loras: [], lora_configs: [] },
  }), /lora_configs/);
  assert.throws(() => create({
    axes: baseAxes,
    registries: { loras: [], lora_configs: [{ id: "unused", label: "未引用", lora_ref: null }] },
  }), /lora_configs/);
  assert.throws(() => create({
    axes: [baseAxes[0], { type: "lora_config", values: [{ value_id: "missing-config", label: "悬空", value: "missing" }] }],
    registries: { loras: [], lora_configs: [{ id: "baseline", label: "基线", lora_ref: null }] },
  }), /lora_config/);
  assert.throws(() => create({
    axes: [baseAxes[0], { type: "lora_config", values: [{ value_id: "test-config", label: "测试", value: "test" }] }],
    registries: {
      loras: [],
      lora_configs: [{ id: "test", label: "测试", lora_ref: "missing-lora" }],
    },
  }), /lora_ref|loras/);
  assert.throws(() => create({
    axes: [baseAxes[0], { type: "lora_config", values: [{ value_id: "baseline-config", label: "基线", value: "baseline" }] }],
    registries: {
      loras: [frozenResourceOne],
      lora_configs: [{ id: "baseline", label: "基线", lora_ref: null }],
    },
  }), /loras/);
  assert.throws(() => create({
    axes: [baseAxes[0], { type: "lora_weight", values: [{ value_id: "w", label: "0.8", value: 0.8 }] }],
    registries: { loras: [], lora_configs: [] },
  }), /lora_weight/);
  assert.throws(() => create({
    axes: [baseAxes[0], { type: "lora_config", values: [{ value_id: "test-config", label: "测试", value: "test" }] }],
    registries: { loras: [{ ...frozenResourceOne, id: "resource" }], lora_configs: [{ id: "test", label: "测试", lora_ref: "resource" }] },
  }), /lora_weight/);
});

test("registry 内容参与 manifest hash，cell 身份只取轴 value_id；resolver 结果是防御性副本", () => {
  const first = registryExperiment();
  const second = registryExperiment({ loraOneLabel: "LoRA 一（新标签）" });
  assert.deepEqual(first.cells.map((cell) => cell.id), second.cells.map((cell) => cell.id));
  assert.notEqual(first.canonical_sha256, second.canonical_sha256);

  const selection = resolveComparisonCellSelection(first, first.cells[2]);
  selection.input_id = "changed";
  assert.equal(first.axes[0].values[0].value, storyPage);
  assert.equal(resolveComparisonCellSelection(first, first.cells[2]).input_id, storyPage);

  const tampered = structuredClone(first);
  tampered.registries.lora_configs[1].lora_ref = "resource-tampered";
  assert.notDeepEqual(validateComparisonExperimentManifest(tampered), []);
  assert.throws(() => assertComparisonExperimentManifest(tampered), /校验失败/);
  const tamperedIdentity = structuredClone(first);
  tamperedIdentity.registries.loras[0].sha256 = "f".repeat(64);
  assert.match(validateComparisonExperimentManifest(tamperedIdentity).join("\n"), /canonical_sha256|sha256/);
});

test("malformed manifest 的 canonical hash 重算不会把原始 hash 错误抛出", () => {
  const malformed = structuredClone(registryExperiment());
  delete malformed.created_at;
  malformed.cells[0].effective_seed = undefined;
  let errors;
  assert.doesNotThrow(() => { errors = validateComparisonExperimentManifest(malformed); });
  assert.equal(Array.isArray(errors), true);
  assert.notDeepEqual(errors, []);
});
