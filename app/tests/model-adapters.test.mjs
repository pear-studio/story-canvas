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
import {compileAndPersistWorkbenchRenderTask} from '../server/page-render.mjs';
import {validateFrozenRenderTask} from '../server/render-task-contract.mjs';
import {publishCandidateResult} from '../server/candidate-storage.mjs';
import sharp from 'sharp';
import Ajv from 'ajv/dist/2020.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;
test('公开 JSON Schema 与 LoRA 权重/开关覆盖契约一致',async()=>{
  for(const name of ['character-prompt','scene-prompt','story-page-prompt']) {
    const definition=JSON.parse(await readFile(path.join(root,'library/schemas',name+'.schema.json'),'utf8'));
    const ajv=new Ajv({strict:false});ajv.addSchema(definition);
    const validate=ajv.compile({$ref:definition.$id+'#/$defs/loraOverrides'});
    assert.equal(validate({'role.safetensors':{weight:.7,enabled:false}}),true);
    assert.equal(validate({'role.safetensors':{weight:3}}),false);
    assert.equal(validate({'role.safetensors':{sha256:'not-an-override'}}),false);
    const targets=name==='story-page-prompt'?[definition.$defs.anima.properties,definition.$defs.qwen.properties]:[definition.$defs.anima.$defs.configuration.properties];
    for(const properties of targets)assert.equal(properties.lora_overrides.$ref,'#/$defs/loraOverrides');
  }
});

