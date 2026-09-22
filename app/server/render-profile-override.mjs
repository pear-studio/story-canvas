import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const stableIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const modelRolePattern = /^[a-z0-9][a-z0-9_-]*$/;
const operationInputs = Object.freeze({
  candidates: new Set(["empty_latent", "reference_image"]),
});
const recipeParameters = new Set([
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "clip_skip",
  "scale",
  "denoise",
  "second_pass_steps",
  "second_pass_cfg",
  "second_pass_sampler",
  "second_pass_scheduler",
]);
const canvases = new Set(["2:3", "3:4", "9:16", "4:3"]);
const topLevelFields = new Set(["$schema", "version", "profiles"]);
const groupFields = new Set(["changes"]);
const changeFields = new Set(["target", "original", "project"]);
const stateFields = new Set(["exists", "value"]);

export const RENDER_PROFILE_OVERRIDE_FILENAME = "render-profile.override.json";
export const RENDER_PROFILE_OVERRIDE_SCHEMA_ID = "https://storyvisualizer.local/schemas/render-profile-override.schema.json";

export class RenderProfileOverrideError extends Error {
  constructor(message) {
    super(`render_profile override 无效：${message}`);
    this.status = 422;
    this.code = "invalid_render_profile_override";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function fail(message) {
  throw new RenderProfileOverrideError(message);
}

function assertExactFields(value, allowed, path) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) fail(`${path} 含有未知字段：${unknown.join("、")}`);
}

function normalizeState(value, path) {
  if (!isRecord(value)) fail(`${path} 必须是值状态对象`);
  assertExactFields(value, stateFields, path);
  if (typeof value.exists !== "boolean") fail(`${path}.exists 必须是 boolean`);
  if (value.exists !== Object.hasOwn(value, "value")) {
    fail(`${path} 必须在 exists=true 时且仅在此时保存 value`);
  }
  if (value.exists) assertJsonValue(value.value, `${path}.value`);
  return value.exists ? { exists: true, value: clone(value.value) } : { exists: false };
}

