import assert from 'node:assert/strict';
import test from 'node:test';
import { checkComparisonLoraCompatibility, assertFrozenComparisonLoraCompatibility } from '../server/comparison-model-compatibility.mjs';
import { hashCanonicalJson } from '../server/workflow-definition.mjs';

const sourceSha = 'f96738d8116d78b7316b57c663d8c98591ddafab7488f48e3099b7655e34ab6f';
const targetSha = 'b4d1475bc7eeffd7b809e82ea13a1fba1fb85c4e18365af3813722faa5c0fe4f';
function fixture() {
  return {
    entry: { kind: 'raw', sha256: 'a'.repeat(64), size_bytes: 128, model_identity: {
      architecture_family: 'moss-image', adapted_components: ['dit'],
      base_models: [{ kind: 'dit', sha256: sourceSha, size_bytes: 10164655808 }, { kind: 'text_encoder', sha256: 'e'.repeat(64), size_bytes: 99 }],
      declaration: { source: 'metadata', status: 'declared' }, target_audit: { component: 'dit', tensor_count: 2, method: 'safetensors_tensor_names_v1' },
    } },
    input: { render: { profile: { architecture_family: 'moss-image', models: { dit: { sha256: targetSha, size_bytes: 5413698958 } } } } },
  };
}
test('精确 SFT BF16 → INT8 单向关系，保留训练来源和非适配 TE 身份', () => {
  const { entry, input } = fixture();
  const evidence = checkComparisonLoraCompatibility(entry, input);
  assert.equal(evidence.matches[0].rule.id, 'moss-sft-bf16-to-int8-convrot-v1');
  assert.equal(evidence.training_models[0].sha256, sourceSha);
  assert.equal(evidence.training_models[1].kind, 'text_encoder');
  assert.deepEqual(assertFrozenComparisonLoraCompatibility(evidence, entry, input), evidence);
  assert.deepEqual(checkComparisonLoraCompatibility({ ...entry, kind: 'resource' }, input), evidence);
  assert.deepEqual(checkComparisonLoraCompatibility({ source_identity: entry }, input), evidence);
});
test('精确相同 SHA 通过，未知身份、反向关系、Base、跨家族及未知目标拒绝', () => {
  const { entry, input } = fixture();
  const exact = structuredClone(input);
  exact.render.profile.models.dit = { sha256: sourceSha, size_bytes: 10164655808 };
  assert.equal(checkComparisonLoraCompatibility(entry, exact).matches[0].method, 'exact');
  for (const sha of ['b'.repeat(64), 'cacd158728a1fb9e57c408a922b54752ec71fceb566b3821269927964e62b41f']) {
    const unknown = structuredClone(input); unknown.render.profile.models.dit.sha256 = sha;
    assert.throws(() => checkComparisonLoraCompatibility(entry, unknown), /精确身份/);
  }
  const reverse = structuredClone(entry); reverse.model_identity.base_models[0] = { kind: 'dit', sha256: targetSha, size_bytes: 5413698958 };
  assert.throws(() => checkComparisonLoraCompatibility(reverse, exact), /精确身份/);
  const family = structuredClone(input); family.render.profile.architecture_family = 'anima';
  assert.throws(() => checkComparisonLoraCompatibility(entry, family), /家族/);
  assert.throws(() => checkComparisonLoraCompatibility({ kind: 'raw' }, input), /身份不足/);
  const target = structuredClone(entry); target.model_identity.target_audit.component = 'unknown';
  assert.throws(() => checkComparisonLoraCompatibility(target, input), /适配目标/);
  const missing = structuredClone(entry); missing.model_identity.base_models[0].sha256 = null;
  assert.throws(() => checkComparisonLoraCompatibility(missing, input), /底座身份不足/);
});
test('冻结证据只依赖冻结规则，源文件和目标文件身份变化仍拒绝', () => {
  const { entry, input } = fixture();
  const evidence = checkComparisonLoraCompatibility(entry, input);
  const archived = structuredClone(evidence);
  // 用冻结规则复核，不要求 rule ID 还存在于当前注册表。
  archived.matches[0].rule.id = 'historical-reviewed-rule';
  assert.throws(() => assertFrozenComparisonLoraCompatibility(archived, entry, input), /证据/);
  const { canonical_sha256: _hash, ...archivedBody } = archived;
  archived.canonical_sha256 = hashCanonicalJson(archivedBody);
  assert.deepEqual(assertFrozenComparisonLoraCompatibility(archived, entry, input), archived);
  const different = structuredClone(entry); different.sha256 = 'f'.repeat(64);
  assert.throws(() => assertFrozenComparisonLoraCompatibility(evidence, different, input), /证据/);
  const changedSize = structuredClone(input); changedSize.render.profile.models.dit.size_bytes += 1;
  assert.throws(() => assertFrozenComparisonLoraCompatibility(evidence, entry, changedSize), /兼容声明/);
});
