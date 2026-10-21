import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// 串行写入，最多保留当前文件和一份旧文件；日志失败不影响业务。
export function createPerformanceLog(root, maxBytes = 5 * 1024 * 1024, filename = 'performance.jsonl') {
  const directory = path.join(root, 'Saved', 'Logs');
  const file = path.join(directory, filename);
  let queue = Promise.resolve();
  return record => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n';
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true });
      const size = await stat(file).then(value => value.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await rm(file + '.1', { force: true });
        await rename(file, file + '.1');
      }
      await appendFile(file, line);
    }).catch(error => console.warn('[performance-log]', error.message));
    return queue;
  };
}

export function browserPerformanceRecord(value) {
  if(value?.event==='video-preview') {
    if(!['loaded','failed','cancelled'].includes(value.outcome)||!['fetch','decode'].includes(value.stage)
      ||![320,1024].includes(value.width)||!Number.isFinite(value.duration_ms)||value.duration_ms<0
      ||typeof value.source!=='string'||!/^\/api\/projects\/[^/?]+\/media\/Outputs\/[^?]+\.mp4$/.test(value.source))return null;
    const number=field=>Number.isFinite(value[field])&&value[field]>=0?Math.round(value[field]):0;
    return {kind:'browser',event:value.event,outcome:value.outcome,stage:value.stage,width:value.width,
      request_id:String(value.request_id??'').slice(0,80),source:value.source.slice(0,500),
      duration_ms:number('duration_ms'),fetch_ms:number('fetch_ms'),decode_ms:number('decode_ms'),bytes:number('bytes'),status:number('status')};
  }
  if (!value || value.event !== 'workbench-load' || !['applied', 'discarded', 'failed'].includes(value.outcome)
    || !Number.isFinite(value.duration_ms) || value.duration_ms < 0) return null;
  return {
    kind: 'browser', event: value.event, outcome: value.outcome,
    duration_ms: Math.round(value.duration_ms),
    request_id: String(value.request_id ?? '').slice(0, 80),
    scope: String(value.scope ?? '').slice(0, 30),
  };
}
