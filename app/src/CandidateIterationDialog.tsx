import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import ZoomableImageLightbox from './ImageLightbox';
import { mediaVariantUrl } from './media-variant';
import type { Candidate, CandidateDetail, CandidateIterationRequest, IterationLora } from './project-workbench-client';
import './candidate-iteration.css';

export function CandidateIterationDialog({ candidate, sourceCandidate, reiterate = false, onClose, onSubmit, onLoadProjectLoras, onLoadPreviousDetail }: {
  candidate: Candidate; onClose: () => void; onSubmit: (request: CandidateIterationRequest) => Promise<void>;
  sourceCandidate?: Candidate; reiterate?: boolean;
  onLoadProjectLoras?: () => Promise<IterationLora[]>;
  onLoadPreviousDetail?: (candidate: Candidate) => Promise<CandidateDetail>;
}) {
  const [instruction, setInstruction] = useState('');
  const [count, setCount] = useState(1);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(false);
  const [typing, setTyping] = useState(false);
  const [useProjectLoras, setUseProjectLoras] = useState(true);
  const [projectLoras, setProjectLoras] = useState<IterationLora[] | null>(null);
  const [loraError, setLoraError] = useState('');
  const [previousReady, setPreviousReady] = useState(!reiterate);
  const [previousError, setPreviousError] = useState('');
  const [readNonce, setReadNonce] = useState(0);
  const preview = reiterate ? sourceCandidate : candidate;
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!reiterate) return;
    let active = true;
    setPreviousReady(false); setPreviousError('');
    const load = async () => {
      if (!onLoadPreviousDetail) throw new Error('无法读取上次迭代信息。');
      const detail = await onLoadPreviousDetail(candidate);
      const instruction = detail.generation.prompt.sections.find(section => section.kind === 'page')?.text;
      if (detail.candidate_id !== candidate.candidate_id || detail.iteration?.source_candidate_id !== candidate.iteration?.source_candidate_id || typeof instruction !== 'string' || !instruction.trim()) throw new Error('上次迭代信息不完整，请刷新候选列表。');
      if (active) {
        setInstruction(instruction);
        setSeed(detail.seed === null ? '' : String(detail.seed));
        setPreviousReady(true);
      }
    };
    void load().catch(cause => { if (active) setPreviousError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [candidate.candidate_id, reiterate, onLoadPreviousDetail, readNonce]);
  useEffect(() => {
    let active = true;
    setProjectLoras(null); setLoraError('');
    (onLoadProjectLoras ? onLoadProjectLoras() : Promise.resolve([])).then(
      loras => { if (active) setProjectLoras(loras); },
      cause => { if (active) setLoraError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { active = false; };
  }, [onLoadProjectLoras]);
  useEffect(() => {
    const backdrop = form.current?.closest<HTMLElement>('.modal-backdrop');
    const viewport = window.visualViewport;
    if (!backdrop || !viewport) return;
    const resize = () => {
      const mobile = window.matchMedia('(max-width: 700px)').matches;
      backdrop.style.setProperty('--iteration-height', mobile ? `${viewport.height}px` : '100dvh');
      backdrop.style.setProperty('--iteration-top', mobile ? `${viewport.offsetTop}px` : '0px');
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => { viewport.removeEventListener('resize', resize); viewport.removeEventListener('scroll', resize); };
  }, [viewing]);
  const seedValid = seed === '' || (/^\d+$/.test(seed) && Number(seed) + count - 1 <= 2147483647);
  const lorasReady = !useProjectLoras || projectLoras !== null;
  const ready = previousReady && Boolean(preview);
  async function submit() {
    if (inFlight.current || !ready || !instruction.trim() || !seedValid || !lorasReady) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await onSubmit({ instruction, count, use_project_loras: useProjectLoras, ...(reiterate ? { reiterate: true } : {}), ...(seed === '' ? {} : { seed: Number(seed) }) });
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (viewing && preview) return <ZoomableImageLightbox src={preview.url} alt="迭代来源图" footer="返回后继续填写修改要求" onClose={() => setViewing(false)} />;
  return <Modal title={reiterate ? '重新迭代' : '迭代候选图'} subtitle="Qwen-Image-2.1" className={`candidate-iteration-dialog ${typing ? 'is-typing' : ''}`} onClose={onClose} busy={busy}
    footer={<><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" form="candidate-iteration-form" className="button button--primary" disabled={busy || !ready || !instruction.trim() || !seedValid || !lorasReady}>{busy ? '正在提交…' : `生成 ${count} 张候选`}</button></>}>
    <form id="candidate-iteration-form" ref={form} className="candidate-iteration-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {preview ? <button type="button" className="candidate-iteration-preview" onClick={() => setViewing(true)} disabled={busy} aria-label="放大迭代来源图">
        <img src={mediaVariantUrl(preview.url, 1024)} alt="本次迭代来源" /><span>{reiterate ? '上次使用的来源图 · 点按放大' : '点按放大查看'}</span>
      </button> : <p className="candidate-iteration-error" role="alert">来源图已删除，无法重新迭代。</p>}
      <div className="candidate-iteration-fields">
        {!previousReady && (previousError ? <p className="candidate-iteration-error" role="alert">{previousError}<button type="button" className="button button--quiet" onClick={() => setReadNonce(value => value + 1)}>重试读取</button></p> : <p role="status">正在读取上次迭代指令…</p>)}
        <label>修改要求<textarea value={instruction} maxLength={8000} rows={6} placeholder="例如：修正右手的手指，保持人物、服装和构图。" disabled={busy || !ready} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} onChange={event => setInstruction(event.target.value)} /></label>
        <label className="candidate-iteration-count">生成数量<select value={count} disabled={busy} onChange={event => setCount(Number(event.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value} 张</option>)}</select></label>
        <div className="candidate-iteration-loras">
          <label><input type="checkbox" checked={useProjectLoras} disabled={busy} onChange={event => setUseProjectLoras(event.target.checked)} />使用项目 Qwen LoRA</label>
          {loraError ? <p role="alert">LoRA 设置读取失败：{loraError}</p> : projectLoras === null ? <p role="status">正在读取 LoRA 设置…</p> : projectLoras.length ? <ul>{projectLoras.map(lora => <li key={lora.filename} title={lora.filename}>{lora.filename.split('/').at(-1)?.replace(/\.safetensors$/i, '')} · 权重 {lora.weight}</li>)}</ul> : <p>项目 Qwen 尚未选择 LoRA。</p>}
          <p>{useProjectLoras ? '版本和权重在项目生成设置中调整；触发词自动带入。' : '本次不使用 LoRA，不改变项目设置。'}</p>
        </div>
        <details open={reiterate || undefined}><summary>高级设置</summary><label>Seed<input type="text" inputMode="numeric" value={seed} placeholder="随机" disabled={busy || !ready} onChange={event => setSeed(event.target.value)} /></label>{!seedValid && <p role="alert">Seed 必须为非负整数，且全部候选的种子不超过 2147483647。</p>}</details>
        <p className="candidate-iteration-note">{reiterate ? '修改上次指令，在上次来源图上重新生成。LoRA 使用当前项目设置。' : '按原图尺寸编辑。'}结果加入本页候选。修改要求仅用于本次任务。</p>
        {error && <p className="candidate-iteration-error" role="alert">{error}</p>}
      </div>
    </form>
  </Modal>;
}
