import { useState } from "react";
import { Modal } from "./Modal";
import "./training-multimodel.css";

export type CaptionSet = { id: string; name: string; format: "tags" | "prose" };
type CaptionSetInput = { name: string; format: CaptionSet["format"]; source_id?: string };
type CaptionSetDraft = CaptionSetInput & { renameId?: string };

export function TrainingCaptionSets({ sets, selectedId, disabled, dirty, onSelect, onSave }: {
  sets: CaptionSet[];
  selectedId: string | null;
  disabled: boolean;
  dirty: boolean;
  onSelect: (id: string) => void;
  onSave: (value: CaptionSetInput, renameId?: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CaptionSetDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = sets.find(set => set.id === selectedId);
  const close = () => { if (!saving) setDraft(null); };
  const editingDisabled = disabled || saving || dirty;
  return <>
    <div className="training-caption-sets">
      <label>打标集 <select aria-label="当前打标集" value={selectedId ?? ""} disabled={disabled || saving} onChange={event => onSelect(event.target.value)}>
        {!selected && <option value="">选择打标集</option>}
        {sets.map(set => <option key={set.id} value={set.id}>{set.name}</option>)}
      </select></label>
      {selected && <small>{selected.format === "prose" ? "自然语言" : "标签"}</small>}
      <button className="button button--quiet" disabled={editingDisabled} onClick={() => setDraft({ name: "", format: "prose" })}>新建打标集</button>
      <button className="button button--quiet" disabled={editingDisabled || !selected} onClick={() => selected && setDraft({ name: `${selected.name} · 副本`, format: selected.format, source_id: selected.id })}>复制</button>
      <button className="button button--quiet" disabled={editingDisabled || !selected} onClick={() => selected && setDraft({ name: selected.name, format: selected.format, renameId: selected.id })}>改名</button>
    </div>
    {draft && <Modal title={draft.renameId ? "重命名打标集" : draft.source_id ? "复制打标集" : "新建打标集"} onClose={close} busy={saving}>
      <form className="training-caption-set-form" onSubmit={async event => {
        event.preventDefault();
        setSaving(true);
        try {
          const saved = await onSave({ name: draft.name.trim(), format: draft.format, ...(draft.source_id ? { source_id: draft.source_id } : {}) }, draft.renameId);
          if (saved) setDraft(null);
        } finally { setSaving(false); }
      }}>
        <label>名称<input autoFocus aria-label="打标集名称" required value={draft.name} disabled={saving} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        {!draft.renameId && <label>格式<select aria-label="打标集格式" value={draft.format} disabled={saving} onChange={event => setDraft({ ...draft, format: event.target.value as CaptionSet["format"] })}>
          <option value="prose">自然语言</option><option value="tags">标签</option>
        </select></label>}
        {draft.source_id && <small>复制当前文本；新集需要单独确认。</small>}
        <footer><button type="button" className="button" disabled={saving} onClick={close}>取消</button><button className="button button--primary" disabled={saving || !draft.name.trim()}>保存</button></footer>
      </form>
    </Modal>}
  </>;
}
