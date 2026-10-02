import { removeUnusedFile } from './reference-materials.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { readFactDraft, saveFactDraft } from './fact-drafts.mjs';
import { saveMaterial, openMaterialFile } from './project-materials.mjs';
import { readCandidateResult } from './candidate-storage.mjs';
import { resolveExistingProjectMedia } from './render-media.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { ApiError } from './http-support.mjs';
import {readPageRenderSettings} from './page-render-settings.mjs';
import {resolveProjectLocation} from './project-operations.mjs';

function targetArgs(projectId, target) {
  if (!target || !['character', 'scene', 'page'].includes(target.kind) || typeof target.id !== 'string') throw new ApiError(400, 'invalid_reference_target');
  return { projectId, domain: target.kind, kind: 'prompt', targetId: target.id };
}
async function holder(root, projectId, draft, target) {
  const modelId = target.kind === 'page'
    ? (await readPageRenderSettings((await resolveProjectLocation(root,projectId)).projectDirectory,target.id)).model_id
    : target.model_id;
  if (modelId !== 'qwen') throw new ApiError(422, 'reference_model_unsupported');
  const document = draft.document.models[modelId];
  const value = target.kind === 'page' ? document : document?.variants[target.variant_id];
  if (!value) throw new ApiError(404, 'reference_setting_not_found');
  return value;
}
export async function readReferenceLibrary(root, projectId, target) {
  const draft = await readFactDraft(root, targetArgs(projectId, target));
  const entries = (await holder(root, projectId, draft, target)).reference_images ?? [];
  return { entries, sha256: hashCanonicalJson(entries) };
}
// 调用方持有 mutateTargetFacts 项目锁。先准备新图片，成功保存引用后才清理旧图片。
export async function mutateReferenceLibrary(root, directory, projectId, value) {
  const args = targetArgs(projectId, value.target), draft = await readFactDraft(root, args);
  const target = await holder(root, projectId, draft, value.target), entries = target.reference_images ?? [];
  if (hashCanonicalJson(entries) !== value.expected_sha256) throw new ApiError(409, 'reference_library_conflict', ['参考图列表已变化，请刷新后重试']);
  const existing = value.id ? entries.find(e => e.id === value.id) : null;
  if (value.id && !existing) throw new ApiError(404, 'reference_image_not_found');
  let newFile = null;
  if (value.action === 'delete') {
    target.reference_images = entries.filter(e => e.id !== value.id);
  } else if (value.action === 'reorder') {
    if (!Array.isArray(value.ids) || value.ids.length !== entries.length || new Set(value.ids).size !== entries.length || value.ids.some(id => !entries.some(e => e.id === id))) throw new ApiError(400, 'invalid_reference_order');
    target.reference_images = value.ids.map(id => entries.find(e => e.id === id));
  } else if (value.action === 'save') {
    let bytes;
    if (value.candidate_id) {
      const result = await readCandidateResult(directory, value.page_key, value.candidate_id);
      if (!result) throw new ApiError(404, 'candidate_not_found');
      const media = await resolveExistingProjectMedia(directory, result.file);
      if (!media) throw new ApiError(404, 'candidate_image_missing');
      bytes = await readFile(media.target);
    } else if (value.material_file) bytes = await readFile((await openMaterialFile(directory, value.material_file)).target);
    else if (typeof value.content === 'string') bytes = Buffer.from(value.content, 'base64');
    if (!bytes?.length || bytes.length > 32 * 1024 * 1024) throw new ApiError(422, 'invalid_reference_image');
    const metadata = await sharp(bytes).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new ApiError(422, 'invalid_reference_image');
    const content = await sharp(bytes).rotate().png().toBuffer();
    newFile = `reference-${randomUUID()}.png`;
    const title = String(value.title || existing?.title || '参考图').slice(0, 200);
    await saveMaterial(directory, projectId, { file: newFile, title, encoding: 'base64', content: content.toString('base64') });
    const next = { id: existing?.id ?? `ref-${randomUUID()}`, file: newFile, title };
    target.reference_images = existing ? entries.map(e => e.id === existing.id ? next : e) : [...entries, next];
  } else throw new ApiError(400, 'invalid_reference_action');
  try {
    await saveFactDraft(root, { ...args, document: draft.document, expectedSha256: draft.expected_sha256,
      expectedContextSha256: draft.expected_context_sha256, conflictCode: 'reference_library_conflict' });
  } catch (error) {
    if (newFile) await removeUnusedFile(directory, newFile);
    throw error;
  }
  return readReferenceLibrary(root, projectId, value.target);
}