for (const modelId of ['anima', 'qwen']) test(`${modelId} 项目 LoRA 实时生效，本页可覆盖、停用、恢复且任务冻结不随项目变化`, async t => {
  const f = await fixture(t, modelId);
  const profileId = modelAdapter(modelId).defaultProfile;
  const projectLora = { filename: 'shared.safetensors', sha256: 'a'.repeat(64), weight: .9, trigger: 'shared_style' };
  const setProject = async value => f.put('render-profile.override.json', { $schema: schema('render-profile-override'), version: 1, profiles: {
    [profileId]: { changes: value ? [{ target: 'style_loras.shared', original: { exists: false }, project: { exists: true, value } }] : [] },
  } });
  const { page_id: id, page_key: pageKey } = await f.create();
  const input = await f.get(`pages/${id}.prompt.json`);
  if (modelId === 'qwen') input.models.qwen.text = 'quiet garden';
  else input.models.anima.setting = [{ description: 'quiet garden' }];
  await f.put(`pages/${id}.prompt.json`, input);
  const compile = () => compilePageRenderInspectionContext({ repositoryRoot: f.root, projectDirectory: f.directory, pageKey });
  const local = async loras => { input.models[modelId].loras = loras; await f.put(`pages/${id}.prompt.json`, input); };
  await setProject(projectLora);
  assert.equal((await compile()).compiled_page.loras[0].weight, .9);
  const created = await f.create();
  assert.deepEqual((await f.get(`pages/${created.page_id}.prompt.json`)).models[modelId].loras, [], '新页不复制项目 LoRA');
  const frozen = await compileAndPersistWorkbenchRenderTask(f.root, 'demo', { page_key: pageKey, count: 1 });
  validateFrozenRenderTask(frozen.task);
  assert.equal(frozen.task.items[0].loras[0].weight, .9);
  await setProject({ ...projectLora, weight: .6 });
  assert.equal((await compile()).compiled_page.loras[0].weight, .6);
  assert.equal(frozen.task.items[0].loras[0].weight, .9);
  const extra = { filename: 'local.safetensors', sha256: 'b'.repeat(64), weight: .4 };
  await local([{ ...projectLora, weight: .3 }, extra]);
  assert.deepEqual((await compile()).compiled_page.loras.map(lora => lora.weight), [.3, .4]);
  await local([{ ...projectLora, enabled: false }]);
  const disabled = (await compile()).compiled_page;
  assert.deepEqual(disabled.loras, []);
  if (modelId === 'anima') assert.doesNotMatch(disabled.positive_prompt, /shared_style/);
  await local([]);
  const restored = (await compile()).compiled_page;
  assert.equal(restored.loras[0].weight, .6);
  if (modelId === 'anima') assert.equal(restored.positive_prompt.match(/shared_style/g)?.length, 1);
  await f.switchModel(id, modelId === 'anima' ? 'qwen' : 'anima');
  assert.deepEqual((await compile()).compiled_page.loras, [], '不同配置不串用项目 LoRA');
  await f.switchModel(id, modelId);
  await setProject(null);
  assert.deepEqual((await compile()).compiled_page.loras, []);
  assert.deepEqual((await f.get(`pages/${id}.prompt.json`)).models[modelId].loras, []);
});
test('三种工作台画幅在两模型所有候选路线上具有相同的准确尺寸',async()=>{
  const presets=JSON.parse(await readFile(path.join(root,'app/shared/canvas-presets.json'),'utf8'));
  assert.deepEqual(presets.map(p=>p.value),['3:4','1:1','4:3']);
  for(const id of ['anima-base-v1','qwen-image-2-1']){
    const {resolved_profile:profile}=await readResolvedRenderProfile(root,id);
    for(const route of Object.values(profile.operations.candidates.routes))for(const p of presets){
      assert.deepEqual(route.recipe.resolutions[p.value],{width:p.width,height:p.height});
      const [w,h]=p.value.split(':').map(Number);assert.equal(p.width*h,p.height*w);
      assert.equal(p.width%64,0);assert.equal(p.height%64,0);
    }
  }
});
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
test('两模型均能冻结可执行任务，Anima policy 身份随任务保存并校验',async t=>{
  for(const modelId of ['anima','qwen']){
    const f=await fixture(t,modelId),{page_id:id}=await f.create();
    const prompt=await f.get(`pages/${id}.prompt.json`);
    if(modelId==='anima')prompt.models.anima.setting=[{description:'quiet garden'}];
    else prompt.models.qwen.text='quiet garden';
    await f.put(`pages/${id}.prompt.json`,prompt);
    for(const canvas of ['3:4','1:1','4:3']){
      const {definition:d}=await readPageRenderDraft(f.root,'demo',id);
      await commitPageRender(f.root,{project_id:'demo',page_id:id,target:{sha256:hash(d.persisted)},upstream:d.upstream},()=>({...d.persisted,canvas}));
      const {task}=await compileAndPersistWorkbenchRenderTask(f.root,'demo',{page_key:{page_id:id},count:1});
      assert.equal(task.snapshot.canvas,canvas);assert.equal(task.snapshot.execution_units.length,1);
      validateFrozenRenderTask(task);
      if(modelId==='anima'){
        assert.equal(task.snapshot.source_identity.prompt_policy.id,'anima-v1');
        task.snapshot.source_identity.prompt_policy.id='wrong';
        assert.throws(()=>validateFrozenRenderTask(task),/来源身份|identity/);
      }
    }
  }
});
test('Qwen 全文输入不重复追加全局与设定，原组合输入仍保留拼接',async()=>{
  const {resolved_profile:profile}=await readResolvedRenderProfile(root,'qwen-image-2-1');profile.prompt.text='GLOBAL';
  const input={pageId:'page-001',pageKey:{page_id:'page-001'},profile,characters:[],participantIds:['missing'],pagePrompt:{text:'complete imported prompt',composition:'standalone'}};
  const full=modelAdapter('qwen').compilePrompt(input);assert.equal(full.positive_prompt,'complete imported prompt');assert.deepEqual(full.errors,[]);
  const composed=modelAdapter('qwen').compilePrompt({...input,participantIds:[],pagePrompt:{text:'local',composition:'settings'}});
  assert.match(composed.positive_prompt,/GLOBAL/);assert.match(composed.positive_prompt,/本页描述：\nlocal/);
  assert.throws(()=>modelAdapter('__proto__'),/未知生成模型/);
});
test('其他页面候选保存为材料后，删除源候选不影响 Qwen 参考图编译',async t=>{
  const f=await fixture(t,'qwen'),source=await f.create(),target=await f.create();
  const doc=await f.get(`pages/${source.page_id}.prompt.json`);doc.models.qwen.text='garden';await f.put(`pages/${source.page_id}.prompt.json`,doc);
  const {task}=await compileAndPersistWorkbenchRenderTask(f.root,'demo',{page_key:source.page_key,count:1});
  const item=task.items[0],bytes=await sharp({create:{width:32,height:32,channels:3,background:'#345678'}}).png().toBuffer();
  const result=await publishCandidateResult(f.directory,task,item,bytes,{warm:false});
  const id=target.page_id,content=await f.get(`pages/${id}.content.json`),before=await f.get(`pages/${id}.prompt.json`);
  const referenceId='ref-11111111-1111-4111-8111-111111111111',file='reference-11111111-1111-4111-8111-111111111111.png';
  await savePage(f.root,'demo',{page_key:target.page_key,content,prompt:{...before.models.qwen,text:'garden',reference_images:[{id:referenceId,file,title:'候选参考'}]},expected_content_sha256:hash(content),expected_prompt_sha256:hash(before),expected_context_sha256:hash(await readStoryPromptUpstream(f.directory,id)),reference_inputs:[{id:referenceId,candidate_id:item.candidate_id,page_key:source.page_key}]});
  await rm(path.dirname(path.join(f.directory,result.file)),{recursive:true});
  const actual=await compilePageRenderInspectionContext({repositoryRoot:f.root,projectDirectory:f.directory,pageKey:target.page_key});
  assert.deepEqual(actual.blockers,[]);assert.equal(actual.reference_images.length,1);
  assert.ok((await readFile(path.join(f.directory,'materials',file))).length);
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
  const original=await f.get(`pages/${id}.prompt.json`);original.models.anima.person=[{description:'a person in garden'}];
  await f.put(`pages/${id}.prompt.json`,original);
  await f.switchModel(id,'qwen');
  const imported=await f.get(`pages/${id}.prompt.json`);assert.equal(imported.models.qwen.composition,'standalone');assert.match(imported.models.qwen.text,/a person in garden/);
  imported.models.qwen.text='own qwen text';await f.put(`pages/${id}.prompt.json`,imported);
  await f.switchModel(id,'anima');await f.switchModel(id,'qwen');assert.equal((await f.get(`pages/${id}.prompt.json`)).models.qwen.text,'own qwen text');
  const copy=await duplicatePage(f.root,'demo',id);assert.deepEqual(await f.get(`pages/${copy.page_id}.prompt.json`),imported);
  const originalRender=await f.get(`pages/${id}.render.json`);
  assert.deepEqual(await f.get(`pages/${copy.page_id}.render.json`),originalRender);
  const {definition:copyRender}=await readPageRenderDraft(f.root,'demo',copy.page_id);
  await commitPageRender(f.root,{project_id:'demo',page_id:copy.page_id,target:{sha256:hash(copyRender.persisted)},upstream:copyRender.upstream},()=>({...copyRender.persisted,canvas:'4:3'}));
  const copyContent=await f.get(`pages/${copy.page_id}.content.json`);
  await savePage(f.root,'demo',{page_key:{page_id:copy.page_id},content:copyContent,prompt:{...imported.models.qwen,text:'independent copied page'},expected_content_sha256:hash(copyContent),expected_prompt_sha256:hash(imported),expected_context_sha256:hash(await readStoryPromptUpstream(f.directory,copy.page_id))});
  assert.deepEqual(await f.get(`pages/${id}.prompt.json`),imported);
  assert.deepEqual(await f.get(`pages/${id}.render.json`),originalRender);
  assert.equal((await f.get(`pages/${copy.page_id}.render.json`)).canvas,'4:3');
  const savedCopy=await f.get(`pages/${copy.page_id}.prompt.json`);
  assert.equal(savedCopy.models.qwen.text,'independent copied page');assert.deepEqual(savedCopy.models.anima,imported.models.anima);
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
  for (const id of ['anima','qwen']) {
    const setting=id==='anima'?{identity:{prompt:modelAdapter('anima').emptyPrompt(),lora:null},variants:{default:{prompt:modelAdapter('anima').emptyPrompt(),loras:[],identity_overrides:{}}}}:{prompt_name:'测试',variants:{default:{text:'测试',reference_images:[]}}};
    const document=makeModelPromptDocument(schema('character-prompt'),id,setting);
    assert.deepEqual(validateModelPromptDocument(document,'character'),[]);
    for(const field of ['loras','lora_overrides'])assert.ok(validateModelPromptDocument({...document,models:{[id]:{...setting,[field]:field==='loras'?[]:{}}}},'character').some(error=>error.includes('设定顶层')));
  }
  doc.models.anima.trigger_sources={style:[],characters:[],scenes:{}};assert.ok(validateModelPromptDocument(doc,'page').length);
});
test('场景改名修复非当前模型的引用和逐词覆盖，删除检查所有模型',async t=>{
  const f=await fixture(t),{page_id:id}=await f.create();
  await f.put('scenes/index.json',{$schema:schema('scene-index'),scenes:['room']});
  await f.put('scenes/room.visual.json',{$schema:schema('scene-visual'),variants:[{id:'day',name:'白天'},{id:'night',name:'夜晚'}]});
  const native={identity:{prompt:modelAdapter('anima').emptyPrompt(),lora:null},variants:Object.fromEntries(['day','night'].map(id=>[id,{prompt:modelAdapter('anima').emptyPrompt(),loras:[],identity_overrides:{}}]))};
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
  const character={identity:{prompt:modelAdapter('anima').emptyPrompt(),lora:{filename:'identity.safetensors',sha256:'a'.repeat(64),weight:.7,trigger:'my_character'}},variants:{default:{prompt:modelAdapter('anima').emptyPrompt(),loras:[{filename:'outfit.safetensors',sha256:'b'.repeat(64),weight:.4,trigger:'my_outfit'}],identity_overrides:{}}}};
  character.identity.prompt.person=[{id:'token-111111111111',tag:'blue_eyes'}];
  await f.put('characters/person.prompt.json',{$schema:schema('character-prompt'),...character});
  await f.put('characters/person.profile.json',{$schema:schema('character-profile'),name:'角色',description:'测试'});
  await f.put('characters/person.visual.json',{$schema:schema('character-visual'),variants:[{id:'default',name:'默认'}]});
  const content=await f.get(`pages/${id}.content.json`);content.characters=[{character_id:'person',variant_id:'default'}];await f.put(`pages/${id}.content.json`,content);
  const native=modelAdapter('anima').emptyPrompt();native.person=[{description:'standing in garden'}];
  await f.put(`pages/${id}.prompt.json`,{$schema:schema('story-page-prompt'),...native});
  const plan=await planModelMigration(f.root,'demo');assert.equal(plan.pages[0].equivalent,true);assert.equal(plan.pages[0].loras.length,2);
  const result=await commitModelMigration(f.root,'demo',plan.fingerprint);
  assert.equal(JSON.parse(await readFile(path.join(result.backup_directory,'project.json'),'utf8')).format,undefined);
  const migrated=await f.get(`pages/${id}.prompt.json`);assert.deepEqual(migrated.models.anima.loras,[]);
  assert.equal((await f.get('characters/person.prompt.json')).models.anima.identity.lora.trigger,'my_character');
  assert.equal((await f.get('characters/person.prompt.json')).models.anima.identity.lora.weight,.7);assert.equal((await f.get('project.json')).format,'story-models-v1');
  assert.equal((await planModelMigration(f.root,'demo')).current,true);
  const actual=await compilePageRenderInspectionContext({repositoryRoot:f.root,projectDirectory:f.directory,pageKey:{page_id:id}});
  assert.deepEqual(actual.blockers,[]);
  assert.equal(hash(actual.compiled_page.positive_prompt),plan.pages[0].positive_sha256);
  assert.equal(hash(actual.compiled_page.negative_prompt),plan.pages[0].negative_sha256);
  assert.deepEqual(actual.compiled_page.loras.map(({filename,sha256,weight})=>({filename,sha256,weight})),plan.pages[0].loras);
});

