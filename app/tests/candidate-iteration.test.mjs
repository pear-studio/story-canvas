import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { registerFixtureProjects } from './project-registry-fixture.mjs';
import { installQwenProfiles } from './helpers/qwen-fixture.mjs';
import { PAGES_INDEX_SCHEMA_ID } from '../server/pages-store.mjs';
import { createCandidateStorageIdentity, publishCandidateResult, readCandidateGeneration } from '../server/candidate-storage.mjs';
import { compileAndPersistCandidateIterationTask } from '../server/page-render.mjs';
import { validateFrozenRenderTask } from '../server/render-task-contract.mjs';
import { readRenderTask } from '../server/render-task-storage.mjs';
import { readPageMedia } from '../server/page-media.mjs';
import { candidateDetailProjection } from '../server/generation-details.mjs';
import { planCandidateCleanup } from '../server/candidate-batches.mjs';
import { iterationCandidateIds } from '../shared/candidate-iteration.mjs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { handleWorkbenchRequest } from '../server/workbench-http.mjs';

async function fixture(t) {
  const testsRoot = fileURLToPath(new URL('../../Saved/Tests/', import.meta.url));
  await mkdir(testsRoot, { recursive: true });
  const root = await mkdtemp(path.join(testsRoot, 'candidate-iteration-'));
  assert.equal(path.dirname(root), path.resolve(testsRoot));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectId = 'demo', projectDirectory = path.join(root, 'workspace', projectId), page_key = { page_id: 'page-001' };
  const json = async (name, value) => { const target = path.join(projectDirectory, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value)); };
  await json('project.json', { format: 'story-models-v1', title: '迭代测试', canvas: '2:3', default_render_profile: 'anima-base-v1' });
  await json('pages/index.json', { $schema: PAGES_INDEX_SCHEMA_ID, pages: [{ ...page_key, owner_kind: 'story', sequence_id: 'start' }] });
  await json('pages/page-001.content.json', { title: 'Anima 页', characters: [], dialogue: [] });
  await json('pages/page-001.render.json', { version: 1, model_id: 'anima', profile_id: 'anima-base-v1', canvas: '2:3' });
  await json('pages/page-001.prompt.json', { models: { anima: { invalid: '不编译此页面 Prompt' } } });
  await installQwenProfiles(root);
  registerFixtureProjects(root);
  const source = { id: 'source.candidate-001', ...createCandidateStorageIdentity(page_key), page_key, seed: 42, status: 'completed', positive_prompt: 'Anima 原指令', negative_prompt: '' };
  const image = await sharp({ create: { width: 192, height: 288, channels: 3, background: '#779988' } }).png().toBuffer();
  await publishCandidateResult(projectDirectory, { id: 'source-task', created_at: new Date().toISOString(), snapshot: null }, source, image, { warm: false });
  return { root, projectId, projectDirectory, page_key, source, image, json, request: { page_key, candidate_id: source.candidate_id, instruction: '修复右手，保留其余画面。' } };
}

test('Anima 候选独立迭代：冻结原图与指令、尺寸对齐、不改页面事实或继承页面 Prompt/LoRA', async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.projectDirectory, 'pages/page-001.prompt.json'));
  const compiled = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, count: 2, seed: 123 });
  const { task } = compiled, unit = task.snapshot.execution_units[0], item = task.items[0];
  assert.deepEqual(await readFile(path.join(f.projectDirectory, 'pages/page-001.prompt.json')), before);
  assert.equal(task.render_profile, 'qwen-image-2-1');
  assert.equal(task.items.length, 2);
  assert.equal(task.snapshot.canvas, '192:288');
  assert.equal(item.positive_prompt, f.request.instruction);
  assert.deepEqual(item.loras, []);
  assert.deepEqual(task.items.map(item => item.seed), [123, 124]);
  assert.equal(unit.workflow.api['4'].inputs.resolution, 0);
  assert.deepEqual(unit.workflow.api['7'].inputs.latent_image, ['4', 2]);
  assert.equal(unit.recipe.resolved_parameters.dimensions.width, 192);
  assert.equal(unit.recipe.resolved_parameters.dimensions.height, 288);
  const inputFile = path.join(compiled.task_directory, 'inputs', item.reference_images[0].sha256 + '.png');
  const frozen = await readFile(inputFile);
  assert.equal((await sharp(frozen).metadata()).width, 192);
  await unlink(path.join(f.projectDirectory, f.source.file));
  await f.json('pages/page-001.prompt.json', { models: { anima: { changed: true } } });
  validateFrozenRenderTask((await readRenderTask(f.projectDirectory, task.id)).task);
  assert.deepEqual(await readFile(inputFile), frozen);
  assert.notDeepEqual(before, await readFile(path.join(f.projectDirectory, 'pages/page-001.prompt.json')));
  const altered = structuredClone(task); altered.items[0].iteration.source_image_sha256 = '0'.repeat(64);
  assert.throws(() => validateFrozenRenderTask(altered), /迭代来源|来源追踪/);
});

