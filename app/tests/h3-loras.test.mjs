import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import Ajv from 'ajv/dist/2020.js';
import {registerFixtureProjects} from './project-registry-fixture.mjs';
import {createPage} from '../server/page-facts.mjs';
import {readReferenceLibrary,mutateReferenceLibrary} from '../server/reference-library.mjs';
import {readFactDraft,saveFactDraft} from '../server/fact-drafts.mjs';
import {compileAndPersistWorkbenchRenderTask} from '../server/page-render.mjs';
import {inspectPageRender} from '../server/page-render-inspection.mjs';
import {validateFrozenRenderTask} from '../server/render-task-contract.mjs';
import {compilePrompt,emptyPrompt,validatePrompt} from '../server/models/h3/prompt.mjs';
import {validateModelPromptDocument} from '../server/model-prompts.mjs';
import {validateLoraResource} from '../server/lora-resources.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;
const lora={filename:'motion.safetensors',sha256:'a'.repeat(64),weight:.6,trigger:'gentle_motion'};
const profile={id:'minimax-h3',style_loras:{motion:lora}};
const basePrompt={...emptyPrompt(),text:'树叶在微风中摇动。'};
const compile=(prompt,activeProfile=profile)=>compilePrompt({pageKey:{page_id:'page-demo'},pagePrompt:prompt,profile:activeProfile,referencePlan:{sequence:[{file:'reference.png'}]}});

test('H3 已登记 LoRA 使用明确的底模家族，Schema 与资源读取一致',async()=>{
  const resource=JSON.parse(await readFile(path.join(root,'library/resources/loras/lora-ecfbc656b6dc5835/resource.json'),'utf8'));
  resource.architecture={family:'minimax-h3',prompt_family:'minimax-h3'};
  const definition=JSON.parse(await readFile(path.join(root,'library/schemas/lora-resource.schema.json'),'utf8'));
  const validate=new Ajv({strict:false,validateFormats:false}).compile(definition);
  assert.deepEqual(validateLoraResource(resource),[]);
  assert.equal(validate(resource),true,JSON.stringify(validate.errors));
});

test('H3 页面 LoRA 覆盖、关闭、恢复与触发词使用同一有效列表，原文不变',()=>{
  const input={...basePrompt,loras:[],lora_overrides:{[lora.filename]:{weight:.3}}};
  const original=structuredClone(input);
  const enabled=compile(input);
  assert.equal(enabled.ready,true);
  assert.equal(enabled.loras[0].weight,.3);
  assert.equal(enabled.loras[0].sha256,lora.sha256);
  assert.match(enabled.positive_prompt,/gentle_motion/);
  assert.deepEqual(input,original);
  const disabled=compile({...input,lora_overrides:{[lora.filename]:{enabled:false}}});
  assert.deepEqual(disabled.loras,[]);
  assert.doesNotMatch(disabled.positive_prompt,/gentle_motion/);
  assert.deepEqual(disabled.sections,[{kind:'page',text:basePrompt.text}]);
  assert.equal(compile({...input,lora_overrides:{}}).loras[0].weight,.6);
  const local=compile({...input,loras:[{...lora,weight:.8}],lora_overrides:{}});
  assert.equal(local.loras.length,1);
  assert.equal(local.loras[0].kind,'page');
  assert.equal(local.loras[0].weight,.8);
  assert.equal(local.positive_prompt.match(/gentle_motion/g).length,1);
  assert.deepEqual(compile({...basePrompt,loras:[{...lora,enabled:false}]},{id:'minimax-h3',style_loras:{}}).loras,[]);
});

test('H3 Schema 与保存校验接受逐页 LoRA，并拒绝非法定义和覆盖',async()=>{
  const definition=JSON.parse(await readFile(path.join(root,'library/schemas/story-page-prompt.schema.json'),'utf8'));
  const validate=new Ajv({strict:false}).compile(definition);
  const document=prompt=>({$schema:schema('story-page-prompt'),models:{h3:prompt}});
  for(const prompt of [basePrompt,{...basePrompt,loras:[lora],lora_overrides:{[lora.filename]:{enabled:false,weight:0}}}]){
    assert.deepEqual(validatePrompt(prompt),[]);
    assert.deepEqual(validateModelPromptDocument(document(prompt),'page'),[]);
    assert.equal(validate(document(prompt)),true,JSON.stringify(validate.errors));
  }
  for(const change of [{loras:{}},{loras:[{...lora,weight:3}]},{loras:[{...lora,enabled:'false'}]},{lora_overrides:{[lora.filename]:{enabled:'false'}}},{lora_overrides:{[lora.filename]:{trigger:'other'}}}]){
    const prompt={...basePrompt,...change};
    assert.ok(validatePrompt(prompt).length);
    assert.ok(validateModelPromptDocument(document(prompt),'page').length);
    assert.equal(validate(document(prompt)),false);
  }
  assert.ok(compile({...basePrompt,loras:[lora,lora]}).errors.some(value=>value.includes('重复')));
});

