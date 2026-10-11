import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { encodePageKey, isPageId } from './page-key.mjs';
import { renderTaskIdPattern } from './render-task-id.mjs';
import { readCandidateResult, readCandidateGeneration, isCandidateId, candidateFilePath, candidateFileRelativePath } from './candidate-storage.mjs';
import { resolveExistingProjectMedia } from './render-media.mjs';

export function emptyTaskBusiness() { return { version: 1, pages: {}, batches: {} }; }

export function assertTaskBusiness(value) {
  const object = row => row !== null && typeof row === 'object' && !Array.isArray(row);
  const statuses = new Set(['launching', 'queued', 'running', 'completed', 'failed', 'cancelled']);
  const itemStatuses = new Set(['queued', 'running', 'available', 'failed', 'cancelled', 'discarded', 'skipped']);
  const time = row => row === null || (typeof row === 'string' && Number.isFinite(Date.parse(row)));
  if (value?.version !== 1 || !object(value.pages) || !object(value.batches)) throw new Error('任务业务摘要无效；保留现有文件并修复，不能用剩余历史覆盖');
  for (const [id, row] of Object.entries(value.pages)) {
    if (!isPageId(id) || !object(row) || !renderTaskIdPattern.test(row.id) || !statuses.has(row.status) || !time(row.created_at)
      || !Array.isArray(row.items) || !row.items.length || new Set(row.items.map(item => item?.id)).size !== row.items.length
      || row.items.some(item => !object(item) || typeof item.id !== 'string' || !item.id || !itemStatuses.has(item.status)
        || item.page_key?.page_id !== id || Object.keys(item.page_key).length !== 1 || (item.candidate_id != null && !isCandidateId(item.candidate_id)))) throw new Error('页面任务摘要无效');
  }
  for (const [id, row] of Object.entries(value.batches)) {
    if (!renderTaskIdPattern.test(id) || !object(row) || !statuses.has(row.status) || !time(row.created_at) || !object(row.expected_counts)
      || !Object.keys(row.expected_counts).length || Object.entries(row.expected_counts).some(([page, count]) => !isPageId(page) || !Number.isSafeInteger(count) || count < 1)
      || !Array.isArray(row.available_ids) || !row.available_ids.length || row.available_ids.some(id => !isCandidateId(id))
      || new Set(row.available_ids).size !== row.available_ids.length) throw new Error('候选批次摘要无效');
  }
  return value;
}

export function applyTaskBusiness(business, state) {
  const pageIds = new Set(state.items.map(item => item.page_key.page_id));
  for (const pageId of pageIds) {
    const previous = business.pages[pageId];
    const key = value => `${value.created_at ?? ''}/${value.id}`;
    if (!previous || previous.id === state.id || key(state) > key(previous)) {
      business.pages[pageId] = {
        id: state.id, status: state.status, created_at: state.created_at,
        items: state.items.filter(item => item.page_key.page_id === pageId).map(item => ({
          id: item.id, page_key: item.page_key, candidate_id: item.candidate_id, status: item.status,
        })),
      };
    }
  }
  const available = state.items.filter(item => item.status === 'available' && item.candidate_id);
  if (available.length) {
    const expected_counts = {};
    for (const item of state.items) expected_counts[item.page_key.page_id] = (expected_counts[item.page_key.page_id] ?? 0) + 1;
    business.batches[state.id] = { status: state.status, created_at: state.created_at, expected_counts, available_ids: available.map(item => item.candidate_id) };
  } else delete business.batches[state.id];
  return business;
}

export function discardBusinessCandidate(business, taskId, candidateId) {
  for (const row of Object.values(business.pages)) {
    if (row.id === taskId) for (const item of row.items) if (item.candidate_id === candidateId) item.status = 'discarded';
  }
  const batch = business.batches[taskId];
  if (batch) {
    batch.available_ids = batch.available_ids.filter(id => id !== candidateId);
    if (!batch.available_ids.length) delete business.batches[taskId];
  }
}

// 清理唯一任务档案前严格验证独立成果；容错媒体列表不能用于删除判据。
export async function verifyTaskAssets(projectDirectory, state) {
  const missing = [];
  const verify = async (file, hash) => {
    const media = await resolveExistingProjectMedia(projectDirectory, file);
    if (!media) throw new Error(`任务成果缺失：${file}`);
    const bytes = await readFile(media.target);
    if (hash && createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`任务成果校验失败：${file}`);
  };
  for (const item of state.items.filter(item => item.status === 'available')) {
    const canonical = candidateFileRelativePath(item.page_key, item.candidate_id);
    // 先检查现存父链的路径边界；媒体缺失不等于整个候选目录不存在。
    await resolveExistingProjectMedia(projectDirectory, canonical);
    const directory = path.dirname(candidateFilePath(projectDirectory, item.page_key, item.candidate_id));
    const info = await lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) { missing.push({ candidate_id: item.candidate_id, page_id: item.page_key.page_id }); continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('候选目录无效');
    const result = await readCandidateResult(projectDirectory, item.page_key, item.candidate_id);
    if (!result || result.task_id !== state.id || result.candidate_id !== item.candidate_id || encodePageKey(result.page_key) !== encodePageKey(item.page_key)) throw new Error('任务候选成果身份不一致');
    const generation = await readCandidateGeneration(projectDirectory, item.page_key, item.candidate_id);
    if (generation.task_id !== state.id || generation.candidate_id !== item.candidate_id || encodePageKey(generation.page_key) !== encodePageKey(item.page_key)) throw new Error('任务候选生成详情身份不一致');
    await verify(result.file, result.image_sha256);
    await verify(result.file.replace(/image\.png$/, 'generation.json'), result.generation_sha256);
    if (result.media_kind === 'video') {
      await verify(result.video_file, result.video_sha256);
      await verify(result.review_file);
    }
  }
  return missing;
}
