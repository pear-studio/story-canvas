import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const architectureFamilies = new Set(["anima"]);
const operations = new Set(["candidates"]);
const inputSources = new Set(["empty_latent"]);
const modifiers = new Set(["lora.model_only"]);
const manifestFields = new Set(["$schema", "id", "template", "architecture_families", "operations", "input_sources", "modifiers", "bindings"]);
const bindingNames = new Set([
  "dit", "text_encoder", "vae",
  "positive_prompt", "negative_prompt",
  "width", "height",
  "seed", "steps", "cfg", "sampler", "scheduler",
  "final_width", "final_height",
  "second_pass_seed", "second_pass_steps", "second_pass_cfg", "second_pass_sampler", "second_pass_scheduler",
  "denoise", "filename_prefix",
]);
const bindingInputNames = new Map([
  ["dit", "unet_name"], ["text_encoder", "clip_name"], ["vae", "vae_name"],
  ["positive_prompt", "text"], ["negative_prompt", "text"],
  ["width", "width"], ["height", "height"], ["seed", "seed"], ["steps", "steps"], ["cfg", "cfg"],
  ["sampler", "sampler_name"], ["scheduler", "scheduler"], ["final_width", "width"], ["final_height", "height"],
  ["second_pass_seed", "seed"], ["second_pass_steps", "steps"], ["second_pass_cfg", "cfg"],
  ["second_pass_sampler", "sampler_name"], ["second_pass_scheduler", "scheduler"],
  ["denoise", "denoise"], ["filename_prefix", "filename_prefix"],
]);
const primarySamplingBindings = ["seed", "steps", "cfg", "sampler", "scheduler"];
const secondPassBindings = [
  "final_width", "final_height", "second_pass_seed", "second_pass_steps", "second_pass_cfg",
  "second_pass_sampler", "second_pass_scheduler", "denoise",
];
const secondPassExclusiveBindings = secondPassBindings.filter((name) => name !== "denoise");
const unsafePathParts = new Set(["__proto__", "prototype", "constructor"]);

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("工作流定义不能包含非有限数值");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareUnicodeCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`工作流定义不能包含 ${typeof value}`);
}

function hashJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashCanonicalJson(value) {
  return hashJson(value);
}

function requireUniqueStringList(value, allowed, label) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !allowed.has(item)) || new Set(value).size !== value.length) {
    throw new Error(`工作流 manifest 的 ${label} 无效`);
  }
}

function assertBindingPath(template, name, dottedPath) {
  if (typeof dottedPath !== "string" || !/^[A-Za-z0-9_-]+\.inputs\.[A-Za-z0-9_]+$/.test(dottedPath)) throw new Error(`工作流绑定 ${name} 不是节点输入叶子：${String(dottedPath)}`);
  const [nodeId, inputsKey, inputName] = dottedPath.split(".");
  if ([nodeId, inputName].some((part) => unsafePathParts.has(part))) throw new Error(`工作流绑定 ${name} 包含不安全路径`);
  if (bindingInputNames.get(name) !== inputName) {
    throw new Error(`工作流绑定 ${name} 必须指向 inputs.${bindingInputNames.get(name)}`);
  }
  if (!Object.hasOwn(template, nodeId)
    || !template[nodeId] || typeof template[nodeId] !== "object"
    || !Object.hasOwn(template[nodeId], inputsKey)
    || !template[nodeId].inputs || typeof template[nodeId].inputs !== "object" || Array.isArray(template[nodeId].inputs)
    || !Object.hasOwn(template[nodeId].inputs, inputName)) {
    throw new Error(`工作流绑定不存在：${name} → ${dottedPath}`);
  }
}

function requireBindings(manifest, names, reason) {
  const missing = names.filter((name) => !Object.hasOwn(manifest.bindings, name));
  if (missing.length) throw new Error(`${manifest.id} 缺少必要绑定（${reason}）：${missing.join("、")}`);
}

function bindingNode(template, manifest, name) {
  const nodeId = manifest.bindings[name].split(".")[0];
  return template[nodeId];
}

