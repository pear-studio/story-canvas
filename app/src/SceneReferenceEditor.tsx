import type { Scene } from './project-workbench-client';

export function SceneReferenceEditor({ scenes, value, variantId, onChange }: {
  scenes: Scene[]; value?: string; variantId?: string;
  onChange: (id?: string, variantId?: string) => void;
}) {
  const selected = scenes.find(scene => scene.id === value);
  const variant = selected?.visual.variants.find(item => item.id === variantId);
  const selectedKey = value ? `${value}:${variantId ?? ''}` : '';
  return <div className="character-reference-editor">
    <select aria-label="页面场景设定" value={selectedKey} onChange={event => {
      const [id, variant] = event.target.value.split(':');
      onChange(id || undefined, variant || undefined);
    }}>
      <option value="">无场景引用</option>
      {value && !variant && <option value={selectedKey}>缺失：{selected?.name ?? value} · {variantId}</option>}
      {scenes.map(scene => <optgroup label={scene.name} key={scene.id}>
        {scene.visual.variants.map(variant => <option key={variant.id} value={`${scene.id}:${variant.id}`}>{scene.name} · {variant.name}</option>)}
      </optgroup>)}
    </select>
    {value && <button type="button" className="button button--quiet" aria-label="移除场景引用" onClick={() => onChange()}>移除</button>}
  </div>;
}
