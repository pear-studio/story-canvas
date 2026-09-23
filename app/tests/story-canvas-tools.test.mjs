import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t, responder) {
  const testsRoot = path.join(repositoryRoot, 'Saved', 'Tests');
  await mkdir(testsRoot, { recursive: true });
  const root = await mkdtemp(path.join(testsRoot, 'dsh-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    '.dsh/presets/story-canvas/story-canvas-tools.mjs',
    'app/scripts/workbench-client.mjs',
    'app/server/page-key.mjs',
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(repositoryRoot, file), path.join(root, file));
  }
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    for await (const _chunk of request) { /* 消费请求体，响应由用例控制。 */ }
    response.setHeader('content-type', 'application/json');
    responder(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await mkdir(path.join(root, 'Config'));
  await writeFile(path.join(root, 'Config/local.json'), JSON.stringify({ port: server.address().port }));
  const { apply } = await import(pathToFileURL(path.join(root, '.dsh/presets/story-canvas/story-canvas-tools.mjs')));
  const tools = new Map();
  apply({ tools: { register: definition => tools.set(definition.name, definition) } });
  return { tools, requests: () => requests };
}

// DSH 对普通异常只呈现 Error.message；必须从该文本恢复诊断，不能依赖异常自定义属性。
async function failurePayload(tool, args) {
  let failure;
  try { await tool.execute(args); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, '失败必须抛出异常，不能成为工具成功结果');
  return JSON.parse(failure.message);
}

test('DSH 两个注册工具的失败文本保留状态码、错误码与诊断，不重放请求', async t => {
  const expected = { error: 'fact_upstream_conflict', message: '事实依赖已变化', status: 409,
    details: { target_id: 'page-001', changed: ['character:alice'] } };
  const { tools, requests } = await fixture(t, (_request, response) => {
    response.statusCode = expected.status;
    response.end(JSON.stringify(expected));
  });
  assert.deepEqual(await failurePayload(tools.get('story_canvas_api'), {
    method: 'POST', path: '/api/agent/facts/page/prompt/save', body: {},
  }), expected);
  assert.deepEqual(await failurePayload(tools.get('story_canvas_facts'), {
    operation: 'save', domain: 'page', kind: 'prompt', draft: {},
  }), expected);
  assert.equal(requests(), 2);
});

test('DSH 参数错误也在失败文本中保留错误码，且不发送请求', async t => {
  const { tools, requests } = await fixture(t, () => assert.fail('无效参数不应发送请求'));
  for (const [name, args] of [
    ['story_canvas_api', { method: 'PATCH', path: '/api/test' }],
    ['story_canvas_facts', { operation: 'save', domain: 'page', kind: 'prompt' }],
  ]) {
    const payload = await failurePayload(tools.get(name), args);
    assert.equal(payload.error, 'invalid_arguments');
    assert.equal(typeof payload.message, 'string');
    assert.equal(Object.hasOwn(payload, 'status'), false);
    assert.equal(Object.hasOwn(payload, 'details'), false);
  }
  assert.equal(requests(), 0);
});

test('DSH 错误适配不改变两个工具的成功结果与渲染', async t => {
  const draft = { project_id: 'demo', document: { text: '中文正文' } };
  const { tools } = await fixture(t, (_request, response) => {
    response.setHeader('x-story-canvas-revision', 'r1');
    response.end(JSON.stringify(draft));
  });
  for (const [name, args, expected] of [
    ['story_canvas_api', { method: 'GET', path: '/api/test' }, { value: draft, revision: 'r1' }],
    ['story_canvas_facts', { operation: 'read', domain: 'story', kind: 'outline', project_id: 'demo' }, draft],
  ]) {
    const tool = tools.get(name);
    const value = await tool.execute(args);
    assert.deepEqual(value, expected);
    assert.deepEqual(JSON.parse(tool.output.render(args, value)[0].text), expected);
  }
});
