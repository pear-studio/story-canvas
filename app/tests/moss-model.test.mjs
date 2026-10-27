import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import {modelAdapter} from '../server/model-adapters.mjs';
import {readResolvedRenderProfile,compileEffectiveRenderProfile} from '../server/render-profile-compiler.mjs';
import {makeModelPromptDocument,validateModelPromptDocument} from '../server/model-prompts.mjs';
import {compilePageRenderInspectionContext} from '../server/page-render-resolver.mjs';
import {compileAndPersistWorkbenchRenderTask} from '../server/page-render.mjs';
import {validateFrozenRenderTask,currentPromptContractIdentity,buildWorkflow,resolveRenderRecipe} from '../server/render-task-contract.mjs';
import {readPromptScope,readPromptScopeSources,savePromptScope} from '../server/prompt-scope.mjs';
import {checkProjectPrompts} from '../server/prompt-check.mjs';
import {createCharacter} from '../server/character-facts.mjs';
import {validateScenePromptDocument} from '../server/scene-files.mjs';
import {createPage} from '../server/page-facts.mjs';
import {registerFixtureProjects} from './project-registry-fixture.mjs';
import {emptyMossPrompt,mossLayoutBox} from '../shared/moss-prompt.mjs';
import {cleanPageCharacterInput} from '../shared/page-character-cleanup.mjs';
import {promptSourceView} from '../shared/prompt-source-view.mjs';
import {commitPageRender,readPageRenderDraft} from '../server/page-render-settings.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;
const entries=description=>[{description}];
const adapter=modelAdapter('moss');
const baseProfile=(await readResolvedRenderProfile(root,'moss-image')).resolved_profile;
const compile=(prompt,extra={})=>adapter.compilePrompt({pageId:'page-001',pageKey:{page_id:'page-001'},pagePrompt:{...emptyMossPrompt(),...prompt},profile:structuredClone(baseProfile),dimensions:{width:960,height:1280},...extra});

test('MOSS 正式配置使用 SFT INT8 与官方 latent/SLG 路线',async()=>{
  assert.equal(baseProfile.models.dit.filename,'moss_image_sft_int8_convrot.safetensors');
  assert.equal(baseProfile.operations.candidates.routes.empty_latent.recipe.steps,50);
  const workflow=JSON.parse(await readFile(path.join(root,'library/workflows/moss-image-text.api.json'),'utf8'));
  assert.equal(workflow['6'].class_type,'EmptyFlux2LatentImage');
  assert.equal(workflow['7'].class_type,'SkipLayerGuidanceDiTSimple');
  assert.equal(workflow['7'].inputs.single_layers,'22');
  assert.deepEqual(workflow['8'].inputs.model,['7',0]);
  const bundle=await readResolvedRenderProfile(root,'moss-image');
  const frozen=buildWorkflow(bundle.workflow_definitions['moss-image-text'],baseProfile,resolveRenderRecipe(baseProfile.operations.candidates.routes.empty_latent.recipe,'3:4'),{page_key:{page_id:'page-001'},id:'test',task:'test',positive_prompt:'A garden.',negative_prompt:'',seed:1,loras:[]});
  assert.deepEqual(frozen['8'].inputs.model,['7',0]);assert.deepEqual(frozen['7'].inputs.model,['1',0]);
  assert.deepEqual(currentPromptContractIdentity(),{version:8,sha256:'02532b34062a462b39e8d7b277d1e2e697f3576e7cf66a77f9454a5ec476882f'});
});

test('MOSS 完整设定与页面 Schema 一致，拒绝越界 Layout/错误角色绑定',async()=>{
  for(const kind of ['page','character','scene']){
    const name=kind==='page'?'story-page-prompt':`${kind}-prompt`;
    const input=kind==='page'?{...emptyMossPrompt(),composition:entries('A portrait.')}:{prompt_name:'Hero',identity:{lora:null},variants:{default:{entries:entries('Silver hair.'),loras:[]}}};
    const document=makeModelPromptDocument(schema(name),'moss',input);
    assert.deepEqual(kind==='scene'?validateScenePromptDocument(document):validateModelPromptDocument(document,kind),[]);
    const definition=JSON.parse(await readFile(path.join(root,'library/schemas',`${name}.schema.json`),'utf8'));
    const validate=new Ajv({strict:false}).compile(definition);assert.equal(validate(document),true,JSON.stringify(validate.errors));
  }
  for(const bad of [{person:[{description:'x',character_id:123}]},{layout:{enabled:true,items:[{id:'box',label:'object',entries:entries('tree'),bbox:[.8,0,.4,1]}]}},{layout:{enabled:true,items:[{id:'box',character_id:'hero',entries:[],bbox:[0,0,1,1]}]}}]){
    assert.ok(validateModelPromptDocument(makeModelPromptDocument(schema('story-page-prompt'),'moss',{...emptyMossPrompt(),...bad}),'page').length);
  }
});

