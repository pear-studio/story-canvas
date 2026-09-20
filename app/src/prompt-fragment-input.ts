export function inferUserPromptType(promptText: string, {
  dictionaryMatched,
  dictionaryAllowed,
}: {
  dictionaryMatched: boolean;
  dictionaryAllowed: boolean;
  scope: "page" | "character" | "render_profile";
  category: string;
}) {
  if (dictionaryMatched) return dictionaryAllowed ? "danbooru" as const : null;
  return promptText.trim() ? "custom_description" as const : null;
}

const ideographicCharacterPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const searchableCharacterPattern = /[\p{Letter}\p{Number}]/gu;

export function canSearchPromptDictionary(rawQuery: string) {
  const query = rawQuery.trim();
  if (!query) return false;
  if (ideographicCharacterPattern.test(query)) return true;
  return (query.match(searchableCharacterPattern)?.length ?? 0) >= 2;
}

export function shouldOpenPromptDictionarySearch({ focused, enabled, composing, query }: { focused: boolean; enabled: boolean; composing: boolean; query: string }) {
  return focused && enabled && !composing && canSearchPromptDictionary(query);
}

export function activePromptDictionarySuggestion<T>(suggestions: T[], activeIndex: number) {
  return activeIndex >= 0 ? suggestions[activeIndex] : undefined;
}

export function mergePromptDictionarySuggestions<T extends { prompt_text: string; source_text?: string }>(current: T[], incoming: T[]) {
  const seen = new Set(current.map((suggestion) => `${suggestion.source_text ?? ""}\u0000${suggestion.prompt_text}`));
  const merged = [...current];
  for (const suggestion of incoming) {
    const key = `${suggestion.source_text ?? ""}\u0000${suggestion.prompt_text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(suggestion);
  }
  return merged;
}
