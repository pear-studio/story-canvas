import { FloatingPanel } from "./FloatingPanel";
import { useId, useMemo, useState, useRef } from 'react';
import type { ProjectWorkbenchView, WorkbenchPage, WorkbenchCharacter } from './project-workbench-client';

type Result = { id: string; title: string; detail: string; number?: number; open: () => void };
export function NavigationSearch({ view, onPage, onCharacter, onScene }: {
  view: ProjectWorkbenchView; onPage: (page: WorkbenchPage) => void;
  onCharacter: (character: WorkbenchCharacter, settingId: string) => void; onScene: (id: string, settingId: string) => void;
}) {
  const [query, setQuery] = useState(''), [visible, setVisible] = useState(false), [index, setIndex] = useState(0);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => {
    const result: Result[] = []; let number = 0;
    for (const chapter of view.outline.chapters) for (const sequence of chapter.sequences) for (const page of sequence.pages) {
      number++; result.push({ id: `story:${page.page_id}`, number, title: page.title, detail: `剧情页 · ${chapter.title} / ${sequence.title}`, open: () => onPage(page) });
    }
    for (const character of view.characters) {
      result.push({ id: character.id, title: character.name, detail: '角色', open: () => onCharacter(character, 'profile') });
      for (const variant of character.visual.variants) result.push({ id: `${character.id}:${variant.id}`, title: variant.name, detail: `子设定 · ${character.name}`, open: () => onCharacter(character, variant.id) });
      for (const page of character.pages) result.push({ id: `character:${character.id}:${page.page_id}`, title: page.title, detail: `角色视觉页 · ${character.name} / ${character.visual.variants.find(v => v.id === page.variant_id)?.name ?? ''}`, open: () => onPage(page) });
    }
    for (const scene of view.scenes?.scenes ?? []) {
      result.push({ id: `scene:${scene.id}`, title: scene.name, detail: '场景', open: () => onScene(scene.id, 'profile') });
      for (const variant of scene.visual.variants) result.push({ id: `scene:${scene.id}:${variant.id}`, title: variant.name, detail: `子设定 · ${scene.name}`, open: () => onScene(scene.id, variant.id) });
      for (const page of scene.pages) result.push({ id: `page:${page.page_id}`, title: page.title, detail: `场景视觉页 · ${scene.name} / ${scene.visual.variants.find(v => v.id === page.variant_id)?.name ?? ''}`, open: () => onPage(page) });
    }
    for (const page of view.orphan_pages ?? []) result.push({ id: `page:${page.page_id}`, title: page.title, detail: '待整理页面', open: () => onPage(page) });
    return result;
  }, [view, onPage, onCharacter, onScene]);
  const term = query.trim().toLocaleLowerCase();
  const results = term ? entries.filter(entry => /^\d+$/.test(term) ? entry.number === Number(term) : `${entry.title} ${entry.detail}`.toLocaleLowerCase().includes(term)).slice(0, 30) : [];
  function choose(entry: Result) { setVisible(false); setQuery(''); entry.open(); }
  return <div className="navigation-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setVisible(false); }}>
    <input ref={inputRef} role="combobox" aria-label="搜索项目内容" aria-autocomplete="list" aria-expanded={visible && !!term} aria-controls={id} aria-activedescendant={visible && results[index] ? `${id}-${index}` : undefined} placeholder="页码、页面、角色或场景…" value={query} onFocus={() => setVisible(true)} onChange={e => { setQuery(e.target.value); setVisible(true); setIndex(0); }} onKeyDown={e => {
      if (e.key === 'Escape') setVisible(false);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setVisible(true); setIndex(value => Math.max(0, Math.min(results.length - 1, value + (e.key === 'ArrowDown' ? 1 : -1)))); }
      if (e.key === 'Enter' && visible && results[index]) { e.preventDefault(); choose(results[index]); }
    }} />
    {visible && term && <FloatingPanel target={inputRef.current ?? undefined} style={{ width: 320 }} id={id} role="listbox" className="navigation-search-results">{results.length ? results.map((entry, i) => <button key={entry.id} id={`${id}-${i}`} role="option" aria-selected={i === index} type="button" onMouseDown={e => e.preventDefault()} onClick={() => choose(entry)}><span>{entry.number ? `${entry.number} · ` : ''}{entry.title}</span><small>{entry.detail}</small></button>) : <p>没有匹配内容</p>}</FloatingPanel>}
  </div>;
}