function bindingNodeId(manifest, name) {
  return manifest.bindings[name].split(".")[0];
}

function requireBindingNodeType(template, manifest, name, classTypes) {
  const node = bindingNode(template, manifest, name);
  if (!classTypes.includes(node.class_type)) {
    throw new Error(`${manifest.id} 的绑定 ${name} 必须指向 ${classTypes.join(" 或 ")} 节点`);
  }
}

function requireNodeType(template, manifest, classType, reason) {
  if (!Object.values(template).some((node) => node?.class_type === classType)) {
    throw new Error(`${manifest.id} 缺少 ${reason} 所需的 ${classType} 节点`);
  }
}

function requireSameNodeType(template, manifest, names, classType, reason) {
  for (const name of names) requireBindingNodeType(template, manifest, name, [classType]);
  const nodeIds = new Set(names.map((name) => bindingNodeId(manifest, name)));
  if (nodeIds.size !== 1) throw new Error(`${manifest.id} 的${reason}绑定必须指向同一个 ${classType} 节点`);
  return [...nodeIds][0];
}

export function validateWorkflowDefinition(definition) {
  const { id, template, manifest } = definition ?? {};
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error(`工作流 ID 无效：${String(id)}`);
  if (!template || typeof template !== "object" || Array.isArray(template)) throw new Error(`${id} 的 API JSON 无效`);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${id} 的 manifest 无效`);
  const unknownFields = Object.keys(manifest).filter((name) => !manifestFields.has(name));
  if (unknownFields.length) throw new Error(`${id} 的 manifest 包含未知字段：${unknownFields.join("、")}`);
  if (Object.hasOwn(manifest, "$schema") && typeof manifest.$schema !== "string") throw new Error(`${id} 的 manifest $schema 必须是字符串`);
  if (manifest.id !== id) throw new Error(`${id} 的 manifest ID 不匹配`);
  if (manifest.template !== `${id}.api.json`) throw new Error(`${id} 的 manifest template 不匹配`);
  requireUniqueStringList(manifest.architecture_families, architectureFamilies, "architecture_families");
  requireUniqueStringList(manifest.operations, operations, "operations");
  requireUniqueStringList(manifest.input_sources, inputSources, "input_sources");
  if (!Array.isArray(manifest.modifiers) || manifest.modifiers.some((item) => typeof item !== "string" || !modifiers.has(item)) || new Set(manifest.modifiers).size !== manifest.modifiers.length) {
    throw new Error("工作流 manifest 的 modifiers 无效");
  }
  if (!manifest.bindings || typeof manifest.bindings !== "object" || Array.isArray(manifest.bindings) || !Object.keys(manifest.bindings).length) {
    throw new Error(`${id} 的 manifest bindings 无效`);
  }
  for (const [name, dottedPath] of Object.entries(manifest.bindings)) {
    if (!bindingNames.has(name)) throw new Error(`${id} 的 manifest 包含未知绑定：${name}`);
    assertBindingPath(template, name, dottedPath);
  }

  requireBindings(manifest, ["positive_prompt", "negative_prompt", "filename_prefix"], "基础生成");
  requireBindingNodeType(template, manifest, "positive_prompt", ["CLIPTextEncode"]);
  requireBindingNodeType(template, manifest, "negative_prompt", ["CLIPTextEncode"]);
  requireBindingNodeType(template, manifest, "filename_prefix", ["SaveImage"]);
  requireNodeType(template, manifest, "KSampler", "生成");

  requireBindings(manifest, ["dit", "text_encoder", "vae"], "Anima 架构");
  requireBindingNodeType(template, manifest, "dit", ["UNETLoader"]);
  requireBindingNodeType(template, manifest, "text_encoder", ["CLIPLoader"]);
  requireBindingNodeType(template, manifest, "vae", ["VAELoader"]);

  if (manifest.input_sources.includes("empty_latent")) {
    requireBindings(manifest, ["width", "height", ...primarySamplingBindings], "empty_latent 输入");
    requireBindingNodeType(template, manifest, "width", ["EmptyLatentImage"]);
    requireBindingNodeType(template, manifest, "height", ["EmptyLatentImage"]);
  }

  const presentPrimarySampling = primarySamplingBindings.filter((name) => Object.hasOwn(manifest.bindings, name));
  let primarySamplerNodeId = null;
  if (presentPrimarySampling.length) {
    requireBindings(manifest, primarySamplingBindings, "第一遍采样");
    primarySamplerNodeId = requireSameNodeType(template, manifest, primarySamplingBindings, "KSampler", "第一遍采样");
  }

  const presentSecondPass = secondPassExclusiveBindings.filter((name) => Object.hasOwn(manifest.bindings, name));
  if (presentSecondPass.length) {
    requireBindings(manifest, secondPassBindings, "second_pass 组合");
    const secondSamplerBindings = secondPassBindings.filter((name) => name.startsWith("second_pass_"));
    const secondSamplerNodeId = requireSameNodeType(template, manifest, [...secondSamplerBindings, "denoise"], "KSampler", "第二遍采样");
    if (primarySamplerNodeId && primarySamplerNodeId === secondSamplerNodeId) {
      throw new Error(`${manifest.id} 的第一遍和第二遍采样绑定必须指向不同 KSampler 节点`);
    }
  } else if (Object.hasOwn(manifest.bindings, "denoise") && primarySamplerNodeId) {
    requireBindingNodeType(template, manifest, "denoise", ["KSampler"]);
    if (bindingNodeId(manifest, "denoise") !== primarySamplerNodeId) {
      throw new Error(`${manifest.id} 的 denoise 必须指向第一遍采样 KSampler 节点`);
    }
  }

  if (manifest.modifiers.includes("lora.model_only")) requireNodeType(template, manifest, "UNETLoader", "lora.model_only");
  return definition;
}

export function assertWorkflowSupports(definition, { architectureFamily = null, operation = null, inputSource = null, requiredModifiers = [] } = {}) {
  validateWorkflowDefinition(definition);
  if (architectureFamily && !definition.manifest.architecture_families.includes(architectureFamily)) {
    throw new Error(`${definition.id} 不支持结构家族 ${architectureFamily}`);
  }
  if (operation && !definition.manifest.operations.includes(operation)) throw new Error(`${definition.id} 不支持 operation ${operation}`);
  if (inputSource && !definition.manifest.input_sources.includes(inputSource)) throw new Error(`${definition.id} 不支持输入来源 ${inputSource}`);
  for (const modifier of requiredModifiers) {
    if (!definition.manifest.modifiers.includes(modifier)) throw new Error(`${definition.id} 不支持 ${modifier}`);
  }
  return definition;
}

export async function readWorkflowDefinition(repositoryRoot, workflowId) {
  if (typeof workflowId !== "string" || !idPattern.test(workflowId)) throw new Error(`工作流 ID 无效：${String(workflowId)}`);
  const root = path.join(repositoryRoot, "library", "workflows");
  const [template, manifest] = await Promise.all([
    readFile(path.join(root, `${workflowId}.api.json`), "utf8").then(JSON.parse),
    readFile(path.join(root, `${workflowId}.manifest.json`), "utf8").then(JSON.parse),
  ]);
  return validateWorkflowDefinition({
    id: workflowId,
    template,
    manifest,
    template_sha256: hashJson(template),
    manifest_sha256: hashJson(manifest),
  });
}

export function freezeWorkflowDefinition(definition) {
  validateWorkflowDefinition(definition);
  return structuredClone({
    id: definition.id,
    template_sha256: hashJson(definition.template),
    manifest_sha256: hashJson(definition.manifest),
    template: definition.template,
    manifest: definition.manifest,
  });
}

export function assertFrozenWorkflowDefinition(snapshot) {
  validateWorkflowDefinition(snapshot);
  if (snapshot.template_sha256 !== hashJson(snapshot.template) || snapshot.manifest_sha256 !== hashJson(snapshot.manifest)) {
    throw new Error(`${snapshot.id} 的工作流定义快照校验失败`);
  }
  return snapshot;
}
