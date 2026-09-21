import { resolveReferenceEntries } from "../shared/reference-images.mjs";
import { readReferenceImage } from "./reference-image.mjs";
import { readPageIndex } from './pages-store.mjs';
import { resolveSceneConfiguration } from './scene-files.mjs';
import { readScenes, readInheritanceSources, checkPageInheritanceReferences } from './prompt-inheritance-facts.mjs';
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  validateCharacterIndexDocument,
  validateCharacterProfileDocument,
  validateCharacterPromptDocument,
  validateCharacterVisualDocument,
} from "./character-files.mjs";
import { compileCurrentPagePrompt } from "./current-page-prompt.mjs";
import { createPageKey, decodePageKey, encodePageKey } from "./page-key.mjs";
import { compileEffectiveRenderProfile } from "./render-profile-compiler.mjs";
import { freezeRenderRoutes } from "./render-plan-route.mjs";
import { freezePageLorasForTask } from "./render-task-helpers.mjs";
import {
  promptCharacterIds,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  storyPromptCategories,
  validateStoryPageNarrativeDocument,
  validateStoryPagePromptDocument,
} from "./story-files.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";

export class PageRenderError extends Error {
  constructor(code, details = [], status = 422) {
    super(code);
    this.name = "PageRenderError";
    this.code = code;
    this.status = status;
    this.details = Array.isArray(details) ? details : [details];
  }
}

function fail(code, details = [], status = 422) {
  throw new PageRenderError(code, details, status);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : jsonSafe(entry)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectionBlocker(code, message, details = []) {
  return { code, message, details: Array.isArray(details) ? details : [details] };
}

function normalizeInspectionPromptDraft(value) {
  const source = isRecord(value) ? value : {};
  const prompt = { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, reference_images: source.reference_images, reference_overrides: source.reference_overrides, ...(source.scene_id ? { scene_id: source.scene_id, scene_variant_id: source.scene_variant_id } : {}), ...(source.inheritance ? { inheritance: structuredClone(source.inheritance) } : {}) };
  for (const category of storyPromptCategories) {
    prompt[category] = Array.isArray(source[category])
      ? source[category].filter(isRecord).map((fragment) => structuredClone(fragment))
      : [];
  }
  const submitted = { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, ...(isRecord(value) ? structuredClone(value) : {}) };
  return { prompt, errors: validateStoryPagePromptDocument(submitted) };
}

async function readJsonFact(projectDirectory, relativePath, { optional = false } = {}) {
  const target = path.resolve(projectDirectory, ...relativePath.split("/"));
  if (!isWithin(projectDirectory, target)) fail("project_fact_path_invalid", [relativePath]);
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") fail("project_fact_missing", [relativePath]);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("project_fact_path_invalid", [relativePath]);
  const [projectReal, targetReal] = await Promise.all([realpath(projectDirectory), realpath(target)]);
  if (!isWithin(projectReal, targetReal)) fail("project_fact_path_invalid", [relativePath]);
  let source;
  let value;
  try {
    source = await readFile(target, "utf8");
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) fail("project_fact_json_invalid", [relativePath, error.message]);
    throw error;
  }
  return {
    relative_path: relativePath,
    absolute_path: target,
    sha256: createHash("sha256").update(source).digest("hex"),
    value,
  };
}

function assertDocument(source, validate) {
  const errors = validate(source.value);
  if (errors.length) fail("project_fact_contract_invalid", errors.map((error) => `${source.relative_path}: ${error}`));
  return source.value;
}

function variantIds(visual) {
  return new Set(visual.variants.map((variant) => variant.id));
}

