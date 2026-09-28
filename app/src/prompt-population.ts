import {populationTag,isPopulationControl} from '../shared/prompt-population.mjs';
import type { PromptFragment } from "./PromptFragmentEditor";

export type Population = { girls: number; boys: number; others: number };

export function isPopulationFragment(fragment: PromptFragment): boolean {
  return isPopulationControl(fragment.prompt_text);
}

export function readPopulation(fragments: PromptFragment[]): Population {
  const result: Population = { girls: 0, boys: 0, others: 0 };
  for (const fragment of fragments) {
    if (fragment.enabled === false) continue;
    const tag = populationTag(fragment.prompt_text);
    if (tag) result[tag.kind as keyof Population] = Math.max(result[tag.kind as keyof Population], tag.minimum);
  }
  return result;
}

export function setPopulation(fragments: PromptFragment[], counts: Population, create: () => PromptFragment): PromptFragment[] {
  const tags: string[] = [];
  for (const kind of ["girls", "boys", "others"] as const) {
    const count = counts[kind] ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > 6) throw new RangeError("人数超出可选范围");
    if (count === 0) continue;
    tags.push(`${count}${count === 6 ? "+" : ""}${count === 1 ? kind.slice(0, -1) : kind}`);
  }
  if (counts.girls + counts.boys + (counts.others??0) === 1) tags.push("solo");
  return [
    ...tags.map(prompt_text => {
      const previous = fragments.find(f => f.prompt_text === prompt_text);
      return { id: previous?.id ?? create().id, prompt_type: "danbooru" as const, prompt_text };
    }),
    ...fragments.filter(fragment => !isPopulationFragment(fragment)),
  ];
}
