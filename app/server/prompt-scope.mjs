import {promptSourceView, promptPageDiagnostics} from '../shared/prompt-source-view.mjs';
import {applyPersonGroups} from './prompt-person-edit.mjs';
import { readFactDraft, saveFactDraft, fingerprintErrors } from './fact-drafts.mjs';
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
    result.references = {characters:narrative.characters ?? [],composition:state.document.composition ?? 'settings',
      edit:{operation:'page.editor.read',args:{project_id:options.projectId,page_key:{page_id:state.target.id},section:'content'}}};
    result.inherited_sources = Object.entries(sources).map(([key,value])=>promptSourceView(key,value,state.document));
    if (state.target.model_id === 'anima') {
      const person=state.document.person ?? [];
      result.bindings={characters:(narrative.characters ?? []).map(ref=>({character_id:ref.character_id,person_indices:person.flatMap((entry,index)=>entry.character_id===ref.character_id?[index]:[])})),unbound_person_indices:person.flatMap((entry,index)=>!entry.character_id?[index]:[])};
    }
    result.diagnostics = promptPageDiagnostics(state.document,narrative.characters ?? [],result.inherited_sources,state.target.model_id);
    result.read_hint = state.target.model_id==='anima'
      ? 'document 仅本页词；references.characters 是画面引用，独立于人数和对白。inherited_sources 已应用覆盖，enabled 为启用，consumed 表示该分类会送入编译；去重后的实际输出按需查 prompt.context，不要复制继承。按角色改本页词用 changes.person_groups:[{character_id,entries}]，null 为未绑定，条目不填 character_id。解除角色用 references.edit；只删词或 LoRA 不会解除引用。diagnostics 是带来源、位置和权重的核查线索，不代表可自动删除。'
      : 'document 是本页文字与覆盖。references.characters 为画面引用；standalone 时不消费上游。inherited_sources 的 text 已应用覆盖，reference_images 为可用图库，selected_image_ids 才是选择结果（空数组表示不选）。解除引用用 references.edit，保留画外对白。';

  } else if (state.target.model_id === 'anima' && state.target.scope === 'variant') {
    const sources = await readPromptScopeSources({...options,target:state.target});
    result.inherited_sources = sources.sources;
    result.read_hint = 'document 是子设定自身词；inherited_sources 是基础继承词，调整 identity_overrides，不重复添加。';
  }
  return result;
}

export async function savePromptScope(options) {
  const errors = fingerprintErrors({expected_sha256:options.expectedSha256},['expected_sha256']);
  if (errors.length) throw new ApiError(400,'invalid_prompt_fingerprint',errors);
  if (!record(options.changes) || !Object.keys(options.changes).length) throw new ApiError(400,'invalid_prompt_changes',['changes 必须是非空对象']);
  const state = await currentScope(options);
  if (options.expectedSha256 !== state.version) throw new ApiError(409,'prompt_scope_conflict',[{target:state.target,message:'本次范围或必要上游已变化；重读判断后再编辑'}]);
  const {person_groups,...changes} = options.changes;
  if (person_groups !== undefined) {
    if (state.target.kind !== 'page' || state.target.model_id !== 'anima' || Object.hasOwn(changes,'person')) throw new ApiError(400,'invalid_person_groups',['仅 Anima 页面可用，不能与 person 同时提交']);
    const narrative = await readPageContent(state.project.projectDirectory,state.target.id);
    changes.person = applyPersonGroups(state.document.person ?? [],person_groups,narrative.characters ?? []);
  }
  const changed = applyDocumentChanges(state.document,changes);
  const model = state.target.kind === 'page' ? changed : replaceSettingPromptScope({target:state.target,document:state.draft.document,visual:state.visual,value:changed});
  const document = replaceModelPrompt(state.draft.document,state.target.model_id,{$schema:state.draft.document.$schema,...model});
  const saved = await saveFactDraft(options.projectRoot,{...state.identity,document,
    expectedSha256:state.draft.expected_sha256,expectedContextSha256:state.draft.expected_context_sha256,
    conflictCode:'prompt_scope_conflict',contextConflictCode:'prompt_scope_conflict',
    ...(state.target.kind === 'page' ? {sourceVersions:{[state.target.model_id]:options.sourceVersions ?? {}}} : {}),
  });
  const inactive = state.target.kind === 'page' && (await readPageRenderSettings(state.project.projectDirectory,state.target.id)).model_id !== state.target.model_id;
  return {saved:true,...await readPromptScope({...options,target:state.target}),
    ...(inactive ? {audit:{status:'not_run',model_id:state.target.model_id,reason:'inactive_model'}} : saved.audit ? {audit:{model_id:state.target.model_id,...Object.fromEntries(Object.entries(saved.audit).filter(([key,value]) => ['status','valid','errors','warnings','diagnostics'].includes(key) && (!Array.isArray(value)||value.length)))}} : {}),
    ...(saved.warnings?.length ? {warnings:saved.warnings} : {}),
    ...(saved.downstream_diagnostics?.length ? {downstream_diagnostics:saved.downstream_diagnostics} : {}),
  };
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
    usage:state.target.kind === 'page' ? '把 source_versions 合并进原 prompt.read 的 save.args.source_versions；保留原 expected_sha256，不能用来源查询更新页面版本。页面调整写 inheritance[source][key]。' : '本子设定只显示可覆盖的基础词，调整写 identity_overrides[key]；自身词在 prompt.read 的 prompt 分类数组中编辑。',
  };
}

export function promptEditorMigration(domain,kind,targetId,projectId) {
  if (!['prompt','page-prompt'].includes(kind)) return null;
  const target = {kind:kind === 'page-prompt' || domain === 'story' ? 'page' : domain,id:targetId};
  return new ApiError(400,'prompt_editor_moved',[{message:'Prompt 编辑已统一为 prompt.read/save；重新读取指定模型和范围后提交 changes，不重用旧完整草稿。',next:{operation:'prompt.read',args:{project_id:projectId,target}},...(target.kind === 'page' ? {} : {required:'target.model_id 与 scope:base 或 scope:variant + variant_id'})}]);
}
