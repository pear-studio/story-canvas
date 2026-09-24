import { referenceImageFilename } from "./reference-image.mjs";
import { profileModelAdapter } from './model-adapters.mjs';
import { createHash } from "node:crypto";
import path from "node:path";

import { encodePageKey } from "./page-key.mjs";
import { freezeRenderPlanRegistries, resolveRenderUnitPlan } from "./render-plan-route.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { createRenderOutputAdapter, createRenderOutputDescriptor } from "./render-media.mjs";

const sourceIdentityFields = new Set(["profile", "shared_assets", "recipes", "workflows", "project_override"]);
const sourceProvenanceFields = new Set(["id", "file", "sha256"]);
const workflowIdentityFields = new Set(["id", "template", "manifest"]);
const workflowAssetIdentityFields = new Set(["file", "sha256"]);
const sha256Pattern = /^[0-9a-f]{64}$/;
const sourceIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const frozenTaskFields = new Set([
  "version", "id", "render_profile", "purpose", "status", "created_at", "started_at", "completed_at", "failed_at", "error",
  "snapshot", "items", "project",
]);
const frozenSnapshotFields = new Set([
  "canvas", "profile", "effective_profile_sha256", "source_identity", "effective_source_identity_sha256",
  "workflows", "recipes", "seeds", "loras", "prompt_contract", "prompt_audit",
  "prompt_binding_fingerprints", "execution", "execution_units",
  "execution_units_sha256",
]);
const frozenItemFields = new Set([
  "id", "task", "page_key", "seed", "candidate_id", "file", "positive_prompt", "negative_prompt", "prompt_parts",
  "loras", "status", "reference_images",
  "render_route", "prompt_id", "generated_at", "discarded_at", "absolute_file",
]);
function clone(value) { return structuredClone(value); }
function hashJson(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function assertCurrentFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length) throw new Error(`${label} 包含未知字段：${unknown.join("、")}`);
}

function sourceIdentityError(message) {
  throw new Error(`effective source identity 无效：${message}`);
}

function requireSourceRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) sourceIdentityError(`${label} 必须是对象`);
  return value;
}

function requireExactSourceFields(value, fields, label) {
  requireSourceRecord(value, label);
  const missing = [...fields].filter((field) => !Object.hasOwn(value, field));
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (missing.length) sourceIdentityError(`${label} 缺少字段：${missing.join("、")}`);
  if (unknown.length) sourceIdentityError(`${label} 含有未知字段：${unknown.join("、")}`);
}

function requireSourceId(value, label) {
  if (typeof value !== "string" || !sourceIdPattern.test(value)) sourceIdentityError(`${label} 无效`);
}

function requireSourceSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) sourceIdentityError(`${label} 必须是 SHA-256`);
}

function assertSourceProvenance(value, { id, file, label }) {
  requireExactSourceFields(value, sourceProvenanceFields, label);
  requireSourceId(value.id, `${label}.id`);
  if (value.id !== id) sourceIdentityError(`${label}.id 与 effective profile 不一致`);
  if (value.file !== file) sourceIdentityError(`${label}.file 与来源 ID 不一致`);
  requireSourceSha256(value.sha256, `${label}.sha256`);
}

function expectedRouteIds(profile, field) {
  return new Set(Object.values(profile.operations ?? {}).flatMap((operation) => Object.values(operation.routes ?? {}).map((route) => route[field])));
}

function assertExactIdentityIds(value, expectedIds, label) {
  requireSourceRecord(value, label);
  const actualIds = Object.keys(value);
  const missing = [...expectedIds].filter((id) => !Object.hasOwn(value, id));
  const unknown = actualIds.filter((id) => !expectedIds.has(id));
  if (missing.length) sourceIdentityError(`${label} 缺少身份：${missing.join("、")}`);
  if (unknown.length) sourceIdentityError(`${label} 含有未引用身份：${unknown.join("、")}`);
}

