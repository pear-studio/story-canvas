import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createComparisonExperiment } from '../server/comparison-experiment.mjs';
import { collectComparisonResults, diffComparisonInputs, renderComparisonSheet } from '../server/comparison-review.mjs';
import { handleComparisonRequest } from '../server/comparison-http.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'comparison-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests = [];
  for (const id of ['first', 'second']) {
    const manifest = createComparisonExperiment({ id, axes: [
      { type: 'input', values: [{ value_id: 'page', label: '<测试 & 页面>', value: 'sample' }] },
      { type: 'seed', values: [1, 2].map(value => ({ value_id: String(value), label: String(value), value })) },
    ] });
    const directory = path.join(root, "Saved", "comparison-results", id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ version: 1, kind: 'comparison_experiment_status', id,
      manifest_sha256: manifest.canonical_sha256, status: 'incomplete', cells: manifest.cells.map((cell, ordinal) => ({ id: cell.id, ordinal,
        status: ordinal ? 'incomplete' : 'completed', error: ordinal ? 'interrupted' : null, result: ordinal ? null : { image: { sha256: 'a'.repeat(64) } } })) }));
    manifests.push(manifest);
  }
  registerFixtureProjects(root); return { root, manifests };
}

test('结果读取跨实验保持显式顺序，过滤轴值并保留失败项，与网页状态一致', async t => {
  const { root, manifests } = await fixture(t);
  const review = await collectComparisonResults(root, { selections: [
    { experiment_id: 'second', cell_ids: [...manifests[1].cells].reverse().map(cell => cell.id) },
    { experiment_id: 'first', axis_values: { seed: '1' } },
  ] });
  assert.deepEqual(review.counts, { total: 3, completed: 2, failed: 1 });
  assert.equal(review.rows[0].status, 'failed');
  assert.equal(review.rows[0].image, null);
  assert.equal(review.rows[1].image.sha256, 'a'.repeat(64));
  assert.equal(review.rows[1].image.absolute_file, path.join(root, 'Saved/comparison-results/second/results', manifests[1].cells[0].id, 'image.png'));
  assert.equal(review.rows[2].experiment_id, 'first');
  assert.equal(review.rows[0].inputs, undefined);
  for (const selection of [{ experiment_id: 'first', axis_values: { seed: 'missing' } }, { experiment_id: 'first', cell_ids: ['missing'] }, { experiment_id: 'first', cell_ids: [] }]) {
    await assert.rejects(collectComparisonResults(root, { selections: [selection] }), { code: 'invalid_comparison_review' });
  }
});

test('HTTP review 通过项目只读入口返回结果，不提交生成或修改事实', async t => {
  const { root } = await fixture(t);
  const body = { selections: [{ experiment_id: 'first' }] };
  const request = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  let response;
  assert.equal(await handleComparisonRequest({ request, projectRoot: root, response: { writeHead() {}, end(body) { response = JSON.parse(body); } }, decodedPath: '/api/comparison-experiments/review',
    readFacts: async (id, operation) => { assert.equal(id, 'project'); return { value: await operation({ projectDirectory: root }) }; },
    sendOperation: (status, result, value) => { assert.equal(status, 200); response = value; },
  }), true);
  assert.equal(response.rows.length, 2);
});

test('输入差异包含 Prompt、模型和任意 workflow 节点的变化，不依赖键顺序', () => {
  const inputs = { prompt: { positive: 'before', negative: '' }, render_identity: { models: { base: { sha256: 'old' } } }, workflow: { api: { 'arbitrary/node': { inputs: { steps: 20 } } } } };
  const first = { experiment_id: 'a', cell_id: 'a', inputs };
  const second = { experiment_id: 'b', cell_id: 'b', inputs: structuredClone(inputs) };
  assert.equal(diffComparisonInputs([first, second]).identical, true);
  second.inputs.prompt.positive = 'after';
  second.inputs.render_identity.models.base.sha256 = 'new';
  second.inputs.workflow.api['arbitrary/node'].inputs.steps = 30;
  assert.deepEqual(diffComparisonInputs([first, second]).differences.map(item => item.path), ['/prompt/positive', '/render_identity/models/base/sha256', '/workflow/api/arbitrary~1node/inputs/steps']);
  assert.throws(() => diffComparisonInputs([first, { inputs: null }]), { code: 'invalid_comparison_review' });
});

