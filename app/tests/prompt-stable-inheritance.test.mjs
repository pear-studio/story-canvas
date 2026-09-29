import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { adjustmentKey, applyInheritedPrompt, emptyCategories, inheritedOverrideCount, variantPrompt, validateAdjustments } from '../shared/prompt-inheritance.mjs';
import { preparePromptForPersistence, prepareSharedPromptForPersistence, validateStoryPagePromptDocument, STORY_PAGE_PROMPT_SCHEMA_ID } from '../server/models/anima/story-files.mjs';
import { prepareCharacterPromptForPersistence, validateCharacterPromptDocument, CHARACTER_PROMPT_SCHEMA_ID } from '../server/models/anima/character-files.mjs';
import { compileCurrentPagePrompt } from '../server/models/anima/current-page-prompt.mjs';
import { readResolvedRenderProfile } from '../server/render-profile-compiler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const a = 'token-111111111111', b = 'token-222222222222';
const prompt = (rows = []) => ({ ...emptyCategories(), person: rows });
const document = (rows = []) => ({ $schema: CHARACTER_PROMPT_SCHEMA_ID, identity: { prompt: prompt(rows), lora: null }, variants: { default: { prompt: prompt(), loras: [] } } });

test('共享词改字后保留继承定位，逐字段覆盖支持重新开启和恢复', () => {
  const identity = { prompt: prompt([{ id: a, description: 'blue jacket', weight: .7, enabled: false }]) };
  const variant = { prompt: prompt(), identity_overrides: { [`identity:${a}`]: { enabled: true, weight: .7 } } };
  identity.prompt.person[0].description = 'navy jacket';
  const inherited = variantPrompt(identity, variant);
  assert.equal(adjustmentKey(inherited.person[0]), `identity:${a}`);
  assert.equal(inherited.person[0].description, 'navy jacket');
  assert.equal(inherited.person[0].enabled, true);
  assert.deepEqual(inheritedOverrideCount(identity.prompt, variant.identity_overrides), { overridden: 1, total: 1 });
  const page = { [`identity:${a}`]: { enabled: false, weight: 1.3 } };
  delete page[`identity:${a}`].weight;
  const restoredWeight = applyInheritedPrompt(inherited, page).person[0];
  assert.equal(restoredWeight.weight, .7);
  assert.equal(restoredWeight.enabled, false);
  assert.deepEqual(variant.identity_overrides, { [`identity:${a}`]: { enabled: true, weight: .7 } });
});

test('相同 ID 位于基础和子设定时仍是不同来源，关闭行不提前消失', () => {
  const inherited = variantPrompt({ prompt: prompt([{ id: a, description: 'base row', enabled: false }]) }, {
    prompt: prompt([{ id: a, description: 'variant row', enabled: false }]),
  });
  const result = applyInheritedPrompt(inherited, { [`variant:${a}`]: { enabled: true } });
  assert.equal(result.person.length, 2);
  assert.equal(result.person[0].enabled, false);
  assert.equal(result.person[1].enabled, true);
  assert.deepEqual(result.person.map(adjustmentKey), [`identity:${a}`, `variant:${a}`]);
});

test('本页保存无 ID，共享 ID 由所属层基线核验并为新增条目分配', () => {
  const page = { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, ...prompt([{ description: 'quiet visitor' }]) };
  assert.deepEqual(preparePromptForPersistence(page), page);
  assert.deepEqual(validateStoryPagePromptDocument(page), []);
  const stale = structuredClone(page); stale.person[0].id = a;
  assert.throws(() => preparePromptForPersistence(stale), /本页词条不保存 id/);
  assert.ok(validateStoryPagePromptDocument(stale).some(message => message.includes('未知字段：id')));
  const baseline = prompt([{ id: a, description: 'old text' }]);
  const shared = prepareSharedPromptForPersistence(prompt([{ id: a, description: 'new text' }, { description: 'new row' }]), {
    baselinePrompt: baseline, createFragmentId: () => b,
  });
  assert.deepEqual(shared.person.map(row => row.id), [a, b]);
  assert.throws(() => prepareSharedPromptForPersistence(shared, { baselinePrompt: prompt(), createFragmentId: () => b }), /已有片段保留/);
  assert.throws(() => prepareSharedPromptForPersistence(prompt([{ id: a, description: 'copy' }, { id: a, description: 'copy 2' }]), { baselinePrompt: baseline }), /id 重复/);
});

