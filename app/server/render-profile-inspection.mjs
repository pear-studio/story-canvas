import { hashCanonicalJson } from "./workflow-definition.mjs";

function clone(value) {
  return structuredClone(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(code, message, source, severity = "error") {
  return { severity, code, message, source };
}

function assertResolvedBundle(bundle) {
  if (!isRecord(bundle)
    || !isRecord(bundle.resolved_profile)
    || !isRecord(bundle.workflow_definitions)
    || !isRecord(bundle.source_identity)
    || typeof bundle.resolved_profile_sha256 !== "string") {
    throw new Error("render profile inspection 只接受 compiler bundle");
  }
}

function inspectionContext(bundle) {
  if (isRecord(bundle?.base_bundle)) {
    assertResolvedBundle(bundle.base_bundle);
    if (!isRecord(bundle.override_resolution) || typeof bundle.blocked !== "boolean") {
      throw new Error("render profile inspection 缺少 override resolution");
    }
    if (bundle.blocked) {
      if (bundle.effective_profile !== null || bundle.effective_profile_sha256 !== null) {
        throw new Error("冲突的 render profile inspection 不能包含 effective profile");
      }
      return {
        base: bundle.base_bundle,
        active: bundle.base_bundle,
        resolution: bundle.override_resolution,
        overrideIdentity: bundle.override_source_identity ?? null,
        effectiveSha256: null,
        blocked: true,
      };
    }
    const active = {
      resolved_profile: bundle.effective_profile,
      resolved_profile_sha256: bundle.effective_profile_sha256,
      workflow_definitions: bundle.workflow_definitions,
      source_identity: bundle.source_identity,
    };
    assertResolvedBundle(active);
    return {
      base: bundle.base_bundle,
      active,
      resolution: bundle.override_resolution,
      overrideIdentity: bundle.override_source_identity ?? null,
      effectiveSha256: bundle.effective_profile_sha256,
      blocked: false,
    };
  }
  assertResolvedBundle(bundle);
  return {
    base: bundle,
    active: bundle,
    resolution: { configured: false, blocked: false, changes: [], conflicts: [], redundant: [] },
    overrideIdentity: null,
    effectiveSha256: bundle.resolved_profile_sha256,
    blocked: false,
  };
}

function modelProjection(id, model, diagnosis = null, source = `models.${id}`) {
  const status = diagnosis?.status ?? "invalid";
  const diagnostics = diagnosis?.reason === "remote_unverified"
    ? [diagnostic("remote_model_unverified", `${model.filename} 将由远程 ComfyUI 在提交时验证`, source, "warning")]
    : status === "available" && diagnosis?.integrity_status === "mismatch"
      ? [diagnostic("model_sha256_mismatch", `${model.filename} 的 SHA-256 与登记身份不一致；普通生成仍可继续`, source, "warning")]
      : status === "available" ? [] : [diagnostic("model_unavailable", `${model.filename} 不可用`, source)];
  return {
    id,
    name: model.filename,
    kind: diagnosis?.kind ?? id,
    filename: model.filename,
    relative_path: model.relative_path,
    sha256: model.sha256,
    ...(model.size_bytes ? { size_bytes: model.size_bytes } : {}),
    ...(model.source ? { source: model.source } : {}),
    available: status === "available",
    status,
    reason: diagnosis?.reason ?? "diagnosis_missing",
    actual_sha256: diagnosis?.actual_sha256 ?? null,
    diagnostics,
  };
}

function loraProjection(id, lora, diagnosis = null) {
  const status = diagnosis?.status ?? "invalid";
  return {
    id,
    name: lora.filename,
    kind: "style_lora",
    filename: lora.filename,
    sha256: lora.sha256,
    weight: lora.weight,
    ...(lora.trigger ? { trigger: lora.trigger } : {}),
    available: status === "available",
    status,
    reason: diagnosis?.reason ?? "diagnosis_missing",
    actual_sha256: diagnosis?.actual_sha256 ?? null,
    diagnostics: diagnosis?.reason === "remote_unverified"
      ? [diagnostic("remote_lora_unverified", `${lora.filename} 将由远程 ComfyUI 在提交时验证`, `style_loras.${id}`, "warning")]
      : status === "available" ? [] : [diagnostic("lora_unavailable", `${lora.filename} 不可用`, `style_loras.${id}`)],
  };
}

function workflowSummary(bundle, id) {
  const definition = bundle.workflow_definitions[id];
  const identity = bundle.source_identity.workflows?.[id];
  return {
    id,
    template_file: identity?.template?.file ?? null,
    manifest_file: identity?.manifest?.file ?? null,
    template_sha256: definition?.template_sha256 ?? identity?.template?.sha256 ?? null,
    manifest_sha256: definition?.manifest_sha256 ?? identity?.manifest?.sha256 ?? null,
    modifiers: clone(definition?.manifest?.modifiers ?? []),
  };
}

function recipeSummary(recipe) {
  return [
    `${recipe.steps ?? "—"} 步`,
    `CFG ${recipe.cfg ?? "—"}`,
    recipe.sampler ?? "采样器未知",
    recipe.scheduler ?? "调度器未知",
    recipe.scale === undefined ? "单遍" : `${recipe.scale}× 二遍`,
  ].join(" · ");
}

function promptProjection(profile, sourceIdentity) {
  const fragments = Object.entries(profile.prompt.fragments).map(([id, fragment]) => ({
    id,
    ...clone(fragment),
    source: clone(sourceIdentity.prompt_fragments?.[id] ?? null),
  }));
  return {
    family: profile.prompt.family,
    policy_id: profile.prompt.policy,
    policy_source_file: sourceIdentity.prompt_policy?.file ?? null,
    policy_sha256: sourceIdentity.prompt_policy?.sha256 ?? null,
    positive_fragments: fragments.filter((fragment) => fragment.polarity === "positive").length,
    negative_fragments: fragments.filter((fragment) => fragment.polarity === "negative").length,
    summary: `${profile.prompt.family} · ${profile.prompt.category_order.length} 个页面分类`,
    category_order: clone(profile.prompt.category_order),
    separator: profile.prompt.separator,
    fragments,
    diagnostics: [],
  };
}

function overrideTargetLabel(target) {
  if (target === "prompt.policy") return "Prompt 策略";
  const model = /^models\.(.+)$/.exec(target);
  if (model) return `模型 · ${model[1]}`;
  const fragment = /^prompt\.fragments\.(.+)$/.exec(target);
  if (fragment) return `Prompt 片段 · ${fragment[1]}`;
  const route = /^operations\.([^.]+)\.routes\.([^.]+)\.(.+)$/.exec(target);
  if (route) return `${route[1]} / ${route[2]} · ${route[3]}`;
  const wholeStyleLora = /^style_loras\.([^.]+)$/.exec(target);
  if (wholeStyleLora) return `风格 LoRA · ${wholeStyleLora[1]}`;
  const styleLora = /^style_loras\.([^.]+)\.weight$/.exec(target);
  if (styleLora) return `风格 LoRA · ${styleLora[1]} 权重`;
  return target;
}

function changeProjection(change) {
  return {
    target: change.target,
    label: overrideTargetLabel(change.target),
    original: clone(change.original),
    current: clone(change.current),
    project: clone(change.project),
  };
}

function overrideProjection(context) {
  const { resolution, overrideIdentity, effectiveSha256 } = context;
  const changes = (resolution.changes ?? []).map(changeProjection);
  const conflicts = (resolution.conflicts ?? []).map(changeProjection);
  const redundant = (resolution.redundant ?? []).map(changeProjection);
  const status = conflicts.length
    ? "conflict"
    : changes.length || redundant.length
      ? "applied"
      : "none";
  return {
    status,
    blocked: conflicts.length > 0,
    source_file: overrideIdentity?.file ?? null,
    source_sha256: overrideIdentity?.sha256 ?? null,
    effective_sha256: effectiveSha256,
    changes,
    conflicts,
    redundant,
  };
}

function inspectRoutes(bundle, diagnosis) {
  const routes = [];
  const profile = bundle.resolved_profile;
  for (const [operation, operationValue] of Object.entries(profile.operations)) {
    for (const [inputSource, route] of Object.entries(operationValue.routes)) {
      const source = `routes.${operation}.${inputSource}`;
      const definition = bundle.workflow_definitions[route.workflow];
      const workflowIdentity = bundle.source_identity.workflows?.[route.workflow];
      const recipeIdentity = bundle.source_identity.recipes?.[route.recipe_source_id];
      const diagnostics = [];
      if (!definition) diagnostics.push(diagnostic("workflow_definition_missing", `工作流定义不存在：${route.workflow}`, source));
      if (!workflowIdentity) diagnostics.push(diagnostic("workflow_identity_missing", `工作流缺少来源身份：${route.workflow}`, source));
      if (definition && workflowIdentity
        && (definition.template_sha256 !== workflowIdentity.template?.sha256
          || definition.manifest_sha256 !== workflowIdentity.manifest?.sha256)) {
        diagnostics.push(diagnostic("workflow_identity_mismatch", `工作流双哈希与来源身份不一致：${route.workflow}`, source));
      }
      if (!recipeIdentity) diagnostics.push(diagnostic("recipe_identity_missing", `配方缺少来源身份：${route.recipe_source_id}`, source));
      if (diagnosis.available !== true) diagnostics.push(diagnostic("profile_unavailable", "基础模型或风格 LoRA 诊断未通过", source));
      routes.push({
        operation,
        input_source: inputSource,
        recipe: {
          source_id: route.recipe_source_id,
          source_file: recipeIdentity?.file ?? null,
          source_sha256: recipeIdentity?.sha256 ?? null,
          instance_sha256: hashCanonicalJson(route.recipe),
          summary: recipeSummary(route.recipe),
          parameters: clone(route.recipe),
        },
        workflow: workflowSummary(bundle, route.workflow),
        available: diagnostics.length === 0,
        diagnostics,
      });
    }
  }
  return routes;
}

export function inspectRenderProfile({ bundle, diagnosis, baseDiagnosis = diagnosis }) {
  const context = inspectionContext(bundle);
  if (!isRecord(diagnosis) || !isRecord(baseDiagnosis)) throw new Error("render profile inspection 缺少诊断结果");
  const profile = context.active.resolved_profile;
  const routes = inspectRoutes(context.active, diagnosis);
  const baseDiagnostics = (baseDiagnosis.errors ?? []).map((message, index) => diagnostic("profile_invalid", message, `profile.errors.${index}`));
  if (baseDiagnosis.available !== true && !baseDiagnostics.length) {
    baseDiagnostics.push(diagnostic("profile_dependencies_unavailable", "基础模型或风格 LoRA 不可用", "profile.dependencies"));
  }
  return {
    version: 1,
    current_contract: {
      profile_format: "asset_resolved",
      base_profile_compiled: true,
      project_override_supported: true,
      request_effective_render_plan_compiled: false,
    },
    base_profile: {
      id: context.base.resolved_profile.id,
      name: context.base.resolved_profile.name,
      description: context.base.resolved_profile.description ?? "",
      architecture_family: context.base.resolved_profile.architecture_family,
      prompt_family: context.base.resolved_profile.prompt.family,
      sha256: context.base.resolved_profile_sha256,
      source_file: context.base.source_identity.profile?.file ?? null,
      source_sha256: context.base.source_identity.profile?.sha256 ?? null,
      available: baseDiagnosis.available === true,
      diagnostics: baseDiagnostics,
    },
    project_override: overrideProjection(context),
    prompt: promptProjection(profile, context.active.source_identity),
    models: Object.fromEntries(Object.entries(profile.models).map(([id, model]) => [id, modelProjection(id, model, diagnosis.models?.[id])])),
    style_loras: Object.fromEntries(Object.entries(profile.style_loras).map(([id, lora]) => [id, loraProjection(id, lora, diagnosis.style_loras?.[id])])),
    routes,
  };
}
