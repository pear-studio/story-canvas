import { PromptFragmentEditor } from './PromptFragmentEditor';
import { displayPromptDraft, createPromptDraftFragment } from './prompt-fragment-draft';
import { promptCategories, type PagePrompt, type InheritedAdjustments } from './models/anima/types';
import { applyInheritedPrompt, adjustmentKey, inheritedOverrideCount } from '../shared/prompt-inheritance.mjs';

const labels = { population: '人数', person: '人物', setting: '场景', camera: '镜头', avoid: '避免' };

export function InheritedPromptEditor({ title, source, prompt, adjustments = {}, defaultOpen = false, collapsible = true, onChange }: {
  title: string; source: string; prompt: PagePrompt; adjustments?: InheritedAdjustments; defaultOpen?: boolean; collapsible?: boolean;
  onChange: (value: InheritedAdjustments) => void;
}) {
  // 完整来源键同时区分基础与子设定；同一 token ID 出现在两层也不会共用 React 行。
  const located = Object.fromEntries(promptCategories.map(category => [category,
    (prompt[category] ?? []).map(fragment => ({ ...fragment, inheritance_key: adjustmentKey(fragment, category) })),
  ])) as unknown as PagePrompt;
  const base = displayPromptDraft(located);
  const effective = displayPromptDraft(applyInheritedPrompt(located, adjustments) as PagePrompt);
  for (const fragment of Object.values(effective).flat()) {
    fragment.inheritance = { ...adjustments[fragment.inheritance_key!] };
  }
  const upstreamWeights = Object.fromEntries(Object.values(base).flat().map(f => [f.id, f.weight ?? 1]));
  const upstreamEnabled = Object.fromEntries(Object.values(base).flat().map(f => [f.id, f.enabled !== false]));
  const validKeys = new Set(Object.values(base).flat().map(f => f.inheritance_key!));
  const staleKeys = Object.keys(adjustments).filter(key => !validKeys.has(key));
  const adjusted = inheritedOverrideCount(located, adjustments).overridden;
  const body = <div className="character-identity-preview-body">
    {staleKeys.length > 0 && <p className="prompt-fragment-category-issues" role="status">有 {staleKeys.length} 项继承调整的原词已不存在，不参与生成。<button type="button" className="button button--quiet" onClick={() => onChange(Object.fromEntries(Object.entries(adjustments).filter(([key]) => validKeys.has(key))))}>清理失效调整</button></p>}
    <PromptFragmentEditor scope="character" categories={promptCategories.map(id => ({ id, label: labels[id] }))} fragments={effective} createFragment={createPromptDraftFragment} toggleOnly upstreamWeights={upstreamWeights} upstreamEnabled={upstreamEnabled} historyScopeKey={source} onChange={next => {
      // 元信息随草稿进入撤销历史；只记录显式字段，不根据有效值重算整表差异。
      const result: InheritedAdjustments = Object.fromEntries(staleKeys.map(key => [key, adjustments[key]]));
      for (const fragment of Object.values(next).flat()) {
        if (fragment.inheritance && Object.keys(fragment.inheritance).length) result[fragment.inheritance_key!] = fragment.inheritance;
      }
      onChange(result);
    }} />
  </div>;
  if (!collapsible) return <div className="inherited-prompt">{body}</div>;
  return <details className="character-identity-preview inherited-prompt" open={defaultOpen || undefined}>
    <summary>{title}{adjusted > 0 ? ` · 调整 ${adjusted} 项` : ''}</summary>
    {body}
  </details>;
}
