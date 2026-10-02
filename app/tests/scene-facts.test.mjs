import {writeQwenFixtureJson, qwenDocument} from './helpers/qwen-fixture.mjs';
import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScene, readSceneFactDraft, commitSceneFact, deleteScene, deleteSceneVariant, renameSceneVariant, cleanupDeletedScenes, readScenes } from '../server/scene-facts.mjs';
import { resolveSceneConfiguration } from '../server/scene-files.mjs';
import { hashCanonicalJson } from '../server/workflow-definition.mjs';
const schema = name => `https://storyvisualizer.local/schemas/${name}.schema.json`;
const pagePrompt = (extra = {}) => ({ $schema: schema('story-page-prompt'), text: '', ...extra });
async function fixture(t) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'sv-scene-facts-'));
 t.after(() => rm(root, {recursive:true,force:true}));
 const directory = path.join(root,'workspace','demo');
 const put = async (file, value) => { await mkdir(path.dirname(path.join(directory,file)),{recursive:true}); await writeQwenFixtureJson(path.join(directory,file),value); };
 const get = async file => JSON.parse(await readFile(path.join(directory,file),'utf8'));
 await put('project.json',{format:'story-models-v1',title:'测试',canvas:'3:4',default_render_profile:'qwen-image-2-1'});
 registerFixtureProjects(root);
 await createScene(root,'demo','room',{name:'房间'});
 async function draft(kind) {
  const {definition:d} = await readSceneFactDraft(root,'demo','room',kind);
  return { document:structuredClone(d.editable??d.persisted),context:{project_id:'demo',...d.identity,target:{relative_path:d.targetRelative,sha256:hashCanonicalJson(d.persisted)},upstream:d.upstream} };
 }
 const save = (kind,d,options) => commitSceneFact(root,d.context,()=>d.document,kind,options);
 registerFixtureProjects(root); return {root,directory,put,get,draft,save};
}
test('场景子设定保存同步 Prompt 各造型自由文本，来源正确展开',async t=>{
 const f=await fixture(t), v=await f.draft('visual');
 v.document.variants.push({id:'night',name:'夜晚'}); await f.save('visual',v);
 const p=await f.draft('prompt');
 assert.equal(p.document.models.qwen.prompt_name,'房间');
 p.document.models.qwen.variants.default.text='安静的房间。';
 p.document.models.qwen.variants.night.text='月光下的房间。';
 await f.save('prompt',p);
 const scene=(await readScenes(f.directory)).scenes[0];
 const config=resolveSceneConfiguration(scene,'night','qwen');
 assert.equal(config.text,'月光下的房间。');
 assert.equal(config.prompt_name,'房间');
 assert.deepEqual(config.reference_images,[]);
 const saved=await f.get('scenes/room.prompt.json');
 assert.equal(saved.models.qwen.variants.default.text,'安静的房间。');
 assert.equal(saved.models.qwen.prompt_name,'房间');
 const day=resolveSceneConfiguration(scene,'default','qwen');
 assert.equal(day.text,'安静的房间。');
});
test('场景 Prompt 名称独立修改，不随显示名称同步',async t=>{
 const f=await fixture(t);
 const p=await f.draft('prompt');
 p.document.models.qwen.prompt_name='旧宅客厅';
 await f.save('prompt',p);
 const profile=await f.draft('profile');
 profile.document.name='新客厅';
 await f.save('profile',profile);
 const scene=(await readScenes(f.directory)).scenes[0];
 assert.equal(scene.prompt.models.qwen.prompt_name,'旧宅客厅');
});
test('删除场景保留页面引用，页面仍能修复；归档按七天清理',async t=>{
 const f=await fixture(t);
 await f.put('pages/index.json',{pages:[{page_id:'page-001',owner_kind:'scene',scene_id:'room',variant_id:'default'}]});
 const page=pagePrompt({scene_id:'room',scene_variant_id:'default',text_overrides:{'scene:room:default':'本页覆盖'}});
 await f.put('pages/page-001.prompt.json',page);
 const result=await deleteScene(f.root,'demo','room');
 assert.equal(result.downstream_diagnostics.length,2); assert.deepEqual(await f.get('pages/page-001.prompt.json'),qwenDocument(page));
 assert.deepEqual((await readScenes(f.directory)).scenes,[]);
 assert.equal((await cleanupDeletedScenes(f.root)).length,0);
 assert.equal((await cleanupDeletedScenes(f.root,{now:Date.now()+8*86400000})).length,1);
});
for (const [text, withReferences] of [['昏暗的覆盖', true], ['', true], ['', false]]) {
test(`场景子设定重命名同时更新归属、实际引用及覆盖键，引用中禁止删除：${JSON.stringify({ text, withReferences })}`,async t=>{
 const f=await fixture(t),v=await f.draft('visual');v.document.variants.push({id:'night',name:'夜晚'});await f.save('visual',v);
 await f.put('pages/index.json',{pages:[{page_id:'page-002',owner_kind:'scene',scene_id:'room',variant_id:'night'},{page_id:'page-003',owner_kind:'story',sequence_id:'first'}]});
 await f.put('pages/page-002.prompt.json',pagePrompt());
 await f.put('pages/page-003.prompt.json',pagePrompt({scene_id:'room',scene_variant_id:'night',text_overrides:{'scene:room:night':text},...(withReferences ? {reference_overrides:{'scene:room:night':[]}} : {})}));
 await assert.rejects(deleteSceneVariant(f.root,'demo','room','night'),e=>e.code==='scene_variant_still_in_use');
 await renameSceneVariant(f.root,'demo','room','night','evening');
 assert.equal((await f.get('pages/index.json')).pages[0].variant_id,'evening');
 const p=await f.get('pages/page-003.prompt.json');
 assert.equal(p.models.qwen.scene_variant_id,'evening');
 assert.deepEqual(p.models.qwen.text_overrides,{'scene:room:evening':text});
 assert.deepEqual(p.models.qwen.reference_overrides,withReferences ? {'scene:room:evening':[]} : undefined);
});
}
test('删除提交失败恢复场景事实和索引，不动页面引用',async t=>{
 const f=await fixture(t),before=await f.get('scenes/room.prompt.json');
 await assert.rejects(deleteScene(f.root,'demo','room',{beforeCommit:()=>{throw new Error('测试提交失败');}}),/测试提交失败/);
 assert.deepEqual((await f.get('scenes/index.json')).scenes,['room']);assert.deepEqual(await f.get('scenes/room.prompt.json'),before);
 assert.equal((await readScenes(f.directory)).scenes[0].name,'房间');
});
