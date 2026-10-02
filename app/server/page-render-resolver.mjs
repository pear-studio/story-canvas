import {settingLoras} from '../shared/lora-inheritance.mjs';
import { readReferenceImage } from "./reference-image.mjs";
import { readPageIndex } from './pages-store.mjs';
import { readPageRenderSettings, pageProjectSettings } from './page-render-settings.mjs';
import { modelPrompt } from './model-prompts.mjs';
import { profileModelAdapter } from './model-adapters.mjs';
import { resolveSceneConfiguration } from './scene-files.mjs';
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
import { characterSource, sceneSource, PAGE_REFERENCE_IMAGE_LIMIT } from "./prompt-contract.mjs";
import { validateProjectManifest } from "./project-manifest.mjs";
import { compileEffectiveRenderProfile } from "./render-profile-compiler.mjs";
import { freezeRenderRoutes } from "./render-plan-route.mjs";
import { freezePageLorasForTask } from "./render-task-helpers.mjs";
import {
  STORY_PAGE_PROMPT_SCHEMA_ID,
  checkPagePromptInputOverrideReferences,
  promptInputOverrideCharacterIds,
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

function normalizeInspectionPromptDraft(value, modelId) {
  const source = isRecord(value) ? value : {};
  if (modelId === 'anima') {
    const prompt={$schema:STORY_PAGE_PROMPT_SCHEMA_ID,...structuredClone(source)};
    return {prompt,errors:validateStoryPagePromptDocument({$schema:STORY_PAGE_PROMPT_SCHEMA_ID,models:{anima:source}})};
  }
  const prompt = {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    text: typeof source.text === "string" ? source.text : "",
    ...(source.composition?{composition:source.composition}:{}),
    ...(source.loras?{loras:structuredClone(source.loras)}:{}),
    ...(source.lora_overrides?{lora_overrides:structuredClone(source.lora_overrides)}:{}),
    ...(source.scene_id ? { scene_id: source.scene_id, scene_variant_id: source.scene_variant_id } : {}),
    ...(isRecord(source.text_overrides) ? { text_overrides: structuredClone(source.text_overrides) } : {}),
    ...(isRecord(source.reference_overrides) ? { reference_overrides: structuredClone(source.reference_overrides) } : {}),
    ...(Array.isArray(source.reference_images) ? { reference_images: source.reference_images.filter(isRecord).map((entry) => structuredClone(entry)) } : {}),
  };
  return { prompt, errors: validateStoryPagePromptDocument({$schema:STORY_PAGE_PROMPT_SCHEMA_ID,models:{qwen:source}}) };
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

async function readCharacter(projectDirectory, characterIndex, reference, modelId) {
  const characterId = reference.character_id;
  if (!characterIndex.characters.includes(characterId)) fail("character_dangling", [`角色不存在：${characterId}`]);
  const [profileSource, visualSource, promptSource] = await Promise.all([
    readJsonFact(projectDirectory, `characters/${characterId}.profile.json`),
    readJsonFact(projectDirectory, `characters/${characterId}.visual.json`),
    readJsonFact(projectDirectory, `characters/${characterId}.prompt.json`),
  ]);
  const profile = assertDocument(profileSource, validateCharacterProfileDocument);
  const visual = assertDocument(visualSource, validateCharacterVisualDocument);
  const promptDocument = modelPrompt(assertDocument(promptSource, validateCharacterPromptDocument), modelId);
  if (!variantIds(visual).has(reference.variant_id)) {
    fail("character_variant_dangling", [`${characterId} 不存在 variant：${reference.variant_id}`]);
  }
  const configuration = promptDocument?.variants[reference.variant_id];
  if (!configuration) fail("character_configuration_dangling", [`${characterId}: variant ${reference.variant_id} 缺少 Prompt 设定`]);
  const character = {
    id: characterId,
    name: profile.name,
    prompt_name: promptDocument.prompt_name,
    configuration_id: reference.variant_id,
    configuration_path: `variants.${reference.variant_id}`,
    text: configuration.text ?? "",
    reference_images: structuredClone(configuration.reference_images ?? []),
    ...(modelId === 'anima' ? { ...structuredClone(configuration), identity: structuredClone(promptDocument.identity), local_loras: structuredClone(configuration.loras ?? []), loras: settingLoras(promptDocument.identity, configuration) } : {}),
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

// 只在一次快照/预览内复用；后续请求仍重新读取当前事实。
function createSceneReader(projectDirectory) {
  let index;
  const scenes = new Map();
  return async (id) => {
    index ??= readJsonFact(projectDirectory, 'scenes/index.json', { optional: true });
    if (!(await index)?.value.scenes.includes(id)) return null;
    if (!scenes.has(id)) scenes.set(id, (async () => {
      const sources = await Promise.all(['profile', 'visual', 'prompt'].map(kind =>
        readJsonFact(projectDirectory, `scenes/${id}.${kind}.json`, { optional: true })));
      if (sources.some(source => !source)) fail('scene_fact_missing', [id]);
      const [profile, visual, prompt] = sources.map(source => source.value);
      return { scene: { id, name: profile.name, visual, prompt }, sources };
    })());
    return scenes.get(id);
  };
}

async function loadPageSnapshot(projectDirectory, pageId, exactPageKey, renderOverride, readScene) {
  const render = renderOverride ?? await readPageRenderSettings(projectDirectory, pageId);
  const modelId = render.model_id;
  const identity = await readPageIdentity(projectDirectory, pageId);
  const [contentSource, promptSource, characterIndexSource] = await Promise.all([
    readJsonFact(projectDirectory, `pages/${pageId}.content.json`),
    readJsonFact(projectDirectory, `pages/${pageId}.prompt.json`),
    readJsonFact(projectDirectory, "characters/index.json"),
  ]);
  const content = assertDocument(contentSource, validateStoryPageNarrativeDocument);
  const promptDocument = assertDocument(promptSource, validateStoryPagePromptDocument);
  const pagePrompt = modelPrompt(promptDocument, modelId);
  if (!pagePrompt) fail('page_model_input_missing', [modelId]);
  const standalone = modelId === 'qwen' && pagePrompt.composition === 'standalone';
  const characterIndex = assertDocument(characterIndexSource, validateCharacterIndexDocument);
  const references = content.characters;
  const sources = [...identity.sources, contentSource, promptSource, characterIndexSource];
  const referenceErrors = [];
  const activeIds = new Set(references.map(reference => reference.character_id));
  const invalidOwners = promptInputOverrideCharacterIds(pagePrompt).filter(id => !activeIds.has(id));
  if (invalidOwners.length) referenceErrors.push(...invalidOwners.map(id => `页面 Prompt 覆盖了未出场角色：${id}`));
  const resolvedCharacters = [];
  for (const reference of standalone ? [] : references) {
    try { resolvedCharacters.push(await readCharacter(projectDirectory, characterIndex, reference, modelId)); }
    catch (error) {
      if (!["character_dangling", "character_variant_dangling", "character_configuration_dangling"].includes(error.code)) throw error;
      referenceErrors.push(...error.details);
    }
  }
  sources.push(...resolvedCharacters.flatMap(entry => entry.sources));
  const scenes = [];
  if (!standalone && pagePrompt.scene_id) {
    const entry = await readScene(pagePrompt.scene_id);
    if (!entry) referenceErrors.push(`场景不存在：${pagePrompt.scene_id}`);
    else {
      try { scenes.push(resolveSceneConfiguration(entry.scene, pagePrompt.scene_variant_id, modelId)); }
      catch (error) { referenceErrors.push(error.message); }
      sources.push(...entry.sources);
    }
  }
  referenceErrors.push(...checkPagePromptInputOverrideReferences(pagePrompt, references));
  return {
    kind: identity.kind, owner_kind: identity.kind, page_id: pageId, page_key: createPageKey(pageId),
    owner_id: identity.membership.character_id ?? identity.membership.scene_id,
    ...(identity.kind === "story" ? { sequence_id: identity.membership.sequence_id } : {}),
    title: content.title, scene_description: content.scene_description, page_kind: content.page_kind ?? null,
    character_references: references, page_prompt: pagePrompt, scenes,
    model_id: modelId, prompt_document: promptDocument,
    reference_errors: referenceErrors,
    characters: resolvedCharacters.map(entry => entry.character),
    character_facts: Object.fromEntries(resolvedCharacters.map(entry => [entry.character.id, entry.facts])),
    sources,
    source_fingerprint: hashCanonicalJson(Object.fromEntries(sources.map(source => [source.relative_path, source.sha256]))),
  };
}

// 写入入口在已有事实锁内捕获，后续编译只消费这份内存快照。
export async function capturePagePromptSnapshot(projectDirectory, pageId, pageKey = null, renderOverride = null) {
  return capturePageSnapshot(projectDirectory, pageId, pageKey, renderOverride, createSceneReader(projectDirectory));
}

async function capturePageSnapshot(projectDirectory, pageId, pageKey, renderOverride, readScene) {
  const [projectSource, snapshot] = await Promise.all([
    readJsonFact(projectDirectory, "project.json"),
    loadPageSnapshot(projectDirectory, pageId, pageKey, renderOverride, readScene),
  ]);
  snapshot.sources.push(projectSource);
  const render = renderOverride ?? await readPageRenderSettings(projectDirectory, pageId, projectSource.value);
  const renderSource = { relative_path: `pages/${pageId}.render.json`, sha256: hashCanonicalJson(render), value: render };
  snapshot.sources.push(renderSource);
  snapshot.source_fingerprint = hashCanonicalJson(Object.fromEntries(snapshot.sources.map((source) => [source.relative_path, source.sha256])));
  return { ...snapshot, render, project_defaults: projectSource.value, project: pageProjectSettings(projectSource.value, render), project_source: projectSource };
}

function assertStoryProjectFormat(project) {
  const errors = validateProjectManifest(project);
  if (errors.length) fail("project_manifest_invalid", errors);
}

/**
 * 参考图解析的唯一入口：编译器与任务冻结共用同一份每来源有序条目与扁平最终序列，
 * 不分别排序。返回 errors 而不抛出，调用方决定阻断或投影为 blocker。
 */
export function planPageReferenceImages(snapshot) {
  if (snapshot.model_id === 'anima') return { groups: [], page: { entries: [] }, sequence: [], errors: [] };
  const errors = [];
  const overrides = isRecord(snapshot.page_prompt?.reference_overrides) ? snapshot.page_prompt.reference_overrides : {};
  const groups = [
    ...snapshot.characters.map((character) => ({
      source: characterSource(character.id, character.configuration_id),
      kind: "character",
      id: character.id,
      variant_id: character.configuration_id,
      available: character.reference_images ?? [],
    })),
    ...snapshot.scenes.map((scene) => ({
      source: sceneSource(scene.id, scene.configuration_id),
      kind: "scene",
      id: scene.id,
      variant_id: scene.configuration_id,
      available: scene.reference_images ?? [],
    })),
  ].map((group) => {
    const ids = overrides[group.source] ?? group.available.slice(0, 1).map((entry) => entry.id);
    const entries = [];
    for (const id of ids) {
      const entry = group.available.find((item) => item.id === id);
      if (!entry) {
        errors.push(`参考图已移除：${group.source}，请重新选择或恢复默认`);
        continue;
      }
      entries.push({ ...structuredClone(entry), source: group.source });
    }
    return { source: group.source, kind: group.kind, id: group.id, variant_id: group.variant_id, entries };
  });
  const pageEntries = (Array.isArray(snapshot.page_prompt?.reference_images) ? snapshot.page_prompt.reference_images : [])
    .map((entry) => ({ ...structuredClone(entry), source: "page" }));
  const sequence = [...groups.flatMap((group) => group.entries), ...pageEntries];
  if (sequence.length > PAGE_REFERENCE_IMAGE_LIMIT) {
    errors.push(`本页引用了 ${sequence.length} 张图片，最多支持 ${PAGE_REFERENCE_IMAGE_LIMIT} 张，请取消部分图片`);
  }
  return { groups, page: { source: "page", kind: "page", entries: pageEntries }, sequence, errors };
}

export async function resolvePageReferenceImages(projectDirectory, snapshot) {
  const plan = planPageReferenceImages(snapshot);
  if (plan.errors.length) throw new Error(plan.errors.join("；"));
  return Promise.all(plan.sequence.map(async entry => ({ ...await readReferenceImage(projectDirectory, entry.file), entry })));
}

export function compilePagePromptSnapshot(snapshot, profile) {
  if (snapshot.model_id && snapshot.model_id !== profileModelAdapter(profile).id) fail('page_profile_model_mismatch');
  const referencePlan = planPageReferenceImages(snapshot);
  const compiled = compileCurrentPagePrompt({
    pageId: snapshot.page_id,
    pageKey: snapshot.page_key,
    pagePrompt: snapshot.page_prompt,
    profile,
    characters: snapshot.characters,
    scenes: snapshot.scenes ?? [],
    participantIds: snapshot.character_references.map((reference) => reference.character_id),
    referencePlan,
  });
  compiled.errors.push(...(snapshot.reference_errors ?? []));
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
}) {
  const requestedPageKey = decodeFullPageKey(pageKey);
  const pageId = requestedPageKey.page_id;
  const snapshot = await capturePagePromptSnapshot(projectDirectory, pageId, requestedPageKey);
  const { project, project_source: projectSource } = snapshot;
  assertStoryProjectFormat(project);
  if (!new Set(["3:4", "1:1", "4:3", "2:3", "9:16"]).has(project.canvas)) {
    fail("project_render_settings_invalid", ["project.json 缺少有效 canvas"]);
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
  const compiledPage = compilePagePromptSnapshot(snapshot, compiledProfile.effective_profile);
  if (!compiledPage.ready) {
    fail("page_not_renderable", [...compiledPage.missing, ...compiledPage.errors, ...compiledPage.audit.errors.map((issue) => issue.message)]);
  }
  const participants = snapshot.character_references.map((reference) => reference.character_id);
  const pageLoras = freezePageLorasForTask(compiledPage, {
    active_scene_settings: [],
    active_character_settings: [],
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
  renderOverride = null,
}) {
  const requestedPageKey = decodeFullPageKey(pageKey);
  const pageId = requestedPageKey.page_id;
  const readScene = createSceneReader(projectDirectory);
  const snapshot = await capturePageSnapshot(projectDirectory, pageId, requestedPageKey, renderOverride, readScene);
  const { project, project_source: projectSource } = snapshot;
  if (encodePageKey(snapshot.page_key) !== encodePageKey(requestedPageKey)) {
    fail("page_owner_mismatch", [`请求 ${encodePageKey(requestedPageKey)}，实际 ${encodePageKey(snapshot.page_key)}`], 404);
  }
  const blockers = [];
  blockers.push(...validateProjectManifest(project).map((message) => inspectionBlocker("project_manifest_invalid", message)));

  if (snapshot.page_kind === "text") {
    blockers.push(inspectionBlocker("text_page_not_renderable", "文字页不生成候选图；编辑标题与正文后直接输出成品"));
  }

  if (pagePromptDraft !== undefined) {
    const normalized = normalizeInspectionPromptDraft(pagePromptDraft,snapshot.model_id);
    snapshot.page_prompt = normalized.prompt;
    snapshot.scenes = [];
    if (normalized.prompt.scene_id) {
      const entry = await readScene(normalized.prompt.scene_id);
      if (entry) {
        try { snapshot.scenes = [resolveSceneConfiguration(entry.scene, normalized.prompt.scene_variant_id,snapshot.model_id)]; }
        catch (error) { blockers.push(inspectionBlocker("scene_variant_dangling", error.message)); }
      } else blockers.push(inspectionBlocker("scene_dangling", `场景不存在：${normalized.prompt.scene_id}`));
    }
    snapshot.reference_errors = checkPagePromptInputOverrideReferences(normalized.prompt, snapshot.character_references);
    blockers.push(...normalized.errors.map((message) => inspectionBlocker("page_prompt_draft_invalid", message)));
  }

  if (typeof project.default_render_profile !== "string" || !project.default_render_profile) {
    blockers.push(inspectionBlocker("project_render_profile_missing", "project.json 缺少 default_render_profile"));
  }
  if (!new Set(["3:4", "1:1", "4:3", "2:3", "9:16"]).has(project.canvas)) {
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
  const workflowDefinitions = compiledProfile?.blocked
    ? compiledProfile.base_bundle.workflow_definitions
    : compiledProfile?.workflow_definitions ?? {};

  let compiledPage = null;
  let audit = { status: "unavailable", diagnostics: [] };
  // 配置冲突时 activeProfile 仅是基础配置预览，不能冒充有效结果审计通过。
  if (activeProfile && !compiledProfile?.blocked) {
    try {
      compiledPage = compilePagePromptSnapshot(snapshot, activeProfile);
      blockers.push(...pagePromptDiagnostics(compiledPage));
      audit = { status: "complete", ...compiledPage.audit, diagnostics: pagePromptDiagnostics(compiledPage) };
    } catch (error) {
      blockers.push(inspectionBlocker("page_prompt_compilation_failed", error?.message ?? String(error)));
    }
  } else if (activeProfile) {
    try {
      compiledPage = compilePagePromptSnapshot(snapshot, activeProfile);
      blockers.push(...pagePromptDiagnostics(compiledPage));
    } catch (error) {
      blockers.push(inspectionBlocker("page_prompt_compilation_failed", error?.message ?? String(error)));
    }
  }

  if (audit.status === "unavailable") {
    const reason = compiledProfile?.blocked
      ? "项目生成配置调整存在冲突，无法审计有效 Prompt"
      : !activeProfile ? "无法取得有效生成配置" : "Prompt 编译失败";
    const diagnostic = inspectionBlocker("prompt_audit_unavailable", `Prompt 审计未完成：${reason}`);
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

export async function resolvePageForRender({ repositoryRoot, projectDirectory, pageId }) {
  const identity = await resolvePageIdentity(projectDirectory, pageId);
  return compilePageRenderTarget({ repositoryRoot, projectDirectory, pageKey: identity.page_key });
}
