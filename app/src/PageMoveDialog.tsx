import { useState } from 'react';
import { Modal } from './Modal';
import type { ProjectWorkbenchView, PageOwner, WorkbenchPage } from './project-workbench-client';

export function PageMoveDialog({ view, page, onClose, onMove }: {
  view: ProjectWorkbenchView; page: WorkbenchPage; onClose: () => void;
  onMove: (owner: Omit<PageOwner, 'page_id'>) => Promise<boolean>;
}) {
  const destinations = [
    ...view.outline.chapters.flatMap(chapter => chapter.sequences.map(sequence => ({
      label: `系列 / ${chapter.title} / ${sequence.title}`, owner: { owner_kind: 'story' as const, sequence_id: sequence.id },
    }))),
    ...view.characters.flatMap(setting => setting.visual.variants.map(variant => ({
      label: `角色 / ${setting.name} / ${variant.name}`, owner: { owner_kind: 'character' as const, character_id: setting.id, variant_id: variant.id },
    }))),
    ...(page.page_kind === 'text' ? [] : (view.scenes?.scenes ?? []).flatMap(setting => setting.visual.variants.map(variant => ({
      label: `场景 / ${setting.name} / ${variant.name}`, owner: { owner_kind: 'scene' as const, scene_id: setting.id, variant_id: variant.id },
    })))),
  ].filter(item => page.page_kind !== 'text' || item.owner.owner_kind === 'story');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="移动页面" subtitle={page.title} size="content" busy={busy} onClose={onClose} footer={<>
    <button className="button" disabled={busy} onClick={onClose}>取消</button>
    <button className="button button--primary" disabled={busy || selected === ''} onClick={() => void (async () => {
      setBusy(true);
      try { if (await onMove(destinations[Number(selected)].owner)) onClose(); } finally { setBusy(false); }
    })()}>移动</button>
  </>}>
    <p>只改变页面归属，保留画面引用、Prompt、候选和成品。</p>
    <label>目标位置<select aria-label="页面目标位置" value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">请选择</option>{destinations.map((item, index) => <option key={index} value={index}>{item.label}</option>)}
    </select></label>
  </Modal>;
}
