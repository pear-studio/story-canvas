import {savedFactReceipt} from './saved-fact-receipt.mjs';
import {promptSourceView} from '../shared/prompt-source-view.mjs';
import {modelAdapter} from './model-adapters.mjs';
import { readFactDraft, saveFactDraft } from './fact-drafts.mjs';
import { assertEditFingerprint } from './edit-fingerprint.mjs';
import { applyDocumentChanges } from './page-edit-context.mjs';
import { resolveProjectLocation } from './project-operations.mjs';
import { modelPrompt, replaceModelPrompt, promptModelEntries } from './model-prompts.mjs';
import { readPageContent } from './pages-store.mjs';
import { readPageRenderSettings } from './page-render-settings.mjs';
import { ApiError } from './http-support.mjs';
import { parseOverrideSource } from './prompt-contract.mjs';
import { readPagePromptDependencies, readPagePromptSources } from './prompt-source-context.mjs';
import { normalizePromptTarget, promptScopeVersion, settingPromptScopeDocument, settingPromptScopeVersion, replaceSettingPromptScope } from './prompt-scope-version.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function currentScope({projectRoot,projectId,target:rawTarget}) {
  const project = await resolveProjectLocation(projectRoot,projectId);
  const activeModel = rawTarget?.kind === 'page' && rawTarget.model_id === undefined ? (await readPageRenderSettings(project.projectDirectory,rawTarget.id)).model_id : undefined;
  const target = normalizePromptTarget(rawTarget,activeModel);
  const identity = {domain:target.kind,kind:'prompt',projectId,targetId:target.id};
  const draft = await readFactDraft(projectRoot,identity);
  if (target.kind === 'page') {
    const document = promptModelEntries(draft.document).some(([id]) => id === target.model_id) ? structuredClone(modelPrompt(draft.document,target.model_id)) : null;
    if (!document) throw new ApiError(404,'prompt_model_missing',[target.model_id,'请先用 page.render.set 初始化该模型']);
    delete document.$schema;
    const narrative = await readPageContent(project.projectDirectory,target.id);
    const sources = await readPagePromptSources(project.projectDirectory,{projectId,modelId:target.model_id,narrative,prompt:document});
    const dependencies = await readPagePromptDependencies(project.projectDirectory,{projectId,pageId:target.id,modelId:target.model_id,prompt:document,narrative,sources});
    return {project,target,identity,draft,document,dependencies,narrative,sources,version:promptScopeVersion({projectId,target,document,dependencies})};
  }
  const visual = (await readFactDraft(projectRoot,{...identity,kind:'visual'})).document;
  const document = settingPromptScopeDocument({target,document:draft.document,visual});
  return {project,target,identity,draft,visual,document,version:settingPromptScopeVersion({projectId,target,document:draft.document,visual})};
}

function receipt(state,projectId) {
  return {target:state.target,document:state.document,save:{operation:'prompt.save',args:{project_id:projectId,target:state.target,expected_sha256:state.version,
    ...(state.target.kind === 'page' ? {source_versions:state.dependencies.sources} : {})},patch_parameter:'changes'}};
}

// 调用方分别持有 readFacts / mutateTargetFacts，写入在最新整文档上只替换本次作用域。
export async function readPromptScope(options) {
  const state = await currentScope(options);
  const result = receipt(state,options.projectId);
  if (state.target.kind === 'page') {
    const {narrative,sources} = state;
    result.references = {characters:narrative.characters ?? [],composition:modelAdapter(state.target.model_id).consumesSettings(state.document)?'settings':'standalone',
      edit:{operation:'page.editor.read',args:{project_id:options.projectId,page_key:{page_id:state.target.id},section:'content'}}};
    result.inherited_sources = Object.entries(sources).map(([key,value])=>promptSourceView(key,value,state.document));
    Object.assign(result,modelAdapter(state.target.model_id).pageScopeDetails({document:state.document,narrative,inheritedSources:result.inherited_sources,referenceEdit:result.references.edit}));
    const readProjectPrompt=modelAdapter(state.target.model_id).readProjectPrompt;
    if(readProjectPrompt)result.project_prompt=await readProjectPrompt({projectRoot:options.projectRoot,projectDirectory:state.project.projectDirectory,render:await readPageRenderSettings(state.project.projectDirectory,state.target.id),projectId:options.projectId,document:state.document});
  } else if (state.target.scope === 'variant' && modelAdapter(state.target.model_id).inheritedSettingReadHint) {
    const sources = await readPromptScopeSources({...options,target:state.target});
    result.inherited_sources = sources.sources;
    result.read_hint = modelAdapter(state.target.model_id).inheritedSettingReadHint;
  }
  return result;
}

