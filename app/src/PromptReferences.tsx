import {useRef,useState,type CSSProperties,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
import type {WorkbenchCharacter} from './project-workbench-client';
export function ReferenceRow({ title, editor, children }: { title: string; editor: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="page-reference-row">
    <div className="page-reference-header"><button type="button" className="reference-disclosure" title={`展开${title}引用`} aria-expanded={open} onClick={() => setOpen(value => !value)}><span aria-hidden="true">{open ? '▾' : '▸'}</span>{title}</button>{editor}</div>
    <div className="page-reference-body" hidden={!open}>{children}</div>
  </div>;
}

export function ReferenceLabel({ name, variant, color }: { name: string; variant?: string; color?: string }) {
  return <span className="character-setting-chip reference-summary-chip" style={{ '--role-color': color ?? '#89938e' } as CSSProperties}><i aria-hidden="true" /><b>{name}</b>{variant && <small>{variant}</small>}</span>;
}
export function ParticipantEditor({ characters, ownerCharacterId, value, onChange, enabledCounts }: {
  characters: WorkbenchCharacter[];
  ownerCharacterId?: string;
  enabledCounts?: Record<string, {enabled: number; total: number}>;
  value: Array<{ character_id: string; variant_id: string }>;
  onChange: (value: Array<{ character_id: string; variant_id: string }>) => void;
}) {
  const [query, setQuery] = useState("");
  const availableCharacters = characters.filter((character) => character.id !== ownerCharacterId);
  const characterById = new Map(characters.map((character) => [character.id, character]));
  const normalizedQuery = query.trim().toLowerCase();
  const matches = availableCharacters.flatMap((character) => character.visual.variants.map((variant) => ({
    character,
    variantId: variant.id,
    label: `${character.name} · ${variant.name}`,
    settingLabel: variant.name,
  }))).filter((option) => `${option.label} ${option.character.id} ${option.variantId}`.toLowerCase().includes(normalizedQuery));

  function setCharacterVariant(characterId: string, variantId: string) {
    const index = value.findIndex((entry) => entry.character_id === characterId);
    const next = index >= 0
      ? value.map((entry, position) => position === index ? { character_id: characterId, variant_id: variantId } : entry)
      : [...value, { character_id: characterId, variant_id: variantId }];
    onChange(next);
  }

  // 横向拖拽排序：与 Prompt 片段同一模式，指示线改为纵向、按 clientX 判断插入位置。
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ from: number; to: number; pointerId: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; pointerId: number } | null>(null);

  function updateDrag(next: { from: number; to: number; pointerId: number } | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function startDragging(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    chipsRef.current?.setPointerCapture(event.pointerId);
    updateDrag({ from: index, to: index, pointerId: event.pointerId });
  }

  function moveDrag(clientX: number, clientY: number, pointerId: number) {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const chips = [...(chipsRef.current?.querySelectorAll<HTMLElement>(".character-setting-chip") ?? [])];
    if (!chips.length) return;
    const insertionSlot = chips.findIndex((chip) => {
      const rect = chip.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return clientX < rect.left + rect.width / 2;
      return clientY < rect.top;
    });
    const rawSlot = insertionSlot === -1 ? chips.length : insertionSlot;
    const to = Math.max(0, Math.min(chips.length - 1, rawSlot > current.from ? rawSlot - 1 : rawSlot));
    if (to !== current.to) updateDrag({ ...current, to });
  }

  function finishDrag(pointerId: number, canceled = false) {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    updateDrag(null);
    if (canceled || current.from === current.to) return;
    const next = [...value];
    const [item] = next.splice(current.from, 1);
    next.splice(current.to, 0, item);
    onChange(next);
  }

  return <div className="character-reference-editor">
    {value.length > 0 && <div className="reference-chips" ref={chipsRef} onPointerMove={(event) => moveDrag(event.clientX, event.clientY, event.pointerId)} onPointerUp={(event) => finishDrag(event.pointerId)} onPointerCancel={(event) => finishDrag(event.pointerId, true)}>
      {value.map((entry, index) => {
        const character = characterById.get(entry.character_id);
        const count = enabledCounts?.[entry.character_id];
        const variant = character?.visual.variants.find((candidate) => candidate.id === entry.variant_id) ?? null;
        const dragPosition = drag?.from === index ? "source" : drag && drag.to !== drag.from && drag.to === index ? (drag.to < drag.from ? "before" : "after") : undefined;
        return <span className={`character-setting-chip${dragPosition ? ` is-drag-${dragPosition}` : ""}`} key={entry.character_id} style={{ "--role-color": character?.style?.display_color ?? "#89938e" } as CSSProperties}>
          <button type="button" className="chip-drag" title="拖动排序" aria-label={`拖动排序：${character?.name ?? entry.character_id}`} onPointerDown={(event) => startDragging(event, index)}>⋮</button>
          <i aria-hidden="true" />
          <select aria-label={`${character?.name ?? entry.character_id}角色设定`} value={entry.variant_id || character?.visual.variants[0]?.id || ""} onChange={(event) => setCharacterVariant(entry.character_id, event.target.value)}>
            {!variant && <option value={entry.variant_id}>缺失：{entry.character_id} · {entry.variant_id}</option>}{(character?.visual.variants ?? []).map((candidate) => <option value={candidate.id} key={candidate.id}>{character?.name ?? entry.character_id} · {candidate.name}</option>)}
          </select>
          <b>{character?.name ?? entry.character_id}</b>{variant && <small>{variant.name}</small>}
          {count && <small className="reference-enabled-count" title={`Prompt 启用 ${count.enabled} / ${count.total} 条（当前启用 / 总词条）`} aria-label={`${character?.name ?? entry.character_id} Prompt 启用 ${count.enabled}/${count.total}`}>{count.enabled}/{count.total}</small>}
          <button type="button" onClick={() => onChange(value.filter((item) => item.character_id !== entry.character_id))} aria-label={`移除${character?.name ?? entry.character_id}`}>×</button>
        </span>;
      })}
    </div>}
    <details>
      <summary title="选择角色">＋</summary>
      <div className="reference-picker-menu">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色" />
        {matches.map(({ character, variantId, label, settingLabel }) => {
          const selected = value.find((entry) => entry.character_id === character.id);
          const checked = Boolean(selected) && (selected?.variant_id || character.visual.variants[0]?.id || "") === variantId;
          return <label key={`${character.id}:${variantId}`}>
            <input type="checkbox" checked={checked} onChange={(event) => event.target.checked
              ? setCharacterVariant(character.id, variantId)
              : onChange(value.filter((entry) => entry.character_id !== character.id))} />
            <span>{label}</span><small>{settingLabel}</small>
          </label>;
        })}
      </div>
    </details>
  </div>;
}
