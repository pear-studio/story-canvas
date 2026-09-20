import { useEffect, useMemo, useState } from "react";
import { promptTagSpans } from "../shared/prompt-tags.mjs";

export type PromptDisplayFragment = {
  prompt_type?: string;
  prompt_text?: string;
};

export type PromptDictionaryDisplayScope = "page" | "character" | "render_profile";

export type PromptDictionaryMatch = {
  matched?: boolean;
  allowed?: boolean;
  prompt_text: string;
  display_text?: string | null;
  source_text?: string;
  provider_type?: string | null;
  post_count?: number | null;
  categories?: string[];
  keywords?: string[];
  aliases?: string[];
  description?: string;
  original_description?: string;
  description_language?: "zh" | "original";
  other_names?: string[];
};

export function normalizedPromptDisplay(promptText: string) {
  return promptText.trim().replaceAll("_", " ").replace(/\s+/g, " ");
}

export function promptDisplayText(fragment: PromptDisplayFragment | undefined, dictionaryDisplays: Record<string, string> = {}) {
  if (!fragment) return "";
  if (fragment.prompt_type !== "danbooru") return fragment.prompt_text?.trim() ?? "";
  const promptText = fragment.prompt_text?.trim() ?? "";
  const normalized = normalizedPromptDisplay(promptText);
  return dictionaryDisplays[promptText] || dictionaryDisplays[normalized] || normalized;
}

export function promptDictionaryBatches(prompts: string[], batchSize = 200) {
  const size = Math.max(1, Math.trunc(batchSize));
  return Array.from({ length: Math.ceil(prompts.length / size) }, (_, index) => prompts.slice(index * size, (index + 1) * size));
}

export function descriptionTags(text: string) {
  return [...new Set(promptTagSpans(text).map(span => span.tag))];
}

// 同一轮挂载的多个页面共用一次批量词库查询，避免总览逐列重复请求。
const matchCache = new Map<string, PromptDictionaryMatch>();
const pendingMatches = new Map<PromptDictionaryDisplayScope, Array<{ prompts: string[]; resolve: (matches: PromptDictionaryMatch[]) => void }>>();
let matchTimer: ReturnType<typeof setTimeout> | undefined;
function requestMatches(prompts: string[], scope: PromptDictionaryDisplayScope): Promise<PromptDictionaryMatch[]> {
  if (prompts.every(prompt => matchCache.has(`${scope}:${prompt}`))) return Promise.resolve(prompts.map(prompt => matchCache.get(`${scope}:${prompt}`)!));
  return new Promise(resolve => {
    const pending = pendingMatches.get(scope) ?? [];
    pending.push({ prompts, resolve });
    pendingMatches.set(scope, pending);
    if (matchTimer) return;
    matchTimer = setTimeout(() => {
      matchTimer = undefined;
      const groups = [...pendingMatches];
      pendingMatches.clear();
      for (const [scope, requests] of groups) void (async () => {
        const missing = [...new Set(requests.flatMap(request => request.prompts))].filter(prompt => !matchCache.has(`${scope}:${prompt}`));
        await Promise.all(promptDictionaryBatches(missing).map(async batch => {
          try {
            const response = await fetch("/api/prompt-dictionary/matches", {
              method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ prompts: batch, scope }),
            });
            if (!response.ok) return;
            const payload = await response.json() as { available?: boolean; matches?: PromptDictionaryMatch[] };
            if (payload.available === false) return;
            for (const match of payload.matches ?? []) matchCache.set(`${scope}:${match.prompt_text}`, match);
          } catch { /* 词库暂时不可用时保留原文，下次查询重试。 */ }
        }));
        requests.forEach(request => request.resolve(request.prompts.flatMap(prompt => {
          const match = matchCache.get(`${scope}:${prompt}`);
          return match ? [match] : [];
        })));
      })();
    }, 100);
  });
}

export function usePromptDictionaryMatches(fragments: PromptDisplayFragment[], scope: PromptDictionaryDisplayScope) {
  const prompts = useMemo(() => [...new Set(fragments.flatMap(fragment => fragment.prompt_type === "danbooru"
    ? [fragment.prompt_text?.trim() ?? ""] : descriptionTags(fragment.prompt_text ?? "")).filter(Boolean))], [fragments]);
  const promptKey = prompts.join("\u0000");
  const [dictionaryMatches, setDictionaryMatches] = useState<Record<string, PromptDictionaryMatch>>({});
  useEffect(() => {
    let cancelled = false;
    void requestMatches(prompts, scope).then(matches => {
      if (!cancelled) setDictionaryMatches(Object.fromEntries(matches.map(match => [match.prompt_text, match])));
    });
    return () => { cancelled = true; };
  }, [promptKey, scope]);
  return dictionaryMatches;
}

export function usePromptDictionaryDisplays(fragments: PromptDisplayFragment[], scope: PromptDictionaryDisplayScope) {
  const matches = usePromptDictionaryMatches(fragments, scope);
  return useMemo(() => Object.fromEntries(Object.entries(matches).map(([prompt, match]) => [
    prompt, match.display_text?.trim() || normalizedPromptDisplay(prompt),
  ])), [matches]);
}
