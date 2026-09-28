import { PromptFragmentEditor } from './PromptFragmentEditor';
import { displayPromptDraft, createPromptDraftFragment } from './prompt-fragment-draft';
import { promptCategories, type PagePrompt, type InheritedAdjustments } from './models/anima/types';
import { applyInheritedPrompt, adjustmentKey, inheritedOverrideCount } from '../shared/prompt-inheritance.mjs';

const labels = { population: '人数', person: "人物",  setting: '场景', camera: '镜头', avoid: '避免' };

export function InheritedPromptEditor({ title, source, prompt, adjustments = {}, disabled = [], defaultOpen = false, collapsible = true, onChange }: {
  title: string; source: string; prompt: PagePrompt; adjustments?: InheritedAdjustments; disabled?: string[]; defaultOpen?: boolean; collapsible?: boolean;
  onChange: (value: InheritedAdjustments) => void;
}) {
  const base = displayPromptDraft(prompt);
  const effective = displayPromptDraft(applyInheritedPrompt(prompt, adjustments, disabled) as PagePrompt);
  const upstreamWeights = Object.fromEntries(Object.values(base).flat().map(f => [f.id, f.weight ?? 1]));
  const upstreamEnabled = Object.fromEntries(Object.values(base).flat().map(f => [f.id, f.enabled !== false]));
  const adjusted = inheritedOverrideCount(prompt, adjustments, disabled).overridden;
  const body = <div className="character-identity-preview-body"><PromptFragmentEditor scope="character" categories={promptCategories.map(id => ({ id, label: labels[id] }))} fragments={effective} createFragment={createPromptDraftFragment} toggleOnly upstreamWeights={upstreamWeights} upstreamEnabled={upstreamEnabled} historyScopeKey={source} onChange={next => {
      const result: InheritedAdjustments = {};
      const originals = Object.values(base).flat();
      for (const [category, fragments] of Object.entries(next)) for (const fragment of fragments) {
        const original = originals.find(f => f.id === fragment.id);
        if (!original) continue;
        const adjustment: InheritedAdjustments[string] = {};
        if ((fragment.weight ?? 1) !== (original.weight ?? 1)) adjustment.weight = fragment.weight ?? 1;
        if ((fragment.enabled !== false) !== (original.enabled !== false)) adjustment.enabled = fragment.enabled !== false;
        if (Object.keys(adjustment).length) result[adjustmentKey(fragment, category)] = adjustment;
      }
      onChange(result);
    }} /></div>;
  if (!collapsible) return <div className="inherited-prompt">{body}</div>;
  return <details className="character-identity-preview inherited-prompt" open={defaultOpen || undefined}>
    <summary>{title}{adjusted > 0 ? ` · 调整 ${adjusted} 项` : ''}</summary>
    {body}
  </details>;
}