test('新候选保留直接来源和修改记录，下一轮指令不累加', async t => {
  const f = await fixture(t);
  const compiled = await compileAndPersistCandidateIterationTask(f.root, f.projectId, f.request);
  assert.equal(compiled.task.items.length, 1);
  const item = compiled.task.items[0];
  await publishCandidateResult(f.projectDirectory, compiled.task, item, f.image, { warm: false });
  const detail = candidateDetailProjection(await readCandidateGeneration(f.projectDirectory, f.page_key, item.candidate_id));
  assert.equal(detail.iteration.source_candidate_id, f.source.candidate_id);
  assert.equal(detail.generation.prompt.positive, f.request.instruction);
  const media = await readPageMedia(f.root, f.projectId, { page_key: f.page_key });
  assert.equal(media.media.candidates.find(row => row.candidate_id === item.candidate_id).iteration.source_candidate_id, f.source.candidate_id);
  const next = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, candidate_id: item.candidate_id, instruction: '只修改表情。' });
  assert.equal(next.task.items[0].positive_prompt, '只修改表情。');
  assert.equal(next.task.items[0].iteration.source_candidate_id, item.candidate_id);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.projectDirectory, 'pages/page-001.render.json'), 'utf8')), { version: 1, model_id: 'anima', profile_id: 'anima-base-v1', canvas: '2:3' });
});

test('空指令、越界种子、错页、视频与变更来源均拒绝提交', async t => {
  const f = await fixture(t);
  const submit = patch => compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, ...patch });
  await assert.rejects(submit({ instruction: '  ' }), { code: 'invalid_candidate_iteration' });
  await assert.rejects(submit({ use_project_loras: 'false' }), { code: 'invalid_candidate_iteration' });
  await assert.rejects(submit({ reiterate: 'true' }), { code: 'invalid_candidate_iteration' });
  await assert.rejects(submit({ reiterate: true }), { code: 'candidate_not_iterated' });
  await assert.rejects(submit({ count: 3, seed: 2147483647 }), { code: 'candidate_seed_out_of_range' });
  await assert.rejects(submit({ page_key: { page_id: 'page-missing' } }));
  const resultFile = f.source.file.replace('image.png', 'result.json');
  const record = JSON.parse(await readFile(path.join(f.projectDirectory, resultFile), 'utf8'));
  await f.json(resultFile, { ...record, media_kind: 'video' });
  await assert.rejects(submit({}), { code: 'candidate_iteration_static_only' });
  await f.json(resultFile, record);
  await writeFile(path.join(f.projectDirectory, f.source.file), Buffer.from('changed'));
  await assert.rejects(submit({}), { code: 'candidate_source_changed' });
});