export function assertEffectiveSourceIdentity({ profile, sourceIdentity, workflowRegistry }) {
  requireSourceRecord(profile, "profile");
  requireSourceId(profile.id, "profile.id");
  const adapter=profileModelAdapter(profile);
  requireExactSourceFields(sourceIdentity, new Set([...sourceIdentityFields,...adapter.sourceIdentityFields]), "source_identity");
  adapter.validateSourceIdentity(profile,sourceIdentity);
  assertSourceProvenance(sourceIdentity.profile, {
    id: profile.id,
    file: `library/render-profiles/${profile.id}.json`,
    label: "source_identity.profile",
  });

  assertExactIdentityIds(sourceIdentity.shared_assets, new Set(), "source_identity.shared_assets");

  const recipeIds = expectedRouteIds(profile, "recipe_source_id");
  assertExactIdentityIds(sourceIdentity.recipes, recipeIds, "source_identity.recipes");
  for (const id of recipeIds) {
    assertSourceProvenance(sourceIdentity.recipes[id], {
      id,
      file: `library/render-recipes/${id}.json`,
      label: `source_identity.recipes.${id}`,
    });
  }

  const workflowIds = expectedRouteIds(profile, "workflow");
  assertExactIdentityIds(sourceIdentity.workflows, workflowIds, "source_identity.workflows");
  for (const id of workflowIds) {
    const identity = sourceIdentity.workflows[id];
    requireExactSourceFields(identity, workflowIdentityFields, `source_identity.workflows.${id}`);
    if (identity.id !== id) sourceIdentityError(`source_identity.workflows.${id}.id 与键不一致`);
    for (const [kind, suffix] of [["template", "api"], ["manifest", "manifest"]]) {
      const asset = identity[kind];
      requireExactSourceFields(asset, workflowAssetIdentityFields, `source_identity.workflows.${id}.${kind}`);
      if (asset.file !== `library/workflows/${id}.${suffix}.json`) {
        sourceIdentityError(`source_identity.workflows.${id}.${kind}.file 与 workflow ID 不一致`);
      }
      requireSourceSha256(asset.sha256, `source_identity.workflows.${id}.${kind}.sha256`);
    }
  }

  requireExactSourceFields(sourceIdentity.project_override, workflowAssetIdentityFields, "source_identity.project_override");
  if (sourceIdentity.project_override.file !== "render-profile.override.json") {
    sourceIdentityError("source_identity.project_override.file 无效");
  }
  requireSourceSha256(sourceIdentity.project_override.sha256, "source_identity.project_override.sha256");

  requireSourceRecord(workflowRegistry, "snapshot.workflows");
  for (const [id, definition] of Object.entries(workflowRegistry)) {
    const identity = sourceIdentity.workflows[id];
    if (!identity) sourceIdentityError(`snapshot.workflows.${id} 缺少来源身份`);
    if (identity.template.sha256 !== definition?.template_sha256 || identity.manifest.sha256 !== definition?.manifest_sha256) {
      sourceIdentityError(`snapshot.workflows.${id} 双哈希与来源身份不一致`);
    }
  }
  return sourceIdentity;
}

