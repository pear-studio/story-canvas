import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { factFixture, confirmedSave } from './fact-fixture.mjs';
import { emptyCategories, applyInheritedPrompt, variantPrompt, duplicatePromptWords } from '../shared/prompt-inheritance.mjs';
import { readInheritanceSources, checkPageInheritance } from '../server/prompt-inheritance-facts.mjs';

const schema = name => `https://storyvisualizer.local/schemas/${name}.schema.json`;
const character = factFixture('character', 'prompt'), scene = factFixture('scene', 'prompt'), page = factFixture('story', 'prompt');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sv-inheritance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'workspace', 'demo');
  const put = async (relative, value) => { const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value)); };
  const get = async relative => JSON.parse(await readFile(path.join(directory, relative), 'utf8'));
  await put('project.json', { title: '继承测试' });
  await put('characters/index.json', { $schema: schema('character-index'), characters: ['alice'] });
  await put('characters/alice.profile.json', { $schema: schema('character-profile'), name: 'Alice', description: '测试角色' });
  await put('characters/alice.visual.json', { $schema: schema('character-visual'), variants: [{ id: 'coat', name: '外套' }, { id: 'shirt', name: '衬衫' }] });
  await put('characters/alice.prompt.json', { $schema: schema('character-prompt'), identity: { lora: null, prompt: { ...emptyCategories(), person: [{ id: 'token-111111111111', description: 'red hair' }] } }, variants: {
    coat: { prompt: emptyCategories(), loras: [], identity_disabled: [], identity_overrides: { 'red hair': { weight: 1.2, enabled: false } } },
    shirt: { prompt: emptyCategories(), loras: [], identity_disabled: [] },
  } });
  await put('characters/pages/index.json', { $schema: schema('character-pages-index'), pages: [] });
  await put('story/outline.json', { $schema: schema('story-outline'), synopsis: '测试', chapters: [{ id: 'one', title: '第一章', summary: '测试', sequences: [{ id: 'first', title: '情节', summary: '测试' }] }] });
  await put('pages/index.json', { $schema: schema('pages-index'), pages: [{page_id:'page-001',owner_kind:'story',sequence_id:'first'}] });
  await put('pages/page-001.content.json', { $schema: schema('story-page-narrative'), title: '第一张', scene_description: 'Alice 站立', characters: [{ character_id: 'alice', variant_id: 'coat' }], dialogue: [] });
  await put('pages/page-001.prompt.json', { $schema: schema('story-page-prompt'), ...emptyCategories(), inheritance: { 'character:alice:coat': { 'red hair': { weight: 0.8, enabled: true } } } });
  registerFixtureProjects(root); return { root, directory, put, get };
}

test('改正文同步关闭与权重记录；确认前不写，改权重/开关统一重置，删除清理记录', async t => {
  const f = await fixture(t);
  const initial = await f.get('characters/alice.prompt.json');
  const draft = await character.read(f.root, 'demo', 'alice');
  draft.document.identity.prompt.person[0].description = 'blue hair';
  let confirmation;
  await assert.rejects(character.save(f.root, draft), error => {
    assert.equal(error.code, 'inheritance_confirmation_required');
    assert.match(error.details[0].changes.join('\n'), /第一张.*red hair.*blue hair/);
    confirmation = error.details[0].confirmation_sha256;
    return true;
  });
  assert.deepEqual(await f.get('characters/alice.prompt.json'), initial);
  await character.save(f.root, draft, { confirmationSha256: confirmation });
  assert.deepEqual((await f.get('characters/alice.prompt.json')).variants.coat.identity_overrides, { 'blue hair': { weight: 1.2, enabled: false } });
  assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance['character:alice:coat'], { 'blue hair': { weight: 0.8, enabled: true } });

  const weights = await character.read(f.root, 'demo', 'alice');
  Object.assign(weights.document.identity.prompt.person[0], { weight: 1.2, enabled: false });
  await character.saveConfirmed(f.root, weights);
  const updated = await f.get('characters/alice.prompt.json');
  const local = await f.get('pages/page-001.prompt.json');
  assert.equal(updated.variants.coat.identity_overrides, undefined);
  assert.equal(local.inheritance['character:alice:coat'], undefined);
  const effective = applyInheritedPrompt(variantPrompt(updated.identity, updated.variants.coat), local.inheritance['character:alice:coat']);
  assert.equal(effective.person[0].weight, 1.2);
  assert.equal(effective.person[0].enabled, false);

  const removed = await character.read(f.root, 'demo', 'alice');
  removed.document.identity.prompt.person = [];
  await character.saveConfirmed(f.root, removed);
  assert.deepEqual((await f.get('characters/alice.prompt.json')).identity.prompt.person, []);
  assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance, {});
});

