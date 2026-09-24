// Anima 策略与词条合并恢复自 64db906；此处不拥有通用模型/配方/工作流校验。
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {hashCanonicalJson} from '../../workflow-definition.mjs';
const profileIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const fragmentIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const promptFamilies = new Set(["anima", "qwen-image-2-1"]);
const promptTypes = new Set(["danbooru", "custom_description"]);
const polarities = new Set(["positive", "negative"]);
const placements = new Set(["prefix", "suffix"]);
const avoidanceStrategies = new Set(["negative_prompt", "positive_avoid", "unsupported"]);
const pageCategories = ["subject","person","setting","camera"];
const policyFields = new Set(["$schema", "id", "name", "family", "separator", "avoidance_strategy", "category_order", "fragments"]);
const fragmentFields = new Set(["polarity", "placement", "order", "prompt_type", "prompt_text", "weight"]);
const promptFields = new Set(["policy", "fragments"]);

function fail(message) { throw new TypeError(message); }
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


function assertFragment(value, label) {
  assertRecord(value, label);
  assertExactFields(value, fragmentFields, label);
  if (!polarities.has(value.polarity)) fail(`${label}.polarity 无效`);
  if (!placements.has(value.placement)) fail(`${label}.placement 无效`);
  assertFiniteNumber(value.order, `${label}.order`, { min: 0, integer: true });
  if (!promptTypes.has(value.prompt_type)) fail(`${label}.prompt_type 无效`);
  assertNonEmptyString(value.prompt_text, `${label}.prompt_text`);
  if (value.weight !== undefined) assertFiniteNumber(value.weight, `${label}.weight`, { min: 0.2, max: 10 });
}


function assertFragmentMap(value, label) {
  assertRecord(value, label);
  for (const [id, fragment] of Object.entries(value)) {
    if (!fragmentIdPattern.test(id)) fail(`${label} 的片段 ID 无效：${id}`);
    assertFragment(fragment, `${label}.${id}`);
  }
}


function assertPromptPolicy(value, expectedId) {
  assertRecord(value, `Prompt policy ${expectedId}`);
  assertExactFields(value, policyFields, `Prompt policy ${expectedId}`);
  if (value.$schema !== undefined && typeof value.$schema !== "string") fail(`${expectedId}.$schema 必须是字符串`);
  if (value.id !== expectedId) fail(`Prompt policy 文件 ID 不匹配：期望 ${expectedId}，实际 ${String(value.id)}`);
  assertNonEmptyString(value.name, `${expectedId}.name`);
  if (!promptFamilies.has(value.family)) fail(`${expectedId}.family 无效`);
  if (typeof value.separator !== "string") fail(`${expectedId}.separator 必须是字符串`);
  if (!avoidanceStrategies.has(value.avoidance_strategy)) fail(`${expectedId}.avoidance_strategy 无效`);
  if (!Array.isArray(value.category_order) || value.category_order.length !== pageCategories.length
    || new Set(value.category_order).size !== pageCategories.length
    || pageCategories.some((category) => !value.category_order.includes(category))) fail(`${expectedId}.category_order 无效`);
  assertFragmentMap(value.fragments, `${expectedId}.fragments`);
}


function mergeFragments(policy, profile) {
  const entries = [];
  for (const [sourceKind, sourceId, values] of [
    ["prompt_policy", policy.id, policy.fragments],
    ["render_profile", profile.id, profile.prompt.fragments],
  ]) {
    for (const [id, fragment] of Object.entries(values)) {
      if (entries.some((entry) => entry.id === id)) fail(`Prompt 片段 ID 冲突：${id}`);
      entries.push({ id, fragment: clone(fragment), source: { source_kind: sourceKind, source_id: sourceId } });
    }
  }
  const polarityRank = new Map([["positive", 0], ["negative", 1]]);
  const placementRank = new Map([["prefix", 0], ["suffix", 1]]);
  entries.sort((left, right) => polarityRank.get(left.fragment.polarity) - polarityRank.get(right.fragment.polarity)
    || placementRank.get(left.fragment.placement) - placementRank.get(right.fragment.placement)
    || left.fragment.order - right.fragment.order
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    fragments: Object.fromEntries(entries.map((entry) => [entry.id, entry.fragment])),
    sources: Object.fromEntries(entries.map((entry) => [entry.id, entry.source])),
  };
}