function assertJsonValue(value, path, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} 必须是合法 JSON 值`);
    return;
  }
  if (typeof value !== "object") fail(`${path} 必须是合法 JSON 值`);
  if (seen.has(value)) fail(`${path} 不能包含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJsonValue(item, `${path}[${index}]`, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${path} 必须是合法 JSON 对象`);
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function parseTarget(target) {
  if (target === "prompt.text") return { kind: "prompt_text" };
  const model = /^models\.([a-z0-9][a-z0-9_-]*)$/.exec(target);
  if (model && modelRolePattern.test(model[1])) return { kind: "model", role: model[1] };
  const wholeStyleLora = /^style_loras\.([a-z0-9][a-z0-9-]*)$/.exec(target);
  if (wholeStyleLora && stableIdPattern.test(wholeStyleLora[1])) return { kind: "style_lora", id: wholeStyleLora[1] };
  const styleLora = /^style_loras\.([a-z0-9][a-z0-9-]*)\.weight$/.exec(target);
  if (styleLora && stableIdPattern.test(styleLora[1])) return { kind: "style_lora_weight", id: styleLora[1] };
  const route = /^operations\.(candidates)\.routes\.(empty_latent|reference_image)\.(.+)$/.exec(target);
  if (!route) return null;
  const base = { operation: route[1], inputSource: route[2], valid: operationInputs[route[1]]?.has(route[2]) === true };
  if (route[3] === "workflow") return { kind: "route_workflow", ...base };
  const recipeParameter = /^recipe\.([a-z_]+)$/.exec(route[3]);
  if (recipeParameter && recipeParameters.has(recipeParameter[1])) {
    return { kind: "route_recipe_parameter", ...base, parameter: recipeParameter[1] };
  }
  const resolution = /^recipe\.resolutions\.(2:3|3:4|9:16|4:3)$/.exec(route[3]);
  if (resolution && canvases.has(resolution[1])) return { kind: "route_recipe_resolution", ...base, canvas: resolution[1] };
  return null;
}

function isAllowedTarget(target) {
  const descriptor = parseTarget(target);
  return descriptor !== null && descriptor.valid !== false;
}

export function emptyRenderProfileOverrideDocument() {
  return { $schema: RENDER_PROFILE_OVERRIDE_SCHEMA_ID, version: 1, profiles: {} };
}

export function validateRenderProfileOverrideDocument(value) {
  if (!isRecord(value)) fail("根值必须是对象");
  assertExactFields(value, topLevelFields, "根值");
  if (Object.hasOwn(value, "$schema") && typeof value.$schema !== "string") fail("$schema 必须是字符串");
  if (value.version !== 1) fail("version 必须为 1");
  if (!isRecord(value.profiles)) fail("profiles 必须是对象");

  const profiles = {};
  for (const [profileId, group] of Object.entries(value.profiles)) {
    if (!stableIdPattern.test(profileId)) fail(`profile ID 无效：${profileId}`);
    if (!isRecord(group)) fail(`profiles.${profileId} 必须是对象`);
    assertExactFields(group, groupFields, `profiles.${profileId}`);
    if (!Array.isArray(group.changes)) fail(`profiles.${profileId}.changes 必须是数组`);
    const seenTargets = new Set();
    const changes = group.changes.map((change, index) => {
      const normalized = normalizeChange(change, index, seenTargets);
      if (!isAllowedTarget(normalized.target)) fail(`target 不在允许列表中：${normalized.target}`);
      return normalized;
    });
    profiles[profileId] = { changes };
  }
  return {
    ...(Object.hasOwn(value, "$schema") ? { $schema: value.$schema } : {}),
    version: 1,
    profiles,
  };
}

export async function readRenderProfileOverrideDocument(projectDirectory) {
  const target = path.join(projectDirectory, RENDER_PROFILE_OVERRIDE_FILENAME);
  let value;
  try {
    value = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRenderProfileOverrideDocument();
    if (error instanceof SyntaxError) fail(`${RENDER_PROFILE_OVERRIDE_FILENAME} 不是合法 JSON`);
    throw error;
  }
  return validateRenderProfileOverrideDocument(value);
}

export async function saveRenderProfileOverrideDocument(projectDirectory, value) {
  const document = validateRenderProfileOverrideDocument(value);
  const target = path.join(projectDirectory, RENDER_PROFILE_OVERRIDE_FILENAME);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  return document;
}

function nestedPropertyAccessor(profile, parents, key) {
  return {
    read() {
      let current = profile;
      for (const parent of parents) {
        if (!isRecord(current) || !Object.hasOwn(current, parent)) return { exists: false };
        current = current[parent];
      }
      if (!isRecord(current) || !Object.hasOwn(current, key)) return { exists: false };
      return { exists: true, value: clone(current[key]) };
    },
    write(state) {
      let current = profile;
      if (state.exists) {
        for (const parent of parents) {
          if (!isRecord(current[parent])) current[parent] = {};
          current = current[parent];
        }
        current[key] = clone(state.value);
        return;
      }
      for (const parent of parents) {
        if (!isRecord(current[parent])) return;
        current = current[parent];
      }
      delete current[key];
    },
  };
}

function validatedAccessor(accessor, validateValue, { required = false, canCreate = null, createKind = "身份或能力", canDelete = null } = {}) {
  return {
    ...accessor,
    validate(state, role, target) {
      if (!state.exists) {
        if (role === "project" && required) fail(`${target} 不能删除`);
        return;
      }
      validateValue(state.value, `${target}.${role}`);
    },
    validateApply(state, target) {
      if (state.exists && canCreate && !canCreate()) fail(`${target} 不能新增不存在的 ${createKind}`);
      if (!state.exists && canDelete && !canDelete()) fail(`${target} 不能删除`);
    },
  };
}

function assertString(value, path) {
  if (typeof value !== "string" || !value.trim()) fail(`${path} 必须是非空字符串`);
}

function assertStableId(value, path) {
  if (typeof value !== "string" || !stableIdPattern.test(value)) fail(`${path} 必须是稳定 ID`);
}

function assertNumber(value, path, { minimum, maximum, exclusiveMinimum = false, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) fail(`${path} 类型无效`);
  if (minimum !== undefined && (exclusiveMinimum ? value <= minimum : value < minimum)) fail(`${path} 小于允许范围`);
  if (maximum !== undefined && value > maximum) fail(`${path} 超出允许范围`);
}

function assertExactValueFields(value, allowed, required, path) {
  if (!isRecord(value)) fail(`${path} 必须是对象`);
  assertExactFields(value, allowed, path);
  for (const field of required) if (!Object.hasOwn(value, field)) fail(`${path} 缺少 ${field}`);
}

function assertModel(value, path) {
  const allowed = new Set(["filename", "relative_path", "sha256", "size_bytes", "source"]);
  assertExactValueFields(value, allowed, new Set(["filename", "relative_path", "sha256"]), path);
  assertString(value.filename, `${path}.filename`);
  assertString(value.relative_path, `${path}.relative_path`);
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) fail(`${path}.sha256 无效`);
  if (value.size_bytes !== undefined) assertNumber(value.size_bytes, `${path}.size_bytes`, { minimum: 1, integer: true });
  if (value.source !== undefined) assertString(value.source, `${path}.source`);
}

function assertPromptTextValue(value, path) {
  if (typeof value !== "string") fail(`${path} 必须是字符串`);
}

function assertStyleLora(value, path) {
  const allowed = new Set(["filename", "sha256", "weight", "trigger"]);
  assertExactValueFields(value, allowed, new Set(["filename", "sha256", "weight"]), path);
  assertString(value.filename, `${path}.filename`);
  if (value.filename.includes("\\") || value.filename.includes(":") || value.filename.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${path}.filename 必须是 loras 目录下的安全相对路径`);
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) fail(`${path}.sha256 无效`);
  assertNumber(value.weight, `${path}.weight`, { minimum: -2, maximum: 2 });
  if (value.trigger !== undefined) assertString(value.trigger, `${path}.trigger`);
}

