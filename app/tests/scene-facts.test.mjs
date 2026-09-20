import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import test from 'node:test';
import { confirmedSave } from './fact-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScene, readSceneFactDraft, commitSceneFact, deleteScene, deleteSceneVariant, renameSceneVariant, cleanupDeletedScenes, readScenes } from '../server/scene-facts.mjs';
import { resolveSceneConfiguration, validateScenePromptDocument } from '../server/scene-files.mjs';
import { readInheritanceSources, checkPageInheritance } from '../server/prompt-inheritance-facts.mjs';
import { hashCanonicalJson } from '../server/workflow-definition.mjs';
import { emptyCategories } from '../shared/prompt-inheritance.mjs';
const schema = name => `https://storyvisualizer.local/schemas/${name}.schema.json`;
async function fixture(t) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'sv-scene-facts-'));
 t.after(() => rm(root, {recursive:true,force:true}));
 const directory = path.join(root,'workspace','demo');
 const put = async (file, value) => { await mkdir(path.dirname(path.join(directory,file)),{recursive:true}); await writeFile(path.join(directory,file),JSON.stringify(value)); };
 const get = async file => JSON.parse(await readFile(path.join(directory,file),'utf8'));
 await put('project.json',{title:'测试'});
 registerFixtureProjects(root);
 await createScene(root,'demo','room',{name:'房间'});
 async function draft(kind) {
  const {definition:d} = await readSceneFactDraft(root,'demo','room',kind);
  return { document:structuredClone(d.editable??d.persisted),context:{project_id:'demo',...d.identity,target:{relative_path:d.targetRelative,sha256:hashCanonicalJson(d.persisted)},upstream:d.upstream} };
 }
 const save = (kind,d,options) => commitSceneFact(root,d.context,()=>d.document,kind,options);
 registerFixtureProjects(root); return {root,directory,put,get,draft,save};
}
test('场景子设定保存同步 Prompt，LoRA复用角色限制，来源正确展开',async t=>{
 const f=await fixture(t), v=await f.draft('visual');
 v.document.variants.push({id:'night',name:'夜晚'}); await f.save('visual',v);
 const p=await f.draft('prompt');
 p.document.identity.prompt.setting.push({description:'quiet room'});
 p.document.variants.night.prompt.setting.push({description:'moonlight'});
 p.document.identity.lora={filename:'room.safetensors',sha256:'a'.repeat(64),weight:0.8,trigger:'room concept'};
 p.document.variants.night.loras=[{filename:'night.safetensors',sha256:'b'.repeat(64),weight:0.6}];
 await assert.rejects(f.save('prompt',p),e=>e.code==='scene_prompt_lora_change_forbidden');
 await confirmedSave(confirmationSha256 => f.save('prompt',p,{allowLoraChanges:true,confirmationSha256}));
 const scene=(await readScenes(f.directory)).scenes[0];
 const config=resolveSceneConfiguration(scene,'night');
 assert.equal(config.loras.length,2); assert.equal(config.identity.lora.trigger,'room concept');
 const narrow=await f.draft('lora'); narrow.document.identity.weight=0.4; await f.save('lora',narrow);
 const saved=await f.get('scenes/room.prompt.json');
 assert.equal(saved.identity.lora.weight,0.4); assert.equal(saved.identity.prompt.setting[0].description,'quiet room');
 const [source]=await readInheritanceSources(f.directory,[],'room','night');
 assert.equal(source.id,'scene:room:night'); assert.equal(source.prompt.setting.length,2);
 p.document.identity.prompt.person.push({description:'standing'});
 assert.match(validateScenePromptDocument(p.document).join(' '),/仅使用场景和避免/);
});
test('场景基础变化传播所有归属的页面调整；确认前不写',async t=>{
 const f=await fixture(t), initial=await f.draft('prompt');
 initial.document.identity.prompt.setting.push({description:'steel wall'}); await confirmedSave(confirmationSha256 => f.save('prompt',initial,{confirmationSha256}));
 const page={ $schema:schema('story-page-prompt'), ...emptyCategories(),scene_id:'room',scene_variant_id:'default',inheritance:{'scene:room:default':{'steel wall':{weight:0.7}}} };
 await f.put('pages/index.json',{pages:[{page_id:'page-001',owner_kind:'character',character_id:'alice',variant_id:'coat'}]});
 await f.put('pages/page-001.content.json',{title:'验证图',characters:[]}); await f.put('pages/page-001.prompt.json',page);
 const d=await f.draft('prompt'); d.document.identity.prompt.setting[0].description='stone wall';
 let token; await assert.rejects(f.save('prompt',d),e=>{token=e.details[0].confirmation_sha256;return e.code==='inheritance_confirmation_required';});
 assert.equal((await f.get('pages/page-001.prompt.json')).inheritance['scene:room:default']['steel wall'].weight,0.7);
 await f.save('prompt',d,{confirmationSha256:token});
 assert.deepEqual((await f.get('pages/page-001.prompt.json')).inheritance['scene:room:default'],{'stone wall':{weight:0.7}});
});
test('删除场景保留引用及调整，页面仍能修复；归档按七天清理',async t=>{
 const f=await fixture(t);
 await f.put('pages/index.json',{pages:[{page_id:'page-001',owner_kind:'scene',scene_id:'room',variant_id:'default'}]});
 const page={...emptyCategories(),scene_id:'room',scene_variant_id:'default',inheritance:{'scene:room:default':{'missing wall':{weight:0.8}}}};
 await f.put('pages/page-001.prompt.json',page);
 const result=await deleteScene(f.root,'demo','room');
 assert.equal(result.downstream_diagnostics.length,2); assert.deepEqual(await f.get('pages/page-001.prompt.json'),page);
 assert.deepEqual((await readScenes(f.directory)).scenes,[]);
 const sources=await readInheritanceSources(f.directory,[],'room','default',{allowMissing:true});
 assert.equal(sources[0].missing,true); assert.deepEqual(checkPageInheritance(page,sources),[]);
 assert.equal((await cleanupDeletedScenes(f.root)).length,0);
 assert.equal((await cleanupDeletedScenes(f.root,{now:Date.now()+8*86400000})).length,1);
});
test('场景子设定重命名同时更新归属、实际引用及调整键，引用中禁止删除',async t=>{
 const f=await fixture(t),v=await f.draft('visual');v.document.variants.push({id:'night',name:'夜晚'});await f.save('visual',v);
 await f.put('pages/index.json',{pages:[{page_id:'page-002',owner_kind:'scene',scene_id:'room',variant_id:'night'},{page_id:'page-003',owner_kind:'story',sequence_id:'first'}]});
 await f.put('pages/page-002.prompt.json',emptyCategories());
 await f.put('pages/page-003.prompt.json',{...emptyCategories(),scene_id:'room',scene_variant_id:'night',inheritance:{'scene:room:night':{'dark':{weight:0.7}}}});
 await assert.rejects(deleteSceneVariant(f.root,'demo','room','night'),e=>e.code==='scene_variant_still_in_use');
 await renameSceneVariant(f.root,'demo','room','night','evening');
 assert.equal((await f.get('pages/index.json')).pages[0].variant_id,'evening');
 const p=await f.get('pages/page-003.prompt.json');assert.equal(p.scene_variant_id,'evening');assert.deepEqual(p.inheritance,{'scene:room:evening':{'dark':{weight:0.7}}});
});
test('删除提交失败恢复场景事实和索引，不动页面引用',async t=>{
 const f=await fixture(t),before=await f.get('scenes/room.prompt.json');
 await assert.rejects(deleteScene(f.root,'demo','room',{beforeCommit:()=>{throw new Error('测试提交失败');}}),/测试提交失败/);
 assert.deepEqual((await f.get('scenes/index.json')).scenes,['room']);assert.deepEqual(await f.get('scenes/room.prompt.json'),before);
 assert.equal((await readScenes(f.directory)).scenes[0].name,'房间');
});
