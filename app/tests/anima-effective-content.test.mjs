import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyCategories } from '../shared/prompt-inheritance.mjs';
import { settingLoras } from '../shared/lora-inheritance.mjs';
import { compileCurrentPagePrompt, auditCharacterPromptConfiguration } from '../server/models/anima/current-page-prompt.mjs';
import { readResolvedRenderProfile } from '../server/render-profile-compiler.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { resolved_profile: baseProfile } = await readResolvedRenderProfile(root, 'anima-base-v1');
const a = 'token-111111111111', b = 'token-222222222222';
const prompt = (category, rows) => ({ ...emptyCategories(), [category]: rows });
const lora = (filename, trigger, weight = .7, sha = 'a') => ({ filename, trigger, weight, sha256: sha.repeat(64) });
const setting = (id, category = 'person') => ({
  id, name: id, configuration_id: 'default', loras: [],
  identity: { prompt: prompt(category, [{ id: a, description: `${id} base`, enabled: false }, { id: b, description: `${id} second`, weight: .8 }]) },
  prompt: prompt(category, [{ id: a, description: `${id} variant`, enabled: false }]),
});
function compile(pagePrompt, characters = [], scenes = [], profile = baseProfile, participantIds = characters.map(c => c.id)) {
  return compileCurrentPagePrompt({ pageId: 'page-001', pageKey: { page_id: 'page-001' },
    pagePrompt, characters, scenes, profile, participantIds, dictionaryEntries: [] });
}

test('有效词条共用覆盖结果，来源索引不随关闭项过滤改变，输入保持不变', () => {
  const character = setting('guest');
  character.identity_overrides = { [`identity:${a}`]: { enabled: true }, [`identity:${b}`]: { weight: 1.1 } };
  const page = { ...emptyCategories(), inheritance: { 'character:guest:default': {
    [`identity:${a}`]: { enabled: false }, [`identity:${b}`]: { weight: 1.4 }, [`variant:${a}`]: { enabled: true },
  } } };
  const before = structuredClone({ character, page });
  let result = compile(page, [character]);
  assert.deepEqual({ character, page }, before);
  assert.deepEqual(result.errors, []);
  const parts = result.prompt_parts.positive.filter(p => p.origin === 'character');
  assert.deepEqual(parts.map(p => [p.prompt_text, p.weight, p.path]), [
    ['guest second', 1.4, 'characters/guest.prompt.json.identity.prompt.person[1]'],
    ['guest variant', 1, 'characters/guest.prompt.json.variants.default.prompt.person[0]'],
  ]);
  delete page.inheritance['character:guest:default'][`identity:${b}`].weight;
  result = compile(page, [character]);
  assert.match(result.positive_prompt, /\(guest second:1.1\)/);
  page.person = [{ description: 'guest variant', character_id: 'guest' }];
  assert.match(compile(page, [character]).errors.join('\n'), /子设定/);
  page.inheritance['character:guest:default'][`variant:${a}`].enabled = false;
  assert.deepEqual(compile(page, [character]).errors, []);
  assert.equal(auditCharacterPromptConfiguration(character, []).valid, true);
});

test('编译保留原有同 scope 文本抑制顺序，并报告不同权重的被抑制项',()=>{
  const page=prompt('person',[{description:'standing',weight:1.1},{description:'standing',weight:1.8}]);
  const result=compile(page);
  assert.equal(result.prompt_parts.positive.filter(part=>part.prompt_text==='standing').length,1);
  const suppressed=result.prompt_parts.suppressed.find(part=>part.prompt_text==='standing');
  assert.equal(suppressed.weight,1.8);assert.equal(suppressed.retained.weight,1.1);
  assert.match(result.positive_prompt,/\(standing:1.1\)/);assert.doesNotMatch(result.positive_prompt,/standing:1.8/);
});

test('场景校重仍包含全部分类，编译仅取 setting/avoid，缺失分类仍被诊断', () => {
  const scene = setting('garden', 'setting');
  scene.prompt.camera = [{ id: b, description: 'wide framing' }];
  scene.prompt.avoid = [{ id: b, description: 'busy background' }];
  const page = prompt('camera', [{ description: 'wide framing' }]);
  let result = compile(page, [], [scene]);
  assert.match(result.errors.join('\n'), /重复词.*wide framing/);
  assert.ok(!result.prompt_parts.positive.some(p => p.origin === 'scene' && p.category === 'camera'));
  assert.ok(result.prompt_parts.negative.some(p => p.origin === 'scene' && p.prompt_text === 'busy background'));
  delete scene.prompt.setting;
  result = compile(emptyCategories(), [], [scene]);
  assert.deepEqual(result.missing, ['scenes/garden.prompt.json.variants.default.prompt.setting']);
  const character = setting('guest');
  delete character.identity;
  result = compile(emptyCategories(), [character]);
  assert.ok(result.missing.includes('characters/guest.prompt.json.identity.prompt'));
  assert.throws(() => auditCharacterPromptConfiguration(character, []), /角色 Prompt 不完整/);
  const incomplete = setting('guest');
  incomplete.prompt.person = [{ id: a, description: '' }];
  delete incomplete.prompt.setting;
  assert.deepEqual(compile(emptyCategories(), [incomplete]).missing, [
    'characters/guest.prompt.json.variants.default.prompt.person[0].prompt_text',
    'characters/guest.prompt.json.variants.default.prompt.setting',
  ]);
});

