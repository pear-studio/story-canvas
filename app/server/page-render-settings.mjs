import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ApiError } from './http-support.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { resolveProjectLocation } from './project-operations.mjs';
import { readPageEntry, pageRelativePath } from './pages-store.mjs';
import { commitFactChanges } from './story-facts.mjs';
import { compileEffectiveRenderProfile } from './render-profile-compiler.mjs';
import { modelAdapter, profileModelAdapter } from './model-adapters.mjs';
import { makeModelPromptDocument, isModelPromptDocument } from './model-prompts.mjs';

export const pageCanvases = Object.freeze(['3:4', '1:1', '4:3', '2:3', '9:16']);
export function validatePageRenderSettings(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['页面生成设置必须是对象'];
  if (Object.keys(value).some(key => !['version', 'model_id', 'profile_id', 'canvas'].includes(key))) errors.push('页面生成设置包含未知字段');
  try { modelAdapter(value.model_id); } catch(error) { errors.push(error.message); }
  if (value.version !== 1) errors.push('页面生成设置 version 必须为 1');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.profile_id ?? '')) errors.push('profile_id 无效');
  if (!pageCanvases.includes(value.canvas)) errors.push('页面画幅无效');
  return errors;
}
export function pageSettingsFromDefaults(project, modelId = 'qwen') {
  return { version: 1, model_id: modelId, profile_id: project.default_render_profile, canvas: project.canvas };
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
  const prompt=JSON.parse(await readFile(path.join(project.projectDirectory,pageRelativePath(pageId,'prompt')),'utf8'));
  return { project, definition: { persisted, targetRelative: pageRelativePath(pageId, 'render'), identity: { page_id: pageId }, upstream: {prompt_sha256:hashCanonicalJson(prompt)} } };
}
export async function commitPageRender(root, context, readDocument) {
  const { project, definition } = await readPageRenderDraft(root, context.project_id, context.page_id);
  if (hashCanonicalJson(definition.persisted) !== context.target.sha256) throw new ApiError(409, 'page_render_target_conflict');
  const value = await readDocument();
  const errors = validatePageRenderSettings(value);
  if (errors.length) throw new ApiError(422, 'page_render_settings_invalid', errors);
  const bundle = await compileEffectiveRenderProfile({ repositoryRoot: root, projectRoot: project.projectDirectory, profileId: value.profile_id });
  if (bundle.blocked) throw new ApiError(422, 'render_profile_override_conflict');
  if (value.model_id !== profileModelAdapter(bundle.effective_profile).id) throw new ApiError(422, 'page_profile_model_mismatch');
  const route = bundle.effective_profile.operations.candidates.routes.empty_latent;
  if (!route?.recipe.resolutions[value.canvas]) throw new ApiError(422, 'page_canvas_unsupported');
  const target = path.join(project.projectDirectory, definition.targetRelative);
  const before = await readFile(target, 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const promptRelative=pageRelativePath(context.page_id,'prompt');
  const beforePrompt=JSON.parse(await readFile(path.join(project.projectDirectory,promptRelative),'utf8'));
  if(context.upstream.prompt_sha256!==hashCanonicalJson(beforePrompt))throw new ApiError(409,'page_render_input_conflict');
  const nextPrompt=isModelPromptDocument(beforePrompt)?structuredClone(beforePrompt):makeModelPromptDocument(beforePrompt.$schema,'qwen',beforePrompt);
  if(!nextPrompt.models[value.model_id]) {
    const input=modelAdapter(value.model_id).emptyPrompt();
    if(value.model_id==='qwen' && nextPrompt.models.anima) {
      input.text=await animaImportText(root,project.projectDirectory,context.page_id);input.composition='standalone';
    }
    input.loras=Object.keys(bundle.effective_profile.style_loras??{}).sort().map(id=>structuredClone(bundle.effective_profile.style_loras[id]));
    nextPrompt.models[value.model_id]=input;
  }
  await commitFactChanges(project.projectDirectory, [
    {relative:promptRelative,before:beforePrompt,after:nextPrompt},
    { relative: definition.targetRelative, before, after: value },
  ]);
  return { page_id: context.page_id, render: value, render_sha256: hashCanonicalJson(value) };
}

async function animaImportText(root,directory,pageId) {
  const {compilePageRenderInspectionContext}=await import('./page-render-resolver.mjs');
  const render=await readPageRenderSettings(directory,pageId);
  const source=await compilePageRenderInspectionContext({repositoryRoot:root,projectDirectory:directory,pageKey:{page_id:pageId},renderOverride:{...render,model_id:'anima',profile_id:modelAdapter('anima').defaultProfile}});
  if(source.blockers.length || !source.compiled_page?.ready || !source.compiled_page.positive_prompt)throw new ApiError(422,'anima_prompt_unavailable',source.blockers.map(value=>value.message));
  return source.compiled_page.positive_prompt;
}

export async function reimportAnimaPrompt(root,projectId,value) {
  const {projectDirectory:directory}=await resolveProjectLocation(root,projectId);
  const pageId=value.page_key?.page_id;
  if(!await readPageEntry(directory,pageId))throw new ApiError(404,'page_not_found');
  const render=await readPageRenderSettings(directory,pageId),relative=pageRelativePath(pageId,'prompt');
  const before=JSON.parse(await readFile(path.join(directory,relative),'utf8'));
  if(hashCanonicalJson(before)!==value.expected_prompt_sha256 || hashCanonicalJson(render)!==value.expected_render_sha256)throw new ApiError(409,'qwen_import_conflict');
  if(render.model_id!=='qwen'||!before.models?.anima||!before.models.qwen)throw new ApiError(422,'anima_prompt_unavailable');
  const text=await animaImportText(root,directory,pageId),after=structuredClone(before);
  after.models.qwen={...after.models.qwen,text,composition:'standalone'};
  await commitFactChanges(directory,[{relative,before,after}]);
  return {page_id:pageId,prompt:after.models.qwen,prompt_sha256:hashCanonicalJson(after)};
}