async function readCharacter(projectDirectory, characterIndex, reference) {
  const characterId = reference.character_id;
  if (!characterIndex.characters.includes(characterId)) fail("character_dangling", [`角色不存在：${characterId}`]);
  const [profileSource, visualSource, promptSource] = await Promise.all([
    readJsonFact(projectDirectory, `characters/${characterId}.profile.json`),
    readJsonFact(projectDirectory, `characters/${characterId}.visual.json`),
    readJsonFact(projectDirectory, `characters/${characterId}.prompt.json`),
  ]);
  const profile = assertDocument(profileSource, validateCharacterProfileDocument);
  const visual = assertDocument(visualSource, validateCharacterVisualDocument);
  const promptDocument = assertDocument(promptSource, validateCharacterPromptDocument);
  if (!variantIds(visual).has(reference.variant_id)) {
    fail("character_variant_dangling", [`${characterId} 不存在 variant：${reference.variant_id}`]);
  }
  const configuration = promptDocument.variants[reference.variant_id];
  if (!configuration) fail("character_configuration_dangling", [`${characterId}: variant ${reference.variant_id} 缺少完整 Prompt/LoRA 配置`]);
  const character = {
    id: characterId,
    name: profile.name,
    description: profile.description,
    identity: { prompt: structuredClone(promptDocument.identity.prompt) },
    prompt: structuredClone(configuration.prompt),
    identity_disabled: structuredClone(configuration.identity_disabled),
    identity_overrides: structuredClone(configuration.identity_overrides ?? {}),
    reference_images: structuredClone(configuration.reference_images ?? []),
    configuration_id: reference.variant_id,
    configuration_path: `variants.${reference.variant_id}`,
    loras: [
      ...(promptDocument.identity.lora === null ? [] : [structuredClone(promptDocument.identity.lora)]),
      ...structuredClone(configuration.loras),
    ],
  };
  return {
    character,
    sources: [profileSource, visualSource, promptSource],
    facts: { profile, visual, prompt: promptDocument, configuration },
  };
}

async function readPageIdentity(projectDirectory, pageId) {
  const index = await readPageIndex(projectDirectory);
  const membership = index.pages.find(entry => entry.page_id === pageId);
  if (!membership) fail("page_not_found", [pageId], 404);
  const source = await readJsonFact(projectDirectory, "pages/index.json");
  return { kind: membership.owner_kind, membership, sources: [source] };
}

async function readExactPageIdentity(projectDirectory, pageKey) {
  return readPageIdentity(projectDirectory, pageKey.page_id);
}

function decodeFullPageKey(pageKey) {
  try { return decodePageKey(pageKey); }
  catch { fail("invalid_page_key", ["page_key 无效"], 400); }
}

export async function resolveExactPageIdentity(projectDirectory, pageKey) {
  const requested = decodeFullPageKey(pageKey);
  return resolvePageIdentity(projectDirectory, requested.page_id);
}

export async function resolvePageIdentity(projectDirectory, pageId) {
  const identity = await readPageIdentity(projectDirectory, pageId);
  return {
    ...identity.membership,
    kind: identity.kind,
    page_id: pageId,
    page_key: createPageKey(pageId),
    owner_id: identity.membership.character_id ?? identity.membership.scene_id,
  };
}

async function loadPageSnapshot(projectDirectory, pageId, exactPageKey = null) {
  const identity = await readPageIdentity(projectDirectory, pageId);
  const [contentSource, promptSource, characterIndexSource] = await Promise.all([
    readJsonFact(projectDirectory, `pages/${pageId}.content.json`),
    readJsonFact(projectDirectory, `pages/${pageId}.prompt.json`),
    readJsonFact(projectDirectory, "characters/index.json"),
  ]);
  const content = assertDocument(contentSource, validateStoryPageNarrativeDocument);
  const pagePrompt = assertDocument(promptSource, validateStoryPagePromptDocument);
  const characterIndex = assertDocument(characterIndexSource, validateCharacterIndexDocument);
  const references = content.characters;
  const sources = [...identity.sources, contentSource, promptSource, characterIndexSource];
  const referenceErrors = [];
  const activeIds = new Set(references.map(reference => reference.character_id));
  const invalidOwners = promptCharacterIds(pagePrompt).filter(id => !activeIds.has(id));
  if (invalidOwners.length) referenceErrors.push(...invalidOwners.map(id => `页面 Prompt 绑定了未出场角色：${id}`));
  const resolvedCharacters = [];
  for (const reference of references) {
    try { resolvedCharacters.push(await readCharacter(projectDirectory, characterIndex, reference)); }
    catch (error) {
      if (!["character_dangling", "character_variant_dangling", "character_configuration_dangling"].includes(error.code)) throw error;
      referenceErrors.push(...error.details);
    }
  }
  sources.push(...resolvedCharacters.flatMap(entry => entry.sources));
  const scenes = [];
  if (pagePrompt.scene_id) {
    const scene = (await readScenes(projectDirectory)).scenes.find(item => item.id === pagePrompt.scene_id);
    if (!scene) referenceErrors.push(`场景不存在：${pagePrompt.scene_id}`);
    else {
      try { scenes.push(resolveSceneConfiguration(scene, pagePrompt.scene_variant_id)); }
      catch (error) { referenceErrors.push(error.message); }
      sources.push(...await Promise.all(['profile', 'visual', 'prompt'].map(kind => readJsonFact(projectDirectory, `scenes/${scene.id}.${kind}.json`))));
    }
  }
  let inheritanceErrors = [];
  try { inheritanceErrors = checkPageInheritanceReferences(pagePrompt, await readInheritanceSources(projectDirectory, references, pagePrompt.scene_id, pagePrompt.scene_variant_id)); }
  catch (error) { inheritanceErrors.push(...(error.details ?? [error.message])); }
  return {
    kind: identity.kind, owner_kind: identity.kind, page_id: pageId, page_key: createPageKey(pageId),
    owner_id: identity.membership.character_id ?? identity.membership.scene_id,
    ...(identity.kind === "story" ? { sequence_id: identity.membership.sequence_id } : {}),
    title: content.title, scene_description: content.scene_description, page_kind: content.page_kind ?? null,
    character_references: references, page_prompt: pagePrompt, scenes,
    inheritance_errors: [...referenceErrors, ...inheritanceErrors],
    characters: resolvedCharacters.map(entry => entry.character),
    character_facts: Object.fromEntries(resolvedCharacters.map(entry => [entry.character.id, entry.facts])),
    sources,
    source_fingerprint: hashCanonicalJson(Object.fromEntries(sources.map(source => [source.relative_path, source.sha256]))),
  };
}

