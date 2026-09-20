import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePromptText } from '../shared/prompt-comparison.mjs';

test('实际文本比较忽略来源身份，区分换行、排序、权重与重复次数', () => {
  assert.equal(comparePromptText('wall', 'wall', [{text:'wall', origin:'page'}], [{text:'wall', origin:'scene'}]).kind, 'same');
  assert.equal(comparePromptText('hair,\nwall', 'hair, wall').kind, 'format');
  assert.equal(comparePromptText('hair, wall', 'wall, hair', [{text:'hair'},{text:'wall'}], [{text:'wall'},{text:'hair'}]).kind, 'order');
  assert.deepEqual(comparePromptText('(hair:1.2), wall, wall', 'hair, wall', [{text:'(hair:1.2)'},{text:'wall'},{text:'wall'}], [{text:'hair'},{text:'wall'}]), {kind:'content',removed:['(hair:1.2)','wall'],added:['hair']});
  assert.equal(comparePromptText('old free text', 'new free text').kind, 'content');
});
