import { readFile } from "node:fs/promises";
import path from "node:path";
import { generationModels, profileModelAdapter } from './model-adapters.mjs';

import {
  assertFrozenWorkflowDefinition,
  assertWorkflowSupports,
  freezeWorkflowDefinition,
  hashCanonicalJson,
  readWorkflowDefinition,
} from "./workflow-definition.mjs";
import {
  RENDER_PROFILE_OVERRIDE_FILENAME,
  readRenderProfileOverrideDocument,
  resolveRenderProfileOverride,
  validateRenderProfileOverrideDocument,
} from "./render-profile-override.mjs";

const profileIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const stableIdPattern = /^[a-z0-9][a-z0-9_-]*$/;
const fragmentIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const architectures = new Set(generationModels.map(model => model.architecture));
const canvases = new Set(["3:4", "1:1", "4:3", "2:3", "9:16"]);
const operationInputs = Object.freeze({
  candidates: new Set(["empty_latent", "reference_image"]),
});
const requiredOperations = new Set(["candidates"]);
const profileFields = new Set(["$schema", "id", "name", "description", "tags", "architecture_family", "models", "prompt", "operations", "style_loras"]);
const recipeFields = new Set([
  "$schema", "id", "name", "resolutions", "steps", "cfg", "sampler", "scheduler", "clip_skip",
  "scale", "denoise", "second_pass_steps", "second_pass_cfg", "second_pass_sampler", "second_pass_scheduler",
]);
const modelFields = new Set(["filename", "relative_path", "size_bytes", "sha256", "source"]);
const loraFields = new Set(["filename", "sha256", "weight", "trigger"]);
const routeFields = new Set(["workflow", "recipe"]);
const operationFields = new Set(["routes"]);
const relativeAssetPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

export class RenderProfileCompilerError extends Error {
  constructor(message, options = undefined) {
    super(`render profile 编译失败：${message}`, options);
    this.status = 422;
    this.code = "render_profile_compilation_failed";
  }
}

function fail(message) {
  throw new RenderProfileCompilerError(message);
}

function compilerError(error) {
  if (error instanceof RenderProfileCompilerError) return error;
  return new RenderProfileCompilerError(error?.message ?? String(error), { cause: error });
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} 必须是对象`);
  return value;
}

function assertExactFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) fail(`${label} 含有未知字段：${unknown.join("、")}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value) fail(`${label} 必须是非空字符串`);
}

function assertFiniteNumber(value, label, { min = -Infinity, max = Infinity, integer = false, exclusiveMin = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))
    || (exclusiveMin ? value <= min : value < min) || value > max) fail(`${label} 数值无效`);
}

