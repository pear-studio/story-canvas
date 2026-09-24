import type { PromptFragment } from "./PromptFragmentEditor";
import { createPromptDraftFragment } from "./prompt-fragment-draft";
import { isPopulationFragment, readPopulation, setPopulation, type Population } from "./prompt-population";
import "./PromptPopulationEditor.css";

export function PromptPopulationEditor({ fragments, disabled, onChange }: {
  fragments: PromptFragment[];
  disabled: boolean;
  onChange: (fragments: PromptFragment[]) => void;
}) {
  const counts = readPopulation(fragments);
  const update = (kind: keyof Population, value: number) => {
    if (Number.isInteger(value) && value >= 0 && value <= 6) {
      onChange(setPopulation(fragments, { ...counts, [kind]: value }, createPromptDraftFragment));
    }
  };
  const result = fragments.filter(fragment => fragment.enabled !== false && isPopulationFragment(fragment)).map(fragment => fragment.prompt_text).join(", ");
  return <div className="prompt-population" role="group" aria-label="画面人数">
    <span className="prompt-population-title" title="人数词固定放在角色描述之前；单人自动添加 solo，多人自动移除。6 表示 6 人及以上。">画面人数</span>
    {([['girls', 'girl'], ['boys', 'boy']] as const).map(([kind, label]) => <div className="prompt-population-counter" key={kind}>
      <button type="button" aria-label={"减少 " + label + " 人数"} disabled={disabled || counts[kind] <= 0} onClick={() => update(kind, counts[kind] - 1)}>−</button>
      <span className="prompt-population-count" aria-label={label + " 人数"}>{counts[kind]}</span>
      <button type="button" aria-label={"增加 " + label + " 人数"} disabled={disabled || counts[kind] >= 6} onClick={() => update(kind, counts[kind] + 1)}>+</button>
      <span>{label}</span>
    </div>)}
    <output className="prompt-population-result" aria-label="生成的人数 Prompt" aria-live="polite">{result || "—"}</output>
  </div>;
}
