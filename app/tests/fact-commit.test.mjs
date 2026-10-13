import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { commitFactChanges } from '../server/fact-commit.mjs';
import { TRANSLATIONS_SCHEMA } from '../server/page-translation-document.mjs';
import { FactError, readJson, readOptionalFact } from '../server/fact-storage.mjs';
import { assertTargetBaseline } from '../server/edit-fingerprint.mjs';
import { hashCanonicalJson } from '../server/workflow-definition.mjs';

async function fixture(t) {
  const parent = fileURLToPath(new URL('../../Saved/Tests/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'fact-commit-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(parent));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const write = async (relative, value) => {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(value));
  };
  const read = async relative => JSON.parse(await fs.readFile(path.join(directory, relative), 'utf8'));
  return { directory, write, read };
}

const content = { dialogue: [{ id: 'line-a', text: '甲', mode: 'speech' }, { id: 'line-b', text: '乙', mode: 'speech' }] };
const editedContent = { dialogue: content.dialogue.slice(0, 1) };
const translations = { $schema: TRANSLATIONS_SCHEMA, en: { dialogue: {
  'line-a': { text: 'A', source_sha256: 'a'.repeat(64) },
  'line-b': { text: 'B', source_sha256: 'b'.repeat(64) },
} } };
const prompt = value => ({ models: { qwen: value } });

test('追加译文写入失败，正文、已写译文和其他事实一起恢复，新建文件与临时文件撤回', async t => {
  const f = await fixture(t), writes = [];
  await f.write('project.json', { title: '原项目' });
  writes.push({ relative: 'project.json', before: { title: '原项目' }, after: { title: '新项目' } });
  writes.push({ relative: 'new.json', before: null, after: { created: true } });
  for (const id of ['page-001', 'page-002']) {
    await f.write(`pages/${id}.content.json`, content);
    await f.write(`pages/${id}.translations.json`, translations);
    writes.push({ relative: `pages/${id}.content.json`, before: content, after: editedContent });
  }
  const rename = fs.rename, failure = Object.assign(new Error('模拟译文替换失败'), { code: 'EIO' });
  let injected = false;
  fs.rename = async (source, target) => {
    if (target === path.join(f.directory, 'pages/page-002.translations.json') && !injected) {
      injected = true;
      assert.deepEqual(Object.keys((await f.read('pages/page-001.translations.json')).en.dialogue), ['line-a']);
      throw failure;
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(commitFactChanges(f.directory, writes), error => error === failure); }
  finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.deepEqual(await f.read('project.json'), { title: '原项目' });
  await assert.rejects(fs.access(path.join(f.directory, 'new.json')), { code: 'ENOENT' });
  for (const id of ['page-001', 'page-002']) {
    assert.deepEqual(await f.read(`pages/${id}.content.json`), content);
    assert.deepEqual(await f.read(`pages/${id}.translations.json`), translations);
  }
  assert.equal((await fs.readdir(f.directory, { recursive: true })).some(file => file.endsWith('.tmp')), false);
});

test('关闭参考图清理仍裁剪被删除原文的译文', async t => {
  const f = await fixture(t);
  await f.write('pages/page-001.content.json', content);
  await f.write('pages/page-001.translations.json', translations);
  const result = await commitFactChanges(f.directory, [{ relative: 'pages/page-001.content.json', before: content, after: editedContent }], { cleanupReferences: false });
  assert.deepEqual(result, { warnings: [] });
  assert.deepEqual((await f.read('pages/page-001.translations.json')).en.dialogue, { 'line-a': translations.en.dialogue['line-a'] });
});

test('同批显式译文优先于自动裁剪，不被派生文档覆盖', async t => {
  const f = await fixture(t);
  await f.write('pages/page-001.content.json', content);
  await f.write('pages/page-001.translations.json', translations);
  const explicit = { $schema: TRANSLATIONS_SCHEMA, en: { dialogue: { 'line-a': { text: '新的译文', source_sha256: 'c'.repeat(64) } } } };
  await commitFactChanges(f.directory, [
    { relative: 'pages/page-001.content.json', before: content, after: editedContent },
    { relative: 'pages/page-001.translations.json', before: translations, after: explicit },
  ]);
  assert.deepEqual(await f.read('pages/page-001.translations.json'), explicit);
});

test('仍被页面引用的设定附图在写入前拒绝删除', async t => {
  const f = await fixture(t);
  const before = prompt({ variants: { default: { reference_images: [{ id: 'old', file: 'reference-aaaa.png' }] } } });
  const after = prompt({ variants: { default: { reference_images: [] } } });
  await f.write('characters/alice.prompt.json', before);
  await f.write('pages/page-001.prompt.json', prompt({ reference_overrides: { 'character:alice:default': ['old'] } }));
  const writes = [
    { relative: 'new.json', before: null, after: { created: true } },
    { relative: 'characters/alice.prompt.json', before, after },
  ];
  await assert.rejects(commitFactChanges(f.directory, writes), { code: 'reference_image_in_use' });
  await assert.rejects(fs.access(path.join(f.directory, 'new.json')), { code: 'ENOENT' });
  assert.deepEqual(await f.read('characters/alice.prompt.json'), before);
  await commitFactChanges(f.directory, writes, { cleanupReferences: false });
  assert.deepEqual(await f.read('characters/alice.prompt.json'), after);
});

test('事实提交后清理旧素材失败只返回警告，不回滚已保存的 Prompt', async t => {
  const f = await fixture(t);
  const before = prompt({ text: '原内容', reference_images: [{ id: 'old', file: 'reference-aaaa.png' }] });
  const after = prompt({ text: '新内容', reference_images: [] });
  await f.write('pages/page-001.prompt.json', before);
  await fs.writeFile(path.join(f.directory, 'pages/broken.prompt.json'), '{invalid');
  const warn = t.mock.method(console, 'warn', () => {});
  const result = await commitFactChanges(f.directory, [{ relative: 'pages/page-001.prompt.json', before, after }]);
  assert.deepEqual(await f.read('pages/page-001.prompt.json'), after);
  assert.deepEqual(result.warnings, [{ code: 'reference_cleanup_failed', file: 'pages/page-001.prompt.json' }]);
  assert.equal(warn.mock.callCount(), 1);
});

test('可选读取保持原始解析错误，严格读取及目标冲突保持既有错误语义', async t => {
  const f = await fixture(t), fallback = { entries: [] };
  const missing = await readOptionalFact(f.directory, 'missing.json', fallback);
  assert.deepEqual(missing, fallback);
  assert.notEqual(missing, fallback);
  await fs.writeFile(path.join(f.directory, 'invalid.json'), '{invalid');
  await assert.rejects(readOptionalFact(f.directory, 'invalid.json'), SyntaxError);
  await assert.rejects(readJson(path.join(f.directory, 'invalid.json'), 'invalid'), error => error instanceof FactError && error.code === 'invalid_story_edit_json');
  const context = { target: { relative_path: 'target.json', sha256: hashCanonicalJson({ value: 1 }) } };
  await f.write('target.json', { value: 1 });
  assert.deepEqual(await assertTargetBaseline(f.directory, context), { value: 1 });
  await f.write('target.json', { value: 2 });
  await assert.rejects(assertTargetBaseline(f.directory, context), { code: 'story_edit_target_conflict', refresh_required: true });
  await fs.unlink(path.join(f.directory, 'target.json'));
  await assert.rejects(assertTargetBaseline(f.directory, context), { code: 'story_edit_target_conflict', refresh_required: true });
});
