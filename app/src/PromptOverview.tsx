import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {ModelOverviewEditor} from './models/registry';
import { GenerateSplitButton } from "./GenerateSplitButton";
import { savePagePrompt, startPageRender, type ProjectWorkbenchView, type WorkbenchPage } from "./project-workbench-client";
import { useFeedback } from "./feedback";
import "./PromptOverview.css";

type ColumnHandle = { save: () => Promise<WorkbenchPage | null>; dirty: () => boolean };
type Entry = { page: WorkbenchPage; chapter: string; sequence: string };
const columnWidth = 375;

function PromptColumn({ projectId, entry, characters, scenes, selected, busy, visible, onSelect, onOpenPage, onSaved, handles }: {
  projectId: string; entry: Entry; characters: ProjectWorkbenchView["characters"]; scenes: NonNullable<ProjectWorkbenchView["scenes"]>["scenes"]; selected: boolean; busy: boolean;
  onSelect: () => void; onOpenPage: () => void; onSaved: (page: WorkbenchPage) => void;
  handles: Map<string, ColumnHandle>; visible: boolean;
}) {
  const { page } = entry;
  const [base, setBase] = useState(page);
  const [draft, setDraft] = useState(() => structuredClone(page.prompt));
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.prompt);
  const conflict = page.model_id !== base.model_id || page.render_sha256 !== base.render_sha256 || page.prompt_sha256 !== base.prompt_sha256 || page.prompt_context_sha256 !== base.prompt_context_sha256;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!dirty) { setBase(page); setDraft(structuredClone(page.prompt)); }
  }, [page.prompt_sha256, page.prompt_context_sha256, page.model_id, page.render_sha256, dirty]);
  const handle: ColumnHandle = { dirty: () => dirty, save: async () => {
    if (!dirty) return page;
    if (conflict) { setError("页面已变化，请重新载入后编辑。"); return null; }
    setError("");
    try {
      const result = await savePagePrompt(projectId, base, draft);
      const saved = { ...base, prompt: result.prompt, prompt_sha256: result.prompt_sha256 };
      if (active.current) { setBase(saved); setDraft(structuredClone(saved.prompt)); onSaved(saved); }
      return saved;
    } catch (cause) { if (active.current) setError((cause instanceof Error ? cause.message : String(cause)) || "页面已变化，请重新载入后编辑。"); return null; }
  } };
  useLayoutEffect(() => { handles.set(page.page_id, handle); return () => { handles.delete(page.page_id); }; });
  return <article className="prompt-overview-column" data-overview-page={page.page_id} data-page-prompt-dirty={dirty ? "true" : undefined} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <header className="prompt-overview-column-header"><label><input type="checkbox" checked={selected} disabled={busy} onChange={onSelect} /><b>{page.title}</b></label><small>{entry.chapter} / {entry.sequence}</small><div><span>{dirty ? "● 未保存" : "已保存"}</span><button type="button" className="button button--quiet" disabled={busy} onClick={onOpenPage}>打开单页</button></div>
      <small>{page.model_id==='anima'?'Anima Basic':'Qwen-Image-2.1'} · {page.render?.canvas}</small>
      {(error || conflict && dirty) && <p role="alert">{error || "页面或角色已变化，草稿保留；请重新载入后编辑。"}<button type="button" disabled={busy} onClick={() => { setBase(page); setDraft(structuredClone(page.prompt)); setError(""); }}>放弃草稿并载入最新</button></p>}
      <small>{(page.characters ?? []).map(ref => { const c = characters.find(c => c.id === ref.character_id); return (c?.name ?? ref.character_id) + ' · ' + (c?.visual.variants.find(v => v.id === ref.variant_id)?.name ?? ref.variant_id); }).join('、')}{page.prompt.scene_id ? ' / 场景：' + (scenes.find(s => s.id === page.prompt.scene_id)?.name ?? page.prompt.scene_id) : ''}</small>
    </header>
    {(visible || focused) && <div className="prompt-overview-editor" inert={busy}>
      <ModelOverviewEditor page={base} prompt={draft} onChange={setDraft} disabled={busy}/>
    </div>}
  </article>;
}

