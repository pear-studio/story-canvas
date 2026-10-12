// 按页面 Prompt/批次清理时保留迭代及其现存来源链；显式选图删除不受影响。
export function iterationCandidateIds(candidates) {
  const byId = new Map(candidates.map(candidate => [candidate.candidate_id, candidate]));
  const keep = new Set();
  for (const candidate of candidates) {
    if (!candidate.iteration) continue;
    let current = candidate;
    while (current && !keep.has(current.candidate_id)) {
      keep.add(current.candidate_id);
      current = byId.get(current.iteration?.source_candidate_id);
    }
  }
  return keep;
}