export function assertEffectiveRenderProfileSnapshot(snapshot) {
  requireSourceRecord(snapshot, "snapshot");
  if (!snapshot.execution || typeof snapshot.execution !== "object" || Array.isArray(snapshot.execution)
    || Object.keys(snapshot.execution).sort().join(",") !== "candidate_batch,queue_all"
    || typeof snapshot.execution.candidate_batch !== "boolean"
    || typeof snapshot.execution.queue_all !== "boolean") {
    throw new Error("任务缺少冻结的执行策略，请重新创建任务");
  }
  if (typeof snapshot.effective_profile_sha256 !== "string"
    || snapshot.effective_profile_sha256 !== hashCanonicalJson(snapshot.profile)) {
    throw new Error("任务的 effective render profile 身份无效，请重新创建任务");
  }
  if (typeof snapshot.effective_source_identity_sha256 !== "string") {
    throw new Error("任务缺少 effective source identity hash，请重新创建任务");
  }
  assertEffectiveSourceIdentity({
    profile: snapshot.profile,
    sourceIdentity: snapshot.source_identity,
    workflowRegistry: snapshot.workflows,
  });
  if (snapshot.effective_source_identity_sha256 !== hashCanonicalJson(snapshot.source_identity)) {
    throw new Error("任务的 effective source identity hash 无效，请重新创建任务");
  }
  return snapshot;
}
function compareStableIds(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function promptItemBindingFingerprint(item) {
  return hashJson({
    version: 5,
    id: typeof item?.id === "string" ? item.id : "",
    page_key: item?.page_key ? encodePageKey(item.page_key) : null,
    positive_prompt: typeof item?.positive_prompt === "string" ? item.positive_prompt : null,
    negative_prompt: typeof item?.negative_prompt === "string" ? item.negative_prompt : null,
    prompt_parts: item?.prompt_parts ?? null,
    loras: item?.loras ?? null,
    reference_images: item?.reference_images ?? [],
  });
}

export function currentPromptContractIdentity() {
  return {
    version: 7,
    sha256: hashJson({
      prompt_format: "story-models-v1",
      model_inputs: ['anima','qwen'],
    }),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// 复验只检查冻结形状与逐条目绑定指纹，不再逐 part 重审。
export function assertRenderTaskPromptAudit(task) {
  const expected = currentPromptContractIdentity();
  if (task?.snapshot?.prompt_contract?.version !== expected.version || task.snapshot.prompt_contract.sha256 !== expected.sha256) {
    throw new Error("渲染任务缺少当前 Prompt 契约身份，不能恢复旧任务");
  }
  const bindings = task.snapshot.prompt_binding_fingerprints;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error("渲染任务缺少逐条目 Prompt 绑定指纹，不能恢复旧任务");
  }
  const itemIds = new Set();
  for (const item of task.items ?? []) {
    if (typeof item?.id !== "string" || !item.id || itemIds.has(item.id)
      || typeof item.positive_prompt !== "string" || typeof item.negative_prompt !== "string") {
      throw new Error("渲染任务的逐条目 Prompt 绑定无效，不能恢复生成");
    }
    itemIds.add(item.id);
    if (!sameJson(task.snapshot.loras?.[item.id], item.loras)) throw new Error(`${item.id} 的 LoRA 绑定与任务快照不一致`);
    if (bindings[item.id] !== promptItemBindingFingerprint(item)) {
      throw new Error(`${item.id} 的 Prompt 或来源追踪已变化，拒绝恢复生成`);
    }
  }
  if (Object.keys(bindings).length !== itemIds.size || Object.keys(bindings).some((itemId) => !itemIds.has(itemId))) {
    throw new Error("渲染任务的逐条目 Prompt 绑定集合已变化，拒绝恢复生成");
  }
}

function setPath(target, dottedPath, value) {
  const parts = dottedPath.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!(part in cursor)) throw new Error(`工作流绑定不存在：${dottedPath}`);
    cursor = cursor[part];
  }
  const key = parts.at(-1);
  if (!(key in cursor)) throw new Error(`工作流绑定不存在：${dottedPath}`);
  cursor[key] = value;
}

function profileModelFilename(profile, kind) {
  const model = profile.models?.[kind];
  if (!model?.filename) throw new Error(`${profile.id ?? "当前生成配置"} 缺少 ${kind} 模型身份`);
  return model.filename;
}