test('重新迭代用上次直接来源生成新候选，多轮时不回到最初原图', async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.projectDirectory, 'pages/page-001.prompt.json'));
  const first = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, seed: 123 });
  const edited = await sharp({ create: { width: 192, height: 288, channels: 3, background: '#cc5522' } }).png().toBuffer();
  const b = first.task.items[0];
  await publishCandidateResult(f.projectDirectory, first.task, b, edited, { warm: false });
  const previous = candidateDetailProjection(await readCandidateGeneration(f.projectDirectory, f.page_key, b.candidate_id));
  const retry = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, candidate_id: b.candidate_id, reiterate: true, seed: previous.seed, instruction: '只修复右手，不改变袖口。' });
  const c = retry.task.items[0];
  assert.equal(c.iteration.source_candidate_id, f.source.candidate_id);
  assert.equal(c.reference_images[0].candidate_file, f.source.file);
  assert.equal(c.seed, 123);
  assert.equal(c.positive_prompt, '只修复右手，不改变袖口。');
  assert.notEqual(c.candidate_id, b.candidate_id);
  assert.deepEqual(await readFile(path.join(retry.task_directory, 'inputs', c.reference_images[0].sha256 + '.png')), f.image);
  validateFrozenRenderTask(retry.task);
  await publishCandidateResult(f.projectDirectory, retry.task, c, f.image, { warm: false });
  assert.equal((await readCandidateGeneration(f.projectDirectory, f.page_key, b.candidate_id)).prompt.positive, f.request.instruction);
  const next = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, candidate_id: b.candidate_id });
  const d = next.task.items[0];
  await publishCandidateResult(f.projectDirectory, next.task, d, f.image, { warm: false });
  const repeated = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, candidate_id: d.candidate_id, reiterate: true });
  const e = repeated.task.items[0];
  assert.equal(e.iteration.source_candidate_id, b.candidate_id);
  assert.equal(e.reference_images[0].candidate_file, b.file);
  assert.deepEqual(await readFile(path.join(repeated.task_directory, 'inputs', e.reference_images[0].sha256 + '.png')), edited);
  assert.deepEqual(await readFile(path.join(f.projectDirectory, 'pages/page-001.prompt.json')), before);
  const media = await readPageMedia(f.root, f.projectId, { page_key: f.page_key });
  assert.equal(media.media.candidates.length, 4);
});

test('重新迭代拒绝已删除或与上次身份不同的来源图', async t => {
  const f = await fixture(t);
  const first = await compileAndPersistCandidateIterationTask(f.root, f.projectId, f.request);
  const b = first.task.items[0];
  await publishCandidateResult(f.projectDirectory, first.task, b, f.image, { warm: false });
  const request = { ...f.request, candidate_id: b.candidate_id, reiterate: true };
  const sourceRecordFile = f.source.file.replace('image.png', 'result.json');
  const sourceRecord = JSON.parse(await readFile(path.join(f.projectDirectory, sourceRecordFile), 'utf8'));
  await unlink(path.join(f.projectDirectory, sourceRecordFile));
  await assert.rejects(compileAndPersistCandidateIterationTask(f.root, f.projectId, request), { code: 'candidate_source_missing' });
  const changed = await sharp({ create: { width: 192, height: 288, channels: 3, background: '#111111' } }).png().toBuffer();
  await f.json(sourceRecordFile, { ...sourceRecord, image_sha256: createHash('sha256').update(changed).digest('hex') });
  await writeFile(path.join(f.projectDirectory, f.source.file), changed);
  await assert.rejects(compileAndPersistCandidateIterationTask(f.root, f.projectId, request), { code: 'candidate_source_changed' });
});