export async function savePromptScope(options) {
  if (!record(options.changes) || !Object.keys(options.changes).length) throw new ApiError(400,'invalid_prompt_changes',['changes 必须是非空对象']);
  const state = await currentScope(options);
  assertEditFingerprint(options.expectedSha256,state.version,{invalidCode:'invalid_prompt_fingerprint',conflictCode:'prompt_scope_conflict'});
  const {person_groups,...changes} = options.changes;
  const adapter=modelAdapter(state.target.model_id);
  if (person_groups !== undefined) {
    if (state.target.kind !== 'page' || !adapter.applyPersonGroups || Object.hasOwn(changes,'person')) throw new ApiError(400,'invalid_person_groups',['仅 Anima 页面可用，不能与 person 同时提交']);
    const narrative = await readPageContent(state.project.projectDirectory,state.target.id);
    changes.person = adapter.applyPersonGroups(state.document.person ?? [],person_groups,narrative.characters ?? []);
  }
  const changed = applyDocumentChanges(state.document,changes);
  if(state.target.kind==='page')adapter.normalizePageScope?.(changed);
  const model = state.target.kind === 'page' ? changed : replaceSettingPromptScope({target:state.target,document:state.draft.document,visual:state.visual,value:changed});
  const document = replaceModelPrompt(state.draft.document,state.target.model_id,{$schema:state.draft.document.$schema,...model});
  const saved = await saveFactDraft(options.projectRoot,{...state.identity,document,
    expectedSha256:state.draft.expected_sha256,expectedContextSha256:state.draft.expected_context_sha256,
    conflictCode:'prompt_scope_conflict',contextConflictCode:'prompt_scope_conflict',
    ...(state.target.kind === 'page' ? {sourceVersions:{[state.target.model_id]:options.sourceVersions ?? {}}} : {}),
  });
  return savedFactReceipt(async () => {
  const inactive = state.target.kind === 'page' && (await readPageRenderSettings(state.project.projectDirectory,state.target.id)).model_id !== state.target.model_id;
  return {saved:true,...await readPromptScope({...options,target:state.target}),
    ...(inactive ? {audit:{status:'not_run',model_id:state.target.model_id,reason:'inactive_model'}} : saved.audit ? {audit:{model_id:state.target.model_id,...Object.fromEntries(Object.entries(saved.audit).filter(([key,value]) => ['status','valid','errors','warnings','diagnostics'].includes(key) && (!Array.isArray(value)||value.length)))}} : {}),
    ...(saved.warnings?.length ? {warnings:saved.warnings} : {}),
    ...(saved.downstream_diagnostics?.length ? {downstream_diagnostics:saved.downstream_diagnostics} : {}),
  };
  }, {operation:'prompt.read',args:{project_id:options.projectId,target:state.target}});
}

// source 可选择将要新引用的角色／场景，先读取其内容和版本再提交引用变更。
export async function readPromptScopeSources(options) {
  const state = await currentScope(options);
  let narrative, prompt, source = options.source;
  if (source !== undefined && !parseOverrideSource(source)) throw new ApiError(400,'invalid_prompt_source');
  if (state.target.kind === 'page') {
    narrative = await readPageContent(state.project.projectDirectory,state.target.id);
    prompt = state.document;
  } else {
    if (state.target.scope !== 'variant') throw new ApiError(400,'prompt_source_requires_variant');
    const ownSource = `${state.target.kind}:${state.target.id}:${state.target.variant_id}`;
    if (source !== undefined && source !== ownSource) throw new ApiError(400,'prompt_source_target_mismatch',['设定范围只查询自身基础；其他来源请更换 target']);
    source = ownSource;
  }
  if (source) {
    const target = parseOverrideSource(source);
    narrative = {characters:target.kind === 'character' ? [{character_id:target.id,variant_id:target.variant_id}] : []};
    prompt = target.kind === 'scene' ? {scene_id:target.id,scene_variant_id:target.variant_id} : {};
  }
  const sources = await readPagePromptSources(state.project.projectDirectory,{projectId:options.projectId,modelId:state.target.model_id,narrative,prompt});
  if (source && !sources[source]) throw new ApiError(404,'prompt_source_not_found',[source]);
  const selected = Object.entries(sources);
  return {target:state.target,sources:source ? selected.map(([key,value])=>promptSourceView(key,value,state.document,{baseOnly:state.target.kind !== 'page'})) : selected.map(([key,value])=>({source:key,kind:value.kind,id:value.id,variant_id:value.variant_id,sha256:value.sha256,...(value.missing ? {missing:value.missing} : {})})),
    source_versions:Object.fromEntries(selected.map(([key,value])=>[key,value.sha256])),
    usage:(state.target.kind === 'page' ? '把 source_versions 合并进原 prompt.read 的 save.args.source_versions；保留原 expected_sha256，不能用来源查询更新页面版本。' : '')+modelAdapter(state.target.model_id).sourceReadHint(state.target),
  };
}

export function promptEditorMigration(domain,kind,targetId,projectId) {
  if (!['prompt','page-prompt'].includes(kind)) return null;
  const target = {kind:kind === 'page-prompt' || domain === 'story' ? 'page' : domain,id:targetId};
  return new ApiError(400,'prompt_editor_moved',[{message:'Prompt 编辑已统一为 prompt.read/save；重新读取指定模型和范围后提交 changes，不重用旧完整草稿。',next:{operation:'prompt.read',args:{project_id:projectId,target}},...(target.kind === 'page' ? {} : {required:'target.model_id 与 scope:base 或 scope:variant + variant_id'})}]);
}
