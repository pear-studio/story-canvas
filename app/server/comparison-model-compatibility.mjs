import { readFileSync } from 'node:fs';
import { hashCanonicalJson } from './workflow-definition.mjs';

const registry = JSON.parse(readFileSync(new URL('../../library/model-compatibility.json', import.meta.url), 'utf8'));
const shaPattern = /^[a-f0-9]{64}$/;
const clone = value => structuredClone(value);
function fail(message) {
  const error = new Error(message);
  error.code = 'comparison_lora_incompatible'; error.status = 422;
  throw error;
}
const ditKinds = new Set(['dit', 'diffusion_model', 'unet', 'base_model']);
function parameters(entry, input) {
  entry = entry?.source_identity ?? entry;
  const identity = entry?.model_identity;
  if (!identity || !identity.architecture_family || !Array.isArray(identity.base_models)) fail('LoRA 底座身份不足；请补充 identity 声明，不能通过裸文件绕过检查');
  const profile = input?.render?.profile ?? input;
  if (identity.architecture_family !== profile?.architecture_family) fail('LoRA 与测试输入的模型家族不一致');
  if (identity.adapted_components?.length !== 1 || identity.adapted_components[0] !== 'dit'
      || identity.target_audit?.component !== 'dit' || identity.target_audit?.tensor_count < 1) fail('LoRA 适配目标未知或包含非 DiT 参数，当前工作流仅支持纯 DiT LoRA');
  const models = identity.base_models.filter(model => ditKinds.has(model.kind));
  if (models.length !== 1 || !shaPattern.test(models[0].sha256 ?? '')) fail('LoRA 的 DiT 训练底座身份不足，需要唯一的精确 SHA-256 声明');
  const target = profile.models?.dit;
  if (!shaPattern.test(target?.sha256 ?? '') || !Number.isSafeInteger(target?.size_bytes)) fail('生成 DiT 缺少精确文件身份');
  if (!shaPattern.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.size_bytes)) fail('LoRA 缺少精确文件身份');
  return { entry, identity, source: models[0], target, family: profile.architecture_family };
}
function proof(entry, input, rules) {
  const { entry: lora, identity, source, target, family } = parameters(entry, input);
  let match;
  if (source.sha256 === target.sha256 && (source.size_bytes === null || source.size_bytes === target.size_bytes)) {
    match = { component: 'dit', method: 'exact', rule: null };
  } else {
    const rule = rules.find(rule => rule.architecture_family === family && rule.component === 'dit'
      && rule.source.sha256 === source.sha256 && (source.size_bytes === null || rule.source.size_bytes === source.size_bytes)
      && rule.target.sha256 === target.sha256 && rule.target.size_bytes === target.size_bytes);
    if (!rule) fail('LoRA 训练底座与生成 DiT 不匹配，且没有这两个精确身份的兼容声明');
    match = { component: 'dit', method: 'declared_conversion', rule: clone(rule) };
  }
  const value = { version: 1, lora: { sha256: lora.sha256, size_bytes: lora.size_bytes }, architecture_family: family,
    adapted_components: ['dit'], training_models: clone(identity.base_models),
    target_models: [{ component: 'dit', sha256: target.sha256, size_bytes: target.size_bytes }],
    declaration: clone(identity.declaration), target_audit: clone(identity.target_audit), matches: [match] };
  return { ...value, canonical_sha256: hashCanonicalJson(value) };
}
// 新建始终从受管表决定关系，调用方不能提供兼容规则。
export function checkComparisonLoraCompatibility(entry, input) { return proof(entry, input, registry.rules); }

// 历史只校验冻结证据的一致性；不因当前表增删而改变已冻结判断。
export function assertFrozenComparisonLoraCompatibility(evidence, entry, input) {
  if (evidence?.version !== 1 || !Array.isArray(evidence.matches) || evidence.matches.length !== 1) fail('LoRA 冻结兼容证据无效');
  const rules = evidence.matches.flatMap(match => match.method === 'declared_conversion' && match.rule ? [match.rule] : []);
  for (const rule of rules) if (!rule.id || !shaPattern.test(rule.source?.sha256 ?? '') || !shaPattern.test(rule.target?.sha256 ?? '')
    || !Number.isSafeInteger(rule.source?.size_bytes) || !Number.isSafeInteger(rule.target?.size_bytes)) fail('LoRA 冻结兼容规则身份无效');
  const expected = proof(entry, input, rules);
  if (hashCanonicalJson(evidence) !== hashCanonicalJson(expected)) fail('LoRA 冻结兼容证据与实际输入不一致');
  return clone(evidence);
}
