// 独立查询词库自有的分类常量；渲染路径已不再消费词库。
export const PAGE_PROMPT_CATEGORIES = Object.freeze(["subject", "person", "setting", "camera", "avoid"]);

export const CHARACTER_PROMPT_CATEGORIES = Object.freeze([
  "identity",
  "hair",
  "face",
  "body",
  "clothing",
  "accessories",
  "equipment",
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

export function normalizePromptText(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

const SEARCH_EVIDENCE = Symbol("promptDictionarySearchEvidence");
const PROVIDER_CATEGORY = Symbol("promptDictionaryProviderCategory");

export const PROMPT_DICTIONARY_SCOPES = Object.freeze(Object.keys(DANBOORU_ALLOWED_CATEGORIES));

export function isPromptDictionaryScope(value) {
  return PROMPT_DICTIONARY_SCOPES.includes(value);
}

function requirePromptDictionaryScope(scope) {
  if (!isPromptDictionaryScope(scope)) throw new TypeError(`未知 Prompt 词库作用域：${scope ?? ""}`);
  return new Set(DANBOORU_ALLOWED_CATEGORIES[scope]);
}

function normalizeSearchTerm(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

function containsWholeTerm(term, query) {
  return term.startsWith(`${query} `) || term.endsWith(` ${query}`) || term.includes(` ${query} `);
}

function containsAllWholeTokens(term, tokens) {
  return tokens.every((token) => term === token || containsWholeTerm(term, token));
}

function uniqueSearchTerms(values, excluded = new Set()) {
  const terms = [];
  for (const value of values) {
    const normalized = normalizeSearchTerm(value);
    if (!normalized || excluded.has(normalized)) continue;
    excluded.add(normalized);
    terms.push(normalized);
  }
  return terms;
}

function setSearchMetadata(entry, { primary, aliases = [], keywords = [] }) {
  const seen = new Set();
  const normalizedPrimary = uniqueSearchTerms(primary, seen);
  const normalizedAliases = uniqueSearchTerms(aliases, seen);
  const normalizedKeywords = uniqueSearchTerms(keywords, seen);
  const all = [...normalizedPrimary, ...normalizedAliases, ...normalizedKeywords];
  Object.defineProperty(entry, SEARCH_EVIDENCE, {
    configurable: true,
    value: {
      primary: normalizedPrimary,
      aliases: normalizedAliases,
      keywords: normalizedKeywords,
      all,
      text: all.join("\n"),
    },
  });
  Object.defineProperty(entry, PROVIDER_CATEGORY, {
    configurable: true,
    value: promptDictionaryCategory(entry),
  });
}

export function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else field += character;
  }
  fields.push(field);
  return fields;
}

export function dataLines(source) {
  return String(source)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function promptText(value) {
  return value.replaceAll("_", " ").trim();
}

const exactPromptCache = new WeakMap();

function exactPrompts(entries) {
  let exact = exactPromptCache.get(entries);
  if (!exact) {
    exact = new Map(entries.map((entry) => [normalizePromptText(entry.prompt_text), entry]));
    exactPromptCache.set(entries, exact);
  }
  return exact;
}

export function promptDictionaryCategory(entry) {
  return DANBOORU_CATEGORY_BY_PROVIDER_TYPE[String(entry?.provider_type)] ?? "unknown";
}

export function lookupPromptDictionaryEntry(entries, prompt) {
  return exactPrompts(entries).get(normalizePromptText(prompt)) ?? null;
}

export const OVERLAY_CATEGORIES = Object.freeze([...PAGE_PROMPT_CATEGORIES, "appearance", "action", ...CHARACTER_PROMPT_CATEGORIES]);

export function validatePromptDictionaryOverlay(overlay, entryNames) {
  const errors = [];
  if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) return ["overlay 必须是 JSON 对象"];
  const names = new Set(entryNames);
  for (const [sourceText, value] of Object.entries(overlay)) {
    const prefix = `overlay.${sourceText}`;
    if (!sourceText.trim()) errors.push(`${prefix}：键不能为空`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${prefix}：词条必须是对象`);
      continue;
    }
    if (!names.has(sourceText)) errors.push(`${prefix}：词库中不存在该标签`);
    if (typeof value.translation !== "string" || !value.translation.trim()) errors.push(`${prefix}：translation 必须是非空字符串`);
    if (value.description !== undefined && (typeof value.description !== "string" || !value.description.trim())) {
      errors.push(`${prefix}：description 必须是非空字符串`);
    }
    if (!Array.isArray(value.categories) || value.categories.length === 0) {
      errors.push(`${prefix}：categories 必须是非空数组`);
    } else {
      for (const category of value.categories) {
        if (!OVERLAY_CATEGORIES.includes(category)) errors.push(`${prefix}：未知分类 ${category}`);
      }
    }
    if (!Array.isArray(value.keywords)) {
      errors.push(`${prefix}：keywords 必须是数组`);
    } else {
      if (value.keywords.length > 10) errors.push(`${prefix}：keywords 最多 10 个`);
      for (const keyword of value.keywords) {
        if (typeof keyword !== "string" || !keyword.trim()) errors.push(`${prefix}：keywords 元素必须是非空字符串`);
        else if (/[A-Z]/.test(keyword)) errors.push(`${prefix}：keywords 必须全部小写：${keyword}`);
      }
    }
  }
  return errors;
}

export function parsePromptDictionaryWiki(wikiSource = "") {
  if (!wikiSource.trim()) return {};
  let wiki;
  try { wiki = JSON.parse(wikiSource); }
  catch { throw new Error("wiki.json 不是合法 JSON"); }
  if (wiki === null || typeof wiki !== "object" || Array.isArray(wiki)) throw new Error("wiki.json 必须是 JSON 对象");
  for (const [name, value] of Object.entries(wiki)) {
    if (!name.trim() || value === null || typeof value !== "object" || Array.isArray(value)
      || typeof value.body !== "string" || !Array.isArray(value.other_names)
      || value.other_names.some((alias) => typeof alias !== "string")) {
      throw new Error(`wiki.json 校验失败：${name} 必须包含字符串 body 和字符串数组 other_names`);
    }
  }
  return wiki;
}

export function buildPromptDictionary(tagsSource, translationsSource = "", overlaySource = "", wikiSource = "") {
  const wiki = parsePromptDictionaryWiki(wikiSource);
  const translations = new Map();
  for (const line of dataLines(translationsSource)) {
    const [source, translation] = parseCsvLine(line);
    if (source?.trim() && translation?.trim()) translations.set(source.trim().toLowerCase(), translation.trim());
  }

  const entries = [];
  const sourceAliases = new Map();
  for (const line of dataLines(tagsSource)) {
    const [nameValue, type = "0", countValue = "0", aliasValue = ""] = parseCsvLine(line);
    const name = nameValue?.trim();
    if (!name) continue;
    const aliases = aliasValue.split(",").map((alias) => alias.trim()).filter(Boolean);
    const translated = translations.get(name.toLowerCase());
    const aliasTranslations = aliases.map((alias) => translations.get(alias.toLowerCase())).filter(Boolean);
    const display = translated ?? aliasTranslations[0] ?? promptText(name);
    const entry = {
      display_text: display,
      prompt_text: promptText(name),
      source_text: name,
      provider_type: type,
      post_count: Number.parseInt(countValue, 10) || 0,
      ...(aliases.length ? { aliases } : {}),
    };
    const article = Object.hasOwn(wiki, name) ? wiki[name] : null;
    if (article) {
      entry.other_names = article.other_names;
      if (article.body.trim()) {
        entry.original_description = article.body;
        entry.description = article.body;
        entry.description_language = "original";
      }
    }
    setSearchMetadata(entry, {
      primary: [name, promptText(name), display],
      aliases: [...aliases, ...aliasTranslations, ...(entry.other_names ?? [])],
    });
    entries.push(entry);
    sourceAliases.set(entry, aliases);
  }

  if (overlaySource.trim()) {
    let overlay;
    try {
      overlay = JSON.parse(overlaySource);
    } catch {
      throw new Error("overlay.json 不是合法 JSON");
    }
    const errors = validatePromptDictionaryOverlay(overlay, entries.map((entry) => entry.source_text));
    if (errors.length) throw new Error(`overlay.json 校验失败：\n${errors.join("\n")}`);
    for (const entry of entries) {
      const applied = overlay[entry.source_text];
      if (!applied) continue;
      entry.display_text = applied.translation;
      entry.categories = applied.categories;
      entry.keywords = applied.keywords;
      if (applied.description !== undefined) {
        entry.description = applied.description;
        entry.description_language = "zh";
      }
      setSearchMetadata(entry, {
        primary: [entry.source_text, entry.prompt_text, applied.translation],
        aliases: [...sourceAliases.get(entry), ...(entry.other_names ?? [])],
        keywords: applied.keywords,
      });
    }
  }

  entries.sort((left, right) => right.post_count - left.post_count || left.prompt_text.localeCompare(right.prompt_text, "en"));
  return entries;
}

function sortedPromptDictionaryMatches(entries, query, { scope, category = null } = {}) {
  const allowedProviderCategories = requirePromptDictionaryScope(scope);
  const normalized = normalizeSearchTerm(query);
  if (!normalized) return [];
  const queryTokens = [...new Set(normalized.split(" "))];
  const requestedCategory = OVERLAY_CATEGORIES.includes(category) ? category : null;
  const matches = [];
  for (const entry of entries) {
    if (!allowedProviderCategories.has(entry[PROVIDER_CATEGORY] ?? promptDictionaryCategory(entry))) continue;
    const evidence = entry[SEARCH_EVIDENCE];
    if (!evidence) continue;
    const continuousMatch = evidence.text.includes(normalized);
    let allTokensMatch = false;
    if (!continuousMatch && queryTokens.length > 1 && queryTokens.every((token) => evidence.text.includes(token))) {
      allTokensMatch = evidence.all.some((term) => containsAllWholeTokens(term, queryTokens));
    }
    if (!continuousMatch && !allTokensMatch) continue;
    const matchRank = evidence.primary.includes(normalized)
      ? 0
      : evidence.aliases.includes(normalized)
        ? 1
        : evidence.keywords.includes(normalized)
          ? 2
          : evidence.primary.some((term) => containsWholeTerm(term, normalized))
            ? 3
            : evidence.aliases.some((term) => containsWholeTerm(term, normalized))
              ? 4
              : evidence.keywords.some((term) => containsWholeTerm(term, normalized))
                ? 5
                : evidence.all.some((term) => term.startsWith(normalized))
                  ? 6
                  : allTokensMatch
                    ? 7
                    : 8;
    // 分类只在相同匹配档内提供语义加权，不能压过更精确的跨分类候选。
    const categoryRank = requestedCategory && entry.categories?.includes(requestedCategory) ? 0 : 1;
    matches.push({ entry, matchRank, categoryRank });
  }
  matches.sort((left, right) => left.matchRank - right.matchRank
    || left.categoryRank - right.categoryRank
    || right.entry.post_count - left.entry.post_count
    || left.entry.prompt_text.localeCompare(right.entry.prompt_text, "en"));
  return matches;
}

export function searchPromptDictionaryPage(entries, query, { scope, limit = 12, offset = 0, category = null } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const normalizedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const matches = sortedPromptDictionaryMatches(entries, query, { scope, category });
  return {
    suggestions: matches.slice(normalizedOffset, normalizedOffset + normalizedLimit).map(({ entry }) => entry),
    has_more: matches.length > normalizedOffset + normalizedLimit,
  };
}

export function searchPromptDictionary(entries, query, options = {}) {
  return searchPromptDictionaryPage(entries, query, options).suggestions;
}

export function matchPromptDictionary(entries, prompts, { scope } = {}) {
  const allowedProviderCategories = requirePromptDictionaryScope(scope);
  return prompts.map((prompt) => {
    const entry = lookupPromptDictionaryEntry(entries, prompt);
    const providerCategory = entry ? (entry[PROVIDER_CATEGORY] ?? promptDictionaryCategory(entry)) : null;
    return {
      prompt_text: String(prompt),
      matched: Boolean(entry),
      allowed: Boolean(entry && allowedProviderCategories.has(providerCategory)),
      provider_type: entry?.provider_type ?? null,
      provider_category: providerCategory,
      display_text: entry?.display_text ?? null,
      source_text: entry?.source_text ?? null,
      post_count: entry?.post_count ?? null,
      ...(entry?.description !== undefined ? { description: entry.description, description_language: entry.description_language } : {}),
      ...(entry?.original_description !== undefined ? { original_description: entry.original_description } : {}),
      ...(entry?.categories !== undefined ? { categories: entry.categories, keywords: entry.keywords } : {}),
      ...(entry?.aliases !== undefined ? { aliases: entry.aliases } : {}),
      ...(entry?.other_names !== undefined ? { other_names: entry.other_names } : {}),
    };
  });
}