function assertResolution(value, path) {
  assertExactValueFields(value, new Set(["width", "height"]), new Set(["width", "height"]), path);
  for (const field of ["width", "height"]) {
    assertNumber(value[field], `${path}.${field}`, { minimum: 64, integer: true });
    if (value[field] % 8 !== 0) fail(`${path}.${field} 必须是 8 的倍数`);
  }
}

function recipeParameterValidator(parameter) {
  if (parameter === "steps" || parameter === "second_pass_steps") return (value, path) => assertNumber(value, path, { minimum: 1, maximum: 100, integer: true });
  if (parameter === "cfg" || parameter === "second_pass_cfg") return (value, path) => assertNumber(value, path, { minimum: 0, maximum: 30, exclusiveMinimum: true });
  if (parameter === "clip_skip") return (value, path) => assertNumber(value, path, { minimum: 1, maximum: 12, integer: true });
  if (parameter === "scale") return (value, path) => assertNumber(value, path, { minimum: 1, maximum: 4 });
  if (parameter === "denoise") return (value, path) => assertNumber(value, path, { minimum: 0, maximum: 1 });
  return assertString;
}

function existingRecord(profile, parents) {
  let current = profile;
  for (const parent of parents) {
    if (!isRecord(current) || !isRecord(current[parent])) return null;
    current = current[parent];
  }
  return current;
}

function routeAccessor(profile, descriptor, target) {
  const { operation, inputSource } = descriptor;
  const allowedInputs = operationInputs[operation];
  if (!allowedInputs?.has(inputSource)) fail(`${target} 的 operation/input 组合无效：${operation}/${inputSource}`);
  const routeExists = () => existingRecord(profile, ["operations", operation, "routes", inputSource]) !== null;
  if (descriptor.kind === "route_workflow") {
    return validatedAccessor(nestedPropertyAccessor(profile, ["operations", operation, "routes", inputSource], "workflow"), assertStableId, {
      required: true,
      canCreate: routeExists,
      createKind: "route",
    });
  }
  if (descriptor.kind === "route_recipe_parameter") {
    const { parameter } = descriptor;
    const optional = new Set(["scale", "denoise", "second_pass_steps", "second_pass_cfg", "second_pass_sampler", "second_pass_scheduler"]);
    return validatedAccessor(
      nestedPropertyAccessor(profile, ["operations", operation, "routes", inputSource, "recipe"], parameter),
      recipeParameterValidator(parameter),
      { required: !optional.has(parameter), canCreate: routeExists, createKind: "route" },
    );
  }
  if (descriptor.kind === "route_recipe_resolution") {
    return validatedAccessor(
      nestedPropertyAccessor(profile, ["operations", operation, "routes", inputSource, "recipe", "resolutions"], descriptor.canvas),
      assertResolution,
      {
        canCreate: routeExists,
        createKind: "route",
        canDelete: () => Object.keys(existingRecord(profile, ["operations", operation, "routes", inputSource, "recipe", "resolutions"]) ?? {}).length > 1,
      },
    );
  }
  fail(`target 不在允许列表中：${target}`);
}