// 写入入口在已有事实锁内捕获，后续编译只消费这份内存快照。
export async function capturePagePromptSnapshot(projectDirectory, pageId, pageKey = null) {
  const [projectSource, snapshot] = await Promise.all([
    readJsonFact(projectDirectory, "project.json"),
    loadPageSnapshot(projectDirectory, pageId, pageKey),
  ]);
  snapshot.sources.push(projectSource);
  snapshot.source_fingerprint = hashCanonicalJson(Object.fromEntries(snapshot.sources.map((source) => [source.relative_path, source.sha256])));
  return { ...snapshot, project: projectSource.value, project_source: projectSource };
}

export function compilePagePromptSnapshot(snapshot, profile, dictionaryEntries, profilePromptFragmentSources = null) {
  const compiled = compileCurrentPagePrompt({
    pageId: snapshot.page_id,
    pageKey: snapshot.page_key,
    pagePrompt: snapshot.page_prompt,
    profile,
    characters: snapshot.characters,
    scenes: snapshot.scenes ?? [],
    participantIds: snapshot.character_references.map((reference) => reference.character_id),
    dictionaryEntries,
    profilePromptFragmentSources,
  });
  compiled.errors.push(...(snapshot.inheritance_errors ?? []));
  if (profile.architecture_family === "qwen-image-2-1" && compiled.loras.length) compiled.errors.push("当前 Qwen 配置暂不支持 LoRA；请使用无 LoRA 的页面或保留 Anima 配置");
  compiled.ready = compiled.ready && !compiled.errors.length;
  return compiled;
}

export function pagePromptDiagnostics(compiled) {
  return [
    ...compiled.missing.map((message) => inspectionBlocker("page_prompt_missing", message)),
    ...compiled.errors.map((message) => inspectionBlocker("page_prompt_invalid", message)),
    ...(!compiled.positive_prompt ? [inspectionBlocker("positive_prompt_empty", "Positive Prompt 为空")] : []),
  ];
}