function prepareModelAndClip(workflow, profile, loras = [], clipSkip = 1) {
  const unetEntry = Object.entries(workflow).find(([, node]) => node.class_type === "UNETLoader");
  const clipEntry = Object.entries(workflow).find(([, node]) => node.class_type === "CLIPLoader");
  if (!unetEntry || !clipEntry) throw new Error("工作流缺少 UNETLoader 或 CLIPLoader 节点");
  if (clipSkip !== 1) throw new Error("当前配置不支持 CLIP skip，请使用 1");
  let modelSource = [unetEntry[0], 0];
  const clipSource = [clipEntry[0], 0];
  let nextNode = Math.max(...Object.keys(workflow).map(Number).filter(Number.isFinite)) + 1;
  for (const lora of loras) {
    const nodeId = String(nextNode++);
    workflow[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { lora_name: lora.filename, strength_model: lora.weight, model: modelSource },
    };
    modelSource = [nodeId, 0];
  }
  const cache = Object.entries(workflow).find(([, node]) => node.class_type === "QwenImage21Cache");
  if (cache) { cache[1].inputs.model = modelSource; modelSource = [cache[0], 0]; }
  for (const node of Object.values(workflow)) {
    if (["CLIPTextEncode", "TextEncodeQwenImage21"].includes(node.class_type)) node.inputs.clip = clipSource;
    if (node.class_type === "KSampler") node.inputs.model = modelSource;
  }
  return { modelSource, clipSource };
}

function scaledDimension(value, scale) {
  return Math.max(64, Math.round((value * scale) / 8) * 8);
}

export function resolveRenderRecipe(parameters, canvas) {
  const declared = clone(parameters);
  const resolution = declared?.resolutions?.[canvas];
  const width = Number(resolution?.width);
  const height = Number(resolution?.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`recipe 缺少画布 ${canvas} 的有效分辨率`);
  }
  const scale = declared.scale === undefined ? 1 : Number(declared.scale);
  if (!Number.isFinite(scale) || scale < 1) throw new Error("recipe scale 必须大于等于 1");
  return {
    ...declared,
    dimensions: {
      width,
      height,
      final_width: scaledDimension(width, scale),
      final_height: scaledDimension(height, scale),
    },
  };
}

export function buildWorkflow(definition, profile, recipe, item) {
  const workflow = clone(definition.template);
  const manifest = definition.manifest;
  const profileStyleLoras = Object.keys(profile.style_loras ?? {}).sort(compareStableIds).map((id) => profile.style_loras[id]);
  const actualLoras = item.loras ?? profileStyleLoras;
  if (actualLoras.length && !manifest.modifiers.includes("lora.model_only")) throw new Error(`${definition.id} 不支持 LoRA`);
  prepareModelAndClip(workflow, profile, actualLoras, recipe.clip_skip);
  const { dimensions } = recipe;
  const values = {
    dit: profileModelFilename(profile, "dit"),
    text_encoder: profileModelFilename(profile, "text_encoder"),
    vae: profileModelFilename(profile, "vae"),
    positive_prompt: item.positive_prompt,
    negative_prompt: item.negative_prompt,
    reference_image: item.reference_images?.length ? referenceImageFilename(item.reference_images[0]) : null,
    width: dimensions.width,
    height: dimensions.height,
    seed: item.seed,
    steps: recipe.steps,
    cfg: recipe.cfg,
    sampler: recipe.sampler,
    scheduler: recipe.scheduler,
    final_width: dimensions.final_width,
    final_height: dimensions.final_height,
    second_pass_seed: item.seed,
    second_pass_steps: recipe.second_pass_steps,
    second_pass_cfg: recipe.second_pass_cfg,
    second_pass_sampler: recipe.second_pass_sampler,
    second_pass_scheduler: recipe.second_pass_scheduler,
    denoise: recipe.denoise,
    filename_prefix: item.output_prefix ?? `StoryCanvas/${encodePageKey(item.page_key)}/${item.task}/${item.id}`,
  };
  const bindings = manifest.bindings;
  for (const name of Object.keys(bindings)) {
    if (Object.hasOwn(values, name) && values[name] == null) {
      throw new Error(`${definition.id} 缺少 recipe 或条目绑定值：${name}`);
    }
  }
  for (const [name, value] of Object.entries(values)) {
    const binding = bindings[name];
    if (binding && value != null) setPath(workflow, binding, value);
  }
  if (item.reference_images?.length) {
    if (item.reference_images.length > 10) throw new Error("最多支持 10 张参考图");
    const encoder = Object.values(workflow).find(node => node.class_type === "TextEncodeQwenImage21");
    if (!encoder) throw new Error("工作流不支持多参考图");
    for (const key of Object.keys(encoder.inputs)) if (key.startsWith("images.image_")) delete encoder.inputs[key];
    const loadId = bindings.reference_image.split('.')[0];
    item.reference_images.forEach((identity, index) => {
      const id = index === 0 ? loadId : 'reference-' + (index + 1);
      workflow[id] = { class_type: "LoadImage", inputs: { image: referenceImageFilename(identity) } };
      encoder.inputs['images.image_' + (index + 1)] = [id, 0];
    });
  }
  return workflow;
}