async function readJsonSource(repositoryRoot, directory, id, label) {
  if (typeof id !== "string" || !profileIdPattern.test(id)) fail(`${label} ID 无效：${String(id)}`);
  const relativeFile = `library/${directory}/${id}.json`;
  let value;
  try {
    value = JSON.parse(await readFile(path.join(repositoryRoot, ...relativeFile.split("/")), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} 引用不存在：${id}`);
    if (error instanceof SyntaxError) fail(`${relativeFile} 不是有效 JSON`);
    throw error;
  }
  return { value, provenance: { id, file: relativeFile, sha256: hashCanonicalJson(value) } };
}

function assertModel(value, label) {
  assertRecord(value, label);
  assertExactFields(value, modelFields, label);
  for (const field of ["filename", "relative_path", "sha256"]) assertNonEmptyString(value[field], `${label}.${field}`);
  if (!relativeAssetPattern.test(value.relative_path)) fail(`${label}.relative_path 不是安全相对路径`);
  if (!sha256Pattern.test(value.sha256)) fail(`${label}.sha256 无效`);
  if (value.size_bytes !== undefined) assertFiniteNumber(value.size_bytes, `${label}.size_bytes`, { min: 1, integer: true });
  if (value.source !== undefined) assertNonEmptyString(value.source, `${label}.source`);
}

function assertRecipe(value, expectedId) {
  assertRecord(value, `recipe ${expectedId}`);
  assertExactFields(value, recipeFields, `recipe ${expectedId}`);
  if (value.$schema !== undefined && typeof value.$schema !== "string") fail(`${expectedId}.$schema 必须是字符串`);
  if (value.id !== expectedId) fail(`recipe 文件 ID 不匹配：期望 ${expectedId}，实际 ${String(value.id)}`);
  assertNonEmptyString(value.name, `${expectedId}.name`);
  assertRecord(value.resolutions, `${expectedId}.resolutions`);
  if (!Object.keys(value.resolutions).length) fail(`${expectedId}.resolutions 不能为空`);
  for (const [canvas, resolution] of Object.entries(value.resolutions)) {
    if (!canvases.has(canvas)) fail(`${expectedId}.resolutions 的画布无效：${canvas}`);
    assertRecord(resolution, `${expectedId}.resolutions.${canvas}`);
    assertExactFields(resolution, new Set(["width", "height"]), `${expectedId}.resolutions.${canvas}`);
    for (const dimension of ["width", "height"]) {
      assertFiniteNumber(resolution[dimension], `${expectedId}.resolutions.${canvas}.${dimension}`, { min: 64, integer: true });
      if (resolution[dimension] % 8 !== 0) fail(`${expectedId}.resolutions.${canvas}.${dimension} 必须是 8 的倍数`);
    }
  }
  assertFiniteNumber(value.steps, `${expectedId}.steps`, { min: 1, max: 100, integer: true });
  assertFiniteNumber(value.cfg, `${expectedId}.cfg`, { min: 0, max: 30, exclusiveMin: true });
  assertNonEmptyString(value.sampler, `${expectedId}.sampler`);
  assertNonEmptyString(value.scheduler, `${expectedId}.scheduler`);
  assertFiniteNumber(value.clip_skip, `${expectedId}.clip_skip`, { min: 1, max: 12, integer: true });
  if (value.scale !== undefined) assertFiniteNumber(value.scale, `${expectedId}.scale`, { min: 1, max: 4 });
  if (value.denoise !== undefined) assertFiniteNumber(value.denoise, `${expectedId}.denoise`, { min: 0, max: 1 });
  if (value.second_pass_steps !== undefined) assertFiniteNumber(value.second_pass_steps, `${expectedId}.second_pass_steps`, { min: 1, max: 100, integer: true });
  if (value.second_pass_cfg !== undefined) assertFiniteNumber(value.second_pass_cfg, `${expectedId}.second_pass_cfg`, { min: 0, max: 30, exclusiveMin: true });
  if (value.second_pass_sampler !== undefined) assertNonEmptyString(value.second_pass_sampler, `${expectedId}.second_pass_sampler`);
  if (value.second_pass_scheduler !== undefined) assertNonEmptyString(value.second_pass_scheduler, `${expectedId}.second_pass_scheduler`);
}

function assertProfile(value, expectedId) {
  assertRecord(value, `profile ${expectedId}`);
  assertExactFields(value, profileFields, `profile ${expectedId}`);
  if (value.$schema !== undefined && typeof value.$schema !== "string") fail(`${expectedId}.$schema 必须是字符串`);
  if (value.id !== expectedId) fail(`profile 文件 ID 不匹配：期望 ${expectedId}，实际 ${String(value.id)}`);
  assertNonEmptyString(value.name, `${expectedId}.name`);
  if (value.description !== undefined) assertNonEmptyString(value.description, `${expectedId}.description`);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || !tag) || new Set(value.tags).size !== value.tags.length)) fail(`${expectedId}.tags 无效`);
  if (!architectures.has(value.architecture_family)) fail(`${expectedId}.architecture_family 无效`);

  assertRecord(value.models, `${expectedId}.models`);
  const expectedRoles = ["dit", "text_encoder", "vae"];
  const modelRoles = Object.keys(value.models);
  if (modelRoles.length !== expectedRoles.length || expectedRoles.some((role) => !Object.hasOwn(value.models, role))) {
    fail(`${expectedId}.models 必须且只能包含：${expectedRoles.join("、")}`);
  }
  for (const [role, model] of Object.entries(value.models)) {
    if (!stableIdPattern.test(role)) fail(`${expectedId}.models 的角色 ID 无效：${role}`);
    assertModel(model, `${expectedId}.models.${role}`);
  }

  profileModelAdapter(value).validateProfilePrompt(value.prompt);

  assertRecord(value.operations, `${expectedId}.operations`);
  for (const operation of requiredOperations) if (!Object.hasOwn(value.operations, operation)) fail(`${expectedId}.operations 缺少 ${operation}`);
  for (const [operation, operationValue] of Object.entries(value.operations)) {
    if (!Object.hasOwn(operationInputs, operation)) fail(`${expectedId}.operations 包含未知 operation：${operation}`);
    assertRecord(operationValue, `${expectedId}.operations.${operation}`);
    assertExactFields(operationValue, operationFields, `${expectedId}.operations.${operation}`);
    assertRecord(operationValue.routes, `${expectedId}.operations.${operation}.routes`);
    if (!Object.keys(operationValue.routes).length) fail(`${expectedId}.operations.${operation}.routes 不能为空`);
    if (operation === "candidates" && !Object.hasOwn(operationValue.routes, "empty_latent")) fail(`${expectedId}.${operation} 缺少 empty_latent route`);
    for (const [inputSource, route] of Object.entries(operationValue.routes)) {
      if (!operationInputs[operation].has(inputSource)) fail(`${expectedId} 的 operation/input 组合无效：${operation}/${inputSource}`);
      assertRecord(route, `${expectedId}.${operation}.${inputSource}`);
      assertExactFields(route, routeFields, `${expectedId}.${operation}.${inputSource}`);
      for (const field of routeFields) if (typeof route[field] !== "string" || !profileIdPattern.test(route[field])) fail(`${expectedId}.${operation}.${inputSource}.${field} 无效`);
    }
  }

  assertRecord(value.style_loras, `${expectedId}.style_loras`);
  for (const [id, lora] of Object.entries(value.style_loras)) {
    if (!fragmentIdPattern.test(id)) fail(`${expectedId}.style_loras 的 ID 无效：${id}`);
    assertRecord(lora, `${expectedId}.style_loras.${id}`);
    assertExactFields(lora, loraFields, `${expectedId}.style_loras.${id}`);
    assertNonEmptyString(lora.filename, `${expectedId}.style_loras.${id}.filename`);
    if (!sha256Pattern.test(lora.sha256 ?? "")) fail(`${expectedId}.style_loras.${id}.sha256 无效`);
    assertFiniteNumber(lora.weight, `${expectedId}.style_loras.${id}.weight`, { min: -2, max: 2 });
    if (lora.trigger !== undefined) assertNonEmptyString(lora.trigger, `${expectedId}.style_loras.${id}.trigger`);
  }

}

function materializeRecipe(recipe, definition, { architectureFamily, operation, inputSource }) {
  const value = clone(Object.fromEntries(Object.entries(recipe).filter(([field]) => !new Set(["$schema", "id", "name"]).has(field))));
  const bindings = definition.manifest.bindings;
  for (const [binding, field] of [["steps", "steps"], ["cfg", "cfg"], ["sampler", "sampler"], ["scheduler", "scheduler"]]) {
    if (Object.hasOwn(bindings, binding) && value[field] === undefined) fail(`${recipe.id} 缺少 ${definition.id} 所需参数：${field}`);
  }
  if (["width", "height", "final_width", "final_height"].some((binding) => Object.hasOwn(bindings, binding)) && !Object.keys(value.resolutions ?? {}).length) {
    fail(`${recipe.id} 缺少 ${definition.id} 所需 resolutions`);
  }
  const hasSecondPass = ["final_width", "final_height", "second_pass_seed", "second_pass_steps", "second_pass_cfg", "second_pass_sampler", "second_pass_scheduler"]
    .some((binding) => Object.hasOwn(bindings, binding));
  if (hasSecondPass) {
    for (const field of ["scale", "denoise", "second_pass_steps", "second_pass_cfg", "second_pass_sampler", "second_pass_scheduler"]) {
      if (value[field] === undefined) fail(`${recipe.id} 的二遍参数不完整：缺少 ${field}`);
    }
  }
  const topologyConsumers = new Map([
    ["scale", Object.hasOwn(bindings, "final_width") && Object.hasOwn(bindings, "final_height")],
    ["denoise", Object.hasOwn(bindings, "denoise")],
    ["second_pass_steps", Object.hasOwn(bindings, "second_pass_steps")],
    ["second_pass_cfg", Object.hasOwn(bindings, "second_pass_cfg")],
    ["second_pass_sampler", Object.hasOwn(bindings, "second_pass_sampler")],
    ["second_pass_scheduler", Object.hasOwn(bindings, "second_pass_scheduler")],
  ]);
  for (const [field, consumed] of topologyConsumers) {
    if (value[field] !== undefined && !consumed) fail(`${recipe.id} 提供了 ${definition.id} 不消费的参数：${field}`);
  }
  if (architectureFamily === "qwen-image-2-1" && value.clip_skip !== 1) fail(`${recipe.id} 的 clip_skip 必须为 1`);
  assertWorkflowSupports(definition, { architectureFamily, operation, inputSource });
  return value;
}

function assertEffectiveContent(profile) {
  const expectedRoles = ["dit", "text_encoder", "vae"];
  if (!isRecord(profile.models) || Object.keys(profile.models).length !== expectedRoles.length
    || expectedRoles.some((role) => !Object.hasOwn(profile.models, role))) {
    fail(`${profile.id}.models 与结构家族不一致`);
  }
  for (const [role, model] of Object.entries(profile.models)) assertModel(model, `${profile.id}.models.${role}`);
  profileModelAdapter(profile).validateProfilePrompt(profile.prompt, { effective: true });
  for (const [id, lora] of Object.entries(profile.style_loras ?? {})) {
    assertRecord(lora, `${profile.id}.style_loras.${id}`);
    assertNonEmptyString(lora.filename, `${profile.id}.style_loras.${id}.filename`);
    if (!sha256Pattern.test(lora.sha256 ?? "")) fail(`${profile.id}.style_loras.${id}.sha256 无效`);
    assertFiniteNumber(lora.weight, `${profile.id}.style_loras.${id}.weight`, { min: -2, max: 2 });
  }
}

async function resolveEffectiveWorkflows(repositoryRoot, baseBundle, effectiveProfile) {
  const definitions = new Map();
  for (const [operation, operationValue] of Object.entries(effectiveProfile.operations)) {
    for (const [inputSource, route] of Object.entries(operationValue.routes)) {
      let definition = definitions.get(route.workflow);
      if (!definition) {
        const frozenBase = baseBundle.workflow_definitions[route.workflow];
        try {
          definition = frozenBase
            ? assertFrozenWorkflowDefinition(frozenBase)
            : await readWorkflowDefinition(repositoryRoot, route.workflow);
        } catch (error) {
          fail(`effective workflow ${route.workflow} 无法读取或校验：${error.message}`);
        }
        definitions.set(route.workflow, definition);
      }
      route.recipe = materializeRecipe({ id: route.recipe_source_id, ...route.recipe }, definition, {
        architectureFamily: effectiveProfile.architecture_family,
        operation,
        inputSource,
      });
    }
  }
  return Object.fromEntries([...definitions.entries()].map(([id, definition]) => [id, freezeWorkflowDefinition(definition)]));
}

/**
 * 读取基础配置与项目 sparse override，产出经关联资产重新校验后的 effective profile bundle。
 * 恢复任务只使用冻结快照，不应调用此入口。
 */
async function compileEffectiveRenderProfileImplementation({ repositoryRoot, projectRoot, profileId, overrideDocument: explicitOverrideDocument }) {
  if (typeof projectRoot !== "string" || !projectRoot) fail("projectRoot 无效");
  const [baseBundle, overrideDocument] = await Promise.all([
    readResolvedRenderProfile(repositoryRoot, profileId),
    explicitOverrideDocument === undefined
      ? readRenderProfileOverrideDocument(projectRoot)
      : Promise.resolve(validateRenderProfileOverrideDocument(explicitOverrideDocument)),
  ]);
  const overrideSourceIdentity = {
    file: RENDER_PROFILE_OVERRIDE_FILENAME,
    sha256: hashCanonicalJson(overrideDocument),
  };
  const overrideResolution = resolveRenderProfileOverride({
    resolvedProfile: baseBundle.resolved_profile,
    overrideDocument,
  });
  if (overrideResolution.blocked) {
    return {
      blocked: true,
      base_bundle: baseBundle,
      override_resolution: overrideResolution,
      override_source_identity: overrideSourceIdentity,
      effective_profile: null,
      effective_profile_sha256: null,
      workflow_definitions: null,
      source_identity: null,
    };
  }

  const effectiveProfile = clone(overrideResolution.effective_profile);
  const sourceIdentity = await profileModelAdapter(effectiveProfile).resolveEffectivePrompt(repositoryRoot, baseBundle, overrideResolution, effectiveProfile);
  assertEffectiveContent(effectiveProfile);
  const workflows = await resolveEffectiveWorkflows(repositoryRoot, baseBundle, effectiveProfile);
  sourceIdentity.workflows = Object.fromEntries(Object.entries(workflows).map(([id, definition]) => [id, {
    id,
    template: { file: `library/workflows/${id}.api.json`, sha256: definition.template_sha256 },
    manifest: { file: `library/workflows/${id}.manifest.json`, sha256: definition.manifest_sha256 },
  }]));
  sourceIdentity.project_override = overrideSourceIdentity;
  return {
    blocked: false,
    base_bundle: baseBundle,
    override_resolution: overrideResolution,
    override_source_identity: overrideSourceIdentity,
    effective_profile: effectiveProfile,
    effective_profile_sha256: hashCanonicalJson(effectiveProfile),
    workflow_definitions: workflows,
    source_identity: sourceIdentity,
  };
}

async function readResolvedRenderProfileImplementation(repositoryRoot, profileId) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot) fail("repositoryRoot 无效");
  const profileSource = await readJsonSource(repositoryRoot, "render-profiles", profileId, "render profile");
  assertProfile(profileSource.value, profileId);
  const profile = profileSource.value;
  const promptBundle = await profileModelAdapter(profile).resolveProfilePrompt(repositoryRoot, profile);

  const profileOperations = profile.operations;
  const sharedAssetIdentity = {};

  const recipeSources = new Map();
  const workflowDefinitions = new Map();
  const operations = {};
  for (const [operation, operationValue] of Object.entries(profileOperations)) {
    const routes = {};
    for (const [inputSource, route] of Object.entries(operationValue.routes)) {
      let recipeSource = recipeSources.get(route.recipe);
      if (!recipeSource) {
        recipeSource = await readJsonSource(repositoryRoot, "render-recipes", route.recipe, "render recipe");
        assertRecipe(recipeSource.value, route.recipe);
        recipeSources.set(route.recipe, recipeSource);
      }
      let definition = workflowDefinitions.get(route.workflow);
      if (!definition) {
        try {
          definition = await readWorkflowDefinition(repositoryRoot, route.workflow);
        } catch (error) {
          fail(`workflow ${route.workflow} 无法读取或校验：${error.message}`);
        }
        workflowDefinitions.set(route.workflow, definition);
      }
      const recipe = materializeRecipe(recipeSource.value, definition, {
        architectureFamily: profile.architecture_family,
        operation,
        inputSource,
      });
      routes[inputSource] = { workflow: route.workflow, recipe_source_id: route.recipe, recipe };
    }
    operations[operation] = { routes };
  }

  const workflows = Object.fromEntries([...workflowDefinitions.entries()].map(([id, definition]) => [id, freezeWorkflowDefinition(definition)]));
  const recipeProvenance = Object.fromEntries([...recipeSources.entries()].map(([id, source]) => [id, source.provenance]));
  const workflowProvenance = Object.fromEntries([...workflowDefinitions.entries()].map(([id, definition]) => [id, {
    id,
    template: { file: `library/workflows/${id}.api.json`, sha256: definition.template_sha256 },
    manifest: { file: `library/workflows/${id}.manifest.json`, sha256: definition.manifest_sha256 },
  }]));
  const resolvedProfile = {
    id: profile.id,
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.tags ? { tags: clone(profile.tags) } : {}),
    architecture_family: profile.architecture_family,
    models: clone(profile.models),
    prompt: promptBundle.prompt,
    operations,
    style_loras: clone(profile.style_loras),
  };
  const sourceIdentity = {
    ...promptBundle.identity,
    profile: profileSource.provenance,
    shared_assets: sharedAssetIdentity,
    recipes: recipeProvenance,
    workflows: workflowProvenance,
  };
  return {
    resolved_profile: resolvedProfile,
    workflow_definitions: workflows,
    source_identity: sourceIdentity,
    resolved_profile_sha256: hashCanonicalJson(resolvedProfile),
  };
}

export async function readResolvedRenderProfile(repositoryRoot, profileId) {
  try {
    return await readResolvedRenderProfileImplementation(repositoryRoot, profileId);
  } catch (error) {
    throw compilerError(error);
  }
}

export async function compileEffectiveRenderProfile(options) {
  try {
    return await compileEffectiveRenderProfileImplementation(options);
  } catch (error) {
    throw compilerError(error);
  }
}

function overrideDocumentWithCurrentOriginals(overrideDocument, profileId, resolution) {
  const resolvedByTarget = new Map([
    ...resolution.changes,
    ...resolution.conflicts,
    ...resolution.redundant,
  ].map((change) => [change.target, change]));
  const document = clone(overrideDocument);
  document.profiles[profileId] = {
    changes: document.profiles[profileId].changes.map((change) => {
      const resolved = resolvedByTarget.get(change.target);
      if (!resolved) fail(`${profileId} 的 override target 未进入解析结果：${change.target}`);
      return { ...change, original: clone(resolved.current) };
    }),
  };
  return document;
}

/**
 * 对准备持久化的完整 override 文档逐 profile 编译。冲突本身可以保存，但项目值仍必须能组成
 * 合法的 effective profile；本入口只消费显式候选文档，不读取磁盘中的旧 override。
 */
export async function validateProjectRenderProfileOverride({ repositoryRoot, projectRoot, overrideDocument }) {
  try {
    const document = validateRenderProfileOverrideDocument(overrideDocument);
    for (const profileId of Object.keys(document.profiles)) {
      const compilation = await compileEffectiveRenderProfileImplementation({
        repositoryRoot,
        projectRoot,
        profileId,
        overrideDocument: document,
      });
      if (!compilation.blocked) continue;
      const candidateDocument = overrideDocumentWithCurrentOriginals(document, profileId, compilation.override_resolution);
      const candidate = await compileEffectiveRenderProfileImplementation({
        repositoryRoot,
        projectRoot,
        profileId,
        overrideDocument: candidateDocument,
      });
      if (candidate.blocked) fail(`${profileId} 的项目值无法形成可验证的 effective profile`);
    }
    return document;
  } catch (error) {
    throw compilerError(error);
  }
}
