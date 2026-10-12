import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { candidateFileRelativePath, readCandidateResult, requireCandidateId } from './candidate-storage.mjs';
import { resolveExistingProjectMedia } from './render-media.mjs';
import { compileEffectiveRenderProfile } from './render-profile-compiler.mjs';
import { explicitPageLoras } from './lora-config.mjs';
import { PageRenderError, resolveExactPageIdentity } from './page-render-resolver.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, status = 422) => { throw new PageRenderError(code, [message], status); };

// 只读取明确候选及页面归属；不编译页面 Prompt，也不把指令写入页面事实。
export async function prepareCandidateIteration({ repositoryRoot, projectDirectory, value }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['page_key', 'candidate_id', 'instruction', 'count', 'seed', 'use_project_loras'].includes(key))
    || (value.use_project_loras !== undefined && typeof value.use_project_loras !== 'boolean')
    || typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 8000) {
    fail('invalid_candidate_iteration', '请指定候选并填写 1–8000 字的修改要求。', 400);
  }
  try { requireCandidateId(value.candidate_id); } catch { fail('invalid_candidate_id', '请选择有效候选。', 400); }
  const page = await resolveExactPageIdentity(projectDirectory, value.page_key);
  const record = await readCandidateResult(projectDirectory, page.page_key, value.candidate_id);
  if (!record) fail('candidate_not_found', '来源候选已不存在，请刷新候选列表。', 404);
  if (record.media_kind === 'video') fail('candidate_iteration_static_only', '迭代仅支持静态候选图。');
  const file = candidateFileRelativePath(page.page_key, value.candidate_id);
  const media = await resolveExistingProjectMedia(projectDirectory, file);
  if (!media) fail('candidate_source_missing', '来源候选图片已丢失。', 404);
  const source = await readFile(media.target);
  if (hash(source) !== record.image_sha256) fail('candidate_source_changed', '来源候选图片已变化，请核对后再提交。', 409);
  const metadata = await sharp(source).metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) fail('candidate_iteration_static_only', '来源必须是单张 PNG 候选图。');
  // 视觉输入和采样画布使用同一尺寸，仅对齐模型要求的 32 像素倍数。
  const width = Math.max(32, Math.round(metadata.width / 32) * 32);
  const height = Math.max(32, Math.round(metadata.height / 32) * 32);
  const { data: bytes, info } = await sharp(source).resize(width, height, { fit: 'fill' }).png().toBuffer({ resolveWithObject: true });
  const reference = { candidate_file: file, source_sha256: hash(source), sha256: hash(bytes), width: info.width, height: info.height };
  const [project, content, bundle] = await Promise.all([
    readFile(path.join(projectDirectory, 'project.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectDirectory, 'pages', `${page.page_id}.content.json`), 'utf8').then(JSON.parse),
    compileEffectiveRenderProfile({ repositoryRoot, projectRoot: projectDirectory, profileId: 'qwen-image-2-1' }),
  ]);
  if (content.page_kind === 'text' || content.page_kind === 'video') fail('candidate_iteration_static_only', '迭代仅支持插画页。');
  if (bundle.blocked) fail('render_profile_override_conflict', '项目 Qwen 配置存在冲突，请先在生成设置中处理。');
  const resolvedLoras = value.use_project_loras === false ? { loras: [], errors: [] } : explicitPageLoras({}, page.page_id, bundle.effective_profile);
  if (resolvedLoras.errors.length) fail('invalid_candidate_iteration_loras', resolvedLoras.errors.join('；'));
  const triggers = [...new Set(resolvedLoras.loras.map(lora => lora.trigger?.trim()).filter(Boolean))].join(', ');
  const sections = [...(triggers ? [{ kind: 'global', text: triggers }] : []), { kind: 'page', text: value.instruction }];
  return {
    ...page, title: content.title, sources: [], project: { ...project, canvas: `${width}:${height}` },
    compiled_profile: bundle, page_loras: resolvedLoras.loras, reference_images: [reference], reference_image_bytes: [{ identity: reference, bytes }],
    iteration: { source_candidate_id: value.candidate_id, source_image_sha256: reference.source_sha256 },
    compiled_page: { positive_prompt: sections.map(section => section.text).join('\n\n'), negative_prompt: '', prompt_parts: { sections }, audit: { valid: true, errors: [], warnings: [] } },
  };
}
