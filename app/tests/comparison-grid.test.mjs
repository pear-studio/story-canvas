import assert from "node:assert/strict";
import test from "node:test";

import { comparisonAxisLabel } from "../src/comparison-grid.ts";

test("对比网格使用面向用户的轴名称", () => {
  assert.equal(comparisonAxisLabel("lora_config"), "风格 LoRA");
  assert.equal(comparisonAxisLabel("character_lora_weight"), "角色 LoRA 权重");
  assert.equal(comparisonAxisLabel("lora_weight"), "风格 LoRA 权重");
  assert.equal(comparisonAxisLabel("seed"), "Seed");
  assert.equal(comparisonAxisLabel("unknown_axis"), "unknown_axis");
});
