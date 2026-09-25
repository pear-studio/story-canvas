import { requestWorkbench, loadWorkbenchConfig, projectRoute } from '../workbench-client.mjs';
import { schema, string } from './contract.mjs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const projectId = { project_id: string('登记的项目 ID') };
export const pageKey = { type: 'object', description: '页面身份 {page_id}', ...schema({ page_id: string('页面 ID') }) };
export const encode = encodeURIComponent;
export const projectPath = (args, suffix) => `${projectRoute(args.project_id)}/${suffix}`;
export async function jsonArtifact(value) {
  const root = fileURLToPath(new URL('../../../Saved/Agent/workbench-artifacts/', import.meta.url));
  await mkdir(root, { recursive: true });
  const file = path.join(root, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx' });
  return { file, content_type: 'application/json' };
}
// 每个操作声明自己的固定路径、参数和帮助；没有模型可控的任意路径入口。
export function endpoint(summary, method, route, properties = {}, { required = Object.keys(properties), details, body, query, credential, capability, project = false, transform } = {}) {
  const fields = { ...(project ? projectId : {}), ...properties, ...(credential ? { [credential]: string(`先读目标返回的 ${credential}，409 必须重读`) } : {}) };
  return { summary, parameters: schema(fields, [...(project ? ['project_id'] : []), ...required, ...(credential ? [credential] : [])]),
    details: `${details ?? '返回服务端回执。'}${credential ? ` 保存使用读取时的 ${credential}，不自动获取新版本覆盖。` : ''}${capability ? ` 需要 ${capability} 执行能力；极简预设禁用，不能通过其他操作绕过。` : ''}`, ...(capability ? { capability } : {}),
    transport: { method, route: typeof route === 'string' ? route : '领域固定路径', credential: credential ?? null },
    async execute(args) {
      let target = typeof route === 'function' ? route(args) : route;
      if (query) { const params = new URLSearchParams(Object.entries(query(args)).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)])); if (params.size) target += `?${params}`; }
      const result = await requestWorkbench(target, { method, ...(body ? { body: await body(args) } : method === 'GET' ? {} : { body: {} }), ...(credential ? { [credential]: args[credential] } : {}) });
      return transform ? transform(result, args) : result;
    },
  };
}
export async function localImage(file) {
  if (!path.isAbsolute(file)) throw new Error('图片路径必须是绝对路径');
  if (!['.png','.jpg','.jpeg','.webp'].includes(path.extname(file).toLowerCase())) throw new Error('仅接受 PNG/JPEG/WebP 图片');
  const info = await stat(file); if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('图片必须是最多32MB的普通文件');
  return { filename: path.basename(file), content: (await readFile(file)).toString('base64') };
}
export async function downloadArtifact(route, { method = 'GET', body, extension } = {}) {
  const { port = 3000 } = await loadWorkbenchConfig();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw Object.assign(new Error(await response.text()), { status: response.status });
  const root = fileURLToPath(new URL('../../../Saved/Agent/workbench-artifacts/', import.meta.url));
  await mkdir(root, { recursive: true });
  const mime=response.headers.get('content-type')?.split(';')[0];
  const suffix=extension ?? ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','text/plain':'txt','application/json':'json'}[mime] ?? 'bin');
  const file = path.join(root, `${randomUUID()}.${suffix}`);
  try { await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: 'wx' })); }
  catch(error) { await unlink(file).catch(()=>{}); throw error; }
  return { file, content_type: response.headers.get('content-type') };
}

