import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const terminal = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
const cursor = task => createHash('sha256').update(JSON.stringify({
  status: task.status, counts: task.item_counts, page: task.current_page_key,
  control: task.pending_control, error: task.error,
  progress: task.progress?.max > 0 ? Math.floor(10 * task.progress.value / task.progress.max) : null,
})).digest('hex').slice(0, 20);

// 工具内串行轮询；模型只收到一次有界摘要。中止信号只结束读取，不发送任务控制请求。
export async function waitForTasks({ targets, wait_ms = 600000, until = 'terminal' }, { signal, read, intervalMs = 2000 }) {
  if (signal?.aborted) throw Object.assign(new Error('等待已取消；生成任务未取消。'), { code: 'wait_cancelled' });
  const deadline = AbortSignal.timeout(wait_ms || 5000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = Date.now(), snapshots = new Map(), baselines = new Map();
  const result = reason => {
    const summary={total:targets.length,completed:0,failed:0,cancelled:0,incomplete:0,pending:0,unknown:0,items_total:0,items_available:0,items_failed:0};
    for(let index=0;index<targets.length;index++) {
      const value=snapshots.get(index);
      if(!value || value.error)summary.unknown++;
      else {
        summary[value.terminal?value.task.status:'pending']++;
        for(const key of ['total','available','failed'])summary[`items_${key}`]+=value.task.item_counts?.[key]??0;
      }
    }
    const all_terminal=summary.unknown===0 && summary.pending===0;
    const remaining=targets.flatMap((target,index)=>{
      const snapshot=snapshots.get(index);
      if(until!=='all_terminal' && snapshot?.terminal)return [];
      return [{...target,...(snapshot?.cursor?{after_cursor:snapshot.cursor}:{})}];
    });
    return { reason, elapsed_ms: Date.now() - started, summary,all_terminal,all_succeeded:all_terminal && summary.completed===summary.total,
      ...(!all_terminal && remaining.length?{wait:{operation:'task.wait',args:{targets:remaining,until,wait_ms}}}:{}),tasks: targets.map((target, index) => {
    const snapshot = snapshots.get(index);
    if (snapshot) {
      if (target.after_cursor && !snapshot.changed && !snapshot.error) {
        const {task, ...identity} = snapshot;
        return {...identity, status: task.status};
      }
      return snapshot;
    }
    return {
      project_id: target.project_id, task_id: target.task_id, purpose: target.purpose ?? 'candidate',
      error: { code: 'status_unknown', message: '本次等待期限内未取得状态，请继续查询原任务，不重复提交。' },
    };
  }) };
  };
  try {
    while (true) {
      await Promise.all(targets.map(async (target, index) => {
        if(snapshots.get(index)?.terminal)return;
        const identity = { project_id: target.project_id, task_id: target.task_id, purpose: target.purpose ?? 'candidate' };
        try {
          const task = await read(identity, combined), next = cursor(task);
          const previous = target.after_cursor ?? baselines.get(index) ?? next;
          baselines.set(index, previous);
          snapshots.set(index, { ...identity, cursor: next, changed: previous !== next, terminal: terminal.has(task.status), task });
        } catch (error) {
          if (combined.aborted) throw error;
          snapshots.set(index, { ...identity, error: { code: error.code ?? 'task_read_failed', message: error.message, ...(error.status ? { status: error.status } : {}) } });
        }
      }));
      const values = [...snapshots.values()];
      if (values.some(value => value.error)) return result('error');
      if (until==='all_terminal' ? values.length===targets.length && values.every(value=>value.terminal) : values.some(value => value.terminal)) return result('terminal');
      if (until === 'change' && values.some(value => value.changed)) return result('changed');
      if (wait_ms === 0) return result('snapshot');
      await delay(intervalMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('等待已取消；生成任务未取消。'), { code: 'wait_cancelled' });
    if (deadline.aborted) return result('timeout');
    throw error;
  }
}