/**
 * 把任务条目划分为渲染单元。默认每个条目一个单元(与原有逐张串行行为一致);
 * 开启批量候选时,同一页面连续出现的候选条目合并为一个单元,用一个
 * ComfyUI 任务并行采样(batch),每个条目对应输出中的一张图。
 * 被跳过的条目单独成单元,保持原有跳过语义。
 */
export function buildRenderUnits(items, { candidateBatch = false } = {}) {
  const units = [];
  for (const item of items) {
    const isCandidate = /\.candidate-\d{3}$/.test(item.id);
    const last = units.at(-1);
    if (item.status === "skipped" || item.status === "discarded") {
      units.push({ items: [item], skipped: true, batch: false });
    } else if (candidateBatch && isCandidate && last && !last.skipped && last.batch && encodePageKey(last.items[0].page_key) === encodePageKey(item.page_key)) {
      last.items.push(item);
    } else if (candidateBatch && isCandidate) {
      units.push({ items: [item], skipped: false, batch: true });
    } else {
      units.push({ items: [item], skipped: false, batch: false });
    }
  }
  return units;
}

export function projectFrozenRenderExecution(task) {
  const execution = task?.snapshot?.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)
    || Object.keys(execution).sort().join(",") !== "candidate_batch,queue_all"
    || typeof execution.candidate_batch !== "boolean" || typeof execution.queue_all !== "boolean") {
    throw new Error("任务缺少冻结的执行策略，请重新创建任务");
  }
  const itemById = new Map(task.items.map((item) => [item.id, item]));
  return {
    units: task.snapshot.execution_units.map((plan) => ({
      plan,
      items: plan.item_ids.map((id) => itemById.get(id)),
      batch: plan.batch,
      skipped: plan.item_ids.every((id) => itemById.get(id)?.status === "discarded"),
    })),
    queueAll: execution.queue_all,
  };
}

/**
 * 为同一页面的多个候选构建批量工作流:以第一个候选构建单图工作流,
 * 再把 EmptyLatentImage 的 batch_size 设为候选数量。
 * 采样器 seed 沿用第一个候选:ComfyUI 的 KSampler 只接受单个 seed,
 * 对 batch latent 生成的噪声张量逐张切片互不相同,因此同一次任务
 * 仍会产出 N 张不同的候选图;但每张图与各自条目 seed 的对应关系
 * 不可复现,条目 seed 仅作为元数据保留。
 */
export function buildBatchWorkflow(definition, profile, recipe, items) {
  const workflow = buildWorkflow(definition, profile, recipe, items[0]);
  const latentNode = Object.values(workflow).find((node) => node.class_type === "EmptyLatentImage");
  if (!latentNode) throw new Error("批量候选工作流缺少 EmptyLatentImage 节点");
  latentNode.inputs.batch_size = items.length;
  return workflow;
}

function workflowOutputNodeId(definition) {
  const binding = definition?.manifest?.bindings?.filename_prefix;
  const match = typeof binding === "string" ? /^(\d+)\.inputs\.filename_prefix$/.exec(binding) : null;
  if (!match) throw new Error(`${definition?.id ?? "工作流"} 缺少可冻结的输出节点绑定`);
  return match[1];
}

