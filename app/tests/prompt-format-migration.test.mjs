import assert from 'node:assert/strict';
import test from 'node:test';
import {migrateAnimaSettingPrompt, migrateAnimaPagePrompt, planPromptFormatMigration} from '../server/prompt-format-migration.mjs';

const empty = () => ({population:[], person:[], setting:[], camera:[], avoid:[]});

test('旧文字覆盖精确展开为不同层稳定引用，并保留 disabled 后 overrides 的优先级', () => {
  const setting = {
    identity:{prompt:{...empty(), person:[{id:'token-111111111111', tag:'blue_jacket'}], avoid:[{id:'token-222222222222', tag:'blue_jacket'}]}},
    variants:{default:{identity_disabled:['blue_jacket'], identity_overrides:{'blue jacket':{enabled:true,weight:1.2}}, prompt:{...empty(),person:[{id:'token-333333333333',tag:'blue_jacket'}]}}},
  };
  const converted = migrateAnimaSettingPrompt(setting);
  assert.equal(Object.hasOwn(converted.variants.default, 'identity_disabled'), false);
  assert.deepEqual(converted.variants.default.identity_overrides, {
    'identity:token-111111111111':{enabled:true,weight:1.2},
    'identity:token-222222222222':{enabled:false},
  });
  const page = {...empty(), inheritance:{'character:lead:default':{'blue jacket':{enabled:false}, 'negative:blue jacket':{weight:0.8}, missing:{enabled:false}}}};
  const migrated = migrateAnimaPagePrompt(page, new Map([['character:lead',setting]]));
  assert.deepEqual(migrated.prompt.inheritance['character:lead:default'], {
    'identity:token-111111111111':{enabled:false},
    'variant:token-333333333333':{enabled:false},
    'identity:token-222222222222':{weight:0.8},
  });
  assert.deepEqual(migrated.removed,[{source:'character:lead:default',old_key:'missing',adjustment:{enabled:false}}]);
  assert.deepEqual(setting.variants.default.identity_disabled,['blue_jacket']);
});

test('迁移仅删除本页行 ID，保留 Qwen、共享身份、LoRA、引用及本页顺序', () => {
  const qwen = {text:'A quiet room.',reference_images:[]};
  const anima = {...empty(),person:[{id:'token-111111111111',tag:'smile',character_id:'lead',enabled:false,weight:1.2},{id:'token-222222222222',tag:'standing'}],loras:[{id:'lora-example',weight:0.8}]};
  const document = {$schema:'example',models:{qwen,anima}};
  const plan = planPromptFormatMigration([{relative:'pages/page-one.prompt.json',document,sha256:'baseline'}]);
  assert.deepEqual(plan.changes[0].after.models.qwen,qwen);
  assert.deepEqual(plan.changes[0].after.models.anima.person,[{tag:'smile',character_id:'lead',enabled:false,weight:1.2},{tag:'standing'}]);
  assert.deepEqual(plan.changes[0].after.models.anima.loras,anima.loras);
  assert.equal(document.models.anima.person[0].id,'token-111111111111');
});
