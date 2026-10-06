const key = t => `${t.project_id}\0${t.purpose??'candidate'}\0${t.task_id??t.id}`;
// 固定经验档位：不查询历史，不拟合参数；任务完成立即返回。
export function fixedWaitBudget(targets, workspace, until='terminal') {
  const queue=workspace.tasks??[],wanted=new Set(targets.map(key));
  const positions=queue.flatMap((t,i)=>wanted.has(key(t))?[i]:[]);
  if(!positions.length)return {wait_ms:600000,basis:'fixed_fallback'};
  const end=until==='all_terminal'?Math.max(...positions):Math.min(...positions);
  const pending=queue.slice(0,end+1);
  const video=pending.some(t=>t.media_kind!=='image');
  const pages=pending.reduce((n,t)=>n+Math.max(1,t.page_count??1),0);
  const minutes=video?(pages===1?20:30):pages===1?2:pages<=4?5:10;
  return {wait_ms:minutes*60000,basis:'fixed_heuristic',media_kind:video?'video_or_unknown':'image',queue_pages:pages};
}