function targetAccessor(profile, target) {
  const descriptor = parseTarget(target);
  if (!descriptor) fail(`target 不在允许列表中：${String(target)}`);
  if (descriptor.kind === "prompt_text") return validatedAccessor(nestedPropertyAccessor(profile, ["prompt"], "text"), assertPromptTextValue, { required: true });

  if (descriptor.kind === "model") {
    const modelExists = () => existingRecord(profile, ["models", descriptor.role]) !== null;
    return validatedAccessor(nestedPropertyAccessor(profile, ["models"], descriptor.role), assertModel, {
      required: true,
      canCreate: modelExists,
      createKind: "model role",
    });
  }

  if (descriptor.kind === "style_lora") {
    return validatedAccessor(nestedPropertyAccessor(profile, ["style_loras"], descriptor.id), assertStyleLora);
  }

  if (descriptor.kind.startsWith("route_")) return routeAccessor(profile, descriptor, target);

  if (descriptor.kind === "style_lora_weight") {
    const styleLoraExists = () => existingRecord(profile, ["style_loras", descriptor.id]) !== null;
    return validatedAccessor(
      nestedPropertyAccessor(profile, ["style_loras", descriptor.id], "weight"),
      (value, path) => assertNumber(value, path, { minimum: -2, maximum: 2 }),
      { required: true, canCreate: styleLoraExists, createKind: "style LoRA" },
    );
  }

  fail(`target 不在允许列表中：${String(target)}`);
}

function activeChanges(resolvedProfile, overrideDocument) {
  if (overrideDocument == null) return { configured: false, changes: [] };
  if (!isRecord(overrideDocument)) fail("根值必须是对象");
  assertExactFields(overrideDocument, topLevelFields, "根值");
  if (Object.hasOwn(overrideDocument, "$schema") && typeof overrideDocument.$schema !== "string") fail("$schema 必须是字符串");
  if (overrideDocument.version !== 1) fail("version 必须为 1");
  if (!isRecord(overrideDocument.profiles)) fail("profiles 必须是对象");
  if (!Object.hasOwn(overrideDocument.profiles, resolvedProfile.id)) return { configured: false, changes: [] };

  const group = overrideDocument.profiles[resolvedProfile.id];
  if (!isRecord(group)) fail(`profiles.${resolvedProfile.id} 必须是对象`);
  assertExactFields(group, groupFields, `profiles.${resolvedProfile.id}`);
  if (!Array.isArray(group.changes)) fail(`profiles.${resolvedProfile.id}.changes 必须是数组`);
  return { configured: true, changes: group.changes };
}

function normalizeChange(rawChange, index, seenTargets) {
  const path = `changes[${index}]`;
  if (!isRecord(rawChange)) fail(`${path} 必须是对象`);
  assertExactFields(rawChange, changeFields, path);
  if (typeof rawChange.target !== "string" || !rawChange.target) fail(`${path}.target 必须是非空字符串`);
  if (seenTargets.has(rawChange.target)) fail(`target 重复：${rawChange.target}`);
  const styleLoraTarget = rawChange.target.replace(/\.weight$/, "");
  const overlappingStyleLoraTarget = rawChange.target.endsWith(".weight")
    ? styleLoraTarget
    : `${rawChange.target}.weight`;
  if (rawChange.target.startsWith("style_loras.") && seenTargets.has(overlappingStyleLoraTarget)) {
    fail(`target 重叠：${styleLoraTarget}`);
  }
  seenTargets.add(rawChange.target);
  return {
    target: rawChange.target,
    original: normalizeState(rawChange.original, `${path}.original`),
    project: normalizeState(rawChange.project, `${path}.project`),
  };
}

export function resolveRenderProfileOverride({ resolvedProfile, overrideDocument = null }) {
  if (!isRecord(resolvedProfile)) fail("已解析语义基础配置必须是对象");
  if (typeof resolvedProfile.id !== "string" || !stableIdPattern.test(resolvedProfile.id)) fail("已解析语义基础配置 ID 无效");

  const effective = clone(resolvedProfile);
  const active = activeChanges(resolvedProfile, overrideDocument);
  const changes = [];
  const conflicts = [];
  const redundant = [];
  const seenTargets = new Set();

  for (const [index, rawChange] of active.changes.entries()) {
    const change = normalizeChange(rawChange, index, seenTargets);
    const accessor = targetAccessor(effective, change.target);
    accessor.validate(change.original, "original", change.target);
    accessor.validate(change.project, "project", change.target);
    const current = accessor.read();
    const result = { ...change, current };

    if (isDeepStrictEqual(current, change.project)) {
      redundant.push(result);
    } else if (isDeepStrictEqual(current, change.original)) {
      accessor.validateApply(change.project, change.target);
      accessor.write(change.project);
      changes.push(result);
    } else {
      conflicts.push(result);
    }
  }

  return {
    profile_id: resolvedProfile.id,
    configured: active.configured,
    blocked: conflicts.length > 0,
    changes,
    conflicts,
    redundant,
    effective_profile: conflicts.length ? null : effective,
  };
}
