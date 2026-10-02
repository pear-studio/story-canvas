import {writeQwenFixtureJson, qwenDocument} from './helpers/qwen-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readPagePromptSources, readPagePromptDependencies, assertPagePromptSourceVersions,
  validatePagePromptInheritance, settingPromptSourceVersions, settingPromptRemovalDiagnostics } from '../server/prompt-source-context.mjs';
import { savePage } from '../server/page-facts.mjs';
import { readStoryPromptUpstream } from '../server/story-facts.mjs';
import { hashCanonicalJson } from '../server/workflow-definition.mjs';
import { registerFixtureProjects } from './project-registry-fixture.mjs';
import { readFile } from 'node:fs/promises';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const categories = rows => ({ population: [], person: rows, setting: [], camera: [], avoid: [] });
const base = 'token-000000000001', local = 'token-000000000002', gone = 'token-000000000003';
async function fixture(t) {
  const parent = path.join(repository, 'Saved/Tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'prompt-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (relative, value) => { const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true }); await writeQwenFixtureJson(target,value); };
  const visual = { variants: [{ id: 'default', name: '默认' }, { id: 'other', name: '其他' }] };
  const document = { models: {
    anima: { identity: { prompt: categories([{ id: base, tag: 'blue_jacket' }]), lora: null }, variants: {
      default: { prompt: categories([{ id: local, tag: 'hat' }]), loras: [], identity_overrides: {} },
      other: { prompt: categories([]), loras: [], identity_overrides: {} },
    } },
    qwen: { prompt_name: '角色', variants: { default: { text: '初始文字', reference_images: [] }, other: { text: '其他文字', reference_images: [] } } },
  } };
  await write('characters/index.json', { characters: ['hero'] }); await write('scenes/index.json', { scenes: [] });
  await write('characters/hero.visual.json', visual); await write('characters/hero.prompt.json', document);
  await write('pages/page-001.render.json', { version: 1, model_id: 'qwen', profile_id: 'qwen-image-2-1', canvas: '2:3' });
  const narrative = { characters: [{ character_id: 'hero', variant_id: 'default' }] };
  return { directory, write, visual, document, narrative, options: { projectId: 'test', modelId: 'anima', narrative, prompt: categories([]) } };
}

test('来源读据绑定指定模型和子设定，不受其他模型／子设定编辑影响', async t => {
  const f = await fixture(t), key = 'character:hero:default';
  const before = await readPagePromptSources(f.directory, f.options);
  const versions = settingPromptSourceVersions({ projectId: 'test', kind: 'character', id: 'hero', document: f.document, visual: f.visual });
  assert.equal(versions.anima.default, before[key].sha256);
  f.document.models.qwen.variants.default.text = '与 Anima 无关';
  f.document.models.anima.variants.other.prompt.person.push({ id: gone, tag: 'coat' });
  await f.write('characters/hero.prompt.json', f.document);
  const after = await readPagePromptSources(f.directory, f.options);
  assert.equal(before[key].sha256, after[key].sha256);
  const deps = await readPagePromptDependencies(f.directory, { ...f.options, pageId: 'page-001' });
  assert.equal(deps.model_id, 'anima'); assert.equal(deps.sources[key], before[key].sha256);
  f.document.models.anima.identity.prompt.person[0].tag = 'green_jacket';
  await f.write('characters/hero.prompt.json', f.document);
  assert.notEqual((await readPagePromptSources(f.directory, f.options))[key].sha256, before[key].sha256);
});

test('新引用和 standalone 转 settings 必须有读据，过期读据不允许保存', async t => {
  const f = await fixture(t), source = 'character:hero:default';
  const options = { ...f.options, baselineNarrative: { characters: [] }, baselinePrompt: categories([]) };
  await assert.rejects(assertPagePromptSourceVersions(f.directory, options), { code: 'prompt_source_read_required' });
  const versions = { [source]: (await readPagePromptSources(f.directory, f.options))[source].sha256 };
  await assertPagePromptSourceVersions(f.directory, { ...options, sourceVersions: versions });
  await assert.rejects(assertPagePromptSourceVersions(f.directory, { ...options, sourceVersions: { [source]: 'a'.repeat(64) } }), { code: 'prompt_source_conflict' });
  await assert.rejects(assertPagePromptSourceVersions(f.directory, { ...f.options, baselinePrompt: { composition: 'standalone' } }), { code: 'prompt_source_read_required' });
  await assert.rejects(assertPagePromptSourceVersions(f.directory, { ...f.options, baselinePrompt: categories([]), protectBaseline: false }), { code: 'prompt_source_read_required' });
});

