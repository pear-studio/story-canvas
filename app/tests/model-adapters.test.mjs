import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { modelAdapter, profileModelAdapter } from '../server/model-adapters.mjs';
import { readResolvedRenderProfile } from '../server/render-profile-compiler.mjs';
import { pageSettingsFromDefaults, readPageRenderSettings, readPageRenderDraft, commitPageRender } from '../server/page-render-settings.mjs';
import { createPage, duplicatePage, savePage } from '../server/page-facts.mjs';
import { renameSceneVariant, deleteSceneVariant, sceneReferences } from '../server/scene-facts.mjs';
import { readStoryPromptUpstream } from '../server/story-facts.mjs';
import { registerFixtureProjects } from './project-registry-fixture.mjs';
import { makeModelPromptDocument, validateModelPromptDocument } from '../server/model-prompts.mjs';
import { hashCanonicalJson as hash } from '../server/workflow-definition.mjs';
import {planModelMigration,commitModelMigration} from '../server/model-migration.mjs';
import {compilePageRenderInspectionContext} from '../server/page-render-resolver.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;
async function fixture(t, modelId='anima') {
  const base=path.join(root,'Saved/Tests');await mkdir(base,{recursive:true});
  const testRoot=await mkdtemp(path.join(base,'models-'));t.after(()=>rm(testRoot,{recursive:true,force:true}));
  const directory=path.join(testRoot,'workspace','demo');
  const put=async(file,value)=>{const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));};
  const get=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'));
  for(const folder of ['render-profiles','render-recipes','workflows','prompt-policies','visual-page-templates'])await cp(path.join(root,'library',folder),path.join(testRoot,'library',folder),{recursive:true});
  await put('project.json',{format:'story-models-v1',title:'测试',canvas:'2:3',default_render_profile:modelId==='anima'?'anima-base-v1':'qwen-image-2-1'});
  await put('story/outline.json',{$schema:schema('story-outline'),synopsis:'测试',chapters:[{id:'main',title:'章',summary:'测试',sequences:[{id:'one',title:'节',summary:'测试'}]}]});
  await put('pages/index.json',{$schema:schema('pages-index'),pages:[]});
  await put('characters/index.json',{$schema:schema('character-index'),characters:[]});
  await put('scenes/index.json',{$schema:schema('scene-index'),scenes:[]});
  registerFixtureProjects(testRoot);
  const create=()=>createPage(testRoot,'demo',{owner_kind:'story',sequence_id:'one'});
  const switchModel=async(pageId,model)=>{const {definition:d}=await readPageRenderDraft(testRoot,'demo',pageId);return commitPageRender(testRoot,{project_id:'demo',page_id:pageId,target:{sha256:hash(d.persisted)},upstream:d.upstream},()=>({...d.persisted,model_id:model,profile_id:model==='anima'?'anima-base-v1':'qwen-image-2-1'}));};
  return {root:testRoot,directory,put,get,create,switchModel};
}
test('已注册 Anima Basic 资源完整可解析，编译保留分类、权重与负向',async()=>{
  const {resolved_profile:profile}=await readResolvedRenderProfile(root,'anima-base-v1');
  const adapter=profileModelAdapter(profile);
  const prompt=adapter.emptyPrompt();prompt.setting.push({description:'quiet garden',weight:1.2});prompt.avoid.push({description:'blur'});
  const compiled=adapter.compilePrompt({pageId:'page-001',pageKey:{page_id:'page-001'},pagePrompt:prompt,profile,participantIds:[],dictionaryEntries:[]});
  assert.equal(adapter.id,'anima');assert.match(compiled.positive_prompt,/\(quiet garden:1.2\)/);
  assert.match(compiled.negative_prompt,/blur/);assert.equal(compiled.errors.length,0);
});
test('Qwen 全文输入不重复追加全局与设定，原组合输入仍保留拼接',async()=>{
  const {resolved_profile:profile}=await readResolvedRenderProfile(root,'qwen-image-2-1');profile.prompt.text='GLOBAL';
  const input={pageId:'page-001',pageKey:{page_id:'page-001'},profile,characters:[],participantIds:['missing'],pagePrompt:{text:'complete imported prompt',composition:'standalone'}};
  const full=modelAdapter('qwen').compilePrompt(input);assert.equal(full.positive_prompt,'complete imported prompt');assert.deepEqual(full.errors,[]);
  const composed=modelAdapter('qwen').compilePrompt({...input,participantIds:[],pagePrompt:{text:'local',composition:'settings'}});
  assert.match(composed.positive_prompt,/GLOBAL/);assert.match(composed.positive_prompt,/本页描述：\nlocal/);
  assert.throws(()=>modelAdapter('__proto__'),/未知生成模型/);
});
test('新页设置是创建时副本，读取实际页配置，新格式缺失不继承默认',async t=>{
  const testRoot=path.join(root,'Saved/Tests');await mkdir(testRoot,{recursive:true});
  const dir=await mkdtemp(path.join(testRoot,'page-render-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'pages'));
  const project={format:'story-models-v1',canvas:'2:3',default_render_profile:'anima-base-v1'};
  const first=pageSettingsFromDefaults(project,'anima');project.canvas='4:3';project.default_render_profile='qwen-image-2-1';
  await writeFile(path.join(dir,'pages/page-001.render.json'),JSON.stringify(first));
  assert.deepEqual(await readPageRenderSettings(dir,'page-001',project),{version:1,model_id:'anima',profile_id:'anima-base-v1',canvas:'2:3'});
  await assert.rejects(readPageRenderSettings(dir,'page-002',project),e=>e.code==='page_render_settings_missing');
});
test('切模型只首次带入全文，往返、复制和整页保存保留另一份 Prompt',async t=>{
  const f=await fixture(t),{page_id:id}=await f.create();
  const original=await f.get(`pages/${id}.prompt.json`);original.models.anima.person=[{id:'token-123456abcdef',description:'a person in garden'}];
  await f.put(`pages/${id}.prompt.json`,original);
  await f.switchModel(id,'qwen');
  const imported=await f.get(`pages/${id}.prompt.json`);assert.equal(imported.models.qwen.composition,'standalone');assert.match(imported.models.qwen.text,/a person in garden/);
  imported.models.qwen.text='own qwen text';await f.put(`pages/${id}.prompt.json`,imported);
  await f.switchModel(id,'anima');await f.switchModel(id,'qwen');assert.equal((await f.get(`pages/${id}.prompt.json`)).models.qwen.text,'own qwen text');
  const copy=await duplicatePage(f.root,'demo',id);assert.deepEqual(await f.get(`pages/${copy.page_id}.prompt.json`),imported);
  await f.switchModel(id,'anima');
  const content=await f.get(`pages/${id}.content.json`),prompt=await f.get(`pages/${id}.prompt.json`);
  await savePage(f.root,'demo',{page_key:{page_id:id},content,prompt:prompt.models.anima,expected_content_sha256:hash(content),expected_prompt_sha256:hash(prompt),expected_context_sha256:hash(await readStoryPromptUpstream(f.directory,id))});
  assert.equal((await f.get(`pages/${id}.prompt.json`)).models.qwen.text,'own qwen text');
});
test('来源缺失时首次 Qwen 导入原子失败，过期切换不能覆盖 Prompt',async t=>{
  const f=await fixture(t),{page_id:id}=await f.create();
  const content=await f.get(`pages/${id}.content.json`);content.characters=[{character_id:'missing',variant_id:'default'}];await f.put(`pages/${id}.content.json`,content);
  const before=await f.get(`pages/${id}.prompt.json`);
  await assert.rejects(f.switchModel(id,'qwen'),e=>e.code==='anima_prompt_unavailable');
  assert.deepEqual(await f.get(`pages/${id}.prompt.json`),before);assert.equal((await f.get(`pages/${id}.render.json`)).model_id,'anima');
  const {definition:d}=await readPageRenderDraft(f.root,'demo',id);before.models.anima.person.push({description:'new'});await f.put(`pages/${id}.prompt.json`,before);
  await assert.rejects(commitPageRender(f.root,{project_id:'demo',page_id:id,target:{sha256:hash(d.persisted)},upstream:d.upstream},()=>({...d.persisted,canvas:'4:3'})),e=>e.code==='page_render_input_conflict');
});
test('两种模型创建模板页均保留模板文字，默认变化不改已有页',async t=>{
  for(const modelId of ['anima','qwen']){
    const f=await fixture(t,modelId);const catalog=JSON.parse(await readFile(path.join(f.root,'library/visual-page-templates/catalog.json'),'utf8'));
    const template=catalog.templates.find(value=>value.applies_to.includes('character'));
    await f.put('characters/index.json',{$schema:schema('character-index'),characters:['person']});
    await f.put('characters/person.visual.json',{$schema:schema('character-visual'),variants:[{id:'default',name:'默认'}]});
    const page=await createPage(f.root,'demo',{owner_kind:'character',character_id:'person',variant_id:'default'},{templateId:template.id});
    const input=(await f.get(`pages/${page.page_id}.prompt.json`)).models[modelId];assert.ok(JSON.stringify(input).includes(template.page.visual.text));
    const project=await f.get('project.json');project.canvas='4:3';await f.put('project.json',project);
    const next=await f.create();assert.equal((await f.get(`pages/${next.page_id}.render.json`)).canvas,'4:3');assert.equal((await f.get(`pages/${page.page_id}.render.json`)).canvas,'2:3');
  }
});
test('容器拒绝错误 schema 与触发词结构',()=>{
  const doc=makeModelPromptDocument(schema('story-page-prompt'),'anima',modelAdapter('anima').emptyPrompt());assert.deepEqual(validateModelPromptDocument(doc,'page'),[]);
  assert.ok(validateModelPromptDocument({...doc,$schema:'bad'},'page').length);
  doc.models.anima.trigger_sources={style:[],characters:[],scenes:{}};assert.ok(validateModelPromptDocument(doc,'page').length);
});
test('场景改名修复非当前模型的引用和逐词覆盖，删除检查所有模型',async t=>{
  const f=await fixture(t),{page_id:id}=await f.create();
  await f.put('scenes/index.json',{$schema:schema('scene-index'),scenes:['room']});
  await f.put('scenes/room.visual.json',{$schema:schema('scene-visual'),variants:[{id:'day',name:'白天'},{id:'night',name:'夜晚'}]});
  const native={identity:{prompt:modelAdapter('anima').emptyPrompt(),lora:null},variants:Object.fromEntries(['day','night'].map(id=>[id,{prompt:modelAdapter('anima').emptyPrompt(),loras:[],identity_disabled:[]}]))};
  await f.put('scenes/room.prompt.json',makeModelPromptDocument(schema('scene-prompt'),'anima',native));
  const doc=await f.get(`pages/${id}.prompt.json`);doc.models.anima={...doc.models.anima,scene_id:'room',scene_variant_id:'day',inheritance:{'scene:room:day':{}}};doc.models.qwen={text:'standalone',composition:'standalone'};
  await f.put(`pages/${id}.prompt.json`,doc);await f.switchModel(id,'qwen');
  assert.equal((await sceneReferences(f.directory,'room')).length,1);
  await assert.rejects(deleteSceneVariant(f.root,'demo','room','day'),e=>e.code==='scene_variant_still_in_use');
  await renameSceneVariant(f.root,'demo','room','day','morning');
  const input=(await f.get(`pages/${id}.prompt.json`)).models.anima;assert.equal(input.scene_variant_id,'morning');assert.deepEqual(input.inheritance,{'scene:room:morning':{}});
});
test('旧 Anima 一次迁移逐页保留 Prompt、LoRA 顺序、触发词并备份原始事实',async t=>{
  const f=await fixture(t),{page_id:id}=await f.create();
  const project=await f.get('project.json');delete project.format;await f.put('project.json',project);
  await f.put('characters/index.json',{$schema:schema('character-index'),characters:['person']});
  const character={identity:{prompt:modelAdapter('anima').emptyPrompt(),lora:{filename:'identity.safetensors',sha256:'a'.repeat(64),weight:.7,trigger:'my_character'}},variants:{default:{prompt:modelAdapter('anima').emptyPrompt(),loras:[{filename:'outfit.safetensors',sha256:'b'.repeat(64),weight:.4,trigger:'my_outfit'}],identity_disabled:[]}}};
  character.identity.prompt.person=[{tag:'blue_eyes'}];
  await f.put('characters/person.prompt.json',{$schema:schema('character-prompt'),...character});
  await f.put('characters/person.profile.json',{$schema:schema('character-profile'),name:'角色',description:'测试'});
  await f.put('characters/person.visual.json',{$schema:schema('character-visual'),variants:[{id:'default',name:'默认'}]});
  const content=await f.get(`pages/${id}.content.json`);content.characters=[{character_id:'person',variant_id:'default'}];await f.put(`pages/${id}.content.json`,content);
  const native=modelAdapter('anima').emptyPrompt();native.person=[{description:'standing in garden'}];
  await f.put(`pages/${id}.prompt.json`,{$schema:schema('story-page-prompt'),...native});
  const plan=await planModelMigration(f.root,'demo');assert.equal(plan.pages[0].equivalent,true);assert.equal(plan.pages[0].loras.length,2);
  const result=await commitModelMigration(f.root,'demo',plan.fingerprint);
  assert.equal(JSON.parse(await readFile(path.join(result.backup_directory,'project.json'),'utf8')).format,undefined);
  const migrated=await f.get(`pages/${id}.prompt.json`);assert.deepEqual(migrated.models.anima.trigger_sources.characters.person,['my_character','my_outfit']);
  assert.equal(migrated.models.anima.loras[0].weight,.7);assert.equal((await f.get('project.json')).format,'story-models-v1');
  assert.equal((await planModelMigration(f.root,'demo')).current,true);
  const actual=await compilePageRenderInspectionContext({repositoryRoot:f.root,projectDirectory:f.directory,pageKey:{page_id:id}});
  assert.deepEqual(actual.blockers,[]);
  assert.equal(hash(actual.compiled_page.positive_prompt),plan.pages[0].positive_sha256);
  assert.equal(hash(actual.compiled_page.negative_prompt),plan.pages[0].negative_sha256);
  assert.deepEqual(actual.compiled_page.loras.map(({filename,sha256,weight})=>({filename,sha256,weight})),plan.pages[0].loras);
});
