import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import ZoomableImageLightbox from './ImageLightbox';
import { NavigationContextMenu, type NavigationMenuRequest } from './NavigationContextMenu';
import { useLongPressContextMenu } from './use-long-press-context-menu';
import { useFeedback } from './feedback';
import { responseJson } from './api-response';
import { mutateTargetFacts, readFacts } from './project-write-client';
import { loadPageMedia, loadProjectWorkbench, type WorkbenchPage } from './project-workbench-client';
import './ReferenceLibrary.css';

export type ReferenceEntry = { id: string; file: string; title: string; purpose?: string; draft?: { content?: string; material_file?: string; candidate_id?:string;page_key?:{page_id:string};preview_url?:string } };
export type ReferenceTarget = { kind: 'character' | 'scene' | 'page'; id: string; variant_id?: string; model_id?: 'anima'|'qwen' };
export const referenceUrl = (project: string, file: string) => `/api/projects/${encodeURIComponent(project)}/materials/file?file=${encodeURIComponent(file)}`;

const entryUrl = (project: string, entry: ReferenceEntry) => entry.draft?.preview_url ?? (entry.draft?.content ? `data:image/png;base64,${entry.draft.content}` : referenceUrl(project, entry.draft?.material_file ?? entry.file));

export function ReferenceSelection({ projectId, entries, selection, onChange }: {
  projectId: string; entries: ReferenceEntry[]; selection?: string[]; onChange: (ids?: string[]) => void;
}) {
  const selected = selection ?? entries.slice(0, 1).map(e => e.id);
  if (!entries.length && !selected.length) return null;
  return <div className="reference-selection">
    <div className="reference-thumbnails reference-options">{entries.map(entry => <button type="button" key={entry.id} className="reference-toggle" aria-label={entry.title} aria-pressed={selected.includes(entry.id)} onClick={() => onChange(selected.includes(entry.id) ? selected.filter(id => id !== entry.id) : [...selected, entry.id])}>
      <img src={entryUrl(projectId, entry)} alt="" />
    </button>)}
    {selection !== undefined && <button type="button" className="reference-reset" aria-label="恢复默认" title="恢复默认" onClick={() => onChange()}>↺</button>}</div>
    {selected.some(id => !entries.some(e => e.id === id)) && <p role="alert">部分参考图已移除，请重新选择或恢复默认。</p>}
  </div>;

}

type LibraryState = { entries: ReferenceEntry[]; sha256: string };
type CandidateChoice = { candidate_id: string; page_id?: string; material_file?: string; content?: string; url?: string | null; title: string; purpose?: string };
export function ReferenceAddButton({ onClick, disabled, title }: { onClick: () => void; disabled?: boolean; title?: string }) { return <button type="button" className="button setting-reference-add" aria-label="添加参考图" title={title} disabled={disabled} onClick={onClick}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>; }