export function compileFrozenExecutionUnits({ items, purpose, snapshot, profile, canvas, candidateBatch, taskId }) {
  const executableItems = items.filter((item) => item.status !== "skipped" && item.status !== "discarded");
  const units = buildRenderUnits(executableItems, { candidateBatch: candidateBatch && purpose === "candidate" && !items.some(item => item.reference_images?.length) });
  const outputAdapter = createRenderOutputAdapter(purpose);
  return units.map((unit, index) => {
    const unitId = `unit-${String(index + 1).padStart(4, "0")}`;
    const { route, definition, recipe: frozenRecipe } = resolveRenderUnitPlan(unit.items, {
      purpose, snapshot, resolvedProfile: profile,
    });
    const recipe = resolveRenderRecipe(frozenRecipe, canvas);
    if (unit.batch) {
      const topology = (item) => ({
        page_key: item.page_key,
        positive_prompt: item.positive_prompt,
        negative_prompt: item.negative_prompt,
        loras: item.loras ?? [],
        render_route: item.render_route,
      });
      const expected = hashCanonicalJson(topology(unit.items[0]));
      if (unit.items.some((item) => hashCanonicalJson(topology(item)) !== expected)) {
        throw new Error(`${unitId} 的 batch 条目拓扑或 Prompt 不一致`);
      }
    }
    const runtimeItem = unit.items[0];
    const api = unit.batch
      ? buildBatchWorkflow(definition, profile, recipe, [runtimeItem, ...unit.items.slice(1)])
      : buildWorkflow(definition, profile, recipe, runtimeItem);
    const outputNodeId = workflowOutputNodeId(definition);
    const recipeSnapshot = snapshot.recipes[route.recipe_instance_id];
    const plan = {
      id: unitId,
      item_ids: unit.items.map((item) => item.id),
      batch: unit.batch,
      atomic: unit.batch,
      render_route: clone(route),
      recipe: {
        source_id: route.recipe_source_id,
        instance_id: route.recipe_instance_id,
        source_canonical_sha256: recipeSnapshot.canonical_sha256,
        resolved_parameters: clone(recipe),
        resolved_canonical_sha256: hashCanonicalJson(recipe),
      },
      workflow: {
        source_id: definition.id,
        template_sha256: definition.template_sha256,
        manifest_sha256: definition.manifest_sha256,
        api,
        canonical_sha256: hashCanonicalJson(api),
      },
      extra_data: {
        extra_pnginfo: {
          storyvisualizer: {
            version: 3,
            task: taskId,
            unit: unitId,
            purpose,
            render_profile: profile.id,
            item_ids: unit.items.map((item) => item.id),
            outputs: unit.items.map((item, imageIndex) => outputAdapter.provenance(item, {
              imageIndex,
              effectiveSeed: unit.items[0].seed,
            })),
          },
        },
      },
      outputs: unit.items.map((item, imageIndex) => ({
        node_id: outputNodeId,
        image_index: imageIndex,
        item_id: item.id,
        ...outputAdapter.describe(item),
      })),
    };
    return { ...plan, canonical_sha256: hashCanonicalJson(plan) };
  });
}

