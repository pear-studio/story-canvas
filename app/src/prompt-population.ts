import type { PromptFragment } from "./PromptFragmentEditor";

export type Population = { girls: number; boys: number };

function populationTag(text: string): { kind: keyof Population; count: number } | null {
  const normalized = text.trim().toLowerCase().replaceAll("_", " ");
  const match = /^(\d+)(\+)?(girls?|boys?)$/.exec(normalized);
  if (match) return { kind: `${match[3].replace(/s$/, "")}s` as keyof Population, count: Number(match[1]) };
  const multiple = /^multiple (girls|boys)$/.exec(normalized);
  return multiple ? { kind: multiple[1] as keyof Population, count: 2 } : null;
}

export function isPopulationFragment(fragment: PromptFragment): boolean {
  return fragment.prompt_text.trim().toLowerCase() === "solo" || populationTag(fragment.prompt_text) !== null;
}

export function readPopulation(fragments: PromptFragment[]): Population {
  const result: Population = { girls: 0, boys: 0 };
  for (const fragment of fragments) {
    if (fragment.enabled === false) continue;
    const tag = populationTag(fragment.prompt_text);
    if (tag) result[tag.kind] = Math.max(result[tag.kind], tag.count);
  }
  return result;
}

export function setPopulation(fragments: PromptFragment[], counts: Population, create: () => PromptFragment): PromptFragment[] {
  const tags: string[] = [];
  for (const kind of ["girls", "boys"] as const) {
    const count = counts[kind];
    if (!Number.isInteger(count) || count < 0 || count > 6) throw new RangeError("人数超出可选范围");
    if (count === 0) continue;
    tags.push(`${count}${count === 6 ? "+" : ""}${count === 1 ? kind.slice(0, -1) : kind}`);
  }
  if (counts.girls + counts.boys === 1) tags.push("solo");
  return [
    ...tags.map(prompt_text => {
      const previous = fragments.find(f => f.prompt_text === prompt_text);
      return { id: previous?.id ?? create().id, prompt_type: "danbooru" as const, prompt_text };
    }),
    ...fragments.filter(fragment => !isPopulationFragment(fragment)),
  ];
}