test('MOSS 描述按完整子设定继承，页面覆盖与 LoRA 开关同时影响文本',()=>{
  const lora={filename:'hero.safetensors',sha256:'a'.repeat(64),weight:.8,trigger:'hero_style'};
  const hero={id:'hero',configuration_id:'default',...adapter.resolveSetting({entries:entries('Silver hair.'),loras:[]},{prompt_name:'Hero',identity:{lora}})};
  const profile=structuredClone(baseProfile);profile.prompt={style:entries('Painterly.'),lighting:entries('Sunlight.')};
  const input={composition:entries('Two people in a garden.'),person:[{description:'Waves.',character_id:'hero'},{description:'A fairy maid.'}],entry_overrides:{'character:hero:default':entries('Golden hair.')},project_overrides:{lighting:entries('Moonlight.')},lora_overrides:{'hero.safetensors':{enabled:false}}};
  const result=compile(input,{profile,characters:[hero],participantIds:['hero']});
  assert.equal(result.ready,true);assert.deepEqual(result.loras,[]);
  assert.match(result.positive_prompt,/Golden hair\.[\s\S]*Waves\./);assert.match(result.positive_prompt,/Painterly\.[\s\S]*Moonlight\./);
  assert.doesNotMatch(result.positive_prompt,/Silver hair|hero_style|Sunlight/);
  delete input.lora_overrides;const enabled=compile(input,{profile,characters:[hero],participantIds:['hero']});
  assert.equal(enabled.loras[0].weight,.8);assert.match(enabled.positive_prompt,/hero_style/);
  assert.match(enabled.positive_prompt,/Hero: hero_style/);
  assert.equal(compile({}, {characters:[{id:'hero',configuration_id:'default',prompt_name:'Hero',entries:[],loras:[]}],participantIds:['hero']}).ready,false,'只有生成名称不算有效描述');
});

test('MOSS 避免继承项目，页面替换、清空、停用和 Layout 使用同一规则',()=>{
  const profile=structuredClone(baseProfile);profile.prompt.avoid=[{description:'watermark'},{description:'text',enabled:false}];
  const input={composition:entries('A garden.')};
  assert.equal(Object.hasOwn(emptyMossPrompt(),'avoid'),false);
  assert.equal(compile(input,{profile}).negative_prompt,'watermark');
  assert.equal(compile({...input,avoid:entries('logo')},{profile}).negative_prompt,'logo');
  assert.equal(compile({...input,avoid:[]},{profile}).negative_prompt,'');
  assert.equal(compile({...input,avoid:[{description:'logo',enabled:false}]},{profile}).negative_prompt,'');
  const layout={enabled:true,items:[{id:'tree',label:'object',entries:entries('A tree.'),bbox:[0,0,1,1]}]};
  assert.equal(compile({...input,layout},{profile}).negative_prompt,'watermark');
  profile.prompt.avoid=entries('updated');
  assert.equal(compile(input,{profile}).negative_prompt,'updated');
  assert.equal(compile({...input,avoid:entries('logo')},{profile}).negative_prompt,'logo');
});

test('MOSS Layout 用实际画幅换算官方坐标，空描述不因 JSON 非空而通过',()=>{
  assert.deepEqual(mossLayoutBox([.1,.2,.2,.3],100,200),[-60,-40,0,-20]);
  const result=compile({composition:entries('A garden.'),layout:{enabled:true,items:[{id:'tree',label:'object',entries:entries('A tree.'),bbox:[.25,.1,.5,.8]}]}});
  assert.equal(result.ready,true);const output=JSON.parse(result.positive_prompt);
  assert.equal(output.summary.caption,'A garden.');assert.equal(output.items[0].caption,'A tree.');
  assert.deepEqual(output.items[0].bbox,[-512,-240,512,240]);assert.equal(output.bbox_format,'yxyx');assert.equal(output.bbox_coord_space,'abs_centralized');
  const blank=compile({layout:{enabled:true,items:[{id:'empty',label:'object',entries:[],bbox:[0,0,1,1]}]}});
  assert.equal(blank.ready,false);assert.ok(blank.missing.length);assert.ok(blank.errors.length);
});