function assertFrozenExecutionPlan(task) {
  if (!Array.isArray(task?.snapshot?.execution_units)) {
    throw new Error("任务缺少冻结 execution_units");
  }
  const items = new Map((task.items ?? []).map((item) => [item.id, item]));
  const executableItems = new Map([...items].filter(([, item]) => item.status !== "skipped"));
  const outputAdapter = createRenderOutputAdapter(task.purpose);
  if (task.snapshot.execution_units_sha256 !== hashCanonicalJson(task.snapshot.execution_units)) {
    throw new Error("任务 execution_units 整体 hash 无效");
  }
  const assigned = [];
  for (const unit of task.snapshot.execution_units) {
    const { canonical_sha256: canonicalSha256, ...content } = unit;
    if (canonicalSha256 !== hashCanonicalJson(content)) throw new Error(`${unit.id ?? "execution unit"} canonical hash 无效`);
    if (!Array.isArray(unit.item_ids) || !unit.item_ids.length || unit.atomic !== unit.batch) throw new Error(`${unit.id} 条目或原子性无效`);
    const unitItems = unit.item_ids.map((id) => {
      const item = items.get(id);
      if (!item) throw new Error(`${unit.id} 引用了不存在的条目：${id}`);
      assigned.push(id);
      return item;
    });
    if (!Array.isArray(unit.outputs) || unit.item_ids.some((id, index) => id !== unit.outputs?.[index]?.item_id
      || unit.outputs[index].image_index !== index)) throw new Error(`${unit.id} 输出映射无效`);
    if (unitItems.some((item) => hashCanonicalJson(item.render_route) !== hashCanonicalJson(unit.render_route))) throw new Error(`${unit.id} route 与条目不一致`);
    const workflow = task.snapshot.workflows?.[unit.workflow?.source_id];
    if (!workflow || workflow.template_sha256 !== unit.workflow.template_sha256 || workflow.manifest_sha256 !== unit.workflow.manifest_sha256
      || unit.workflow.canonical_sha256 !== hashCanonicalJson(unit.workflow.api)) throw new Error(`${unit.id} workflow 身份无效`);
    const outputNodeId = workflowOutputNodeId(workflow);
    if (unit.outputs.some((output) => output.node_id !== outputNodeId)) throw new Error(`${unit.id} 输出节点映射无效`);
    const provenanceOutputs = unit.extra_data?.extra_pnginfo?.storyvisualizer?.outputs;
    if (!Array.isArray(provenanceOutputs) || provenanceOutputs.length !== unit.outputs.length) {
      throw new Error(`${unit.id} PNG provenance 输出数量无效`);
    }
    for (const [outputIndex, output] of unit.outputs.entries()) {
      const item = items.get(output.item_id);
      try {
        outputAdapter.validate(output, item);
      } catch (error) {
        throw new Error(`${unit.id} 输出 descriptor 无效：${error.message}`);
      }
      const expectedProvenance = outputAdapter.provenance(unitItems[outputIndex], {
        imageIndex: outputIndex,
        effectiveSeed: unitItems[0].seed,
      });
      if (hashCanonicalJson(provenanceOutputs[outputIndex]) !== hashCanonicalJson(expectedProvenance)) {
        throw new Error(`${unit.id} PNG provenance 与输出 descriptor 不一致`);
      }
    }
    const recipe = task.snapshot.recipes?.[unit.recipe?.instance_id];
    if (!recipe || recipe.source_id !== unit.recipe.source_id || recipe.canonical_sha256 !== unit.recipe.source_canonical_sha256
      || unit.recipe.resolved_canonical_sha256 !== hashCanonicalJson(unit.recipe.resolved_parameters)) throw new Error(`${unit.id} recipe 身份无效`);
  }
  if (assigned.length !== executableItems.size || new Set(assigned).size !== executableItems.size
    || assigned.some((id) => !executableItems.has(id))) throw new Error("execution_units 未唯一覆盖全部可执行任务条目");
  return task.snapshot.execution_units;
}

