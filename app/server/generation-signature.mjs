import { hashCanonicalJson } from "./workflow-definition.mjs";

// 只比较影响出图的条件；种子、文件名和展示名称不参与匹配。
export function generationConditions({ profile, recipe, workflow, canvas, item }) {
  const resolution = recipe?.resolutions?.[canvas];
  if (!profile?.models || !resolution || !workflow?.template_sha256 || !workflow?.manifest_sha256
    || typeof item?.positive_prompt !== "string" || typeof item?.negative_prompt !== "string") return null;
  const models = Object.fromEntries(Object.entries(profile.models).map(([role, model]) => [role, model.sha256]));
  const loras = (item.loras ?? []).map(lora => ({ sha256: lora.sha256, weight: lora.weight }));
  if (Object.values(models).some(sha => !sha) || loras.some(lora => !lora.sha256 || !Number.isFinite(lora.weight))
    || (item.reference_image && !item.reference_image.sha256)) return null;
  const { $schema, id, name, resolutions, dimensions, ...sampling } = recipe;
  return {
    version: 1,
    prompt: { positive: item.positive_prompt, negative: item.negative_prompt },
    models, loras,
    reference_image: item.reference_image?.sha256 ?? null,
    recipe: { ...sampling, resolution },
    workflow: { template_sha256: workflow.template_sha256, manifest_sha256: workflow.manifest_sha256 },
  };
}

export const conditionsSignature = conditions => conditions ? hashCanonicalJson(conditions) : null;

export function taskGenerationConditions(task, item) {
  const snapshot = task.snapshot, route = item.render_route;
  return generationConditions({ profile: snapshot?.profile, canvas: snapshot?.canvas,
    recipe: snapshot?.recipes?.[route?.recipe_instance_id]?.parameters,
    workflow: snapshot?.workflows?.[route?.workflow_id], item });
}

export const taskGenerationSignature = (task, item) => conditionsSignature(taskGenerationConditions(task, item));

export function inspectionGenerationConditions(context) {
  // 冲突时 active_profile 仅是基础配置预览，不代表用户的实际生成条件。
  if (context.compiled_profile?.blocked) return null;
  if (context.snapshot.page_prompt.reference_image && !context.reference_image) return null;
  return generationConditions({ profile: context.active_profile, canvas: context.project.canvas,
    recipe: context.candidate_recipe, workflow: context.candidate_workflow,
    item: { ...context.compiled_page, reference_image: context.reference_image } });
}

export const inspectionGenerationSignature = context => conditionsSignature(inspectionGenerationConditions(context));