test('移除角色清理 MOSS 描述与 Layout 引用，保留自由人物和场景覆盖',()=>{
  const input={...emptyMossPrompt(),person:[{character_id:'hero',description:'Wave.'},{description:'A maid.'}],entry_overrides:{'character:hero:default':entries('hero'),'scene:inn:default':entries('inn')},layout:{enabled:true,items:[{id:'hero',character_id:'hero',bbox:[0,0,.4,1]},{id:'chair',label:'object',entries:entries('chair'),bbox:[.5,.5,.5,.5]}]}};
  const next=cleanPageCharacterInput(input,[{character_id:'hero',variant_id:'default'}],[]);
  assert.deepEqual(next.person,entries('A maid.'));assert.deepEqual(Object.keys(next.entry_overrides),['scene:inn:default']);assert.deepEqual(next.layout.items.map(v=>v.id),['chair']);
  const view=promptSourceView('character:hero:default',{identity:{lora:null},variant:{entries:entries('inherit')}},input);
  assert.equal(view.entries[0].text,'hero');
});

async function fixture(t){
  const base=path.join(root,'Saved/Tests');await mkdir(base,{recursive:true});
  const localRoot=await mkdtemp(path.join(base,'moss-'));t.after(()=>rm(localRoot,{recursive:true,force:true}));
  const directory=path.join(localRoot,'workspace/demo');
  const put=async(file,value)=>{const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));};
  const get=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'));
  for(const folder of ['render-profiles','render-recipes','workflows','prompt-policies','visual-page-templates'])await cp(path.join(root,'library',folder),path.join(localRoot,'library',folder),{recursive:true});
  await put('project.json',{format:'story-models-v1',title:'测试',canvas:'3:4',default_render_profile:'moss-image'});
  await put('story/outline.json',{$schema:schema('story-outline'),synopsis:'测试',chapters:[{id:'main',title:'章',summary:'测试',sequences:[{id:'one',title:'节',summary:'测试'}]}]});
  await put('pages/index.json',{$schema:schema('pages-index'),pages:[]});await put('characters/index.json',{$schema:schema('character-index'),characters:[]});await put('scenes/index.json',{$schema:schema('scene-index'),scenes:[]});
  registerFixtureProjects(localRoot);return {root:localRoot,directory,put,get};
}

