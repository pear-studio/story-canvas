import { hashCanonicalJson } from "./workflow-definition.mjs";

export function candidateGenerationDetail(task, item) {
  const snapshot = task.snapshot ?? null;
  const profile = snapshot?.profile ?? null;
  const executionUnit = snapshot?.execution_units?.find((unit) => unit?.item_ids?.includes(item.id)) ?? null;
  const route = structuredClone(executionUnit?.render_route ?? item.render_route ?? null);
  const recipe = executionUnit?.recipe?.resolved_parameters
    ?? (route?.recipe_instance_id ? snapshot?.recipes?.[route.recipe_instance_id] : null)
    ?? null;
  const frozenOutput = executionUnit?.outputs?.find((output) => output.item_id === item.id) ?? null;
  const frozenSeed = executionUnit?.extra_data?.extra_pnginfo?.storyvisualizer?.outputs
    ?.find((output) => output.item_id === item.id) ?? null;
  const workflowSnapshot = executionUnit?.workflow
    ?? (route?.workflow_id ? snapshot?.workflows?.[route.workflow_id] : null)
    ?? null;
  const prompt = {
    positive: typeof item.positive_prompt === "string" ? item.positive_prompt : "",
    negative: typeof item.negative_prompt === "string" ? item.negative_prompt : "",
  };
  const recipeSourceIdentity = executionUnit?.recipe?.source_id
    ? snapshot?.source_identity?.recipes?.[executionUnit.recipe.source_id] ?? null
    : null;
  return {
    page_key: structuredClone(item.page_key),
    candidate_id: item.candidate_id,
    status: "available",
    task_id: task.id,
    created_at: task.created_at ?? null,
    completed_at: item.generated_at ?? task.completed_at ?? null,
    seed: Number.isSafeInteger(item.seed) ? item.seed : null,
    execution_seed: frozenSeed && Number.isInteger(frozenOutput?.image_index) ? {
      declared_seed: frozenSeed.declared_seed,
      effective_seed: frozenSeed.effective_seed,
      output_index: frozenOutput.image_index,
      batch_size: executionUnit.item_ids.length,
    } : null,
    prompt: { ...prompt, sha256: hashCanonicalJson(prompt) },
    prompt_parts: structuredClone(item.prompt_parts ?? null),
    canvas: typeof snapshot?.canvas === "string" ? snapshot.canvas : null,
    render_profile: profile ? {
      id: String(profile.id ?? task.render_profile ?? ""),
      name: String(profile.name ?? task.render_profile ?? ""),
      prompt_family: profile.prompt?.family ?? null,
      effective_profile_sha256: snapshot?.effective_profile_sha256 ?? null,
    } : null,
    models: profile ? Object.entries(profile.models ?? {}).map(([role, model]) => ({ role, ...structuredClone(model) })) : [],
    loras: structuredClone(item.loras ?? []),
    render_route: route,
    recipe: recipe ? structuredClone(recipe) : null,
    workflow: workflowSnapshot ? {
      id: workflowSnapshot.source_id ?? workflowSnapshot.id,
      template_sha256: workflowSnapshot.template_sha256,
      manifest_sha256: workflowSnapshot.manifest_sha256,
      canonical_sha256: workflowSnapshot.canonical_sha256 ?? null,
    } : null,
    execution_unit: executionUnit ? {
      id: executionUnit.id,
      item_ids: structuredClone(executionUnit.item_ids),
      batch: Boolean(executionUnit.batch),
      canonical_sha256: executionUnit.canonical_sha256,
      recipe: { ...structuredClone(executionUnit.recipe), source_file_sha256: recipeSourceIdentity?.sha256 ?? null },
      workflow: structuredClone(executionUnit.workflow),
      outputs: structuredClone(executionUnit.outputs ?? []),
    } : null,
    asset_policy: {
      backup: false,
      description: "图片与控制资产只记录生成时的路径和 SHA-256，不额外备份；源资产改变或丢失后不能保证完整复现。",
    },
  };
}
