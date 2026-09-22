function triggerForLora(lora) {
  return typeof lora?.trigger === "string" && lora.trigger.trim() ? lora.trigger.trim() : null;
}

export function generationDetailsProjection({ profile = null, models = null, recipe = null, prompt = null, sections = null, canvas = null, loras = [] }) {
  const dimensions = recipe?.dimensions ?? (typeof canvas === "string" ? recipe?.resolutions?.[canvas] : null);
  return {
    profile_name: typeof profile?.name === "string" && profile.name ? profile.name : null,
    canvas: typeof canvas === "string" && canvas ? canvas : null,
    parameters: recipe && typeof recipe === "object" ? {
      dimensions: dimensions && typeof dimensions === "object" ? {
        width: Number.isFinite(dimensions.width) ? dimensions.width : null,
        height: Number.isFinite(dimensions.height) ? dimensions.height : null,
      } : null,
      steps: Number.isFinite(recipe.steps) ? recipe.steps : null,
      cfg: Number.isFinite(recipe.cfg) ? recipe.cfg : null,
      sampler: typeof recipe.sampler === "string" ? recipe.sampler : null,
      scheduler: typeof recipe.scheduler === "string" ? recipe.scheduler : null,
    } : null,
    models: Array.isArray(models)
      ? models.flatMap((model) => typeof model?.filename === "string" ? [{ role: typeof model.role === "string" ? model.role : "model", filename: model.filename }] : [])
      : profile && typeof profile.models === "object" && profile.models
        ? Object.entries(profile.models).flatMap(([role, model]) => typeof model?.filename === "string" ? [{ role, filename: model.filename }] : [])
        : [],
    loras: (Array.isArray(loras) ? loras : []).flatMap((lora) => typeof lora?.filename === "string" ? [{
      kind: typeof lora.kind === "string" ? lora.kind : "style",
      owner: typeof lora.owner === "string" ? lora.owner : "",
      filename: lora.filename,
      weight: typeof lora.weight === "number" ? lora.weight : null,
      trigger: triggerForLora(lora),
    }] : []),
    prompt: {
      positive: typeof prompt?.positive === "string" ? prompt.positive : "",
      negative: typeof prompt?.negative === "string" ? prompt.negative : "",
      sections: structuredClone(Array.isArray(sections) ? sections : []),
    },
  };
}

export function candidateDetailProjection(detail) {
  const seed = Number.isSafeInteger(detail?.execution_seed?.effective_seed)
    ? detail.execution_seed.effective_seed
    : Number.isSafeInteger(detail?.seed) ? detail.seed : null;
  return {
    candidate_id: typeof detail?.candidate_id === "string" ? detail.candidate_id : "",
    created_at: typeof detail?.created_at === "string" ? detail.created_at : null,
    completed_at: typeof detail?.completed_at === "string" ? detail.completed_at : null,
    seed,
    generation: generationDetailsProjection({
      profile: detail?.render_profile,
      models: detail?.models,
      recipe: detail?.recipe,
      prompt: detail?.prompt,
      sections: detail?.prompt_parts?.sections,
      canvas: detail?.canvas,
      loras: detail?.loras,
    }),
  };
}