export async function compilePageRenderTarget({
  repositoryRoot,
  projectDirectory,
  pageKey,
  dictionaryEntries = null,
}) {
  const requestedPageKey = decodeFullPageKey(pageKey);
  const pageId = requestedPageKey.page_id;
  const snapshot = await capturePagePromptSnapshot(projectDirectory, pageId, requestedPageKey);
  const { project, project_source: projectSource } = snapshot;
  if (typeof project.default_render_profile !== "string" || !project.default_render_profile
    || !new Set(["2:3", "3:4", "9:16", "4:3"]).has(project.canvas)) {
    fail("project_render_settings_invalid", ["project.json 缺少 default_render_profile 或有效 canvas"]);
  }
  if (encodePageKey(snapshot.page_key) !== encodePageKey(requestedPageKey)) {
    fail("page_owner_mismatch", [`请求 ${encodePageKey(requestedPageKey)}，实际 ${encodePageKey(snapshot.page_key)}`], 404);
  }
  if (snapshot.page_kind === "text") {
    fail("text_page_not_renderable", ["文字页不生成候选图，请直接输出成品"]);
  }
  const compiledProfile = await compileEffectiveRenderProfile({
    repositoryRoot,
    projectRoot: projectDirectory,
    profileId: project.default_render_profile,
  });
  if (compiledProfile.blocked) {
    fail("render_profile_override_conflict", compiledProfile.override_resolution.conflicts.map((item) => item.target));
  }
  const compiledPage = compilePagePromptSnapshot(snapshot, compiledProfile.effective_profile, dictionaryEntries, compiledProfile.source_identity.prompt_fragments);
  if (!compiledPage.ready) {
    fail("page_not_renderable", [...compiledPage.missing, ...compiledPage.errors, ...compiledPage.audit.errors.map((issue) => issue.message)]);
  }
  const participants = snapshot.character_references.map((reference) => reference.character_id);
  const pageLoras = freezePageLorasForTask(compiledPage, {
    active_scene_settings: snapshot.scenes.map(scene => ({scene_id:scene.id,loras:structuredClone(scene.loras)})),
    active_character_settings: snapshot.characters.map((character) => ({
      character_id: character.id,
      loras: structuredClone(character.loras),
    })),
  });
  const referenceImages = await resolvePageReferenceImages(projectDirectory, snapshot);
  const routed = freezeRenderRoutes([{ reference_images: referenceImages.map(r => r.identity), id: `target.${encodePageKey(snapshot.page_key).replaceAll("/", ".")}`, page_key: snapshot.page_key }], {
    purpose: "candidate",
    resolvedProfile: compiledProfile.effective_profile,
  })[0];
  const profileRoute = compiledProfile.effective_profile.operations.candidates.routes[routed.render_route.input_source];
  const workflowDefinition = compiledProfile.workflow_definitions[routed.render_route.workflow_id];
  if (!profileRoute?.recipe || !workflowDefinition) fail("render_profile_route_unavailable", [routed.render_route.workflow_id]);
  const models = Object.fromEntries(Object.entries(compiledProfile.effective_profile.models ?? {}).map(([role, model]) => [role, {
    role,
    relative_path: model.relative_path,
    sha256: model.sha256,
    size_bytes: model.size_bytes ?? null,
  }]));
  const renderIdentity = {
    architecture_family: compiledProfile.effective_profile.architecture_family,
    prompt_family: compiledProfile.effective_profile.prompt.family,
    profile_id: compiledProfile.effective_profile.id,
    profile_sha256: hashCanonicalJson(compiledProfile.effective_profile),
    canvas: project.canvas,
    models,
    base_model_sha256: models.dit?.sha256 ?? null,
  };
  const target = {
    ...snapshot,
    project,
    project_source: projectSource,
    compiled_profile: compiledProfile,
    compiled_page: compiledPage,
    reference_images: referenceImages.map(r => r.identity),
    reference_image_bytes: referenceImages,
    participant_ids: participants,
    page_loras: pageLoras,
    render_identity: renderIdentity,
    candidate_route: routed.render_route,
    candidate_recipe: structuredClone(profileRoute.recipe),
    candidate_workflow: {
      id: workflowDefinition.id,
      template_sha256: workflowDefinition.template_sha256,
      manifest_sha256: workflowDefinition.manifest_sha256,
    },
    base_cfg: profileRoute.recipe.cfg,
    canonical_page_key: encodePageKey(snapshot.page_key),
  };
  target.target_sha256 = hashCanonicalJson(jsonSafe({
    page_key: target.page_key,
    source_fingerprint: target.source_fingerprint,
    compiled_page: target.compiled_page,
    participant_ids: target.participant_ids,
    page_loras: target.page_loras,
    render_identity: target.render_identity,
    reference_images: target.reference_images,
    candidate_route: target.candidate_route,
    candidate_recipe: target.candidate_recipe,
    candidate_workflow: target.candidate_workflow,
  }));
  return target;
}

