import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RESULT_CHARS = 2 * 1024 * 1024;

export class PromptRewriteRunnerError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'PromptRewriteRunnerError';
    this.code = code;
  }
}

function requireAbsoluteFile(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new PromptRewriteRunnerError(`${name}_MUST_BE_ABSOLUTE`);
  }
  return value;
}

function answerObjects(text) {
  if (text.includes('<think>') && !text.includes('</think>')) return [];
  const answer = text.includes('</think>') ? text.slice(text.indexOf('</think>') + '</think>'.length) : text;
  const candidates = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < answer.length; index += 1) {
    const char = answer[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(answer.slice(start, index + 1));
    }
  }
  return candidates.reverse();
}

export function parsePromptRewrite(text) {
  if (typeof text !== 'string' || text.length > MAX_RESULT_CHARS) {
    throw new PromptRewriteRunnerError('INVALID_RESULT');
  }
  for (const candidate of answerObjects(text)) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    const prompt = value?.rewritten_prompt ?? value?.rewrited_prompt;
    if (typeof prompt === 'string' && prompt.trim()
      && typeof value.wh_ratio === 'string' && /^\d{1,3}:\d{1,3}$/.test(value.wh_ratio)) {
      return { rewritten_prompt: prompt.trim(), wh_ratio: value.wh_ratio };
    }
  }
  throw new PromptRewriteRunnerError('INVALID_RESULT');
}

function workflow(systemPrompt, positivePrompt, modelName) {
  const prompt = [
    `<|im_start|>system\n${systemPrompt.trim()}<|im_end|>`,
    `<|im_start|>user\n${positivePrompt.trim()}<|im_end|>`,
    '<|im_start|>assistant\n<think>\n',
  ].join('\n');
  return {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: modelName, type: 'qwen_image', device: 'default' } },
    '2': { class_type: 'TextGenerate', inputs: {
      clip: ['1', 0], prompt, max_length: 4096,
      sampling_mode: 'on', 'sampling_mode.temperature': 1.0,
      'sampling_mode.top_k': 20, 'sampling_mode.top_p': 0.95,
      'sampling_mode.min_p': 0.0, 'sampling_mode.repetition_penalty': 1.0,
      'sampling_mode.presence_penalty': 1.5, 'sampling_mode.seed': Math.floor(Math.random() * 2 ** 32),
      thinking: true, use_default_template: false, mtp: 'off',
    } },
    '3': { class_type: 'SaveText', inputs: {
      text: ['2', 0], filename_prefix: 'StoryCanvas/page-rewrite', format: 'txt',
    } },
  };
}