export function ReferenceLibrary({ projectId, target, pages, disabled, onChanged, inheritedEntries = [], initialEntries = [], capacity, onDraftChange, sourceVersion }: {
  projectId: string; target: ReferenceTarget; pages: WorkbenchPage[]; disabled?: boolean; onChanged: () => void; inheritedEntries?: ReferenceEntry[]; initialEntries?: ReferenceEntry[]; capacity?: number; sourceVersion?: string; onDraftChange?: (entries: ReferenceEntry[]) => void;
}) {
  const compact = target.kind === 'page';
  const [uploads, setUploads] = useState<CandidateChoice[] | null>(null);
  const [uploadReading, setUploadReading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ replaceId?: string } | null>(null);
  const [pageId, setPageId] = useState(''), [candidates, setCandidates] = useState<CandidateChoice[]>([]);
  const [projectPages,setProjectPages]=useState<WorkbenchPage[]>([]);
  const sourcePages=compact?projectPages:pages;
  useEffect(()=>{
    if(!picker||!compact)return;
    let active=true;
    void loadProjectWorkbench(projectId).then(({view})=>{if(active)setProjectPages(view.pages??view.outline.chapters.flatMap(chapter=>chapter.sequences.flatMap(sequence=>sequence.pages)));}).catch(cause=>{if(active)setError(cause.message);});
    return ()=>{active=false;};
  },[Boolean(picker),compact,projectId]);
  const [selected, setSelected] = useState<CandidateChoice[]>([]), [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState<NavigationMenuRequest | null>(null);
  const [preview, setPreview] = useState<ReferenceEntry | null>(null);
  const [purposeEdit, setPurposeEdit] = useState<{ entry: ReferenceEntry; purpose: string } | null>(null);
  const longPress = useLongPressContextMenu();
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; to: number; pointer: number } | null>(null);
  const [dragState, setDragState] = useState<{ from: number; to: number } | null>(null);
  const { confirm } = useFeedback();
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/workbench/reference-library`;
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    if (onDraftChange) return;
    let current = true;
    setError(''); setLibrary(null); setPicker(null);
    void readFacts(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'read', target }) })
      .then(responseJson<LibraryState>).then(value => { if (current) setLibrary(value); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [targetKey, endpoint, reload, sourceVersion]);
  useEffect(() => {
    let current = true; setCandidates([]);
    if (picker && compact && !pageId) {
      setLoading(true);
      void readFacts(`/api/projects/${encodeURIComponent(projectId)}/materials`).then(responseJson<{ materials: Array<{ file: string; title: string; available: boolean }> }>).then(value => { if (current) setCandidates(value.materials.filter(item => item.available && /\.(png|jpe?g|webp)$/i.test(item.file)).map(item => ({ candidate_id: item.file, material_file: item.file, title: item.title, url: referenceUrl(projectId, item.file) }))); }).catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setLoading(false); });
    } else if (picker && pageId) {
      setLoading(true);
      void loadPageMedia(projectId, { page_id: pageId }).then(value => {
        if (current) setCandidates((value?.media.candidates ?? []).map((candidate, index) => ({ ...candidate, page_id: pageId, title: `${sourcePages.find(p => p.page_id === pageId)?.title ?? '候选'} · ${index + 1}` })));
      }).catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setLoading(false); });
    } else setLoading(false);
    return () => { current = false; };
  }, [picker, pageId, projectId]);
  async function prepareUploads(files: File[]) {
    if (busy || disabled || uploadReading) return;
    setError(''); setUploadReading(true);
    try {
      if (files.some(file => !/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > 32 * 1024 * 1024)) throw new Error('请选择不超过 32MB 的 PNG、JPEG 或 WebP 图片。');
      if (picker?.replaceId && files.length > 1) throw new Error('替换时请选择一张图片。');
      const prepared = await Promise.all(files.map(file => new Promise<CandidateChoice>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('读取图片失败'));
        reader.onload = () => resolve({ candidate_id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, ''), content: String(reader.result).split(',')[1], url: String(reader.result) }); reader.readAsDataURL(file);
      })));
      if (prepared.length) setUploads(prepared);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setUploadReading(false); }
  }
  function saveChoices(choices: CandidateChoice[]) {
    return mutate(choices.map(candidate => ({ action: 'save', id: picker?.replaceId, ...(candidate.content ? { content: candidate.content } : candidate.material_file ? { material_file: candidate.material_file } : { page_key: { page_id: candidate.page_id }, candidate_id: candidate.candidate_id, preview_url:candidate.url }), title: candidate.title, ...(candidate.purpose?.trim() ? { purpose: candidate.purpose.trim() } : {}) })));
  }
  async function mutate(values: object[]) {
    if ((!library && !onDraftChange) || busy || disabled) return;
    if (capacity !== undefined && values.some(value => (value as {action?: string;id?: string}).action === 'save' && !(value as {id?: string}).id) && values.length > capacity) { setError('参考图合计最多 10 张，请减少选择。'); return; }
    if (onDraftChange) {
      let entries = [...initialEntries];
      for (const raw of values) {
        const value = raw as { action: string; id?: string; ids?: string[]; title?: string; purpose?: string; content?: string; material_file?: string;candidate_id?:string;page_key?:{page_id:string};preview_url?:string };
        if (value.action === 'delete') entries = entries.filter(entry => entry.id !== value.id);
        else if (value.action === 'reorder') entries = value.ids!.map(id => entries.find(entry => entry.id === id)!);
        else {
          const previous = value.id ? entries.find(entry => entry.id === value.id) : undefined;
          const purpose = value.purpose !== undefined ? value.purpose : previous?.purpose;
          const next: ReferenceEntry = { id: value.id ?? `ref-${crypto.randomUUID()}`, file: `reference-${crypto.randomUUID()}.png`, title: value.title!.trim(), ...(purpose?.trim() ? { purpose: purpose.trim() } : {}), draft: { ...(value.content ? { content: value.content } : value.material_file ? { material_file: value.material_file } : {candidate_id:value.candidate_id,page_key:value.page_key,preview_url:value.preview_url}) } };
          entries = value.id ? entries.map(entry => entry.id === value.id ? next : entry) : [...entries, next];
        }
      }
      onDraftChange(entries); setError(''); setPicker(null); setSelected([]); setUploads(null); return;
    }
    setBusy(true); setError('');
    let updated = library!, completed = 0;
    try {
      for (const value of values) {
        updated = await responseJson<LibraryState>(await mutateTargetFacts(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...value, target, expected_sha256: updated.sha256 }),
        }));
        completed++; setLibrary(updated);
      }
      setPicker(null); setSelected([]); setUploads(null);
    } catch (e) {
      setSelected(current => current.slice(completed)); setUploads(current => current ? current.slice(completed) : null);
      setError(`${completed ? `已添加 ${completed} 张，其余未添加。` : ''}${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); if (completed) onChanged(); }
  }
  function openPicker(replaceId?: string) {
    setSelected([]); setUploads(null); setError(''); setPageId(compact ? '' : pages[0]?.page_id ?? ''); setPicker({ replaceId });
  }
  async function remove(entry: ReferenceEntry) {
    if (onDraftChange) { await mutate([{ action: 'delete', id: entry.id }]); return; }
    if (await confirm({ kind: 'warning', title: '移除参考图', message: `移除“${entry.title}”？不再使用的图片会清理；仍被剧情页手动引用时会提示。`, danger: true })) await mutate([{ action: 'delete', id: entry.id }]);
  }
  function openMenu(point: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, entry: ReferenceEntry) {
    point.preventDefault?.(); point.stopPropagation?.();
    setMenu({ x: point.clientX, y: point.clientY, label: '参考图', items: [
      ...(onDraftChange ? [{ id: 'purpose', label: '编辑用途', disabled: busy || disabled, onSelect: () => setPurposeEdit({ entry, purpose: entry.purpose ?? '' }) }] : []),
      { id: 'replace', label: '替换', disabled: busy || disabled, onSelect: () => openPicker(entry.id) },
      { id: 'remove', label: '移除', danger: true, disabled: busy || disabled, onSelect: () => void remove(entry) },
    ] });
  }
  function savePurpose() {
    if (!purposeEdit || !onDraftChange) return;
    const purpose = purposeEdit.purpose.trim();
    onDraftChange(initialEntries.map(entry => entry.id === purposeEdit.entry.id ? { ...entry, ...(purpose ? { purpose } : { purpose: undefined }) } : entry));
    setPurposeEdit(null);
  }
  function turnPreview(direction: number) {
    if (!preview) return;
    const entries = onDraftChange ? initialEntries : library?.entries ?? [];
    const index = entries.findIndex(entry => entry.id === preview.id);
    setPreview(entries[(index + direction + entries.length) % entries.length]);
  }
  function finishDrag(pointer: number, cancel = false) {
    const current = drag.current; if (!current || current.pointer !== pointer) return;
    drag.current = null; setDragState(null);
    if (cancel || current.from === current.to) return;
    const ids = (onDraftChange ? initialEntries : library?.entries ?? []).map(entry => entry.id), [id] = ids.splice(current.from, 1);
    ids.splice(current.to, 0, id); void mutate([{ action: 'reorder', ids }]);
  }
  return <section className={compact ? "setting-reference-library page-attached-references" : "setting-reference-library"} aria-label={compact ? "最终启用的参考图" : "参考图"} {...longPress.captureProps}>
    {!compact && <div className="section-header"><h3>参考图</h3></div>}
    {error && !picker && <p role="alert">{error}<button type="button" className="button button--quiet" disabled={busy} onClick={() => setReload(value => value + 1)}>刷新</button></p>}
    {!onDraftChange && !library && !error && <p className="muted">正在读取…</p>}
    <fieldset className="reference-library-body" disabled={disabled || busy || (!library && !onDraftChange)}>
      <div className="setting-reference-grid" ref={grid} onPointerMove={event => {
        const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
        const cards = [...(grid.current?.querySelectorAll<HTMLElement>('[data-reference-card]') ?? [])];
        const slot = cards.findIndex(card => { const r = card.getBoundingClientRect(); return event.clientY < r.top || (event.clientY <= r.bottom && event.clientX < r.left + r.width / 2); });
        const raw = slot < 0 ? cards.length : slot, to = Math.max(0, Math.min(cards.length - 1, raw > current.from ? raw - 1 : raw));
        if (to !== current.to) { current.to = to; setDragState({ ...current }); }
      }} onPointerUp={event => finishDrag(event.pointerId)} onPointerCancel={event => finishDrag(event.pointerId, true)}>
        {compact && inheritedEntries.map((entry, index) => <img className="inherited-reference-image" key={index + entry.id} src={entryUrl(projectId, entry)} alt={entry.title} />)}
        {(library?.entries ?? initialEntries).map((entry, index) => <div className={`setting-reference-card${dragState?.from === index ? ' is-drag-source' : ''}${dragState && dragState.from !== dragState.to && dragState.to === index ? (dragState.to < dragState.from ? ' is-drag-before' : ' is-drag-after') : ''}`} data-reference-card={entry.id} key={entry.id} data-long-press-context-menu onContextMenu={event => openMenu(event, entry)} onPointerDown={event => longPress.start(event, point => openMenu(point, entry))}>
          <button type="button" className="setting-reference-image" aria-label={`查看参考图：${entry.title}`} title={entry.purpose ? `用途：${entry.purpose}` : undefined} onClick={() => setPreview(entry)}><img src={entryUrl(projectId, entry)} alt={entry.title} draggable={false} />{compact ? <span className="setting-reference-default">本页</span> : index === 0 && <span className="setting-reference-default">默认</span>}</button>
          <button type="button" className="reference-grip" aria-label={`拖动排序：${entry.title}`} title="拖动排序" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); grid.current?.setPointerCapture(event.pointerId); drag.current = { from: index, to: index, pointer: event.pointerId }; setDragState({ from: index, to: index }); }} onClick={event => { event.preventDefault(); event.stopPropagation(); }}><svg viewBox="0 0 12 18" aria-hidden="true">{[4, 9, 14].flatMap(y => [3, 8].map(x => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.2" />))}</svg></button>
        </div>)}
        <ReferenceAddButton title={disabled ? '请先保存修改' : '添加参考图'} onClick={() => openPicker()} />
      </div>
    </fieldset>
    <NavigationContextMenu request={menu} onClose={() => setMenu(null)} />
    {preview && <ZoomableImageLightbox fullResolutionOnly={Boolean(preview.draft?.content)} src={entryUrl(projectId, preview)} alt={preview.title} footer={<span>{preview.title}{preview.purpose ? ` · ${preview.purpose}` : ''}</span>} onClose={() => setPreview(null)} onPrevious={(onDraftChange ? initialEntries : library?.entries ?? []).length > 1 ? () => turnPreview(-1) : undefined} onNext={(onDraftChange ? initialEntries : library?.entries ?? []).length > 1 ? () => turnPreview(1) : undefined} />}
    {picker && <Modal className="reference-picker-modal" title={picker.replaceId ? '替换参考图' : '选择参考图'} busy={busy || uploadReading} onClose={() => { setPicker(null); setUploads(null); }} footer={<><button type="button" className="button button--quiet" disabled={busy} onClick={() => setPicker(null)}>取消</button><button type="button" className="button button--primary" disabled={busy || disabled || !selected.length} onClick={() => void saveChoices(selected)}>{busy ? '保存中…' : picker.replaceId ? '确认替换' : `添加${selected.length ? ` ${selected.length} 张` : ''}`}</button></>}>
      {error && <p role="alert">{error}</p>}
      <fieldset className="reference-library-body" disabled={busy || disabled || uploadReading} onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); void prepareUploads(Array.from(event.dataTransfer.files)); }}>
        <input ref={uploadInput} hidden type="file" accept=".png,.jpg,.jpeg,.webp" multiple={!picker.replaceId} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void prepareUploads(files); }} />
        {(compact || sourcePages.length > 1) && <label className="reference-candidate-source">图片来源<select aria-label="参考图候选来源" value={pageId} onChange={event => setPageId(event.target.value)}>{compact&&<option value="">项目素材</option>}{sourcePages.map(page => <option key={page.page_id} value={page.page_id}>{page.title} · 候选</option>)}</select></label>}
        {loading ? <p>正在读取图片…</p> : <div className="reference-candidate-grid"><details className="reference-upload-menu"><summary aria-label="上传参考图"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></summary><div><button type="button" className="button button--quiet" onClick={() => uploadInput.current?.click()}>选择图片</button><small>或将图片拖入面板</small></div></details>{candidates.map(candidate => {
          const checked = selected.some(item => item.page_id === candidate.page_id && item.candidate_id === candidate.candidate_id);
          return <button type="button" className="reference-candidate-choice" aria-label={candidate.title} aria-pressed={checked} key={candidate.candidate_id} onClick={() => setSelected(current => checked ? current.filter(item => item.page_id !== candidate.page_id || item.candidate_id !== candidate.candidate_id) : picker.replaceId ? [candidate] : [...current, candidate])}>{candidate.url && <img src={candidate.url} alt="" />}<span>{candidate.title}</span>{checked && <i aria-hidden="true">✓</i>}</button>;
        })}</div>}
        {!loading && !candidates.length && <p className="reference-picker-empty">还没有图片，可点击＋或拖入图片。</p>}
      </fieldset>
    </Modal>}
    {uploads && <Modal title="确认上传" busy={busy} onClose={() => setUploads(null)} footer={<><button type="button" className="button button--quiet" disabled={busy} onClick={() => setUploads(null)}>取消</button><button type="button" className="button button--primary" disabled={busy || uploads.some(item => !item.title.trim())} onClick={() => void saveChoices(uploads)}>{busy ? '上传中…' : '确认添加'}</button></>}>
      {error && <p role="alert">{error}</p>}
      <div className="reference-upload-previews">{uploads.map((item, index) => <label key={item.candidate_id}><img src={item.url ?? ''} alt="上传预览" /><input aria-label={`图片名称 ${index + 1}`} value={item.title} disabled={busy} onChange={event => setUploads(current => current!.map((entry, i) => i === index ? { ...entry, title: event.target.value } : entry))} />{compact && <input aria-label={`图片用途 ${index + 1}`} value={item.purpose ?? ''} placeholder="用途说明（可选）" disabled={busy} onChange={event => setUploads(current => current!.map((entry, i) => i === index ? { ...entry, purpose: event.target.value } : entry))} />}</label>)}</div>
    </Modal>}
    {purposeEdit && <Modal title="编辑附图用途" subtitle={purposeEdit.entry.title} busy={busy} onClose={() => setPurposeEdit(null)} footer={<><button type="button" className="button button--quiet" onClick={() => setPurposeEdit(null)}>取消</button><button type="button" className="button button--primary" onClick={savePurpose}>确定</button></>}>
      <label className="reference-purpose-field"><span>用途说明（可选，随页面草稿一起保存）</span><input aria-label="附图用途" value={purposeEdit.purpose} autoFocus onChange={event => setPurposeEdit(current => current ? { ...current, purpose: event.target.value } : current)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); savePurpose(); } }} /></label>
    </Modal>}
  </section>;
}