export function createTaskSnapshot({ purpose, canvas, profile, effectiveProfileSha256, sourceIdentity, workflowDefinitions, items, promptAudit = null, execution = { candidate_batch: false, queue_all: false } }) {
  if (typeof effectiveProfileSha256 !== "string" || effectiveProfileSha256 !== hashCanonicalJson(profile)) {
    throw new Error("effective render profile 身份校验失败");
  }
  if (!execution || typeof execution !== "object" || Array.isArray(execution)
    || Object.keys(execution).sort().join(",") !== "candidate_batch,queue_all"
    || typeof execution.candidate_batch !== "boolean" || typeof execution.queue_all !== "boolean") {
    throw new Error("执行策略必须显式冻结 candidate_batch 与 queue_all");
  }
  const registries = freezeRenderPlanRegistries(items, { purpose, resolvedProfile: profile, workflowDefinitions });
  assertEffectiveSourceIdentity({ profile, sourceIdentity, workflowRegistry: registries.workflows });
  const snapshot = {
    canvas,
    profile: clone(profile),
    effective_profile_sha256: effectiveProfileSha256,
    source_identity: clone(sourceIdentity),
    effective_source_identity_sha256: hashCanonicalJson(sourceIdentity),
    ...registries,
    seeds: Object.fromEntries(items.map((item) => [item.id, item.seed])),
    loras: Object.fromEntries(items.map((item) => [item.id, clone(item.loras ?? [])])),
    prompt_contract: currentPromptContractIdentity(),
    prompt_audit: clone(promptAudit ?? { valid: false, pages: {} }),
    prompt_binding_fingerprints: Object.fromEntries(items.map((item) => [item.id, promptItemBindingFingerprint(item)])),
    execution: clone(execution),
  };
  for (const item of items) {
    resolveRenderUnitPlan([item], { purpose, snapshot, resolvedProfile: profile });
  }
  return snapshot;
}









/**
 * 冻结渲染任务契约的主要 Interface：一次性校验 version、effective profile 来源身份、
 * route/registry、Prompt 可重审计证据和 execution unit，并返回可供执行器消费的原任务。
 */
export function validateFrozenRenderTask(task) {
  if (task?.version !== 2 || !task?.snapshot || !Array.isArray(task.items)) {
    throw new Error("只支持当前 version=2 的冻结渲染任务，请重新创建任务");
  }
  assertCurrentFields(task, frozenTaskFields, "冻结渲染任务");
  assertCurrentFields(task.snapshot, frozenSnapshotFields, "冻结渲染任务 snapshot");
  for (const item of task.items) assertCurrentFields(item, frozenItemFields, "冻结渲染任务条目");
  if (task.purpose !== "candidate") {
    throw new Error("冻结渲染任务 purpose 无效，只支持 candidate，请重新创建任务");
  }
  assertEffectiveRenderProfileSnapshot(task.snapshot);
  const profileId = task.snapshot.profile?.id;
  if (typeof profileId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(profileId)) {
    throw new Error(`生成配置 ID 无效：${String(profileId)}`);
  }
  if (task.render_profile !== profileId) throw new Error("任务 render_profile 与冻结 profile 不一致");
  const itemsById = new Map(task.items.map((item) => [item.id, item]));
  if (itemsById.size !== task.items.length || [...itemsById.keys()].some((id) => typeof id !== "string" || !id)) {
    throw new Error("冻结渲染任务的条目 ID 集合无效");
  }
  for (const item of task.items) {
    // absolute_file is local display convenience only. Candidate identity remains
    // page_key + candidate_id + canonical relative file, so project moves do not
    // invalidate or redirect an otherwise valid task.
    if (item.absolute_file !== undefined && (typeof item.absolute_file !== "string" || !path.isAbsolute(item.absolute_file))) {
      throw new Error(`${item.id ?? "任务条目"} 的 absolute_file 必须是绝对展示路径`);
    }
    try {
      createRenderOutputDescriptor({ purpose: task.purpose, item });
    } catch (error) {
      throw new Error(`${item.id ?? "任务条目"} 输出身份无效：${error.message}`);
    }
  }
  for (const unit of task.snapshot.execution_units ?? []) {
    const unitItems = (unit.item_ids ?? []).map((id) => itemsById.get(id));
    if (unitItems.some((item) => !item)) throw new Error(`${unit.id ?? "execution unit"} 引用了不存在的任务条目`);
    resolveRenderUnitPlan(unitItems, { purpose: task.purpose, snapshot: task.snapshot, resolvedProfile: task.snapshot.profile });
  }
  assertFrozenExecutionPlan(task);
  assertRenderTaskPromptAudit(task);
  return { task, execution: projectFrozenRenderExecution(task) };
}