async function pollDelay(signal) {
  await new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 1000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function rewriteProgressFromMessage(message, promptId) {
  let event;
  try { event = JSON.parse(message); } catch { return null; }
  if (!promptId || event?.data?.prompt_id !== promptId) return null;
  if (event.type === 'executing' && ['1', '2'].includes(event.data.node)) return { phase: 'loading' };
  if (event.type === 'progress' && Number.isFinite(event.data.value)) return { phase: 'generating', tokens: event.data.value };
  if (event.type === 'executing' && event.data.node === '3') return { phase: 'saving' };
  return null;
}

async function runComfy(comfyUrl, graph, signal, onProgress) {
  const base = comfyUrl.replace(/\/+$/, '');
  const clientId = randomUUID();
  let promptId = null, socket = null, phase = 'queued';
  const report = value => { phase = value.phase; onProgress?.({ ...value, prompt_id: promptId }); };
  try {
    socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
    socket.addEventListener('error', () => {});
    socket.addEventListener('message', event => {
      const value = rewriteProgressFromMessage(event.data, promptId);
      if (value) report(value);
    });
  } catch { /* 无 WebSocket 时仍可轮询执行状态与结果。 */ }
  try {
    let response;
    try {
      response = await fetch(`${base}/prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }), signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PromptRewriteRunnerError('COMFY_UNAVAILABLE', error);
    }
    if (!response.ok) throw new PromptRewriteRunnerError('COMFY_FAILED');
    let queued;
    try { queued = await response.json(); }
    catch (error) { throw new PromptRewriteRunnerError('COMFY_FAILED', error); }
    if (typeof queued.prompt_id !== 'string' || !queued.prompt_id) {
      throw new PromptRewriteRunnerError('COMFY_FAILED');
    }
    promptId = queued.prompt_id;
    report({ phase: 'queued' });
    for (;;) {
      await pollDelay(signal);
      let historyResponse;
      try { historyResponse = await fetch(`${base}/history/${encodeURIComponent(queued.prompt_id)}`, { signal }); }
      catch (error) {
        if (signal.aborted) throw error;
        throw new PromptRewriteRunnerError('COMFY_UNAVAILABLE', error);
      }
      if (!historyResponse.ok) throw new PromptRewriteRunnerError('COMFY_FAILED');
      let envelope;
      try { envelope = await historyResponse.json(); }
      catch (error) { throw new PromptRewriteRunnerError('COMFY_FAILED', error); }
      const history = envelope[queued.prompt_id];
      if (!history) {
        if (phase === 'queued') {
          try {
            const queueResponse = await fetch(`${base}/queue`, { signal });
            if (queueResponse.ok) {
              const queue = await queueResponse.json();
              if (queue.queue_running?.some(item => item[1] === promptId)) report({ phase: 'running' });
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // 进度不可用不影响通过 history 获取结果。
          }
        }
        continue;
      }
      if (history.status?.status_str === 'error') throw new PromptRewriteRunnerError('COMFY_FAILED');
      const text = history.outputs?.['3']?.text?.[0];
      if (typeof text === 'string') return text;
      if (history.status?.completed) throw new PromptRewriteRunnerError('COMFY_FAILED');
    }
  } finally {
    try { socket?.close(); } catch { /* 关闭可选进度连接。 */ }
  }
}

/** Run the official Qwen PE-T2I prompt on ComfyUI's installed INT8 TextGenerate node. */
export async function runPromptRewrite({
  positivePrompt, comfyUrl, modelName, systemPromptPath,
  taskDirectory, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress,
}) {
  if (typeof positivePrompt !== 'string' || !positivePrompt.trim()) {
    throw new PromptRewriteRunnerError('EMPTY_PROMPT');
  }
  if (typeof comfyUrl !== 'string' || !/^https?:\/\/[^/]+/.test(comfyUrl)) {
    throw new PromptRewriteRunnerError('INVALID_COMFY_URL');
  }
  if (typeof modelName !== 'string' || !modelName.endsWith('.safetensors') || /[\\/]/.test(modelName)) {
    throw new PromptRewriteRunnerError('INVALID_MODEL_NAME');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new PromptRewriteRunnerError('INVALID_TIMEOUT');
  }
  const promptPath = requireAbsoluteFile(systemPromptPath, 'SYSTEM_PROMPT_PATH');
  const directory = requireAbsoluteFile(taskDirectory, 'TASK_DIRECTORY');
  if (!(await stat(promptPath).catch(() => null))?.isFile()) {
    throw new PromptRewriteRunnerError('REQUIRED_FILE_MISSING');
  }
  const systemPrompt = await readFile(promptPath, 'utf8');
  if (!systemPrompt.trim()) throw new PromptRewriteRunnerError('EMPTY_SYSTEM_PROMPT');
  await mkdir(directory, { recursive: true });
  const controller = new AbortController();
  let stopCode = null;
  const stop = (code) => { stopCode = code; controller.abort(); };
  const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
  const onAbort = () => stop('CANCELLED');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const started = Date.now();
  const graph = workflow(systemPrompt, positivePrompt, modelName);
  let diagnostic = {
    status: 'failed', code: 'UNKNOWN', duration_ms: 0, model: modelName,
    seed: graph['2'].inputs['sampling_mode.seed'],
    system_prompt_sha256: createHash('sha256').update(systemPrompt).digest('hex'),
  };
  try {
    const raw = await runComfy(comfyUrl, graph, controller.signal, progress => {
      diagnostic.prompt_id = progress.prompt_id;
      onProgress?.(progress);
    });
    const result = parsePromptRewrite(raw);
    diagnostic = { ...diagnostic, status: 'completed', code: null };
    return result;
  } catch (error) {
    diagnostic = { ...diagnostic, code: stopCode ?? error?.code ?? 'COMFY_FAILED' };
    throw stopCode ? new PromptRewriteRunnerError(stopCode, error) : error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    diagnostic.duration_ms = Date.now() - started;
    await writeFile(path.join(directory, 'diagnostic.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
  }
}
