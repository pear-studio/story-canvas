import assert from 'node:assert/strict';
import test from 'node:test';
import { readPageRewriteProgress, trackPageRewrite } from '../server/page-rewrite-runtime.mjs';

test('rewrite status isolates pages and projects and prevents duplicate submission', async () => {
  const page = { page_id: 'page-001' };
  let finish;
  const pending = trackPageRewrite('root', 'project', page, async progress => {
    progress({ phase: 'generating', tokens: 120 });
    return new Promise(resolve => { finish = resolve; });
  });
  const status = readPageRewriteProgress('root', 'project', page);
  assert.equal(status.tokens, 120);
  assert.equal(status.phase, 'generating');
  status.tokens = 999;
  assert.equal(readPageRewriteProgress('root', 'project', page).tokens, 120);
  assert.equal(readPageRewriteProgress('root', 'other', page), null);
  assert.equal(readPageRewriteProgress('root', 'project', { page_id: 'page-002' }), null);
  await assert.rejects(trackPageRewrite('root', 'project', page, () => assert.fail('duplicate')), /page_rewrite_running/);
  finish('saved');
  assert.equal(await pending, 'saved');
  assert.equal(readPageRewriteProgress('root', 'project', page).phase, 'completed');
});

test('failed rewrite retains readable failure and allows an explicit retry', async () => {
  const page = { page_id: 'page-003' };
  await assert.rejects(trackPageRewrite('root', 'project', page, async () => {
    throw Object.assign(new Error('TIMEOUT'), { details: ['等待重写超过 15 分钟'] });
  }), /TIMEOUT/);
  assert.equal(readPageRewriteProgress('root', 'project', page).error, '等待重写超过 15 分钟');
  await trackPageRewrite('root', 'project', page, async () => 'new result');
  const status = readPageRewriteProgress('root', 'project', page);
  assert.equal(status.phase, 'completed');
  assert.equal(status.error, undefined);
});