function applyPromptFragmentChanges(fragments, sources, changes, profileId) {
  for (const change of changes) {
    const match = /^prompt\.fragments\.([a-z0-9][a-z0-9-]*)$/.exec(change.target);
    if (!match) continue;
    if (change.project.exists) {
      fragments[match[1]] = clone(change.project.value);
      sources[match[1]] = { source_kind: "project_override", source_id: profileId };
    } else {
      delete fragments[match[1]];
      delete sources[match[1]];
    }
  }
}


export async function resolveEffectivePrompt(repositoryRoot, baseBundle, resolution, effectiveProfile) {
  const sourceIdentity = clone(baseBundle.source_identity);
  const policyChanged = resolution.changes.some((change) => change.target === "prompt.policy");
  if (!policyChanged) {
    applyPromptFragmentChanges(effectiveProfile.prompt.fragments, sourceIdentity.prompt_fragments, resolution.changes, resolution.profile_id);
    return sourceIdentity;
  }

  const policyId = effectiveProfile.prompt.policy;
  const policySource = await readJsonSource(repositoryRoot, "prompt-policies", policyId, "Prompt policy");
  assertPromptPolicy(policySource.value, policyId);
  const profileFragments = Object.fromEntries(Object.entries(baseBundle.resolved_profile.prompt.fragments)
    .filter(([id]) => baseBundle.source_identity.prompt_fragments?.[id]?.source_kind === "render_profile"));
  const merged = mergeFragments(policySource.value, { id: effectiveProfile.id, prompt: { fragments: profileFragments } });
  applyPromptFragmentChanges(merged.fragments, merged.sources, [...resolution.changes, ...resolution.redundant], resolution.profile_id);
  effectiveProfile.prompt = {
    policy: policySource.value.id,
    family: policySource.value.family,
    separator: policySource.value.separator,
    avoidance_strategy: policySource.value.avoidance_strategy,
    category_order: clone(policySource.value.category_order),
    fragments: merged.fragments,
  };
  sourceIdentity.prompt_policy = policySource.provenance;
  sourceIdentity.prompt_fragments = merged.sources;
  return sourceIdentity;
}


export function validateProfilePrompt(prompt, {effective=false}={}) {
  assertRecord(prompt,'anima.prompt');
  if (!effective) { assertExactFields(prompt,promptFields,'anima.prompt'); assertNonEmptyString(prompt.policy,'anima.prompt.policy'); }
  else {
    if(prompt.family!=='anima'||prompt.avoidance_strategy!=='negative_prompt'||typeof prompt.separator!=='string') fail('Anima Prompt 策略无效');
    if(!Array.isArray(prompt.category_order)||prompt.category_order.length!==pageCategories.length||pageCategories.some(c=>!prompt.category_order.includes(c))) fail('Anima Prompt 分类顺序无效');
  }
  assertFragmentMap(prompt.fragments,'anima.prompt.fragments');
}
export async function resolveProfilePrompt(repositoryRoot,profile) {
  const policySource=await readJsonSource(repositoryRoot,'prompt-policies',profile.prompt.policy,'Prompt policy');
  assertPromptPolicy(policySource.value,profile.prompt.policy);
  const merged=mergeFragments(policySource.value,profile);
  const {id,family,separator,avoidance_strategy,category_order}=policySource.value;
  return {prompt:{policy:id,family,separator,avoidance_strategy,category_order,fragments:merged.fragments},identity:{prompt_policy:policySource.provenance,prompt_fragments:merged.sources}};
}

export function validateSourceIdentity(profile, identity) {
  const policy=identity.prompt_policy;
  assertRecord(policy,'source_identity.prompt_policy');
  assertExactFields(policy,new Set(['id','file','sha256']),'source_identity.prompt_policy');
  if(policy.id!==profile.prompt.policy || policy.file!==`library/prompt-policies/${policy.id}.json` || !/^[a-f0-9]{64}$/.test(policy.sha256))fail('Anima Prompt policy 来源身份无效');
  const fragments=identity.prompt_fragments,ids=Object.keys(profile.prompt.fragments);
  assertRecord(fragments,'source_identity.prompt_fragments');
  if(Object.keys(fragments).length!==ids.length || ids.some(id=>!Object.hasOwn(fragments,id)))fail('Anima Prompt 片段来源不完整');
  for(const id of ids) {
    const source=fragments[id];
    assertRecord(source,`source_identity.prompt_fragments.${id}`);
    assertExactFields(source,new Set(['source_kind','source_id']),`source_identity.prompt_fragments.${id}`);
    if(!['prompt_policy','render_profile','project_override'].includes(source.source_kind) || source.source_id!==(source.source_kind==='prompt_policy'?policy.id:profile.id))fail('Anima Prompt 片段来源身份无效');
  }
}
