export const PROMPT_TYPES = Object.freeze(["danbooru", "custom_description"]);

export const PAGE_PROMPT_CATEGORIES = Object.freeze(["subject","person","setting","camera","avoid"]);

export const PAGE_POSITIVE_PROMPT_CATEGORIES = Object.freeze(PAGE_PROMPT_CATEGORIES.filter((category) => category !== "avoid"));

export const CHARACTER_PROMPT_CATEGORIES = Object.freeze([
  "identity",
  "hair",
  "face",
  "body",
  "clothing",
  "accessories",
  "equipment",
]);

export const PROMPT_POPULATION_TAGS = Object.freeze([
  ...["1girl", "2girls", "3girls", "4girls", "5girls"].map((prompt_text, index) => Object.freeze({ prompt_text, kind: "girls", minimum: index + 1 })),
  Object.freeze({ prompt_text: "6+girls", kind: "girls", minimum: 6 }),
  Object.freeze({ prompt_text: "multiple girls", kind: "girls", minimum: 2 }),
  ...["1boy", "2boys", "3boys", "4boys", "5boys"].map((prompt_text, index) => Object.freeze({ prompt_text, kind: "boys", minimum: index + 1 })),
  Object.freeze({ prompt_text: "6+boys", kind: "boys", minimum: 6 }),
  Object.freeze({ prompt_text: "multiple boys", kind: "boys", minimum: 2 }),
  ...["1other", "2others", "3others"].map((prompt_text, index) => Object.freeze({ prompt_text, kind: "others", minimum: index + 1 })),
  Object.freeze({ prompt_text: "multiple others", kind: "others", minimum: 2 }),
]);

export const DANBOORU_CATEGORY_BY_PROVIDER_TYPE = Object.freeze({
  "0": "general",
  "1": "artist",
  "3": "copyright",
  "4": "character",
  "5": "meta",
});

export const DANBOORU_ALLOWED_CATEGORIES = Object.freeze({
  page: Object.freeze(["general"]),
  character: Object.freeze(["general", "character", "copyright"]),
  render_profile: Object.freeze(["general", "meta"]),
  lora: Object.freeze(["general", "character"]),
});

export const PROMPT_AUDIT_CODES = Object.freeze({
  INVALID_FRAGMENT: "prompt.fragment.invalid",
  INVALID_TYPE: "prompt.fragment.type_invalid",
  EMPTY_TEXT: "prompt.fragment.text_empty",
  INVALID_WEIGHT: "prompt.fragment.weight_invalid",
  INLINE_WEIGHT: "prompt.fragment.inline_weight_forbidden",
  DANBOORU_NOT_FOUND: "prompt.danbooru.not_found",
  DANBOORU_ARTIST_FORBIDDEN: "prompt.danbooru.artist_forbidden",
  DANBOORU_CATEGORY_NOT_ALLOWED: "prompt.danbooru.category_not_allowed",
  POPULATION_TAG_TYPE_INVALID: "prompt.population.type_invalid",
  POPULATION_TAG_PLACEMENT_INVALID: "prompt.population.placement_invalid",
  POPULATION_TAG_ROLE_INVALID: "prompt.population.role_invalid",
  POPULATION_TAG_CONFLICT: "prompt.population.conflict",
  SOLO_CONFLICT: "prompt.population.solo_conflict",
  SOLO_COUNT_WARNING: "prompt.population.solo_count_warning",
  DUPLICATE_IN_SCOPE: "prompt.fragment.duplicate_in_scope",
  POSITIVE_AVOID_CONFLICT: "prompt.fragment.positive_avoid_conflict",
});

export function normalizePromptText(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

const populationTagByText = new Map(PROMPT_POPULATION_TAGS.map((tag) => [normalizePromptText(tag.prompt_text), tag]));

export function promptPopulationTag(value) {
  return populationTagByText.get(normalizePromptText(value)) ?? null;
}

export function isPromptPopulationControl(value) {
  return normalizePromptText(value) === "solo" || promptPopulationTag(value) !== null;
}

export function promptFragmentWeight(fragment) {
  return fragment?.weight === undefined ? 1 : fragment.weight;
}

export function promptFragmentRecord(fragment, metadata = {}) {
  return {
    fragment,
    path: metadata.path ?? "",
    source_kind: metadata.source_kind ?? "page",
    source_id: metadata.source_id ?? "",
    scope: metadata.scope ?? `${metadata.source_kind ?? "page"}:${metadata.source_id ?? ""}:${metadata.role ?? fragment?.role ?? "unbound"}`,
    category: metadata.category ?? "",
    role: metadata.role ?? fragment?.role,
    polarity: metadata.polarity ?? (metadata.category === "avoid" ? "negative" : "positive"),
  };
}
