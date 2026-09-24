import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ApiError } from './http-support.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { resolveProjectLocation } from './project-operations.mjs';
import { readPageEntry, pageRelativePath } from './pages-store.mjs';
import { commitFactChanges } from './story-facts.mjs';
import { compileEffectiveRenderProfile } from './render-profile-compiler.mjs';

export const pageCanvases = Object.freeze(['2:3', '3:4', '9:16', '4:3']);
export function validatePageRenderSettings(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['页面生成设置必须是对象'];
  if (Object.keys(value).some(key => !['version', 'profile_id', 'canvas'].includes(key))) errors.push('页面生成设置包含未知字段');
  if (value.version !== 1) errors.push('页面生成设置 version 必须为 1');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.profile_id ?? '')) errors.push('profile_id 无效');
  if (!pageCanvases.includes(value.canvas)) errors.push('页面画幅无效');
  return errors;
}
export function pageSettingsFromDefaults(project) {
  return { version: 1, profile_id: project.default_render_profile, canvas: project.canvas };
}
export async function readPageRenderSettings(directory, pageId, project = null) {
  const relative = pageRelativePath(pageId, 'render');
  let value;
  try { value = JSON.parse(await readFile(path.join(directory, relative), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 迁移窗口只允许旧格式项目使用旧行为；新格式缺失文件必须报错。
    project ??= JSON.parse(await readFile(path.join(directory, 'project.json'), 'utf8'));
    if (project.format !== 'story-free-text-v1') throw new ApiError(422, 'page_render_settings_missing', [relative]);
    value = pageSettingsFromDefaults(project);
  }
  const errors = validatePageRenderSettings(value);
  if (errors.length) throw new ApiError(422, 'page_render_settings_invalid', errors);
  return value;
}
export function pageProjectSettings(project, settings) {
  return { ...project, canvas: settings.canvas, default_render_profile: settings.profile_id };
}
export async function readPageRenderDraft(root, projectId, pageId) {
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  if (!await readPageEntry(project.projectDirectory, pageId)) throw new ApiError(404, 'page_not_found');
  const persisted = await readPageRenderSettings(project.projectDirectory, pageId);
  return { project, definition: { persisted, targetRelative: pageRelativePath(pageId, 'render'), identity: { page_id: pageId }, upstream: {} } };
}
export async function commitPageRender(root, context, readDocument) {
  const { project, definition } = await readPageRenderDraft(root, context.project_id, context.page_id);
  if (hashCanonicalJson(definition.persisted) !== context.target.sha256) throw new ApiError(409, 'page_render_target_conflict');
  const value = await readDocument();
  const errors = validatePageRenderSettings(value);
  if (errors.length) throw new ApiError(422, 'page_render_settings_invalid', errors);
  const bundle = await compileEffectiveRenderProfile({ repositoryRoot: root, projectRoot: project.projectDirectory, profileId: value.profile_id });
  if (bundle.blocked) throw new ApiError(422, 'render_profile_override_conflict');
  const route = bundle.effective_profile.operations.candidates.routes.empty_latent;
  if (!route?.recipe.resolutions[value.canvas]) throw new ApiError(422, 'page_canvas_unsupported');
  const target = path.join(project.projectDirectory, definition.targetRelative);
  const before = await readFile(target, 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
  await commitFactChanges(project.projectDirectory, [{ relative: definition.targetRelative, before, after: value }]);
  return { page_id: context.page_id, render: value, render_sha256: hashCanonicalJson(value) };
}
