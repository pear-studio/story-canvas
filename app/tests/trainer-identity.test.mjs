import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gitCommit, resolveTrainerCommit } from '../server/lora-training-plan.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const parent = fileURLToPath(new URL('../../Saved/Tests/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'trainer-identity-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(parent));
    await rm(root, { recursive: true, force: true });
  });
  const git = async (directory, ...args) => (await exec('git', ['-C', directory, ...args], { windowsHide: true })).stdout.trim();
  await git(root, 'init', '-b', 'main');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '--allow-empty', '-m', 'fixture');
  return { root, git, commit: await git(root, 'rev-parse', 'HEAD') };
}

test('仓库内的解压版训练器不继承父仓库提交，按内容指纹识别并拒绝篡改', async t => {
  const { root, git, commit } = await fixture(t);
  const trainer = path.join(root, 'trainer');
  await mkdir(trainer);
  const source = '# frozen trainer\n';
  await writeFile(path.join(trainer, 'train.py'), source);
  const manifest = { commit: 'c'.repeat(40), identity_files: [{ file: 'train.py', sha256: createHash('sha256').update(source).digest('hex') }] };
  assert.equal(await git(trainer, 'rev-parse', 'HEAD'), commit, '复现 Git 向上找到父仓库');
  assert.equal(await gitCommit(trainer), null);
  const resolved = await resolveTrainerCommit(trainer, manifest);
  assert.equal(resolved.matches, true);
  assert.equal(resolved.commit, manifest.commit);
  await writeFile(path.join(trainer, 'train.py'), '# modified');
  assert.equal((await resolveTrainerCommit(trainer, manifest)).matches, false);
});

test('训练器自身是仓库时使用它的提交，真实版本不符不能由文件指纹掩盖', async t => {
  const { root, commit } = await fixture(t);
  assert.equal(await gitCommit(root), commit);
  assert.equal((await resolveTrainerCommit(root, { commit })).matches, true);
  const wrong = commit === 'c'.repeat(40) ? 'd'.repeat(40) : 'c'.repeat(40);
  const result = await resolveTrainerCommit(root, { commit: wrong });
  assert.equal(result.matches, false);
  assert.equal(result.commit, commit);
});