test('迭代默认冻结项目 Qwen LoRA 与触发词，单次关闭不改设置或带入其他 Prompt', async t => {
  const f = await fixture(t);
  const definition = { filename: 'veloria/qwen/veloria-v2.safetensors', sha256: 'a'.repeat(64), weight: 0.8, trigger: 'veloria' };
  const override = { version: 1, profiles: { 'qwen-image-2-1': { changes: [
    { target: 'style_loras.veloria', original: { exists: false }, project: { exists: true, value: definition } },
    { target: 'prompt.text', original: { exists: true, value: '' }, project: { exists: true, value: '不要带入的项目 Prompt' } },
  ] } } };
  await f.json('render-profile.override.json', override);
  const compiled = await compileAndPersistCandidateIterationTask(f.root, f.projectId, f.request);
  const item = compiled.task.items[0];
  assert.deepEqual(item.loras, [{ ...definition, kind: 'style', owner: 'qwen-image-2-1' }]);
  assert.equal(item.positive_prompt, 'veloria\n\n' + f.request.instruction);
  assert.equal(item.prompt_parts.sections.find(section => section.kind === 'page').text, f.request.instruction);
  const workflow = compiled.task.snapshot.execution_units[0].workflow.api;
  const loader = Object.entries(workflow).find(([, node]) => node.class_type === 'LoraLoaderModelOnly');
  assert.equal(loader[1].inputs.lora_name, definition.filename);
  assert.equal(loader[1].inputs.strength_model, 0.8);
  const cache = Object.values(workflow).find(node => node.class_type === 'QwenImage21Cache');
  assert.deepEqual((cache ?? workflow['7']).inputs.model, [loader[0], 0]);
  const disabled = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, use_project_loras: false });
  assert.deepEqual(disabled.task.items[0].loras, []);
  assert.equal(disabled.task.items[0].positive_prompt, f.request.instruction);
  assert.equal(Object.values(disabled.task.snapshot.execution_units[0].workflow.api).some(node => node.class_type === 'LoraLoaderModelOnly'), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.projectDirectory, 'render-profile.override.json'), 'utf8')), override);
  await f.json('render-profile.override.json', { version: 1, profiles: {} });
  validateFrozenRenderTask((await readRenderTask(f.projectDirectory, compiled.task.id)).task);
  assert.equal((await readRenderTask(f.projectDirectory, compiled.task.id)).task.items[0].loras[0].weight, 0.8);
  await publishCandidateResult(f.projectDirectory, compiled.task, item, f.image, { warm: false });
  const detail = candidateDetailProjection(await readCandidateGeneration(f.projectDirectory, f.page_key, item.candidate_id));
  assert.equal(detail.generation.loras[0].trigger, 'veloria');
  assert.equal(detail.generation.prompt.sections.find(section => section.kind === 'page').text, f.request.instruction);
  const retried = await compileAndPersistCandidateIterationTask(f.root, f.projectId, { ...f.request, candidate_id: item.candidate_id, reiterate: true, instruction: '仅修复右手。' });
  assert.deepEqual(retried.task.items[0].loras, [], '重新迭代使用当前配置，不恢复旧 LoRA 或重复触发词');
  assert.equal(retried.task.items[0].positive_prompt, '仅修复右手。');
});

test('整批清理保留多轮迭代和来源链，删除无关旧候选', () => {
  const candidates = [
    { candidate_id: 'base' }, { candidate_id: 'unrelated' },
    { candidate_id: 'edit-1', iteration: { source_candidate_id: 'base' } },
    { candidate_id: 'edit-2', iteration: { source_candidate_id: 'edit-1' } }, { candidate_id: 'new' },
  ];
  assert.deepEqual([...iterationCandidateIds(candidates)], ['edit-1', 'base', 'edit-2']);
  const plan = planCandidateCleanup({ page_key: { page_id: 'page-001' }, fingerprint: 'test', groups: [
    { task_id: 'new', status: 'completed', expected_count: 1, complete: true, candidates: [candidates[4]] },
    { task_id: 'old', status: 'completed', candidates: candidates.slice(0, 4) },
  ] });
  assert.deepEqual(plan.delete_candidate_ids, ['unrelated']);
  assert.equal(plan.keep_candidate_ids.length, 4);
});

test('HTTP 迭代入口冻结任务并加入既有队列，回执指向原页面', async t => {
  const f = await fixture(t);
  const request = Readable.from([Buffer.from(JSON.stringify(f.request))]);
  request.method = 'POST'; request.headers = { 'content-type': 'application/json' };
  let receipt, launched;
  const handled = await handleWorkbenchRequest({
    request, decodedPath: '/api/projects/demo/workbench/candidate-iterate', projectRoot: f.root, config: {},
    mutateDerived: async (id, handler) => ({ value: await handler({ projectDirectory: f.projectDirectory, projectId: id }) }),
    generationScheduler: { startReference: reference => { launched = reference; return Promise.resolve(); } },
    sendOperation: (status, result, extra) => { receipt = { status, result, extra }; },
  });
  assert.equal(handled, true);
  assert.equal(receipt.status, 202);
  assert.deepEqual(receipt.extra.task.page_key, f.page_key);
  assert.ok(launched);
  const saved = await readRenderTask(f.projectDirectory, receipt.extra.task.task_id);
  assert.equal(saved.task.items[0].iteration.source_candidate_id, f.source.candidate_id);
});