test('角色 LoRA 随引用与子设定实时继承，页面仅保存覆盖，触发词跟随启用状态',async t=>{
  const f=await fixture(t),{page_id:id}=await f.create();
  const lora={filename:'character.safetensors',sha256:'c'.repeat(64),weight:.7,trigger:'character_trigger'};
  const outfit={filename:'outfit.safetensors',sha256:'d'.repeat(64),weight:.5,trigger:'outfit_trigger'};
  const character={identity:{prompt:modelAdapter('anima').emptyPrompt(),lora},variants:{default:{prompt:modelAdapter('anima').emptyPrompt(),loras:[outfit],identity_overrides:{},lora_overrides:{'character.safetensors':{weight:.8}}}}};
  character.identity.prompt.person=[{id:'token-111111111111',tag:'blue_eyes'}];
  await f.put('characters/index.json',{$schema:schema('character-index'),characters:['person']});
  await f.put('characters/person.prompt.json',makeModelPromptDocument(schema('character-prompt'),'anima',character));
  await f.put('characters/person.profile.json',{$schema:schema('character-profile'),name:'角色',description:'测试'});
  await f.put('characters/person.visual.json',{$schema:schema('character-visual'),variants:[{id:'default',name:'默认'}]});
  const content=await f.get(`pages/${id}.content.json`);content.characters=[{character_id:'person',variant_id:'default'}];await f.put(`pages/${id}.content.json`,content);
  const document=await f.get(`pages/${id}.prompt.json`);document.models.anima.loras=[];await f.put(`pages/${id}.prompt.json`,document);
  const inspect=async()=> (await compilePageRenderInspectionContext({repositoryRoot:f.root,projectDirectory:f.directory,pageKey:{page_id:id}})).compiled_page;
  let compiled=await inspect();assert.equal(compiled.loras.find(v=>v.filename===lora.filename).weight,.8);assert.match(compiled.positive_prompt,/character_trigger/);assert.match(compiled.positive_prompt,/outfit_trigger/);
  document.models.anima.lora_overrides={[lora.filename]:{weight:.3},[outfit.filename]:{enabled:false}};await f.put(`pages/${id}.prompt.json`,document);
  character.identity.lora={...lora,sha256:'e'.repeat(64),weight:1.2,trigger:'updated_trigger'};await f.put('characters/person.prompt.json',makeModelPromptDocument(schema('character-prompt'),'anima',character));
  compiled=await inspect();assert.equal(compiled.loras.find(v=>v.filename===lora.filename).weight,.3);assert.equal(compiled.loras.find(v=>v.filename===lora.filename).sha256,'e'.repeat(64));assert.match(compiled.positive_prompt,/updated_trigger/);assert.doesNotMatch(compiled.positive_prompt,/outfit_trigger|character_trigger/);assert.ok(!compiled.loras.some(v=>v.filename===outfit.filename));
  const {readPromptEditContext}=await import('../server/prompt-edit-context.mjs');
  const context=await readPromptEditContext({projectRoot:f.root,projectDirectory:f.directory,projectId:'demo',pageKey:{page_id:id}});
  assert.deepEqual(context.context.configuration.effective_loras,compiled.loras);
  const layers=context.context.configuration.lora_sources;
  assert.equal(layers.settings['character:person:default'].identity.weight,1.2);
  assert.equal(layers.settings['character:person:default'].local[0].filename,outfit.filename);
  assert.equal(layers.settings['character:person:default'].overrides[lora.filename].weight,.8);
  assert.equal(layers.page.overrides[outfit.filename].enabled,false);
  delete document.models.anima.lora_overrides;await f.put(`pages/${id}.prompt.json`,document);assert.equal((await inspect()).loras.find(v=>v.filename===lora.filename).weight,.8);
  content.characters=[];await f.put(`pages/${id}.content.json`,content);compiled=await inspect();assert.ok(!compiled.loras.some(v=>v.filename===lora.filename||v.filename===outfit.filename));assert.doesNotMatch(compiled.positive_prompt,/updated_trigger|outfit_trigger/);
  document.models.anima.lora_overrides={bad:{weight:3}};assert.ok(validateModelPromptDocument(document,'page').some(message=>message.includes('weight')));
});
