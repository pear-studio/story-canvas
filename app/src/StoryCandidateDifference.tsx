import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { inspectPageRender, loadCandidateDetail, type PageRenderInspection, type CandidateDetail, type StoryCandidateRefreshPage } from './project-workbench-client';
import { comparePromptText } from '../shared/prompt-comparison.mjs';

export function StoryCandidateDifference({ projectId, row, onClose }: { projectId: string; row: StoryCandidateRefreshPage & {title: string}; onClose: () => void }) {
  const [current, setCurrent] = useState<PageRenderInspection | null>(null);
  const [candidateId, setCandidateId] = useState(row.candidate_ids[0] ?? row.all_candidate_ids[0] ?? '');
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState('');
  const [candidateError, setCandidateError] = useState('');
  useEffect(() => {
    let active = true;
    inspectPageRender(projectId, row.page_key).then(result => { if (active) setCurrent(result.inspection); }, cause => { if (active) setError(String(cause.message ?? cause)); });
    return () => { active = false; };
  }, [projectId, row.page_key]);
  useEffect(() => {
    let active = true; setCandidate(null); setCandidateError('');
    if (candidateId) loadCandidateDetail(projectId, row.page_key, candidateId).then(result => { if (active) setCandidate(result.detail); }, cause => { if (active) setCandidateError(String(cause.message ?? cause)); });
    return () => { active = false; };
  }, [projectId, row.page_key, candidateId]);
  const labels = { same: '完全一致', format: '仅空格或换行不同', order: '词条相同，顺序或排版不同', content: '词句或权重有变化' };
  return <Modal size="workspace" className="candidate-difference-modal" title="候选差异详情" subtitle={row.title} onClose={onClose} footer={<button type="button" className="button" onClick={onClose}>关闭</button>}>
    <p>比较候选生成时的记录与当前已保存的生成条件；没有候选也会列入补齐范围。</p>
    <p>{row.all_candidate_ids.length ? `共 ${row.all_candidate_ids.length} 张候选，扫描时 ${row.matched} 张相符、${row.candidate_ids.length} 张不符。` : '本页没有候选图，没有旧 Prompt 可比较。'}</p>
    {current && current.generation_signature !== row.signature && <p>扫描后页面状态已变化，请关闭并重新扫描后再生成或清理。</p>}
    {error && <p role="alert">{error}</p>}
    {!current && !error && <p role="status">正在读取当前 Prompt…</p>}
    {current?.blockers.map((issue, index) => <p key={index}>{issue.message}</p>)}
    {candidateId && <label>比较候选 <select aria-label="比较候选" value={candidateId} onChange={event => setCandidateId(event.target.value)}>{row.all_candidate_ids.map((id, index) => <option key={id} value={id}>候选 {index + 1} · {row.candidate_ids.includes(id) ? '不符' : '相符'} · {id.slice(-8)}</option>)}</select></label>}
    {candidateError && <p role="alert">候选详情读取失败：{candidateError}</p>}
    {candidateId && !candidate && !candidateError && <p role="status">正在读取候选记录…</p>}
    {candidate && <p>生成时间：{candidate.completed_at ?? candidate.created_at ?? '未记录'} · Seed：{candidate.seed ?? '未记录'}</p>}
    {current && (!candidateId || candidate) && (['positive', 'negative'] as const).map(polarity => {
      const before = candidate?.generation.prompt[polarity] ?? '', after = current.prompt[polarity];
      const difference = comparePromptText(before, after, candidate?.generation.prompt.parts[polarity], current.prompt.parts[polarity]);
      return <section className="candidate-prompt-comparison" key={polarity}>
        <h3>{polarity === 'positive' ? '正向 Prompt' : '负向 Prompt'}{candidate ? ` · ${labels[difference.kind]}` : ''}</h3>
        {candidate && (difference.removed.length > 0 || difference.added.length > 0) && <div className="candidate-prompt-comparison-columns">
          <div><b>旧候选中独有</b>{difference.removed.map((text, index) => <p className="candidate-prompt-removed" key={index}>{text}</p>)}</div>
          <div><b>当前中独有</b>{difference.added.map((text, index) => <p className="candidate-prompt-added" key={index}>{text}</p>)}</div>
        </div>}
        <details open={difference.kind === 'order' || difference.kind === 'format' || !candidate}><summary>完整文本</summary><div className="candidate-prompt-comparison-columns">
          {candidate && <div><b>旧候选</b><pre>{before || '（空）'}</pre></div>}
          <div><b>当前已保存</b><pre>{after || '（空）'}</pre></div>
        </div></details>
      </section>;
    })}
    {current && candidate && row.candidate_ids.includes(candidateId) && current.prompt.positive === candidate.generation.prompt.positive && current.prompt.negative === candidate.generation.prompt.negative && <p>正负向文本一致；扫描签名仍不符，差异来自模型、LoRA、参考图、采样配置或缺失的历史记录。</p>}
  </Modal>;
}