test('旧文本键和 identity_disabled 被拒绝，已有悬空覆盖可原样保留或删除', () => {
  const baseline = document([{ id: a, description: 'blue jacket' }]);
  baseline.variants.default.identity_overrides = { [`identity:${a}`]: { enabled: false, weight: 1 } };
  const after = structuredClone(baseline); after.identity.prompt.person = [];
  assert.deepEqual(validateCharacterPromptDocument(after), [], '正常读取不被已有悬空覆盖阻塞');
  assert.deepEqual(prepareCharacterPromptForPersistence(after, { baselinePrompt: baseline }), after);
  const changed = structuredClone(after); changed.variants.default.identity_overrides[`identity:${a}`].enabled = true;
  assert.throws(() => prepareCharacterPromptForPersistence(changed, { baselinePrompt: baseline }), /继承词不存在/);
  delete after.variants.default.identity_overrides[`identity:${a}`];
  assert.deepEqual(prepareCharacterPromptForPersistence(after, { baselinePrompt: baseline }), after);
  const old = document(); old.variants.default.identity_disabled = [];
  assert.ok(validateCharacterPromptDocument(old).some(message => message.includes('identity_disabled')));
  assert.ok(validateAdjustments({ 'blue jacket': { enabled: false } }).length);
  assert.ok(validateAdjustments({ [`variant:${a}`]: { enabled: false } }, '基础覆盖', { layers: ['identity'] }).length);
  assert.deepEqual(validateAdjustments({ [`identity:${a}`]: { weight: 1 } }, '页面覆盖', {
    availableKeys: [], baselineAdjustments: { [`identity:${a}`]: { weight: 1 } },
  }), []);
});

test('编译按共享稳定来源调整，基础改字不改变页面关闭意图', async () => {
  const { resolved_profile: profile } = await readResolvedRenderProfile(root, 'anima-base-v1');
  const character = {
    id: 'guest', name: '访客', configuration_id: 'default', loras: [],
    identity: { prompt: prompt([{ id: a, description: 'navy jacket' }]) },
    prompt: prompt([{ id: a, description: 'polite visitor', enabled: false }]),
  };
  const page = { ...prompt([{ description: 'standing calmly', character_id: 'guest' }]), inheritance: {
    'character:guest:default': { [`identity:${a}`]: { enabled: false }, [`variant:${a}`]: { enabled: true, weight: 1.2 } },
  } };
  const result = compileCurrentPagePrompt({ pageId: 'page-001', pageKey: { page_id: 'page-001' }, pagePrompt: page, profile, characters: [character], participantIds: ['guest'], dictionaryEntries: [] });
  assert.doesNotMatch(result.positive_prompt, /navy jacket/);
  assert.match(result.positive_prompt, /\(polite visitor:1.2\)/);
  assert.match(result.positive_prompt, /standing calmly/);
  assert.deepEqual(result.errors, []);
});

test('三个公开 Schema 与本页无 ID、共享 ID 及稳定覆盖键一致', async () => {
  for (const name of ['story-page-prompt', 'character-prompt', 'scene-prompt']) {
    const definition = JSON.parse(await readFile(path.join(root, 'library/schemas', `${name}.schema.json`), 'utf8'));
    const ajv = new Ajv({ strict: false }); ajv.addSchema(definition);
    const validate = ajv.compile({ $ref: definition.$id + '#/$defs/anima' });
    if (name === 'story-page-prompt') {
      const value = prompt([{ description: 'quiet garden' }]);
      value.inheritance = { 'character:guest:default': { [`identity:${a}`]: { enabled: false } } };
      assert.equal(validate(value), true);
      value.person[0].id = a;
      assert.equal(validate(value), false);
      delete value.person[0].id;
      value.inheritance['character:guest:default'] = { 'quiet garden': { enabled: false } };
      assert.equal(validate(value), false);
    } else {
      const { $schema, ...value } = document([{ id: a, description: 'quiet visitor' }]);
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
      delete value.identity.prompt.person[0].id;
      assert.equal(validate(value), false);
      value.identity.prompt.person[0].id = a;
      value.variants.default.identity_disabled = [];
      assert.equal(validate(value), false);
    }
  }
});
