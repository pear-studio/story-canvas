const comparisonAxisLabels: Record<string, string> = {
  input: "测试输入",
  lora_config: "风格 LoRA",
  character_lora_weight: "角色 LoRA 权重",
  lora_weight: "风格 LoRA 权重",
  seed: "Seed",
  cfg: "CFG",
};

export function comparisonAxisLabel(type: string) {
  return comparisonAxisLabels[type] ?? type;
}