test('下游在确认期间被修改时重新汇报，旧确认不能覆盖新调整', async t => {
  const f = await fixture(t);
  const draft = await character.read(f.root, 'demo', 'alice');
  draft.document.identity.prompt.person[0].weight = 2;
  let token;
  await assert.rejects(character.save(f.root, draft), error => { token = error.details[0].confirmation_sha256; return error.code === 'inheritance_confirmation_required'; });
  const downstream = await page.read(f.root, 'demo', 'page-001');
  downstream.document.inheritance['character:alice:coat']['red hair'].weight = 0.6;
  await page.save(f.root, downstream);
  await assert.rejects(character.save(f.root, draft, { confirmationSha256: token }), error => error.code === 'inheritance_confirmation_required' && error.details[0].confirmation_sha256 !== token);
  assert.equal((await f.get('pages/page-001.prompt.json')).inheritance['character:alice:coat']['red hair'].weight, 0.6);
  assert.equal((await f.get('characters/alice.prompt.json')).identity.prompt.person[0].weight, undefined);
});

test('场景完整设定引用后改词需确认，删除保留引用及调整', async t => {
  const f = await fixture(t);
  const {createScene, deleteScene} = await import('../server/scene-facts.mjs');
  await createScene(f.root,'demo','room',{name:'房间'});
  const draft = await scene.read(f.root, 'demo','room');
  draft.document.identity.prompt.setting.push({description:'steel wall'});
  await scene.saveConfirmed(f.root, draft);
  const downstream = await page.read(f.root, 'demo', 'page-001');
  downstream.document.scene_id = 'room'; downstream.document.scene_variant_id='default';
  downstream.document.inheritance['scene:room:default'] = { 'steel wall': { weight: 0.7 } };
  await page.save(f.root, downstream);
  const changed = await scene.read(f.root, 'demo','room');
  changed.document.identity.prompt.setting[0].description = 'stone wall';
  await scene.saveConfirmed(f.root, changed);
  assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance['scene:room:default'], { 'stone wall': { weight: 0.7 } });
  const sources = await readInheritanceSources(f.directory, [{ character_id: 'alice', variant_id: 'coat' }], 'room','default');
  const duplicate = await f.get('pages/page-001.prompt.json'); duplicate.setting.push({ description: 'Stone_wall' });
  assert.match(checkPageInheritance(duplicate, sources).join(' '), /重复词.*Stone_wall.*场景.*本页/);
  await deleteScene(f.root,'demo','room');
  const saved = await f.get('pages/page-001.prompt.json');
  assert.equal(saved.scene_id,'room'); assert.deepEqual(saved.inheritance['scene:room:default'],{'stone wall':{weight:0.7}});
});

test('切换子设定只清除对应角色调整；不同角色同词不冲突', async t => {
  const f = await fixture(t);
  const narrative = factFixture('story', 'narrative');
  const draft = await narrative.read(f.root, 'demo', 'page-001');
  draft.document.characters[0].variant_id = 'shirt';
  await confirmedSave(confirmationSha256 => narrative.save(f.root, draft, { confirmationSha256 }));
  assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance, {});
  assert.equal((await f.get('pages/page-001.content.json')).characters[0].variant_id, 'shirt');
  const prompt = { ...emptyCategories(), person: [{ description: 'blue eyes' }] };
  assert.deepEqual(duplicatePromptWords([{ prompt, scope: 'alice', label: 'Alice' }, { prompt, scope: 'bob', label: 'Bob' }]), []);
  assert.match(duplicatePromptWords([{ prompt, scope: 'alice', label: '基础' }, { prompt, scope: 'alice', label: '本页' }]).join('\n'), /重复词.*基础.*本页/);
});


