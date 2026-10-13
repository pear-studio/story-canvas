import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const server = fileURLToPath(new URL('../server/', import.meta.url));
async function imports(file) {
  return ts.preProcessFile(await readFile(file, 'utf8'), true, true).importedFiles.map(item => item.fileName);
}

test('公共文件操作只依赖 Node，事实提交与译文文档不反向依赖编辑入口', async () => {
  const storage = path.join(server, 'fact-storage.mjs');
  assert.ok((await imports(storage)).every(name => name.startsWith('node:')));
  const forbidden = new Set(['story-facts.mjs', 'scene-facts.mjs', 'page-facts.mjs', 'page-translations.mjs', 'setting-save.mjs', 'fact-drafts.mjs', 'project-workbench.mjs'].map(name => path.join(server, name)));
  for (const entry of ['fact-commit.mjs', 'page-translation-document.mjs']) {
    const seen = new Set();
    async function visit(file, route = []) {
      assert.ok(!forbidden.has(file), `反向依赖：${[...route, path.basename(file)].join(' → ')}`);
      if (seen.has(file)) return;
      seen.add(file);
      for (const target of await imports(file)) if (target.startsWith('.') && target.endsWith('.mjs')) {
        await visit(path.resolve(path.dirname(file), target), [...route, path.basename(file)]);
      }
    }
    await visit(path.join(server, entry));
  }
});