test('MOSS 实际页面创建、角色继承、项目画风覆盖与 1.5 倍 Layout 可冻结执行',async t=>{
  const f=await fixture(t);await createCharacter(f.root,'demo','hero',{name:'Hero'});
  const character=await f.get('characters/hero.prompt.json');const lora={filename:'hero.safetensors',sha256:'a'.repeat(64),weight:.7,trigger:'veloria'};
  character.models.moss.identity.lora=lora;character.models.moss.variants.default.entries=entries('A woman in a blue dress.');await f.put('characters/hero.prompt.json',character);
  const {page_id:id,page_key:pageKey}=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'one'});
  const content=await f.get(`pages/${id}.content.json`);content.characters=[{character_id:'hero',variant_id:'default'}];await f.put(`pages/${id}.content.json`,content);
  const document=await f.get(`pages/${id}.prompt.json`);document.models.moss.composition=entries('Portrait in a garden.');document.models.moss.layout={enabled:true,items:[{id:'hero',character_id:'hero',bbox:[.25,.1,.5,.8]}]};await f.put(`pages/${id}.prompt.json`,document);
  const scope=await readPromptScope({projectRoot:f.root,projectId:'demo',target:{kind:'page',id,model_id:'moss'}});
  assert.equal(scope.references.composition,'settings');assert.deepEqual(scope.document.composition,entries('Portrait in a garden.'));
  await f.put('render-profile.override.json',{$schema:schema('render-profile-override'),version:1,profiles:{'moss-image':{changes:[{target:'prompt.style',original:{exists:true,value:[]},project:{exists:true,value:entries('Anime illustration.')}},{target:'prompt.avoid',original:{exists:false},project:{exists:true,value:entries('watermark, logo')}}]}}});
  const bundle=await compileEffectiveRenderProfile({repositoryRoot:f.root,projectRoot:f.directory,profileId:'moss-image'});assert.equal(bundle.blocked,false);assert.deepEqual(bundle.effective_profile.prompt.style,entries('Anime illustration.'));
  const inherited=await readPromptScope({projectRoot:f.root,projectId:'demo',target:{kind:'page',id,model_id:'moss'}});
  assert.equal(inherited.project_prompt.status,'ready');assert.equal(inherited.project_prompt.profile_id,'moss-image');
  assert.deepEqual(inherited.project_prompt.fields.avoid,{project:entries('watermark, logo'),effective:entries('watermark, logo'),overridden:false});
  assert.deepEqual(inherited.project_prompt.inspect,{operation:'generation.inspect',args:{project_id:'demo',profile_id:'moss-image'}});
  assert.equal(inherited.project_prompt.help.topic,'moss');
  const {definition:d}=await readPageRenderDraft(f.root,'demo',id);await commitPageRender(f.root,{project_id:'demo',page_id:id,target:{sha256:hashCanonicalJson(d.persisted)},upstream:d.upstream},()=>({...d.persisted,resolution_scale:1.5}));
  const inspection=await compilePageRenderInspectionContext({repositoryRoot:f.root,projectDirectory:f.directory,pageKey});
  assert.equal(inspection.compiled_page.ready,true,JSON.stringify(inspection.compiled_page));
  const layout=JSON.parse(inspection.compiled_page.positive_prompt);assert.match(layout.summary.caption,/Anime illustration/);assert.match(layout.items[0].caption,/veloria[\s\S]*blue dress/);assert.deepEqual(layout.items[0].bbox,[-768,-360,768,360]);
  const {task}=await compileAndPersistWorkbenchRenderTask(f.root,'demo',{page_key:pageKey,count:1});validateFrozenRenderTask(task);
  assert.equal(task.items[0].loras[0].weight,.7);assert.equal(task.items[0].negative_prompt,'watermark, logo');
  const execution=task.snapshot.execution_units[0];
  const workflow=execution.workflow.api;
  assert.deepEqual(workflow['8'].inputs.model,['7',0]);assert.deepEqual(workflow['7'].inputs.model,['11',0]);assert.equal(workflow['11'].class_type,'LoraLoaderModelOnly');assert.deepEqual(workflow['11'].inputs.model,['1',0]);
  assert.equal(workflow['6'].inputs.width,1440);assert.equal(workflow['6'].inputs.height,1920);
  character.models.moss.variants.default.entries=entries('Red dress.');await f.put('characters/hero.prompt.json',character);
  assert.match(task.items[0].positive_prompt,/blue dress/);assert.doesNotMatch(task.items[0].positive_prompt,/Red dress/);
});

test('MOSS 项目描述回执区分清空覆盖与继承，配置不可用时不冒充空值',async t=>{
  const f=await fixture(t),{page_id:id}=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'one'});
  await f.put('render-profile.override.json',{version:1,profiles:{'moss-image':{changes:[{target:'prompt.avoid',original:{exists:false},project:{exists:true,value:entries('watermark')}}]}}});
  const document=await f.get(`pages/${id}.prompt.json`);document.models.moss.avoid=[];await f.put(`pages/${id}.prompt.json`,document);
  const options={projectRoot:f.root,projectId:'demo',target:{kind:'page',id,model_id:'moss'}};
  const cleared=await readPromptScope(options);
  assert.deepEqual(cleared.project_prompt.fields.avoid,{project:entries('watermark'),effective:[],overridden:true});
  await f.put('render-profile.override.json',{version:1,profiles:{'moss-image':{changes:[{target:'prompt.avoid',original:{exists:true,value:entries('old')},project:{exists:true,value:entries('watermark')}}]}}});
  const conflict=await readPromptScope(options);assert.equal(conflict.project_prompt.status,'conflict');assert.equal(conflict.project_prompt.fields,undefined);
  const check=()=>checkProjectPrompts(f.root,{project_id:'demo',model_id:'moss'},async(_id,run)=>({value:await run({projectDirectory:f.directory})}));
  const conflictedCheck=await check();assert.equal(conflictedCheck.incomplete,1);assert.equal(conflictedCheck.counts.project_prompt_conflict,1);
  await f.put('render-profile.override.json',{invalid:true});
  const unavailable=await readPromptScope(options);assert.equal(unavailable.project_prompt.status,'unavailable');assert.equal(unavailable.project_prompt.fields,undefined);assert.ok(unavailable.project_prompt.inspect);
  const unavailableCheck=await check();assert.equal(unavailableCheck.incomplete,1);assert.equal(unavailableCheck.counts.project_prompt_unavailable,1);
});

