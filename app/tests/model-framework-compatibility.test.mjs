import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertRenderTaskPromptAudit,currentPromptContractIdentity} from '../server/render-task-contract.mjs';
import {compilePageRenderInspectionContext} from '../server/page-render-resolver.mjs';
import {createPage} from '../server/page-facts.mjs';
import {registerFixtureProjects} from './project-registry-fixture.mjs';
import {installModelResources} from './model-fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;

test('模型边界整理仍接受改造前冻结的 Prompt 契约及绑定，拒绝冻结输入篡改',()=>{
  // 从改造前 HEAD 的 currentPromptContractIdentity / promptItemBindingFingerprint 捕获。
  // 重构注册顺序不应让已排队的任务失去恢复能力。
  const identity={version:8,sha256:'02532b34062a462b39e8d7b277d1e2e697f3576e7cf66a77f9454a5ec476882f'};
  const item={id:'page-001.seed-7',page_key:{page_id:'page-001'},positive_prompt:'Alice: silver hair.\nA quiet room.',negative_prompt:'blur',
    prompt_parts:[{kind:'page',text:'A quiet room.'}],loras:[{filename:'style.safetensors',sha256:'a'.repeat(64),weight:.6}],
    reference_images:[{id:'ref-1',sha256:'b'.repeat(64)}],seed:7};
  const task={items:[item],snapshot:{prompt_contract:identity,loras:{[item.id]:structuredClone(item.loras)},
    prompt_binding_fingerprints:{[item.id]:'57751095b7d76a1af09c5815e0154346a35f5e11a7462f70e1f0ff32e1eaa830'}}};
  assert.deepEqual(currentPromptContractIdentity(),identity);
  assert.doesNotThrow(()=>assertRenderTaskPromptAudit(task));
  const changed=structuredClone(task);changed.items[0].positive_prompt+=' Changed after enqueue.';
  assert.throws(()=>assertRenderTaskPromptAudit(changed),/Prompt 或来源追踪已变化/);
  const changedLora=structuredClone(task);changedLora.items[0].loras[0].weight=.8;
  assert.throws(()=>assertRenderTaskPromptAudit(changedLora),/LoRA 绑定与任务快照不一致/);
});

test('Qwen 草稿预览保留显式空文字、空选图与停用 LoRA，且不改已保存输入',async t=>{
  const parent=path.join(root,'Saved/Tests');await mkdir(parent,{recursive:true});
  const temporary=await mkdtemp(path.join(parent,'model-framework-'));
  t.after(()=>rm(temporary,{recursive:true,force:true}));
  const directory=path.join(temporary,'workspace/demo');
  const put=async(file,value)=>{const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));};
  const get=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'));
  await installModelResources(temporary);
  await put('project.json',{format:'story-models-v1',title:'测试',canvas:'2:3',default_render_profile:'qwen-image-2-1'});
  await put('story/outline.json',{$schema:schema('story-outline'),synopsis:'测试',chapters:[{id:'main',title:'章',summary:'测试',sequences:[{id:'one',title:'节',summary:'测试'}]}]});
  await put('pages/index.json',{$schema:schema('pages-index'),pages:[]});
  await put('characters/index.json',{$schema:schema('character-index'),characters:['alice']});
  await put('scenes/index.json',{$schema:schema('scene-index'),scenes:[]});
  await put('characters/alice.profile.json',{$schema:schema('character-profile'),name:'Alice',description:'测试角色'});
  await put('characters/alice.visual.json',{$schema:schema('character-visual'),variants:[{id:'default',name:'默认'}]});
  await put('characters/alice.prompt.json',{$schema:schema('character-prompt'),models:{qwen:{prompt_name:'Alice',variants:{default:{text:'silver hair and a blue dress',reference_images:[
    {id:'ref-11111111-1111-1111-1111-111111111111',file:'reference-11111111-1111-1111-1111-111111111111.png',title:'未选择的图片'},
  ]}}}}});
  registerFixtureProjects(temporary);
  const {page_id:id}=await createPage(temporary,'demo',{owner_kind:'story',sequence_id:'one'});
  const content=await get(`pages/${id}.content.json`);content.characters=[{character_id:'alice',variant_id:'default'}];
  await put(`pages/${id}.content.json`,content);
  const saved=await get(`pages/${id}.prompt.json`);saved.models.qwen.text='saved action';
  await put(`pages/${id}.prompt.json`,saved);
  const before=await readFile(path.join(directory,`pages/${id}.prompt.json`),'utf8');
  const draft={text:'local action',composition:'settings',text_overrides:{'character:alice:default':''},
    reference_overrides:{'character:alice:default':[]},reference_images:[],
    loras:[{filename:'disabled.safetensors',sha256:'a'.repeat(64),weight:.7,enabled:false}]};
  const original=structuredClone(draft);
  const result=await compilePageRenderInspectionContext({repositoryRoot:temporary,projectDirectory:directory,pageKey:{page_id:id},pagePromptDraft:draft});
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.compiled_page.positive_prompt,'Alice：\n\n本页描述：\nlocal action');
  assert.deepEqual(result.compiled_page.loras,[]);
  assert.deepEqual(result.reference_images,[]);
  assert.equal(result.candidate_route.input_source,'empty_latent');
  assert.deepEqual(result.snapshot.page_prompt.text_overrides,draft.text_overrides);
  assert.deepEqual(result.snapshot.page_prompt.reference_overrides,draft.reference_overrides);
  assert.deepEqual(draft,original);
  assert.equal(await readFile(path.join(directory,`pages/${id}.prompt.json`),'utf8'),before);
});