test('H3 保存、预检、冻结工作流一致，关闭缺失的继承 LoRA 可生成，旧快照不变',async t=>{
  await mkdir(path.join(root,'Saved/Tests'),{recursive:true});
  const base=await mkdtemp(path.join(root,'Saved/Tests/h3-loras-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const directory=path.join(base,'workspace/demo'),modelsRoot=path.join(base,'models');
  const put=async(f,v)=>{await mkdir(path.dirname(f),{recursive:true});await writeFile(f,JSON.stringify(v));};
  for(const folder of ['render-profiles','render-recipes','workflows','prompt-policies'])await cp(path.join(root,'library',folder),path.join(base,'library',folder),{recursive:true});
  const profileFile=path.join(base,'library/render-profiles/minimax-h3.json');
  const fixtureProfile=JSON.parse(await readFile(profileFile,'utf8'));
  for(const model of Object.values(fixtureProfile.models)){
    const file=path.join(modelsRoot,model.relative_path),bytes=Buffer.from(model.filename);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
    model.sha256=createHash('sha256').update(bytes).digest('hex');
  }
  // 配置中保留一个缺失 LoRA，验证页面关闭后不会仍被配置级预检阻断。
  fixtureProfile.style_loras={motion:lora};await put(profileFile,fixtureProfile);
  await put(path.join(directory,'project.json'),{format:'story-models-v1',title:'H3 LoRA 回归',canvas:'3:4',default_render_profile:'anima-base-v1'});
  await put(path.join(directory,'story/outline.json'),{$schema:schema('story-outline'),synopsis:'测试',chapters:[{id:'main',title:'章',summary:'测试',sequences:[{id:'one',title:'单元',summary:'测试'}]}]});
  await put(path.join(directory,'pages/index.json'),{$schema:schema('pages-index'),pages:[]});
  await put(path.join(directory,'characters/index.json'),{$schema:schema('character-index'),characters:[]});
  await put(path.join(directory,'scenes/index.json'),{$schema:schema('scene-index'),scenes:[]});
  registerFixtureProjects(base);
  const video=await createPage(base,'demo',{owner_kind:'story',sequence_id:'one'},{pageKind:'video'});
  const target={kind:'page',id:video.page_id};
  const bytes=await sharp({create:{width:384,height:512,channels:3,background:'blue'}}).png().toBuffer();
  const refs=await readReferenceLibrary(base,'demo',target);
  await mutateReferenceLibrary(base,directory,'demo',{target,action:'save',expected_sha256:refs.sha256,content:bytes.toString('base64')});
  const args={projectId:'demo',domain:'page',kind:'prompt',targetId:video.page_id};
  const save=async changes=>{
    const draft=await readFactDraft(base,args);
    Object.assign(draft.document.models.h3,changes);
    await saveFactDraft(base,{...args,document:draft.document,expectedSha256:draft.expected_sha256,expectedContextSha256:draft.expected_context_sha256});
  };
  const inspect=()=>inspectPageRender({repositoryRoot:base,projectDirectory:directory,pageKey:video.page_key,config:{models_root:modelsRoot}});
  await save({text:basePrompt.text,loop:true,lora_overrides:{[lora.filename]:{weight:.25}}});
  const inspection=await inspect();
  assert.equal(inspection.loras[0].weight,.25);
  assert.ok(inspection.blockers.some(item=>item.code==='page_lora_unavailable'));
  const task=(await compileAndPersistWorkbenchRenderTask(base,'demo',{page_key:video.page_key})).task;
  validateFrozenRenderTask(task);
  const api=task.snapshot.execution_units[0].workflow.api;
  const loaders=Object.entries(api).filter(([,node])=>node.class_type==='LoraLoaderModelOnly');
  assert.equal(loaders.length,1);
  assert.equal(loaders[0][1].inputs.strength_model,.25);
  assert.deepEqual(api['7'].inputs.model,[loaders[0][0],0]);
  assert.deepEqual(api['10'].inputs.model,[loaders[0][0],0]);
  assert.deepEqual(api['6'].inputs.last_frame,['5',0]);
  assert.match(api['6'].inputs.prompt,/gentle_motion/);
  assert.equal(task.items[0].loras[0].sha256,inspection.loras[0].sha256);
  assert.equal(task.items[0].loras[0].weight,inspection.loras[0].weight);
  await save({lora_overrides:{[lora.filename]:{enabled:false}}});
  const off=await inspect();
  assert.deepEqual(off.loras,[]);
  assert.equal(off.ready,true,JSON.stringify(off.blockers));
  assert.notEqual(off.generation_signature,inspection.generation_signature);
  const next=(await compileAndPersistWorkbenchRenderTask(base,'demo',{page_key:video.page_key})).task;
  const nextApi=next.snapshot.execution_units[0].workflow.api;
  assert.equal(Object.values(nextApi).some(node=>node.class_type==='LoraLoaderModelOnly'),false);
  assert.deepEqual(nextApi['7'].inputs.model,['1',0]);
  assert.doesNotMatch(nextApi['6'].inputs.prompt,/gentle_motion/);
  validateFrozenRenderTask(task);
  assert.equal(task.items[0].loras[0].weight,.25);
});