test('MOSS sources 返回可保存的整组覆盖指引，清空和 null 恢复保持来源描述',async t=>{
  const f=await fixture(t);await createCharacter(f.root,'demo','hero',{name:'Hero'});
  const character=await f.get('characters/hero.prompt.json');character.models.moss.variants.default.entries=entries('Blue dress.');await f.put('characters/hero.prompt.json',character);
  const {page_id:id}=await createPage(f.root,'demo',{owner_kind:'character',character_id:'hero',variant_id:'default'});
  const options={projectRoot:f.root,projectId:'demo',target:{kind:'page',id,model_id:'moss'}},source='character:hero:default';
  const inherited=await readPromptScopeSources({...options,source});
  assert.match(inherited.usage,/changes\.entry_overrides\[source\]/);assert.match(inherited.usage,/null.*恢复继承/);
  const save=async(receipt,changes)=>savePromptScope({...options,expectedSha256:receipt.save.args.expected_sha256,sourceVersions:receipt.save.args.source_versions,changes});
  const changed=await save(await readPromptScope(options),{composition:entries('A portrait.'),entry_overrides:{[source]:entries('Red dress.')}});
  assert.equal(changed.inherited_sources[0].entries[0].text,'Red dress.');
  const cleared=await save(changed,{entry_overrides:{[source]:[]}});assert.deepEqual(cleared.inherited_sources[0].entries,[]);
  const restored=await save(cleared,{entry_overrides:{[source]:null}});
  assert.equal(restored.document.entry_overrides?.[source],undefined);assert.equal(restored.inherited_sources[0].entries[0].text,'Blue dress.');
  const variant=await readPromptScopeSources({...options,target:{kind:'character',id:'hero',model_id:'moss',scope:'variant',variant_id:'default'}});
  assert.match(variant.usage,/直接编辑.*entries/);assert.doesNotMatch(variant.usage,/changes\.identity_overrides/);
});

test('MOSS prompt.check 报告缺失来源、悬空覆盖和人物/Layout 未出场绑定',async t=>{
  const f=await fixture(t),{page_id:id}=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'one'});
  const content=await f.get(`pages/${id}.content.json`);content.characters=[{character_id:'missing-hero',variant_id:'default'}];await f.put(`pages/${id}.content.json`,content);
  const document=await f.get(`pages/${id}.prompt.json`);
  document.models.moss.composition=entries('A portrait.');
  document.models.moss.person=[{description:'Waves.',character_id:'other'}];
  document.models.moss.entry_overrides={'character:stale:default':entries('Old description.')};
  document.models.moss.layout={enabled:false,items:[{id:'ghost-box',character_id:'ghost',bbox:[0,0,1,1]}]};
  await f.put(`pages/${id}.prompt.json`,document);
  const check=await checkProjectPrompts(f.root,{project_id:'demo',model_id:'moss'},async(_id,run)=>({value:await run({projectDirectory:f.directory})}));
  assert.equal(check.failed,0);assert.equal(check.incomplete,1);assert.equal(check.results[0].status,'incomplete');
  for(const code of ['source_missing','unused_source_override','unreferenced_character_binding','unreferenced_layout_character'])assert.equal(check.counts[code],1,code);
  const scope=await readPromptScope({projectRoot:f.root,projectId:'demo',target:{kind:'page',id,model_id:'moss'}});
  assert.deepEqual(scope.diagnostics.find(issue=>issue.code==='unreferenced_layout_character'),{code:'unreferenced_layout_character',severity:'error',index:0,item_id:'ghost-box',character_id:'ghost'});
});
