import {
  assertFrozenWorkflowDefinition,
  assertWorkflowSupports,
  freezeWorkflowDefinition,
  hashCanonicalJson,
} from "./workflow-definition.mjs";

const operations = new Set(["candidates"]);
const inputSources = new Set(["empty_latent"]);
const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const routeFields = ["operation", "input_source", "workflow_id", "recipe_source_id", "recipe_instance_id"];
const routeFieldSet = new Set(routeFields);
const recipeSnapshotFields = new Set(["source_id", "canonical_sha256", "parameters"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function itemLabel(item) {
  return item?.id ?? "渲染条目";
}

function operationForPurpose(purpose) {
  const operation = purpose === "candidate" ? "candidates" : purpose;
  if (!operations.has(operation)) throw new Error(`渲染 purpose 无法映射到 operation：${String(purpose)}`);
  return operation;
}

function resolvedProfileRoute(resolvedProfile, operation, inputSource, label) {
  if (!isRecord(resolvedProfile)) throw new Error("缺少已解析 render profile");
  const route = resolvedProfile.operations?.[operation]?.routes?.[inputSource];
  if (!isRecord(route)) throw new Error(`${label} 的 render profile 缺少 route：${operation}/${inputSource}`);
  if (typeof route.workflow !== "string" || !idPattern.test(route.workflow)) {
    throw new Error(`${label} 的 ${operation}/${inputSource} workflow 无效`);
  }
  if (typeof route.recipe_source_id !== "string" || !idPattern.test(route.recipe_source_id) || !isRecord(route.recipe)) {
    throw new Error(`${label} 的 ${operation}/${inputSource} recipe 无效`);
  }
  return route;
}

function recipeInstanceId(sourceId, parameters) {
  return `${sourceId}@${hashCanonicalJson(parameters)}`;
}

function expectedRoute(item, { purpose, resolvedProfile }) {
  if (!isRecord(item)) throw new Error("渲染条目无效");
  const operation = operationForPurpose(purpose);
  const inputSource = "empty_latent";
  const profileRoute = resolvedProfileRoute(resolvedProfile, operation, inputSource, itemLabel(item));
  return {
    operation,
    input_source: inputSource,
    workflow_id: profileRoute.workflow,
    recipe_source_id: profileRoute.recipe_source_id,
    recipe_instance_id: recipeInstanceId(profileRoute.recipe_source_id, profileRoute.recipe),
  };
}

function assertRouteShape(route, label) {
  if (!isRecord(route)) throw new Error(`${label} 缺少冻结 render_route，请重新创建任务`);
  const unknown = Object.keys(route).filter((field) => !routeFieldSet.has(field));
  if (unknown.length) throw new Error(`${label} 的 render_route 包含未知字段：${unknown.join("、")}`);
  const missing = routeFields.filter((field) => !Object.hasOwn(route, field));
  if (missing.length) throw new Error(`${label} 的 render_route 缺少 ${missing.join("、")}，请重新创建任务`);
  if (!operations.has(route.operation)) throw new Error(`${label} 的 render_route.operation 无效`);
  if (!inputSources.has(route.input_source)) throw new Error(`${label} 的 render_route.input_source 无效`);
  if (typeof route.workflow_id !== "string" || !idPattern.test(route.workflow_id)) throw new Error(`${label} 的 render_route.workflow_id 无效`);
  if (typeof route.recipe_source_id !== "string" || !idPattern.test(route.recipe_source_id)) throw new Error(`${label} 的 render_route.recipe_source_id 无效`);
  if (typeof route.recipe_instance_id !== "string"
    || route.recipe_instance_id !== `${route.recipe_source_id}@${route.recipe_instance_id.slice(-64)}`
    || !sha256Pattern.test(route.recipe_instance_id.slice(-64))) {
    throw new Error(`${label} 的 render_route.recipe_instance_id 无效`);
  }
  return route;
}

function assertRouteMatches(actual, expected, label) {
  assertRouteShape(actual, label);
  for (const field of routeFields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} 的 render_route 与条目输入或 render profile 不一致：${field} 应为 ${expected[field]}，实际为 ${actual[field]}`);
    }
  }
  return actual;
}

function requiredModifiers(items) {
  const required = new Set();
  for (const item of items) {
    if ((item.loras?.length ?? 0) > 0) required.add("lora.model_only");
  }
  return [...required];
}

function normalizedWorkflowDefinitions(value) {
  const entries = Array.isArray(value) ? value.map((definition) => [definition?.id, definition]) : Object.entries(value ?? {});
  const definitions = new Map();
  for (const [key, definition] of entries) {
    if (typeof key !== "string" || !idPattern.test(key) || definition?.id !== key) {
      throw new Error(`workflow definitions 的键与定义 ID 不匹配：${String(key)}`);
    }
    const frozen = freezeWorkflowDefinition(definition);
    if ((definition.template_sha256 !== undefined && definition.template_sha256 !== frozen.template_sha256)
      || (definition.manifest_sha256 !== undefined && definition.manifest_sha256 !== frozen.manifest_sha256)) {
      throw new Error(`工作流 ${key} 的来源身份校验失败`);
    }
    const existing = definitions.get(key);
    if (existing && (existing.template_sha256 !== frozen.template_sha256 || existing.manifest_sha256 !== frozen.manifest_sha256)) {
      throw new Error(`工作流 ${key} 在同一任务中出现不同身份`);
    }
    definitions.set(key, existing ?? frozen);
  }
  return definitions;
}

function freezeReferencedWorkflows(workflowDefinitions, referencedIds) {
  const definitions = normalizedWorkflowDefinitions(workflowDefinitions);
  const workflows = {};
  for (const id of referencedIds) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`render_route 引用的工作流未进入 registry：${id}`);
    workflows[id] = structuredClone(definition);
  }
  return workflows;
}

function recipeSnapshot(sourceId, parameters) {
  const cloned = structuredClone(parameters);
  return { source_id: sourceId, canonical_sha256: hashCanonicalJson(cloned), parameters: cloned };
}

function freezeReferencedRecipes(items, resolvedProfile) {
  const recipes = {};
  for (const item of items) {
    const route = assertRouteShape(item.render_route, itemLabel(item));
    const profileRoute = resolvedProfileRoute(resolvedProfile, route.operation, route.input_source, itemLabel(item));
    const frozen = recipeSnapshot(profileRoute.recipe_source_id, profileRoute.recipe);
    const instanceId = recipeInstanceId(frozen.source_id, frozen.parameters);
    if (route.recipe_source_id !== frozen.source_id || route.recipe_instance_id !== instanceId) {
      throw new Error(`${itemLabel(item)} 的 render_route 与 render profile recipe instance 不一致`);
    }
    const existing = recipes[instanceId];
    if (existing && (existing.source_id !== frozen.source_id || existing.canonical_sha256 !== frozen.canonical_sha256)) {
      throw new Error(`recipe instance ${instanceId} 在同一任务中出现不同身份`);
    }
    recipes[instanceId] ??= frozen;
  }
  return recipes;
}

function assertSnapshotRegistries(snapshot) {
  if (!isRecord(snapshot)) throw new Error("任务快照无效，请重新创建任务");
  if (Object.hasOwn(snapshot, "base_workflow_id") || Object.hasOwn(snapshot, "recipe")) {
    throw new Error("任务快照仍使用旧工作流或全局 recipe 字段，请重新创建任务");
  }
  if (!isRecord(snapshot.workflows)) throw new Error("任务缺少 workflows registry，请重新创建任务");
  if (!isRecord(snapshot.recipes)) throw new Error("任务缺少 recipes registry，请重新创建任务");
}

function resolveWorkflow(route, snapshot, label) {
  const frozen = snapshot.workflows[route.workflow_id];
  if (!frozen) throw new Error(`render_route 工作流 ${route.workflow_id} 不在任务 registry 中`);
  if (frozen.id !== route.workflow_id) throw new Error(`workflow registry 键与定义 ID 不匹配：${route.workflow_id}`);
  return assertFrozenWorkflowDefinition(frozen);
}

function resolveRecipe(route, snapshot, profileRoute) {
  const frozen = snapshot.recipes[route.recipe_instance_id];
  if (!isRecord(frozen)) throw new Error(`render_route recipe instance ${route.recipe_instance_id} 不在任务 registry 中`);
  const unknown = Object.keys(frozen).filter((field) => !recipeSnapshotFields.has(field));
  if (unknown.length || frozen.source_id !== route.recipe_source_id || !isRecord(frozen.parameters)
    || typeof frozen.canonical_sha256 !== "string" || !sha256Pattern.test(frozen.canonical_sha256)) {
    throw new Error(`recipe registry ${route.recipe_instance_id} 的身份无效`);
  }
  const actualHash = hashCanonicalJson(frozen.parameters);
  if (frozen.canonical_sha256 !== actualHash
    || route.recipe_instance_id !== recipeInstanceId(frozen.source_id, frozen.parameters)) {
    throw new Error(`recipe instance ${route.recipe_instance_id} 的快照校验失败`);
  }
  if (frozen.source_id !== profileRoute.recipe_source_id || actualHash !== hashCanonicalJson(profileRoute.recipe)) {
    throw new Error(`recipe instance ${route.recipe_instance_id} 与冻结 render profile 不一致`);
  }
  return structuredClone(frozen.parameters);
}

export function assertRenderRoute(route, { itemId = "渲染条目" } = {}) {
  return assertRouteShape(route, itemId);
}

export function freezeRenderRoutes(items, { purpose, resolvedProfile }) {
  if (!Array.isArray(items)) throw new Error("渲染条目必须是数组");
  return items.map((item) => ({
    ...item,
    render_route: expectedRoute(item, { purpose, resolvedProfile }),
  }));
}

export function freezeRenderPlanRegistries(items, { purpose, resolvedProfile, workflowDefinitions }) {
  if (!Array.isArray(items) || !items.length) throw new Error("任务必须冻结至少一个渲染条目");
  const referencedWorkflowIds = new Set();
  for (const item of items) {
    const expected = expectedRoute(item, { purpose, resolvedProfile });
    const route = assertRouteMatches(item.render_route, expected, itemLabel(item));
    referencedWorkflowIds.add(route.workflow_id);
  }
  return {
    workflows: freezeReferencedWorkflows(workflowDefinitions, referencedWorkflowIds),
    recipes: freezeReferencedRecipes(items, resolvedProfile),
  };
}

export function resolveRenderUnitPlan(items, { purpose, snapshot, resolvedProfile }) {
  if (!Array.isArray(items) || !items.length) throw new Error("渲染单元不能为空");
  assertSnapshotRegistries(snapshot);
  const routes = items.map((item) => assertRouteMatches(
    item.render_route,
    expectedRoute(item, { purpose, resolvedProfile }),
    itemLabel(item),
  ));
  const route = routes[0];
  for (let index = 1; index < routes.length; index += 1) {
    if (routeFields.some((field) => routes[index][field] !== route[field])) {
      throw new Error("同一渲染单元的 render_route 不一致");
    }
  }
  const profileRoute = resolvedProfileRoute(resolvedProfile, route.operation, route.input_source, itemLabel(items[0]));
  const definition = resolveWorkflow(route, snapshot, itemLabel(items[0]));
  const recipe = resolveRecipe(route, snapshot, profileRoute);
  assertWorkflowSupports(definition, {
    architectureFamily: resolvedProfile.architecture_family,
    operation: route.operation,
    inputSource: route.input_source,
    requiredModifiers: requiredModifiers(items),
  });
  return { route, definition, recipe };
}
