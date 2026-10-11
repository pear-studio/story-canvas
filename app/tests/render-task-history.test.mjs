import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { createRenderTask, updateRenderTask, readRenderTaskState, readRenderHistoryReferences, readRenderTaskBusiness,
  maintainRenderTaskHistory, deleteRetainedCandidate, RENDER_HISTORY_LIMIT } from '../server/render-task-storage.mjs';
import { publishCandidateResult, readGenerationCandidateRecords, candidateFilePath } from '../server/candidate-storage.mjs';
import { groupCandidateTasks, planCandidateCleanup } from '../server/candidate-batches.mjs';
import { sheetPageCells } from '../server/candidate-sheet.mjs';
import { listWorkspaceRenderHistory } from '../server/render-task-workspace.mjs';
import { assertTaskBusiness } from '../server/render-task-business.mjs';
import { runCompiledPageRenderTask } from '../server/page-render.mjs';
import { controlGenerationTask, executeGenerationTask } from '../server/generation-lifecycle.mjs';
import { enqueueGenerationTask, generationReference, waitForGenerationUnitTurn } from '../server/generation-queue.mjs';
import { PAGES_INDEX_SCHEMA_ID } from '../server/pages-store.mjs';
import { registerFixtureProjects } from './project-registry-fixture.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=', 'base64');
const pageKey = { page_id: 'page-001' };
const idFor = n => `render-20260828T010203Z-${n.toString(16).padStart(8, '0')}`;
function task(n, key = pageKey) {
  const candidate_id = `candidate-${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return { version: 2, id: idFor(n), project: 'demo', purpose: 'candidate', render_profile: 'anima-base-v1',
    status: 'queued', created_at: new Date(Date.UTC(2026, 7, 28, 1, 0, n)).toISOString(), snapshot: {},
    items: [{ id: 'item', page_key: key, candidate_id, file: `Outputs/pages/${key.page_id}/${candidate_id}/image.png`, status: 'queued', seed: 1 }] };
}
async function fixture(t) {
  const base = path.resolve(import.meta.dirname, '../../Saved/Tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'task-history-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const directory = path.join(root, 'workspace/demo');
  await mkdir(directory, { recursive: true });
  registerFixtureProjects(root);
  return { root, directory, store: path.join(directory, 'Saved/render') };
}
async function terminal(directory, n, { key = pageKey, asset = false, options } = {}) {
  const value = task(n, key);
  await createRenderTask(directory, value, { pages: [] });
  if (asset) await publishCandidateResult(directory, value, value.items[0], png, { warm: false });
  return updateRenderTask(directory, value.id, current => {
    current.status = asset ? 'completed' : 'failed';
    current[asset ? 'completed_at' : 'failed_at'] = new Date(Date.UTC(2026, 7, 28, 2, 0, n)).toISOString();
    current.items[0].status = asset ? 'available' : 'failed';
  }, options);
}
async function rawHistory(directory, count) {
  const initial = await terminal(directory, 0, { key: { page_id: 'page-002' } });
  const manifest = JSON.parse(await readFile(path.join(initial.task_directory, 'manifest.json'), 'utf8'));
  for (let n = 1; n < count; n++) {
    const value = task(n);
    const state = { ...initial.state, id: value.id, created_at: value.created_at, failed_at: new Date(Date.UTC(2026, 7, 28, 2, 0, n)).toISOString(), items: value.items.map(item => ({ ...item, status: 'failed' })) };
    const folder = path.join(directory, 'Saved/render/history', value.id);
    await mkdir(folder);
    await writeFile(path.join(folder, 'state.json'), JSON.stringify(state));
    await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ ...manifest, id: value.id, task: { ...manifest.task, id: value.id, items: value.items } }));
  }
  await rm(path.join(directory, 'Saved/render/history-index.json'));
}

test('500条保留上限实际回收档案与专属文件，每页旧失败摘要不随档案消失', async t => {
  const { directory, store } = await fixture(t);
  await rawHistory(directory, 503);
  await mkdir(path.join(store, 'submissions', idFor(0)), { recursive: true });
  await writeFile(path.join(store, 'submissions', idFor(0), 'unit.json'), '{}');
  await writeFile(path.join(store, 'progress', `${idFor(0)}.json`), '{}');
  const result = await maintainRenderTaskHistory(directory);
  assert.equal(RENDER_HISTORY_LIMIT, 500);
  assert.equal(result.removed.length, 3);
  assert.deepEqual(result.blocked, []);
  assert.equal((await readdir(path.join(store, 'history'))).length, 500);
  assert.equal(await readRenderTaskState(directory, idFor(0)), null);
  await assert.rejects(readFile(path.join(store, 'progress', `${idFor(0)}.json`)), { code: 'ENOENT' });
  await assert.rejects(readdir(path.join(store, 'submissions', idFor(0))), { code: 'ENOENT' });
  const business = await readRenderTaskBusiness(directory);
  assert.equal(business.pages['page-002'].id, idFor(0));
  assert.equal(sheetPageCells({ page_key: { page_id: 'page-002' } }, 1, business.pages['page-002'], [])[0].status, 'failed');
  await writeFile(path.join(store, 'history-index.json'), '{broken');
  assert.equal((await readRenderHistoryReferences(directory)).length, 500);
  assert.deepEqual((await readRenderTaskBusiness(directory)).pages['page-002'], business.pages['page-002']);
});

test('3000条历史正常首屏与下一页只读当页state，不重扫坏的旧档案', async t => {
  const { root, directory, store } = await fixture(t);
  await rawHistory(directory, 3000);
  await readRenderHistoryReferences(directory); // 首次派生重建，单独计成本。
  await writeFile(path.join(store, 'history', idFor(1), 'state.json'), '{broken old state');
  const timings = [];
  const first = await listWorkspaceRenderHistory(root, { onTiming: value => timings.push(value) });
  const next = await listWorkspaceRenderHistory(root, { before: first.next_cursor, onTiming: value => timings.push(value) });
  assert.equal(first.history.length, 30);
  assert.equal(next.history.length, 30);
  assert.deepEqual(timings.map(value => value.state_reads), [30, 30]);
  assert.equal(new Set([...first.history, ...next.history].map(value => value.id)).size, 60);
  t.diagnostic(JSON.stringify(timings));
});

test('活动与未收尾队列保护旧档案，项目空闲后收敛', async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1); await terminal(directory, 2);
  await createRenderTask(directory, task(3), { pages: [] });
  assert.equal((await maintainRenderTaskHistory(directory, { limit: 1 })).skipped, 'active');
  await updateRenderTask(directory, idFor(3), value => { value.status = 'failed'; });
  assert.equal((await maintainRenderTaskHistory(directory, { limit: 1, isIdle: async () => false })).skipped, 'active');
  assert.equal((await maintainRenderTaskHistory(directory, { limit: 1 })).removed.length, 2);
});

test('档案清理保留候选、批次完整信息与最新任务，删除失败不丢摘要，最后候选删除回收批次', async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1, { asset: true });
  await terminal(directory, 2, { key: { page_id: 'page-002' } });
  const value = task(1), item = value.items[0], file = candidateFilePath(directory, pageKey, item.candidate_id);
  const generationFile = file.replace(/image\.png$/, 'generation.json');
  const before = await readFile(generationFile);
  assert.deepEqual((await maintainRenderTaskHistory(directory, { limit: 1 })).removed, [value.id]);
  assert.deepEqual(await readFile(file), png);
  assert.deepEqual(await readFile(generationFile), before);
  let business = await readRenderTaskBusiness(directory);
  const groups = groupCandidateTasks(await readGenerationCandidateRecords(directory), new Map(Object.entries(business.batches)), pageKey);
  assert.equal(groups[0].complete, true);
  assert.equal(planCandidateCleanup({ page_key: pageKey, fingerprint: 'x', groups }).keep_task_id, value.id);
  await assert.rejects(deleteRetainedCandidate(directory, value.id, pageKey, item.candidate_id, async () => { throw new Error('move failed'); }), /move failed/);
  assert.deepEqual(await readRenderTaskBusiness(directory), business);
  await deleteRetainedCandidate(directory, value.id, pageKey, item.candidate_id, () => rename(path.dirname(file), path.join(directory, 'deleted-candidate')));
  business = await readRenderTaskBusiness(directory);
  assert.equal(business.batches[value.id], undefined);
  assert.equal(business.pages['page-001'].id, value.id);
  assert.equal(business.pages['page-001'].items[0].status, 'discarded');
});

test('损坏独立成果阻止清理唯一档案，不把容错列表的缺席当删除', async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1, { asset: true }); await terminal(directory, 2);
  await writeFile(candidateFilePath(directory, pageKey, task(1).items[0].candidate_id), 'changed');
  const result = await maintainRenderTaskHistory(directory, { limit: 1 });
  assert.equal(result.removed.length, 0);
  assert.equal(result.blocked[0].id, idFor(1));
  assert.ok(await readRenderTaskState(directory, idFor(1)));
});

test('清理准备后中断，GET不执行待办；state已部分删除也可幂等完成', async t => {
  const { directory, store } = await fixture(t);
  await terminal(directory, 1, { key: { page_id: 'page-002' } }); await terminal(directory, 2);
  await assert.rejects(maintainRenderTaskHistory(directory, { limit: 1, checkpoint: async () => { throw new Error('crash'); } }), /crash/);
  const pendingBefore = await readFile(path.join(store, 'cleanup-pending.json'), 'utf8');
  assert.deepEqual((await readRenderHistoryReferences(directory)).map(row => row.id), [idFor(2)]);
  assert.ok(await readRenderTaskState(directory, idFor(1)), 'GET 没有清理源');
  assert.equal(await readFile(path.join(store, 'cleanup-pending.json'), 'utf8'), pendingBefore);
  await rm(path.join(store, 'history', idFor(1), 'state.json'));
  await rm(path.join(store, 'history-index.json'));
  assert.deepEqual((await readRenderHistoryReferences(directory)).map(row => row.id), [idFor(2)]);
  assert.equal((await readRenderTaskBusiness(directory)).pages['page-002'].id, idFor(1));
  assert.deepEqual((await maintainRenderTaskHistory(directory, { limit: 1 })).removed, [idFor(1)]);
  await assert.rejects(readFile(path.join(store, 'cleanup-pending.json')), { code: 'ENOENT' });
});

for (const phase of ['source-written', 'business-written', 'index-written']) test(`源提交后 ${phase} 中断，不改判任务失败；dirty合并修复保留已清理摘要`, async t => {
  const { directory, store } = await fixture(t);
  await terminal(directory, 1, { key: { page_id: 'page-002' } }); await terminal(directory, 2);
  await maintainRenderTaskHistory(directory, { limit: 1 });
  await terminal(directory, 3, { options: { catalogCheckpoint: async current => { if (current === phase) throw new Error('crash'); } } });
  assert.equal((await readRenderTaskState(directory, idFor(3))).status, 'failed');
  await readRenderHistoryReferences(directory);
  const business = await readRenderTaskBusiness(directory);
  assert.equal(business.pages['page-002'].id, idFor(1));
  assert.equal(business.pages['page-001'].id, idFor(3));
  await assert.rejects(readFile(path.join(store, 'catalog-dirty.json')), { code: 'ENOENT' });
});

test('摘要初始化标记独立于索引；摘要丢失或损坏后拒绝覆盖及清理', async t => {
  const { directory, store } = await fixture(t);
  await terminal(directory, 1); await terminal(directory, 2);
  await rm(path.join(store, 'business-summary.json'));
  await rm(path.join(store, 'history-index.json'));
  assert.equal((await readRenderHistoryReferences(directory)).length, 2);
  await assert.rejects(readRenderTaskBusiness(directory), /摘要缺失/);
  await assert.rejects(maintainRenderTaskHistory(directory, { limit: 1 }), /摘要缺失/);
  assert.ok(await readRenderTaskState(directory, idFor(1)));
  await writeFile(path.join(store, 'business-summary.json'), '{broken');
  await assert.rejects(readRenderTaskBusiness(directory));
  assert.equal(await readFile(path.join(store, 'business-summary.json'), 'utf8'), '{broken');
});

test('业务摘要拒绝类型、身份、时间与状态损坏，不把坏集合当空摘要', () => {
  for (const value of [
    { version: 1, pages: 42, batches: 42 },
    { version: 1, pages: {}, batches: { [idFor(1)]: { expected_counts: 42, available_ids: [] } } },
    { version: 1, pages: { 'page-001': { id: idFor(1), status: 'completed', created_at: 'bad', items: [] } }, batches: {} },
    { version: 1, pages: {}, batches: { [idFor(1)]: { status: 'completed', created_at: null, expected_counts: { 'page-001': -1 }, available_ids: ['bad'] } } },
  ]) assert.throws(() => assertTaskBusiness(value));
});

for (const phase of ['prepared', 'moved']) test(`候选删除 ${phase} 中断恢复源与摘要，源存在分支不丢批次、不重新发布`, async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1, { asset: true });
  const value = task(1), candidate = value.items[0].candidate_id;
  const move = () => rename(path.dirname(candidateFilePath(directory, pageKey, candidate)), path.join(directory, 'deleted'));
  const deleting = deleteRetainedCandidate(directory, value.id, pageKey, candidate, move, {
    checkpoint: async point => { if (point === phase) throw new Error('crash'); },
  });
  if (phase === 'prepared') await assert.rejects(deleting, /crash/);
  else await deleting;
  const state = await readRenderTaskState(directory, value.id); // 执行器读也先修复删除意图。
  const business = await readRenderTaskBusiness(directory);
  assert.equal(state.items[0].status, phase === 'prepared' ? 'available' : 'discarded');
  assert.equal(Boolean(business.batches[value.id]), phase === 'prepared');
  assert.equal((await readGenerationCandidateRecords(directory)).length, phase === 'prepared' ? 1 : 0);
});

test('同步执行消费维护前快照，早创建取消任务落在500之外也可返回', async t => {
  const { root, directory } = await fixture(t);
  await rawHistory(directory, 501);
  const compiled = { task: task(0), project_directory: directory };
  // 可注入执行器模拟收尾已裁掉原档案；返回值具有真实持久快照契约。
  const final = { task: { ...compiled.task, status: 'cancelled' }, state: { id: compiled.task.id, status: 'cancelled' }, task_directory: 'retired' };
  const result = await runCompiledPageRenderTask(compiled, { repositoryRoot: root }, { runTask: async () => {
    await rm(path.join(directory, 'Saved/render/history', compiled.task.id), { recursive: true });
    return final;
  } });
  assert.equal(result, final);
});

test('旧任务等待另一项目队列，取消控制维护后worker仍能取最终快照', async t => {
  const { root, directory } = await fixture(t);
  await rawHistory(directory, 501);
  const waiting = task(9999);
  waiting.created_at = '2026-01-01T00:00:00Z';
  await createRenderTask(directory, waiting, { pages: [] });
  const other = generationReference('other', idFor(9998), 'candidate');
  await enqueueGenerationTask(root, other);
  const lease = await waitForGenerationUnitTurn(root, other, 'other-unit');
  t.after(() => lease.release());
  const reference = generationReference('demo', waiting.id, 'candidate', waiting.created_at);
  await enqueueGenerationTask(root, reference);
  const worker = executeGenerationTask({ projectRoot: directory, taskId: waiting.id, purpose: 'candidate', generationQueue: { repositoryRoot: root, reference } }, async () => {
    await assert.rejects(waitForGenerationUnitTurn(root, reference, 'waiting-unit', { pollMs: 100 }), { code: 'generation_task_removed' });
    return readRenderTaskState(directory, waiting.id);
  });
  const cancelledAfter = Date.now();
  const response = await controlGenerationTask(root, 'demo', waiting.id, 'cancel', { purpose: 'candidate' });
  assert.equal(response.status.status, 'cancelled');
  assert.ok(Date.parse(response.status.completed_at) >= cancelledAfter);
  const final = await worker;
  assert.equal(final.status, 'cancelled');
  assert.equal((await readRenderHistoryReferences(directory)).length, 500);
  assert.equal((await readRenderTaskState(directory, waiting.id)).status, 'cancelled');
});

test('完整候选目录已不存在时可清旧档案，总览保持missing，批次不会永久积累', async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1, { asset: true }); await terminal(directory, 2, { key: { page_id: 'page-002' } });
  await mkdir(path.join(directory, 'pages'));
  await writeFile(path.join(directory, 'pages/index.json'), JSON.stringify({ $schema: PAGES_INDEX_SCHEMA_ID, pages: [{ page_id: 'page-001', owner_kind: 'story', sequence_id: 's1' }] }));
  await rm(path.dirname(candidateFilePath(directory, pageKey, task(1).items[0].candidate_id)), { recursive: true });
  assert.deepEqual((await maintainRenderTaskHistory(directory, { limit: 1 })).removed, [idFor(1)]);
  const business = await readRenderTaskBusiness(directory);
  assert.equal(business.batches[idFor(1)], undefined);
  assert.equal(business.pages['page-001'].items[0].status, 'available');
  assert.equal(sheetPageCells({ page_key: pageKey }, 1, business.pages['page-001'], [])[0].status, 'missing');
});

test('候选目录仍有文件但result缺失时保留档案，不误判为完整缺失', async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1, { asset: true }); await terminal(directory, 2);
  await rm(candidateFilePath(directory, pageKey, task(1).items[0].candidate_id).replace(/image\.png$/, 'result.json'));
  const result = await maintainRenderTaskHistory(directory, { limit: 1 });
  assert.equal(result.removed.length, 0);
  assert.equal(result.blocked[0].id, idFor(1));
  assert.ok(await readRenderTaskState(directory, idFor(1)));
});

test('页面整体归档后清源仍保留批次，还原媒体后完整数量与状态可读', async t => {
  const { directory } = await fixture(t);
  await terminal(directory, 1, { asset: true }); await terminal(directory, 2, { key: { page_id: 'page-002' } });
  await mkdir(path.join(directory, 'pages'));
  await writeFile(path.join(directory, 'pages/index.json'), JSON.stringify({ $schema: PAGES_INDEX_SCHEMA_ID, pages: [] }));
  const pageDirectory = path.join(directory, 'Outputs/pages/page-001');
  await rename(pageDirectory, path.join(directory, 'archived-page'));
  assert.deepEqual((await maintainRenderTaskHistory(directory, { limit: 1 })).removed, [idFor(1)]);
  await rename(path.join(directory, 'archived-page'), pageDirectory);
  const business = await readRenderTaskBusiness(directory);
  const groups = groupCandidateTasks(await readGenerationCandidateRecords(directory), new Map(Object.entries(business.batches)), pageKey);
  assert.equal(groups[0].status, 'completed');
  assert.equal(groups[0].expected_count, 1);
  assert.equal(groups[0].complete, true);
});