export function PromptOverview({ projectId, view, focus, busy = false, onOpenPage, onSaved, onTrackedTasks }: {
  projectId: string; view: ProjectWorkbenchView; focus: { pageId: string; request: number } | null; busy?: boolean;
  onOpenPage: (page: WorkbenchPage) => void; onSaved: (page: WorkbenchPage) => void; onTrackedTasks: (projectId: string, taskIds: string[]) => void;
}) {
  const { notify } = useFeedback();
  const entries = useMemo(() => view.outline.chapters.flatMap(chapter => chapter.sequences.flatMap(sequence => sequence.pages.map(page => ({ page, chapter: chapter.title, sequence: sequence.title })))), [view.outline]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [count, setCount] = useState<1 | 3>(3);
  const handles = useRef(new Map<string, ColumnHandle>());
  const scroller = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState(() => {
    const index = Math.max(0, entries.findIndex(entry => entry.page.page_id === focus?.pageId));
    return { start: Math.max(0, index - 1), end: index + 6 };
  });
  function updateWindow() {
    const container = scroller.current;
    if (!container) return;
    const start = Math.max(0, Math.floor(container.scrollLeft / columnWidth) - 1);
    const end = Math.ceil((container.scrollLeft + container.clientWidth) / columnWidth) + 1;
    setWindow(current => current.start === start && current.end === end ? current : { start, end });
  }
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useLayoutEffect(() => {
    const container = scroller.current;
    const column = container?.querySelector<HTMLElement>(`[data-overview-page="${CSS.escape(focus?.pageId ?? "")}"]`);
    if (container && column) container.scrollLeft += column.getBoundingClientRect().left - container.getBoundingClientRect().left;
    updateWindow();
  }, [focus?.request, focus?.pageId, entries.length]);
  useEffect(() => {
    const observer = new ResizeObserver(updateWindow);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setSelected(current => new Set([...current].filter(id => entries.some(entry => entry.page.page_id === id)))); }, [entries]);

  async function run(generate: boolean) {
    if (working || busy) return;
    setWorking(true);
    const targets = entries.filter(({ page }) => generate ? selected.has(page.page_id) : handles.current.get(page.page_id)?.dirty());
    const tasks: string[] = [];
    let failures = 0, saved = 0;
    try {
      // 复用逐页指纹保存；失败页留在原地，不重试覆盖，不妨碍其他页完成。
      for (const { page } of targets) {
        if (!active.current) break;
        const result = await handles.current.get(page.page_id)?.save();
        if (!result) { failures++; continue; }
        saved++;
        if (generate) try {
          const result = await startPageRender(projectId, page.page_key, { operation: "candidates", count });
          tasks.push(result.task.task_id);
        } catch (cause) { failures++; if (active.current) notify({ kind: "error", message: `${page.title}：${cause instanceof Error ? cause.message : String(cause)}` }); }
      }
      if (tasks.length && active.current) onTrackedTasks(projectId, tasks);
      if (active.current) notify({ kind: failures ? "error" : "success", message: `${generate ? `已排队 ${tasks.length} 页` : `已保存 ${saved} 页`}${failures ? `；${failures} 页未完成，请查看错误` : ""}` });
    } finally { if (active.current) setWorking(false); }
  }

  const blockedPage = entries.find(({page}) => selected.has(page.page_id) && !(page.render_capabilities ?? view.render_capabilities).candidates.available)?.page;
  return <section className="prompt-overview" aria-label="Prompt 总览">
    <header className="prompt-overview-toolbar"><h2>Prompt 总览</h2><small>{entries.length} 页 · 已选 {selected.size} 页</small><button type="button" className="button" disabled={busy || working} onClick={() => void run(false)}>保存全部修改</button><GenerateSplitButton dirty={true} count={count} pageCount={selected.size} disabled={busy || working || !selected.size || Boolean(blockedPage)} reason={blockedPage ? `${blockedPage.title}：${(blockedPage.render_capabilities ?? view.render_capabilities).candidates.blocker ?? '生成不可用'}` : ''} onSubmit={() => void run(true)} onCountChange={setCount} /></header>
    <div className="prompt-overview-scroll" ref={scroller} onScroll={updateWindow}><div className="prompt-overview-grid" style={{ gridAutoColumns: columnWidth, gridTemplateRows: "auto minmax(0, auto)" } as CSSProperties}>
      {entries.map((entry, index) => <PromptColumn projectId={projectId} key={entry.page.page_id} entry={entry} characters={view.characters} scenes={view.scenes?.scenes ?? []} visible={index >= window.start && index < window.end} selected={selected.has(entry.page.page_id)} busy={busy || working} onSelect={() => setSelected(current => { const next = new Set(current); next.has(entry.page.page_id) ? next.delete(entry.page.page_id) : next.add(entry.page.page_id); return next; })} onOpenPage={() => onOpenPage(entry.page)} onSaved={onSaved} handles={handles.current} />)}
    </div></div>
  </section>;
}
