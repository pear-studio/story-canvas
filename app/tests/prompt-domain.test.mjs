import test from 'node:test';
import assert from 'node:assert/strict';
import {promptSourceView,promptPageDiagnostics} from '../shared/prompt-source-view.mjs';
import {cleanPageCharacterInput} from '../shared/page-character-cleanup.mjs';
import {applyPersonGroups} from '../server/prompt-person-edit.mjs';
import {emptyCategories} from '../shared/prompt-inheritance.mjs';

const key='identity:token-111111111111';
const source={kind:'character',id:'alice',variant_id:'default',identity:{prompt:{...emptyCategories(),person:[{id:'token-111111111111',tag:'blue_eyes',enabled:false}]}},variant:{prompt:emptyCategories(),identity_overrides:{[key]:{enabled:true,weight:1.2}}}};
test('领域投影保留关闭项与权重层次，场景启用和消费不同，基础编辑不误带子设定覆盖',()=>{
  const name='character:alice:default';
  const view=promptSourceView(name,source,{inheritance:{[name]:{[key]:{enabled:false,weight:1.5}}}});
  assert.deepEqual(view.entries.map(e=>[e.key,e.enabled,e.consumed,e.weight]),[[key,false,false,1.5]]);
  const base=promptSourceView(name,source,{}, {baseOnly:true});
  assert.equal(base.entries[0].enabled,false);assert.equal(base.entries[0].weight,1);
  const scene=promptSourceView('scene:room:default',{...source,kind:'scene'},{});
  assert.equal(scene.entries[0].enabled,true);assert.equal(scene.entries[0].consumed,false);
});
test('Qwen 可用图片与显式空选择分开，默认只选首张，空文本覆盖不回退',()=>{
  const value={kind:'character',id:'alice',variant:{text:'base',reference_images:[{id:'a'},{id:'b'}]}};
  const name='character:alice:default';
  assert.deepEqual(promptSourceView(name,value).selected_image_ids,['a']);
  const view=promptSourceView(name,value,{text_overrides:{[name]:''},reference_overrides:{[name]:[]}});
  assert.equal(view.text,'');assert.deepEqual(view.selected_image_ids,[]);assert.equal(view.reference_images.length,2);
});
test('诊断不合并不同角色，相同权重与否有证据，未绑定匹配只是提示',()=>{
  const name='character:alice:default';const view=promptSourceView(name,source);
  const prompt={person:[{tag:'blue_eyes',character_id:'bob'},{tag:'blue_eyes',character_id:'alice',weight:2},{tag:'blue_eyes'}]};
  const result=promptPageDiagnostics(prompt,[{character_id:'alice'},{character_id:'bob'}],[view],'anima');
  const repeat=result.filter(issue=>issue.code==='same_owner_repeated_text');assert.equal(repeat.length,1);
  assert.deepEqual(repeat[0].weights,[1.2,2]);assert.equal(repeat[0].same_weight,false);
  assert.equal(result.filter(issue=>issue.code==='unbound_matches_inherited').length,1);
});
test('按角色替换保留交错槽位及他组顺序，增加/清空/未绑定与参数错误',()=>{
  const refs=[{character_id:'alice'},{character_id:'bob'}];
  const original=[{tag:'a',character_id:'alice'},{tag:'b',character_id:'bob'},{tag:'c',character_id:'alice'},{tag:'free'}];
  const result=applyPersonGroups(original,[{character_id:'alice',entries:[{tag:'x'},{tag:'y'},{tag:'z'}]}],refs);
  assert.deepEqual(result.map(row=>row.tag),['x','b','y','z','free']);
  assert.deepEqual(applyPersonGroups(result,[{character_id:'alice',entries:[]}],refs).map(row=>row.tag),['b','free']);
  assert.deepEqual(applyPersonGroups(original,[{character_id:null,entries:[{tag:'shared'}]}],refs).at(-1),{tag:'shared'});
  assert.deepEqual(original.map(row=>row.tag),['a','b','c','free']);
  assert.throws(()=>applyPersonGroups(original,[{character_id:'none',entries:[]}],refs),{code:'invalid_person_groups'});
  assert.throws(()=>applyPersonGroups(original,[{character_id:'alice',entries:[{tag:'x',character_id:'bob'}]}],refs),{code:'invalid_person_groups'});
});
test('解除引用保留共享/显式/风格 LoRA 覆盖，只删确定悬空的覆盖与触发词位置',()=>{
  const refs=[{character_id:'alice',variant_id:'default'},{character_id:'bob',variant_id:'default'}];
  const loras=['only','shared','explicit','style'].map(filename=>({filename}));
  const input={person:[{tag:'a',character_id:'alice'},{tag:'b',character_id:'bob'},{tag:'free'}],loras:[{filename:'explicit'}],lora_overrides:Object.fromEntries(loras.map(l=>[l.filename,{weight:.5}])),trigger_sources:{characters:{alice:['x'],bob:['y']}},inheritance:{'character:alice:default':{[key]:{enabled:false}}}};
  const a={identity:{},variant:{loras}},b={identity:{},variant:{loras:[{filename:'shared'}]}};
  const scope={beforeSources:{'character:alice:default':a,'character:bob:default':b},afterSources:{'character:bob:default':b},styleLoras:[{filename:'style'}]};
  const next=cleanPageCharacterInput(input,refs,refs.slice(1),scope);
  assert.deepEqual(Object.keys(next.lora_overrides),['shared','explicit','style']);
  assert.deepEqual(next.person.map(row=>row.tag),['b','free']);assert.deepEqual(next.trigger_sources.characters,{bob:['y']});
  assert.deepEqual(next.inheritance,{});assert.ok(input.lora_overrides.only);
  assert.ok(cleanPageCharacterInput(input,refs,refs.slice(1),{...scope,styleLoras:undefined}).lora_overrides.only);
  const variant=cleanPageCharacterInput(input,refs,[{character_id:'alice',variant_id:'other'},refs[1]]);
  assert.equal(variant.person.length,3);assert.equal(variant.trigger_sources.characters.alice,undefined);assert.deepEqual(variant.inheritance,{});
});
