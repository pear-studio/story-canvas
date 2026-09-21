import type { Scene } from './project-workbench-client';
import { useState, type CSSProperties } from 'react';

export function SceneReferenceEditor({ scenes, value, variantId, onChange }: {
  scenes: Scene[]; value?: string; variantId?: string;
  onChange: (id?: string, variantId?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = scenes.find(scene => scene.id === value);
  const variant = selected?.visual.variants.find(item => item.id === variantId);
  const selectedKey = value ? `${value}:${variantId ?? ''}` : '';
  const matches = scenes.flatMap(scene => scene.visual.variants.map(variant => ({ scene, variant })))
    .filter(({ scene, variant }) => `${scene.name} ${variant.name} ${scene.id} ${variant.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="character-reference-editor">
    {value && <div className="reference-chips"><span className="character-setting-chip" style={{ '--role-color': '#89938e' } as CSSProperties}>
    <i aria-hidden="true" />
    <select aria-label="页面场景设定" value={selectedKey} onChange={event => {
      const [id, variant] = event.target.value.split(':');
      onChange(id || undefined, variant || undefined);
    }}>
      {value && !variant && <option value={selectedKey}>缺失：{selected?.name ?? value} · {variantId}</option>}
      {selected?.visual.variants.map(variant => <option key={variant.id} value={`${selected.id}:${variant.id}`}>{selected.name} · {variant.name}</option>)}
    </select>
    <b>{selected?.name ?? value}</b>{variant && <small>{variant.name}</small>}
    <button type="button" aria-label="移除场景引用" onClick={() => onChange()}>×</button>
    </span></div>}
    <details>
      <summary title="选择场景">＋</summary>
      <div className="reference-picker-menu">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索场景" />
        {matches.map(({ scene, variant }) => <label key={`${scene.id}:${variant.id}`}>
          <input type="checkbox" checked={selectedKey === `${scene.id}:${variant.id}`} onChange={event => event.target.checked ? onChange(scene.id, variant.id) : onChange()} />
          <span>{scene.name} · {variant.name}</span><small>{variant.name}</small>
        </label>)}
      </div>
    </details>
  </div>;
}