test('HTTP sheet 接收排版选项并在来源索引中保留原始条件和失败状态', async t => {
  const { root } = await fixture(t);
  const body = { selections: [{ experiment_id: 'first', axis_values: { seed: '2' } }], font_size: 38, title: '中文对照', labels: ['v5 · 加词'] };
  const request = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  let response;
  await handleComparisonRequest({ request, projectRoot: root, response: { writeHead() {}, end(body) { response = JSON.parse(body); } }, decodedPath: '/api/comparison-experiments/sheet',
    mutateDerived: async (id, operation) => ({ value: await operation({ projectDirectory: root }) }),
    sendOperation: (_status, _result, value) => { response = value; },
  });
  const index = JSON.parse(await readFile(response.index_path, 'utf8'));
  assert.equal(index.sheet.font_size, 38);
  assert.equal(index.sheet.title, '中文对照');
  assert.equal(index.sheet.labels[0], '1. v5 · 加词\n状态：失败');
  assert.equal(index.rows[0].experiment_id, 'first');
  assert.equal(index.rows[0].conditions[0].label, '<测试 & 页面>');
  assert.equal((await sharp(response.image_path).metadata()).width, 512);
});

test('拼图保持图片比例及失败占位，标签支持 XML 字符，损坏来源拒绝导出', async () => {
  const bytes = await sharp({ create: { width: 20, height: 40, channels: 3, background: 'red' } }).png().toBuffer();
  const row = { experiment_id: '<&>', cell_id: 'a', conditions: [{ axis: 'page', label: '<测试 & 页面>' }], seed: 1, status: 'completed', image: {} };
  let reads = 0;
  const png = await renderComparisonSheet([row, { ...row, image: null, status: 'failed' }], { columns: 2 }, async () => { reads++; return bytes; });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1024);
  assert.equal(reads, 1);
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.deepEqual(pixel(256, info.height - 100), [255, 0, 0]);
  assert.deepEqual(pixel(768, info.height - 100), [238, 238, 238]);
  await assert.rejects(renderComparisonSheet([{ ...row, image: { sha256: 'wrong' } }], {}, async () => bytes), { code: 'comparison_image_hash_mismatch' });
  await assert.rejects(renderComparisonSheet([], {}, async () => bytes), { code: 'invalid_comparison_review' });
});

test('大字标题按内容增高且不覆盖下一排，标签数量错误不读取图片', async () => {
  const bytes = await sharp({ create: { width: 512, height: 748, channels: 3, background: 'red' } }).png().toBuffer();
  const row = { experiment_id: 'test', cell_id: 'a', conditions: [], seed: 1, status: 'completed', image: {} };
  const short = await renderComparisonSheet([row], { title: '全身 <对比>', labels: ['v3 · 不加词'], font_size: 36 }, async () => bytes);
  const long = await renderComparisonSheet([row], { title: '全身 <对比>', labels: ['v3 · 不加词\n中文长标签 & zzzrender '.repeat(6)], font_size: 36 }, async () => bytes);
  assert((await sharp(long).metadata()).height > (await sharp(short).metadata()).height);
  const grid = await renderComparisonSheet([row, row, row], { labels: ['v3', '长标签\n'.repeat(8), 'v5'], font_size: 38 }, async () => bytes);
  const { data, info } = await sharp(grid).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(((info.height - 1) * info.width + 256) * info.channels, ((info.height - 1) * info.width + 256) * info.channels + 3)], [255, 0, 0]);
  for (const options of [{ labels: [] }, { labels: [''] }, { font_size: 0 }, { title: 1 }]) {
    await assert.rejects(renderComparisonSheet([row], options, () => { throw Error('不应读取图片'); }), { code: 'invalid_comparison_review' });
  }
});
