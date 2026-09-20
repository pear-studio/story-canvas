function promptPart(value, polarity, index) {
  if (typeof value === "string") {
    return {
      category: polarity === "negative" ? "avoid" : null,
      role: null,
      prompt_type: null,
      prompt_text: value,
      weight: 1,
      origin: "visual",
      origin_id: null,
      polarity,
      path: `prompt_parts.${polarity}[${index}]`,
      text: value,
    };
  }
  if (!value || typeof value !== "object") return null;
  const text = typeof value.text === "string"
    ? value.text
    : typeof value.prompt_text === "string" ? value.prompt_text : "";
  return {
    ...structuredClone(value),
    category: typeof value.category === "string" ? value.category : null,
    role: typeof value.role === "string" ? value.role : null,
    prompt_type: typeof value.prompt_type === "string" ? value.prompt_type : null,
    prompt_text: typeof value.prompt_text === "string" ? value.prompt_text : text,
    weight: typeof value.weight === "number" ? value.weight : 1,
    origin: typeof value.origin === "string" ? value.origin : "visual",
    origin_id: typeof value.origin_id === "string" ? value.origin_id : null,
    polarity,
    path: typeof value.path === "string" ? value.path : `prompt_parts.${polarity}[${index}]`,
    text,
  };
}

function promptParts(value, polarity) {
  const source = Array.isArray(value?.[polarity]) ? value[polarity] : [];
  return source.map((part, index) => promptPart(part, polarity, index)).filter(Boolean);
}

function triggerForLora(lora, parts) {
  if (typeof lora.trigger === "string" && lora.trigger.trim()) return lora.trigger.trim();
  const owner = typeof lora.owner === "string" ? lora.owner : null;
  if (!owner) return null;
  const trigger = parts
    .filter((part) => part.origin === "lora_trigger" && part.origin_id === owner)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join(", ");
  return trigger || null;
}

export function generationDetailsProjection({ profile = null, models = null, recipe = null, prompt = null, promptParts: rawPromptParts = null, canvas = null, loras = [] }) {
  const positiveParts = promptParts(rawPromptParts, "positive");
  const negativeParts = promptParts(rawPromptParts, "negative");
  const allParts = [...positiveParts, ...negativeParts];
  const dimensions = recipe?.dimensions ?? (typeof canvas === "string" ? recipe?.resolutions?.[canvas] : null);
  return {
    prompt_mode: rawPromptParts?.mode === "free" ? "free" : "structured",
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
      kind: typeof lora.kind === "string" ? lora.kind : "character",
      owner: typeof lora.owner === "string" ? lora.owner : "",
      filename: lora.filename,
      weight: typeof lora.weight === "number" ? lora.weight : null,
      trigger: triggerForLora(lora, allParts),
    }] : []),
    prompt: {
      positive: typeof prompt?.positive === "string" ? prompt.positive : "",
      negative: typeof prompt?.negative === "string" ? prompt.negative : "",
      separator: typeof rawPromptParts?.separator === "string" ? rawPromptParts.separator : ", ",
      parts: { positive: positiveParts, negative: negativeParts },
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
      promptParts: detail?.prompt_parts,
      canvas: detail?.canvas,
      loras: detail?.loras,
    }),
  };
}