test('场景词参与最终编译，应用页面权重、开关和重复拦截', async () => {
 const { compileCurrentPagePrompt } = await import('../server/current-page-prompt.mjs');
 const prompt = { ...emptyCategories(), scene_id: 'room', scene_variant_id:'default', inheritance: { 'scene:room:default': { 'stone wall': { weight: 0.7 }, 'dark room': { enabled: false } } } };
 const scenes = [{ id: 'room', name: '房间', configuration_id:'default', identity:{prompt:emptyCategories(),lora:null}, loras:[], prompt: { ...emptyCategories(), setting: [{ description: 'stone wall' }, { description: 'dark room' }], avoid: [{ description: 'clutter' }] } }];
 const args = { pageId: 'page-001', pageKey: { page_id: 'page-001' }, pagePrompt: prompt, scenes, profile: { id: 'example', style_loras: {}, prompt: { family: 'anima', category_order: ['subject',"person",'setting','camera'], avoidance_strategy: 'negative_prompt', fragments: {} } } };
 const compiled = compileCurrentPagePrompt(args);
 assert.equal(compiled.positive_prompt, '(stone wall:0.7)');
 assert.equal(compiled.negative_prompt, 'clutter');
 assert.equal(compiled.prompt_parts.positive[0].origin, 'scene');
 assert.equal(compiled.ready, true);
 prompt.person.push({ description: 'standing still' });
 prompt.setting.push({ description: 'window light' });
 prompt.camera.push({ description: 'wide shot' });
 const ordered = compileCurrentPagePrompt(args);
 assert.equal(ordered.positive_prompt, 'standing still,\n(stone wall:0.7), window light,\nwide shot');
 assert.equal(ordered.negative_prompt, 'clutter');
 const opposite = { ...emptyCategories(), setting: [{ description: 'same word' }], avoid: [{ description: 'same word' }] };
 const adjusted = applyInheritedPrompt(opposite, { 'same word': {weight: 0.5}, 'negative:same word': {enabled: false} });
 assert.equal(adjusted.setting[0].weight, 0.5);
 assert.equal(adjusted.setting[0].enabled, undefined);
 assert.equal(adjusted.avoid[0].weight, undefined);
 assert.equal(adjusted.avoid[0].enabled, false);
 prompt.setting.push({ description: 'Stone_wall' });
 const conflict = compileCurrentPagePrompt(args);
 assert.equal(conflict.ready, false);
 assert.match(conflict.errors.join(' '), /重复词/);
});

test('子设定 ID 改名更新引用与调整，移动验证图归属保留画面引用', async t => {
 const f = await fixture(t);
 const { renameCharacterVariant } = await import('../server/character-facts.mjs');
 const { createCharacterPage, deleteCharacterPage } = await import('../server/character-page-facts.mjs');
 const { mutateFixture } = await import('./fact-fixture.mjs');
 await mutateFixture(f.root, 'demo', () => renameCharacterVariant(f.root, 'demo', 'alice', 'coat', 'jacket'));
 const story = await f.get('pages/page-001.prompt.json');
 assert.deepEqual(story.inheritance['character:alice:jacket'], { 'red hair': { weight: 0.8, enabled: true } });
 assert.equal(story.inheritance['character:alice:coat'], undefined);
 const created = await mutateFixture(f.root, 'demo', () => createCharacterPage(f.root, 'demo', 'alice', 'jacket', { templateId: null }));
 const goal = await f.get('pages/' + created.page_id + '.content.json');
 assert.equal(goal.title, '验证图');
 const charPage = factFixture('character', 'page-prompt');
 const draft = await charPage.read(f.root, 'demo', created.page_id);
 draft.document.inheritance = { 'character:alice:jacket': { 'red hair': { weight: 0.9 } } };
 await charPage.save(f.root, draft);
 const indexFacts = factFixture('character', 'page-index');
 const index = await indexFacts.read(f.root, 'demo');
 index.document.pages[0].variant_id = 'shirt';
 await indexFacts.save(f.root, index);
 assert.deepEqual((await f.get('pages/' + created.page_id + '.prompt.json')).inheritance, {'character:alice:jacket':{'red hair':{weight:0.9}}});
 assert.deepEqual((await f.get('pages/' + created.page_id + '.content.json')).characters,[{character_id:'alice',variant_id:'jacket'}]);
 await mutateFixture(f.root, 'demo', () => deleteCharacterPage(f.root, 'demo', created.page_id));
 const second = await mutateFixture(f.root, 'demo', () => createCharacterPage(f.root, 'demo', 'alice', 'shirt', { templateId: null }));
 assert.notEqual(second.page_id,created.page_id);
});


test('删除关闭词只清理记录；下游独立开启的页面才进入影响清单', async t => {
 const f = await fixture(t);
 const initial = await f.get('characters/alice.prompt.json');
 initial.identity.prompt.person[0].enabled = false;
 await f.put('characters/alice.prompt.json', initial);
 const draft = await character.read(f.root, 'demo', 'alice');
 draft.document.identity.prompt.person = [];
 await assert.rejects(character.save(f.root, draft), error => {
   assert.equal(error.code, 'inheritance_confirmation_required');
   const changes = error.details[0].changes;
   assert.equal(changes.length, 1);
   assert.match(changes[0], /第一张.*red hair.*开启/);
   return true;
 });
 const local = await page.read(f.root, 'demo', 'page-001');
 local.document.inheritance['character:alice:coat']['red hair'].enabled = false;
 await page.save(f.root, local);
 await character.save(f.root, draft);
 assert.equal((await f.get('characters/alice.prompt.json')).variants.coat.identity_overrides, undefined);
 assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance, {});
});

