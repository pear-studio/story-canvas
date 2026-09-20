import recipe from "../../library/generation-experiments/anima-base-depth-v1.json" with { type: "json" };
import { hashCanonicalJson } from "./workflow-definition.mjs";

// 固定实验配方；变更时已有任务仍使用冻结的参数和完整工作流。
export const depthRecipe = Object.freeze(recipe);

export function validateTwoStep(value) {
  if (value === undefined) return [];
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["two_step 必须是对象"];
  if (Object.keys(value).some(key => !["enabled", "strength", "draft"].includes(key))) errors.push("two_step 包含未知字段");
  if (typeof value.enabled !== "boolean") errors.push("two_step.enabled 必须是布尔值");
  if (!Number.isFinite(value.strength) || value.strength < 0 || value.strength > 1) errors.push("深度控制强度必须在 0 到 1 之间");
  if (value.draft !== undefined) {
    const draft = value.draft;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)
      || Object.keys(draft).some(key => !["positive", "base_sha256"].includes(key))
      || typeof draft.positive !== "string" || !/^[a-f0-9]{64}$/.test(draft.base_sha256 ?? "")) errors.push("草稿 Prompt 或来源指纹无效");
  }
  return errors;
}

export function attachTwoStep(compiled, options, profile) {
  const supported = profile?.models?.dit?.sha256 === depthRecipe.base_sha256;
  const base = { positive: compiled.positive_prompt, base_sha256: hashCanonicalJson(compiled.positive_prompt) };
  const conflict = Boolean(options?.draft && options.draft.base_sha256 !== base.base_sha256);
  const errors = validateTwoStep(options);
  if (options?.enabled) {
    if (!supported) errors.push("两步生成实验仅支持 Anima Base v1.0");
    if (conflict) errors.push("草稿来源已变化，请重置或确认保留草稿");
    if (!(options.draft?.positive ?? base.positive).trim()) errors.push("草稿正向 Prompt 为空");
  }
  return { ...compiled, errors: [...compiled.errors, ...errors], ready: compiled.ready && !errors.length,
    draft_base: base, two_step_supported: supported,
    ...(options?.enabled ? { two_step: { recipe: { ...depthRecipe }, strength: options.strength,
      base_model: { ...profile.models.dit },
      positive: options.draft?.positive ?? base.positive, negative: compiled.negative_prompt,
      base_sha256: base.base_sha256,
      loras: Object.keys(profile.style_loras ?? {}).sort().map(key => ({ ...profile.style_loras[key] })),
    } } : {}),
  };
}

export function expandDepthWorkflow(workflow, item) {
  const config = item.two_step;
  if (!config) return workflow;
  const entries = Object.entries(workflow);
  const find = type => {
    const matches = entries.filter(([, node]) => node.class_type === type);
    if (matches.length !== 1) throw new Error(`两步生成需要唯一的 ${type} 节点`);
    return matches[0];
  };
  const [baseId] = find("UNETLoader");
  const [samplerId, sampler] = find("KSampler");
  const [vaeId] = find("VAELoader");
  const [saveId, save] = find("SaveImage");
  let next = Math.max(...entries.map(([id]) => Number(id))) + 1;
  const add = (class_type, inputs) => { const id = String(next++); workflow[id] = { class_type, inputs }; return [id, 0]; };
  // 在基础模型处分叉，草稿不继承最终分支的角色/自定义 LoRA。
  let draftModel = add("ModelSamplingAuraFlow", { model: [baseId, 0], shift: config.recipe.shift });
  for (const lora of config.loras) draftModel = add("LoraLoaderModelOnly", { model: draftModel, lora_name: lora.filename, strength_model: lora.weight });
  const clip = workflow[sampler.inputs.positive[0]].inputs.clip;
  const positive = add("CLIPTextEncode", { clip, text: config.positive });
  const negative = add("CLIPTextEncode", { clip, text: config.negative });
  const latent = add("KSampler", { ...sampler.inputs, model: draftModel, positive, negative, seed: config.seed, steps: config.recipe.steps });
  const draft = add("VAEDecode", { samples: latent, vae: [vaeId, 0] });
  add("SaveImage", { images: draft, filename_prefix: `${save.inputs.filename_prefix}/draft` });
  const empty = workflow[sampler.inputs.latent_image[0]].inputs;
  const depth = add("DepthAnythingV2Preprocessor", { image: draft, ckpt_name: config.recipe.preprocessor, resolution: Math.min(empty.width, empty.height) });
  add("SaveImage", { images: depth, filename_prefix: `${save.inputs.filename_prefix}/depth` });
  const control = add("ACN_ControlNetLoaderAdvanced", { cnet: config.recipe.controlnet });
  const conditioning = add("ACN_AdvancedControlNetApply_v2", { positive: sampler.inputs.positive, negative: sampler.inputs.negative,
    control_net: control, image: depth, strength: config.strength, start_percent: 0, end_percent: 1, vae_optional: [vaeId, 0] });
  workflow[samplerId].inputs = { ...sampler.inputs,
    model: add("ModelSamplingAuraFlow", { model: sampler.inputs.model, shift: config.recipe.shift }),
    positive: conditioning, negative: [conditioning[0], 1],
  };
  // 原 SaveImage 仍是最终候选的唯一输出绑定。
  workflow[saveId] = save;
  return workflow;
}

export function depthIntermediateOutputs(workflow, item) {
  if (!item.two_step) return [];
  return ["draft", "depth"].map(kind => {
    const [nodeId] = Object.entries(workflow).find(([, node]) => node.class_type === "SaveImage" && node.inputs.filename_prefix.endsWith(`/${kind}`));
    return { node_id: nodeId, image_index: 0, item_id: item.id, kind,
      file: `Outputs/tasks/${item.task}/${item.candidate_id}/${kind}.png` };
  });
}

export async function checkDepthNodes(apiUrl, config) {
  const required = ["ModelSamplingAuraFlow", "DepthAnythingV2Preprocessor", "ACN_ControlNetLoaderAdvanced", "ACN_AdvancedControlNetApply_v2"];
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/object_info`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("无法检查两步生成依赖：ComfyUI object_info 不可用");
  const info = await response.json();
  const missing = required.filter(name => !info[name]);
  const controls = info.ACN_ControlNetLoaderAdvanced?.input?.required?.cnet?.[0];
  if (!Array.isArray(controls) || !controls.includes(config.recipe.controlnet)) missing.push(config.recipe.controlnet);
  if (missing.length) throw new Error(`两步生成缺少依赖：${missing.join("、")}`);
}