test('LoRA 执行归属与触发词位置分开保留，页面替换、旧来源与顺序保持一致', () => {
  const character = setting('guest'), scene = setting('garden', 'setting');
  character.loras = [lora('shared.safetensors', 'shared_trigger')];
  scene.loras = [lora('shared.safetensors', 'shared_trigger')];
  const profile = { ...baseProfile, style_loras: { z: lora('z.safetensors', 'z_trigger'), a: lora('a.safetensors', 'a_trigger') } };
  const page = { ...emptyCategories(), loras: [lora('shared.safetensors', 'shared_trigger', 1.2), lora('local.safetensors', 'legacy_trigger')],
    trigger_sources: { style: [], characters: { guest: ['legacy_trigger'] }, scenes: {} } };
  let result = compile(page, [character], [scene], profile);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.loras.map(item => [item.filename, item.kind, item.owner]), [
    ['a.safetensors', 'style', profile.id], ['z.safetensors', 'style', profile.id],
    ['shared.safetensors', 'page', 'page-001'], ['local.safetensors', 'page', 'page-001'],
  ]);
  const triggers = result.prompt_parts.positive.filter(p => p.origin === 'lora_trigger');
  assert.deepEqual(triggers.map(p => [p.prompt_text, p.origin_detail.kind, p.origin_id]), [
    ['a_trigger', 'style', profile.id], ['z_trigger', 'style', profile.id],
    ['shared_trigger', 'character', 'guest'], ['legacy_trigger', 'character', 'guest'],
  ]);
  page.loras[0].trigger = 'replacement_trigger';
  result = compile(page, [character], [scene], profile);
  assert.doesNotMatch(result.positive_prompt, /shared_trigger/);
  assert.ok(result.prompt_parts.positive.some(p => p.prompt_text === 'replacement_trigger' && p.origin_detail.kind === 'style'));
});

test('LoRA 冲突、禁用和恢复保留原语义，子设定关闭项可由页面重新开启', () => {
  const character = setting('guest'), scene = setting('garden', 'setting');
  const identity = { lora: lora('shared.safetensors', 'shared_trigger') };
  character.loras = settingLoras(identity, { lora_overrides: { 'shared.safetensors': { enabled: false } } });
  scene.loras = [lora('shared.safetensors', 'shared_trigger', 1.1)];
  const page = { ...emptyCategories(), lora_overrides: { 'shared.safetensors': { weight: .9, enabled: true } } };
  let result = compile(page, [character]);
  assert.equal(result.loras[0].weight, .9);
  assert.match(result.positive_prompt, /shared_trigger/);
  delete page.lora_overrides['shared.safetensors'].enabled;
  result = compile(page, [character]);
  assert.deepEqual(result.loras, []);
  assert.doesNotMatch(result.positive_prompt, /shared_trigger/);
  assert.deepEqual(compile(page, [character], [scene]).errors, [], '页面权重消除上游权重冲突');
  delete page.lora_overrides;
  assert.match(compile(page, [character], [scene]).errors.join('\n'), /继承 LoRA 配置冲突/);
  page.lora_overrides = { 'shared.safetensors': { enabled: false } };
  assert.deepEqual(compile(page, [character], [scene]).errors, []);
  page.lora_overrides = { 'shared.safetensors': { weight: .9 } };
  scene.loras[0].sha256 = 'b'.repeat(64);
  assert.match(compile(page, [character], [scene]).errors.join('\n'), /继承 LoRA 配置冲突/);
  page.loras = [lora('shared.safetensors', 'new_trigger')];
  assert.deepEqual(compile(page, [character], [scene]).errors, []);
  const extra = setting('extra'); extra.loras = [lora('extra.safetensors', 'extra_trigger')];
  assert.ok(!compile(page, [character, extra], [], baseProfile, ['guest']).loras.some(item => item.filename === 'extra.safetensors'));
});