/**
 * 为工作台流程预览编译当前页面，但不创建任务，也不会把 Prompt 草稿写入项目事实。
 * 页面身份和既有项目事实仍然严格校验；只有渲染配置、Prompt 可渲染性与 route
 * 被投影为 blockers，便于浏览器在修正前继续展示可用上下文。
 */
export async function compilePageRenderInspectionContext({
  repositoryRoot,
  projectDirectory,
  pageKey,
  pagePromptDraft = undefined,
  dictionaryEntries = null,
  dictionaryError = null,
}) {
  const requestedPageKey = decodeFullPageKey(pageKey);
  const pageId = requestedPageKey.page_id;
  const snapshot = await capturePagePromptSnapshot(projectDirectory, pageId, requestedPageKey);
  const { project, project_source: projectSource } = snapshot;
  if (encodePageKey(snapshot.page_key) !== encodePageKey(requestedPageKey)) {
    fail("page_owner_mismatch", [`请求 ${encodePageKey(requestedPageKey)}，实际 ${encodePageKey(snapshot.page_key)}`], 404);
  }
  const blockers = [];

  if (snapshot.page_kind === "text") {
    blockers.push(inspectionBlocker("text_page_not_renderable", "文字页不生成候选图；编辑标题与正文后直接输出成品"));
  }

  if (pagePromptDraft !== undefined) {
    const normalized = normalizeInspectionPromptDraft(pagePromptDraft);
    snapshot.page_prompt = normalized.prompt;
    snapshot.scenes = [];
    if (normalized.prompt.scene_id) {
      const scene = (await readScenes(projectDirectory)).scenes.find(s => s.id === normalized.prompt.scene_id);
      if (scene) {
        try { snapshot.scenes = [resolveSceneConfiguration(scene, normalized.prompt.scene_variant_id)]; }
        catch (error) { blockers.push(inspectionBlocker("scene_variant_dangling", error.message)); }
      } else blockers.push(inspectionBlocker("scene_dangling", `场景不存在：${normalized.prompt.scene_id}`));
    }
    try { snapshot.inheritance_errors = checkPageInheritanceReferences(normalized.prompt, await readInheritanceSources(projectDirectory, snapshot.character_references, normalized.prompt.scene_id, normalized.prompt.scene_variant_id)); }
    catch (error) { snapshot.inheritance_errors = error.details ?? [error.message]; }
    blockers.push(...normalized.errors.map((message) => inspectionBlocker("page_prompt_draft_invalid", message)));
  }

  if (typeof project.default_render_profile !== "string" || !project.default_render_profile) {
    blockers.push(inspectionBlocker("project_render_profile_missing", "project.json 缺少 default_render_profile"));
  }
  if (!new Set(["2:3", "3:4", "9:16", "4:3"]).has(project.canvas)) {
    blockers.push(inspectionBlocker("project_canvas_invalid", "project.json 缺少有效 canvas"));
  }

  let compiledProfile = null;
  if (typeof project.default_render_profile === "string" && project.default_render_profile) {
    try {
      compiledProfile = await compileEffectiveRenderProfile({
        repositoryRoot,
        projectRoot: projectDirectory,
        profileId: project.default_render_profile,
      });
    } catch (error) {
      blockers.push(inspectionBlocker(
        error?.code ?? "render_profile_compilation_failed",
        error?.message ?? String(error),
      ));
    }
  }

  if (compiledProfile?.blocked) {
    blockers.push(...compiledProfile.override_resolution.conflicts.map((item) => inspectionBlocker(
      "render_profile_override_conflict",
      `项目生成配置调整存在冲突：${item.target}`,
      [item.target],
    )));
  }
  const activeProfile = compiledProfile?.blocked
    ? compiledProfile.base_bundle.resolved_profile
    : compiledProfile?.effective_profile ?? null;
  const activeSourceIdentity = compiledProfile?.blocked
    ? compiledProfile.base_bundle.source_identity
    : compiledProfile?.source_identity ?? null;
  const workflowDefinitions = compiledProfile?.blocked
    ? compiledProfile.base_bundle.workflow_definitions
    : compiledProfile?.workflow_definitions ?? {};

  let compiledPage = null;
  let audit = { status: "unavailable", diagnostics: [] };
  const auditUnavailableReason = (dictionaryError
    || (!Array.isArray(dictionaryEntries) || !dictionaryEntries.length ? "Prompt 审计词库不可用" : null))
    || (compiledProfile?.blocked ? "项目生成配置调整存在冲突，无法审计有效 Prompt" : null)
    || (!activeProfile ? "无法取得有效生成配置" : null);
  if (activeProfile) {
    try {
      compiledPage = compilePagePromptSnapshot(snapshot, activeProfile, auditUnavailableReason ? null : dictionaryEntries, activeSourceIdentity?.prompt_fragments);
      blockers.push(...pagePromptDiagnostics(compiledPage));
      if (!auditUnavailableReason) {
        audit = { status: "complete", ...compiledPage.audit, diagnostics: pagePromptDiagnostics(compiledPage) };
        blockers.push(...compiledPage.audit.errors);
      }
    } catch (error) {
      blockers.push(inspectionBlocker("page_prompt_compilation_failed", error?.message ?? String(error)));
    }
  }

  if (audit.status === "unavailable") {
    const diagnostic = inspectionBlocker("prompt_audit_unavailable", `Prompt 审计未完成：${auditUnavailableReason || "Prompt 编译失败"}`);
    audit.diagnostics.push(diagnostic);
    blockers.push(diagnostic);
  }

  let referenceImages = null;
  try { referenceImages = await resolvePageReferenceImages(projectDirectory, snapshot); }
  catch (error) { blockers.push(inspectionBlocker("reference_image_unavailable", error.message)); }
  let candidateRoute = null;
  let candidateRecipe = null;
  let candidateWorkflow = null;
  if (activeProfile) {
    try {
      const routed = freezeRenderRoutes([{
        id: `target.${encodePageKey(snapshot.page_key).replaceAll("/", ".")}`,
        page_key: snapshot.page_key,
        reference_images: referenceImages?.map(r => r.identity),
      }], { purpose: "candidate", resolvedProfile: activeProfile })[0];
      candidateRoute = routed.render_route;
      const profileRoute = activeProfile.operations?.candidates?.routes?.[candidateRoute.input_source];
      const workflowDefinition = workflowDefinitions[candidateRoute.workflow_id];
      if (!profileRoute?.recipe || !workflowDefinition) {
        blockers.push(inspectionBlocker("render_profile_route_unavailable", `候选 route 不可用：${candidateRoute.workflow_id}`));
      } else {
        candidateRecipe = structuredClone(profileRoute.recipe);
        candidateWorkflow = {
          id: workflowDefinition.id,
          template_sha256: workflowDefinition.template_sha256,
          manifest_sha256: workflowDefinition.manifest_sha256,
        };
      }
    } catch (error) {
      blockers.push(inspectionBlocker(error?.code ?? "render_profile_route_unavailable", error?.message ?? String(error)));
    }
  }

  return {
    project,
    project_source: projectSource,
    snapshot,
    compiled_profile: compiledProfile,
    active_profile: activeProfile,
    reference_images: referenceImages?.map(r => r.identity) ?? null,
    compiled_page: compiledPage,
    audit,
    candidate_route: candidateRoute,
    candidate_recipe: candidateRecipe,
    candidate_workflow: candidateWorkflow,
    blockers,
  };
}

export async function resolvePageForRender({ repositoryRoot, projectDirectory, pageId, dictionaryEntries = null }) {
  const identity = await resolvePageIdentity(projectDirectory, pageId);
  return compilePageRenderTarget({ repositoryRoot, projectDirectory, pageKey: identity.page_key, dictionaryEntries });
}

export async function resolvePageReferenceImages(projectDirectory, snapshot) {
  const groups = [
    ...snapshot.characters.map(c => ({ source: 'character:' + c.id + ':' + c.configuration_id, entries: c.reference_images ?? [] })),
    ...snapshot.scenes.map(c => ({ source: 'scene:' + c.id + ':' + c.configuration_id, entries: c.reference_images ?? [] })),
  ];
  const entries = resolveReferenceEntries(groups, snapshot.page_prompt.reference_overrides, snapshot.page_prompt.reference_images);
  return Promise.all(entries.map(async entry => ({ ...await readReferenceImage(projectDirectory, entry.file), entry })));
}
