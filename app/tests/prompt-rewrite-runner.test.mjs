import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parsePromptRewrite, runPromptRewrite } from '../server/prompt-rewrite-runner.mjs';

async function fixture(t, answer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'story-canvas-pe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const systemPromptPath = path.join(dir, 'system.txt');
  await writeFile(systemPromptPath, 'Official persona with "quotes" and 中文.\n');
  let submitted;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/prompt') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      submitted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.end(JSON.stringify({ prompt_id: 'prompt-1' }));
    } else if (request.url === '/history/prompt-1') {
      response.end(JSON.stringify(answer === null ? {} : {
        'prompt-1': answer === 'error'
          ? { status: { status_str: 'error' } }
          : { outputs: { '3': { text: [answer] } } },
      }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    positivePrompt: 'A portrait with <image1> beside her',
    comfyUrl: `http://127.0.0.1:${server.address().port}`,
    modelName: 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
    systemPromptPath, taskDirectory: path.join(dir, 'task'),
    submitted: () => submitted,
  };
}

test('submits the official PE prompt to INT8 TextGenerate and parses the answer', async (t) => {
  const args = await fixture(t, 'thinking text</think>\n{"rewritten_prompt":"An image of 中文","wh_ratio":"3:2"}');
  const result = await runPromptRewrite(args);
  assert.deepEqual(result, { rewritten_prompt: 'An image of 中文', wh_ratio: '3:2' });
  const graph = args.submitted().prompt;
  assert.equal(graph['1'].inputs.clip_name, args.modelName);
  assert.equal(graph['2'].inputs.thinking, true);
  assert.equal(graph['2'].inputs.max_length, 4096);
  assert.match(graph['2'].inputs.prompt, /Official persona with "quotes" and 中文/);
  assert.match(graph['2'].inputs.prompt, /A portrait with <image1> beside her/);
  assert.equal(graph['3'].class_type, 'SaveText');
  const diagnostic = JSON.parse(await readFile(path.join(args.taskDirectory, 'diagnostic.json'), 'utf8'));
  assert.equal(diagnostic.status, 'completed');
  assert.equal(JSON.stringify(diagnostic).includes(args.positivePrompt), false);
});

test('accepts the last valid JSON object after thinking and rejects incomplete answers', () => {
  assert.deepEqual(parsePromptRewrite('x</think> note {bad} {"rewrited_prompt":"ok {x}","wh_ratio":"2:3"}'), {
    rewritten_prompt: 'ok {x}', wh_ratio: '2:3',
  });
  assert.throws(() => parsePromptRewrite('<think>unfinished'), { code: 'INVALID_RESULT' });
});

test('reports ComfyUI errors and bounded timeout diagnostics', async (t) => {
  const failed = await fixture(t, 'error');
  await assert.rejects(runPromptRewrite(failed), { code: 'COMFY_FAILED' });
  const waiting = await fixture(t, null);
  await assert.rejects(runPromptRewrite({ ...waiting, timeoutMs: 1100 }), { code: 'TIMEOUT' });
  const diagnostic = JSON.parse(await readFile(path.join(waiting.taskDirectory, 'diagnostic.json'), 'utf8'));
  assert.equal(diagnostic.code, 'TIMEOUT');
  assert.equal(JSON.stringify(diagnostic).includes(waiting.positivePrompt), false);
});
