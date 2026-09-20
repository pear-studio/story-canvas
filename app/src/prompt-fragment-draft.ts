import type { PromptFragment as DisplayPromptFragment } from "./PromptFragmentEditor";
import { promptCategories, type PagePrompt, type PromptFragment } from "./project-workbench-client";

export function promptFragmentText(fragment: PromptFragment) {
  return fragment.tag ?? fragment.description ?? "";
}

function displayPromptFragment(fragment: PromptFragment, category: string, index: number): DisplayPromptFragment {
  const promptType = fragment.tag ? "danbooru" : "custom_description";
  return {
    id: fragment.id ?? `draft-existing-${category}-${index}`,
    prompt_type: promptType,
    prompt_text: promptFragmentText(fragment),
    ...(fragment.camera_settings === undefined ? {} : { camera_settings: fragment.camera_settings }),
    ...(fragment.character_id ? { role: fragment.character_id } : {}),
    ...(fragment.weight === undefined ? {} : { weight: fragment.weight }),
    ...(fragment.enabled === undefined ? {} : { enabled: fragment.enabled }),
  };
}

export function displayFragmentList(fragments: PromptFragment[], category = "person"): DisplayPromptFragment[] {
  return fragments.map((fragment, index) => displayPromptFragment(fragment, category, index));
}

export function displayPromptDraft(prompt: PagePrompt): Record<string, DisplayPromptFragment[]> {
  return Object.fromEntries(promptCategories.map((category) => [
    category,
    prompt[category].map((fragment, index) => displayPromptFragment(fragment, category, index)),
  ]));
}

function persistDisplayFragment(fragment: DisplayPromptFragment): PromptFragment {
  return {
    ...(fragment.id.startsWith("token-") ? { id: fragment.id } : {}),
    ...(fragment.prompt_type === "danbooru"
      ? { tag: fragment.prompt_text }
      : { description: fragment.prompt_text }),
    ...(fragment.camera_settings
      ? { camera_settings: fragment.camera_settings }
      : {}),
    ...(fragment.role ? { character_id: fragment.role } : {}),
    ...(fragment.weight === undefined ? {} : { weight: fragment.weight }),
    ...(fragment.enabled === undefined ? {} : { enabled: fragment.enabled }),
  };
}

export function persistFragmentList(fragments: DisplayPromptFragment[]): PromptFragment[] {
  return fragments.map(persistDisplayFragment);
}

export function persistPromptDraft(prompt: Record<string, DisplayPromptFragment[]>): PagePrompt {
  return Object.fromEntries(promptCategories.map((category) => [category, (prompt[category] ?? []).map(persistDisplayFragment)])) as unknown as PagePrompt;
}

let promptDraftSequence = 0;

export function createPromptDraftFragment(): DisplayPromptFragment {
  promptDraftSequence += 1;
  return { id: `draft-new-${promptDraftSequence}`, prompt_type: "danbooru", prompt_text: "" };
}