test('页面逐词覆盖按稳定来源区分基础和子设定，并容许原有悬空项原样保留或删除', async t => {
  const f = await fixture(t), source = 'character:hero:default', missing = `identity:${gone}`;
  const baselinePrompt = { inheritance: { [source]: { [missing]: { enabled: false } } } };
  const prompt = { ...categories([]), inheritance: { [source]: { [missing]: { enabled: false }, [`identity:${base}`]: { enabled: false }, [`variant:${local}`]: { weight: 1.2 } } } };
  assert.deepEqual(await validatePagePromptInheritance(f.directory, { ...f.options, prompt, baselinePrompt }), []);
  prompt.inheritance[source][missing].enabled = true;
  assert.match((await validatePagePromptInheritance(f.directory, { ...f.options, prompt, baselinePrompt })).join(' '), /继承词不存在/);
  delete prompt.inheritance[source][missing];
  assert.deepEqual(await validatePagePromptInheritance(f.directory, { ...f.options, prompt, baselinePrompt }), []);
  prompt.inheritance[source][`identity:${local}`] = { enabled: false };
  assert.match((await validatePagePromptInheritance(f.directory, { ...f.options, prompt, baselinePrompt })).join(' '), /继承词不存在/);
});

test('删除共享词只返回下游失效覆盖统计，整个来源缺失仍拒绝保存', async t => {
  const f = await fixture(t), source = 'character:hero:default';
  const prompt = { ...categories([]), inheritance: { [source]: { [`identity:${base}`]: { enabled: false } } } };
  await f.write('pages/index.json', { pages: [{ page_id: 'page-001' }] });
  await f.write('pages/page-001.prompt.json', { models: { anima: prompt } });
  const next = structuredClone(f.document); next.models.anima.identity.prompt.person = [];
  const diagnostics = await settingPromptRemovalDiagnostics(f.directory, { kind: 'character', id: 'hero', before: f.document, after: next });
  assert.equal(diagnostics[0].affected_page_count, 1);
  await f.write('characters/index.json', { characters: [] });
  await assert.rejects(assertPagePromptSourceVersions(f.directory, { ...f.options, baselinePrompt: prompt }), { code: 'prompt_source_missing' });
});

test('整页新增引用缺失读据时不落盘任何内容，补齐读据后同次保存', async t => {
  const f = await fixture(t), root = f.directory, directory = path.join(root, 'workspace/test');
  const write = (relative, value) => f.write(`workspace/test/${relative}`, value);
  const schema = name => `https://storyvisualizer.local/schemas/${name}.schema.json`;
  const content = { $schema: schema('story-page-narrative'), title: '原题', scene_description: '', characters: [], dialogue: [] };
  const prompt = { $schema: schema('story-page-prompt'), text: '' };
  await write('project.json', { format: 'story-models-v1', title: '测试', canvas: '2:3', default_render_profile: 'qwen-image-2-1' });
  await write('pages/index.json', { $schema: schema('pages-index'), pages: [{ page_id: 'page-001', owner_kind: 'story', sequence_id: 'test' }] });
  await write('pages/page-001.content.json', content); await write('pages/page-001.prompt.json', prompt);
  await write('characters/index.json', { characters: ['hero'] }); await write('scenes/index.json', { scenes: [] });
  await write('characters/hero.visual.json', f.visual);
  await write('characters/hero.prompt.json', { $schema: schema('character-prompt'), ...f.document.models.qwen });
  registerFixtureProjects(root);
  const request = { page_key: { page_id: 'page-001' }, content: { ...content, title: '新题', characters: f.narrative.characters }, prompt,
    expected_content_sha256: hashCanonicalJson(content), expected_prompt_sha256: hashCanonicalJson(qwenDocument(prompt)),
    expected_context_sha256: hashCanonicalJson(await readStoryPromptUpstream(directory, 'page-001')) };
  await assert.rejects(savePage(root, 'test', request), { code: 'prompt_source_read_required' });
  assert.equal(JSON.parse(await readFile(path.join(directory, 'pages/page-001.content.json'), 'utf8')).title, '原题');
  const sources = await readPagePromptSources(directory, { projectId: 'test', modelId: 'qwen', narrative: request.content, prompt });
  request.source_versions = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.sha256]));
  const receipt = await savePage(root, 'test', request);
  assert.equal(receipt.content.title, '新题'); assert.deepEqual(receipt.content.characters, f.narrative.characters);
});
