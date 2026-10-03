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
  return <div className="prompt-population" role="group" aria-label="画面人数" title={`人数 Prompt：${result || "—"}；6 表示 6 人及以上`}>
    <span className="prompt-population-title" title="人数词固定放在角色描述之前；单人自动添加 solo，多人自动移除。6 表示 6 人及以上。">画面人数</span>
    {([['girls', 'girl'], ['boys', 'boy'], ['others', 'other']] as const).map(([kind, label]) => <div className="prompt-population-counter" key={kind}>
      <label className="prompt-population-select">{{girl:"女",boy:"男",other:"其他"}[label]}<select aria-label={label + " 人数选择"} value={counts[kind]} disabled={disabled} onChange={event=>update(kind,Number(event.target.value))}>{[0,1,2,3,4,5,6].map(count=><option key={count} value={count}>{count === 6 ? '6+' : count}</option>)}</select></label>
      <button type="button" aria-label={"减少 " + label + " 人数"} disabled={disabled || counts[kind] <= 0} onClick={() => update(kind, counts[kind] - 1)}>−</button>
      <span className="prompt-population-count" aria-label={label + " 人数"}>{counts[kind]}</span>
      <button type="button" aria-label={"增加 " + label + " 人数"} disabled={disabled || counts[kind] >= 6} onClick={() => update(kind, counts[kind] + 1)}>+</button>
      <span>{{girl:"女",boy:"男",other:"其他"}[label]}</span>
    </div>)}
    <label><input type="checkbox" checked={fragments.some(f=>f.enabled!==false && f.prompt_text.replaceAll('_',' ')==='no humans')} disabled={disabled} onChange={event=>onChange(event.target.checked ? [{...createPromptDraftFragment(),prompt_type:'danbooru',prompt_text:'no_humans'}] : fragments.filter(f=>f.prompt_text.replaceAll('_',' ')!=='no humans'))}/>无人物</label>
    <output className="prompt-population-result" aria-label="生成的人数 Prompt" aria-live="polite">{result || "—"}</output>
  </div>;
}
