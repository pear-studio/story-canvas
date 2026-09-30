import type { PromptFragment as DisplayPromptFragment } from "./PromptFragmentEditor";
import { promptCategories, type PagePrompt, type PromptFragment } from "./models/anima/types";

export function promptFragmentText(fragment: PromptFragment) {
  return fragment.tag ?? fragment.description ?? "";
}

function displayPromptFragment(fragment: PromptFragment, category: string, index: number): DisplayPromptFragment {
  const promptType = Object.hasOwn(fragment, "tag") ? "danbooru" : "custom_description";
  return {
    id: fragment.inheritance_key ?? fragment.id ?? nextDraftId(),
    ...(fragment.inheritance_key ? { inheritance_key: fragment.inheritance_key } : {}),
    ...(fragment.inheritance_source ? { inheritance_source: fragment.inheritance_source } : {}),
    source_index: index,
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

function persistDisplayFragment(fragment: DisplayPromptFragment, shared: boolean): PromptFragment {
  return {
    ...(shared && fragment.id.startsWith("token-") ? { id: fragment.id } : {}),
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

export function persistFragmentList(fragments: DisplayPromptFragment[], options: { shared?: boolean } = {}): PromptFragment[] {
  return fragments.map(fragment => persistDisplayFragment(fragment, options.shared === true));
}

export function persistPromptDraft(prompt: Record<string, DisplayPromptFragment[]>, options: { shared?: boolean } = {}): PagePrompt {
  return Object.fromEntries(promptCategories.map((category) => [category, persistFragmentList(prompt[category] ?? [], options)])) as unknown as PagePrompt;
}

/** 引用、LoRA 等旁路字段变化时，保留本地行身份和输入框状态。 */
export function matchesLocalPromptDraft(draft: Record<string, DisplayPromptFragment[]>, prompt: PagePrompt) {
  const native = Object.fromEntries(promptCategories.map(category => [category, (prompt[category] ?? []).map(({ id: _id, inheritance_key: _key, ...fragment }) => fragment)]));
  return JSON.stringify(persistPromptDraft(draft)) === JSON.stringify(native);
}

let promptDraftSequence = 0;

function nextDraftId() {
  promptDraftSequence += 1;
  return `draft-${promptDraftSequence}`;
}

export function createPromptDraftFragment(): DisplayPromptFragment {
  return { id: nextDraftId(), prompt_type: "danbooru", prompt_text: "" };
}