test('关闭词改权重或正文不提示，重新开启仍报告实际变化', async t => {
 const f = await fixture(t);
 const initial = await f.get('characters/alice.prompt.json');
 initial.identity.prompt.person[0].enabled = false;
 await f.put('characters/alice.prompt.json', initial);
 const local = await f.get('pages/page-001.prompt.json');
 local.inheritance['character:alice:coat']['red hair'].enabled = false;
 await f.put('pages/page-001.prompt.json',local);
 const changed = await character.read(f.root, 'demo', 'alice');
 Object.assign(changed.document.identity.prompt.person[0], {description:'blue hair',weight:2});
 await character.save(f.root, changed);
 assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance['character:alice:coat'], {'blue hair':{enabled:false}});
 const enabled = await character.read(f.root, 'demo', 'alice');
 enabled.document.identity.prompt.person[0].enabled = true;
 await assert.rejects(character.save(f.root, enabled), e => e.code === 'inheritance_confirmation_required' && e.details[0].changes.some(line=>line.includes('第一张')));
});


test('切换到相同有效词的子设定不提示，仍清除旧来源调整', async t => {
 const f=await fixture(t);
 const local=await f.get('pages/page-001.prompt.json');
 local.inheritance['character:alice:coat']['red hair']={weight:1,enabled:true};
 await f.put('pages/page-001.prompt.json',local);
 const narrative=factFixture('story','narrative');
 const draft=await narrative.read(f.root,'demo','page-001');
 draft.document.characters[0].variant_id='shirt';
 await narrative.save(f.root,draft);
 assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance,{});
});


test('继承检查与编译只检查生效词，关闭可重写、重新开启仍拦截真实重复', async () => {
 const { compileCurrentPagePrompt } = await import('../server/current-page-prompt.mjs');
 const identity = { prompt: { ...emptyCategories(), person: [{ description: 'silver hair' }] } };
 const character = { id: 'alice', name: 'Alice', configuration_id: 'coat', identity, identity_overrides: { 'silver hair': { enabled: false } }, prompt: emptyCategories(), loras: [] };
 const pagePrompt = { ...emptyCategories(), person: [{ description: 'silver hair', character_id: 'alice' }], camera: [{ description: 'close-up', enabled: false }, { description: 'close-up' }], scene_id: 'room', scene_variant_id:'default', setting: [{ description: 'quiet room' }], inheritance: { 'scene:room:default': { 'quiet room': { enabled: false } } } };
 const scenes = [{ id: 'room', name: '房间', configuration_id:'default', identity:{prompt:emptyCategories(),lora:null}, loras:[], prompt: { ...emptyCategories(), setting: [{ description: 'quiet room' }] } }];
 const { variantPrompt } = await import('../shared/prompt-inheritance.mjs');
 const sources = () => [{ id: 'character:alice:coat', scope: 'alice', label: 'Alice', prompt: variantPrompt(identity, character) }, { id: 'scene:room:default', scope: 'environment', label: '房间', prompt: scenes[0].prompt }];
 const args = { pageId: 'page-001', pageKey: { page_id: 'page-001' }, pagePrompt, characters: [character], participantIds: ['alice'], scenes, profile: { id: 'example', style_loras: {}, prompt: { family: 'anima', category_order: ['subject','person','setting','camera'], avoidance_strategy: 'negative_prompt', fragments: {} } } };
 assert.deepEqual(checkPageInheritance(pagePrompt, sources()), []);
 const compiled = compileCurrentPagePrompt(args);
 assert.equal(compiled.ready, true);
 assert.equal(compiled.positive_prompt, 'silver hair,\nquiet room,\nclose-up');
 pagePrompt.inheritance['character:alice:coat'] = { 'silver hair': { enabled: true, weight: 0.8 } };
 assert.match(checkPageInheritance(pagePrompt, sources()).join(' '), /重复词.*silver hair/);
 assert.equal(compileCurrentPagePrompt(args).ready, false);
 pagePrompt.person = [];
 const reopened = compileCurrentPagePrompt(args);
 assert.deepEqual(checkPageInheritance(pagePrompt, sources()), []);
 assert.equal(reopened.ready, true);
 assert.equal(reopened.positive_prompt, '(silver hair:0.8),\nquiet room,\nclose-up');
});
