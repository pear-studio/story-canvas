import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBlankComparisonInput,assertComparisonInput,importComparisonPage,compileComparisonInput,comparisonInputRoute} from '../server/comparison-inputs.mjs';
import {modelAdapter} from '../server/model-adapters.mjs';
import {captureMossComparisonNative} from '../server/comparison-native-input.mjs';
import {emptyMossPrompt,mossLayoutBox} from '../shared/moss-prompt.mjs';
import {createCharacter} from '../server/character-facts.mjs';
import {createPage} from '../server/page-facts.mjs';
import {createScene} from '../server/scene-facts.mjs';
import {registerFixtureProjects} from './project-registry-fixture.mjs';
import {readPageRenderDraft,commitPageRender} from '../server/page-render-settings.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';
import {convertComicPage,splitComicPanel,comicGenerationDimensions} from '../server/comic-pages.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const entries=description=>[{description}];
const lora=(name,letter,trigger,kind='character',owner='alice')=>({filename:`${name}.safetensors`,sha256:letter.repeat(64),weight:.7,trigger,kind,owner});
const aliceLora=lora('alice','a','alice_trigger');
const bobLora=lora('bob','b','bob_trigger','character','bob');
const styleLora=lora('style','c','style_trigger','style','moss-image');

async function nativeFixture({shared=false,sameWord=false,layout=true}={}){
  const input=await createBlankComparisonInput(root,'moss-image');
  input.render.profile.prompt.style=entries('Anime illustration.');
  input.render.profile.style_loras={style:styleLora};
  const prompt={...emptyMossPrompt(),composition:entries('Two women at a reception desk.'),person:[{character_id:'alice',description:'Apologizes politely.'}],layout:{enabled:layout,items:[{id:'alice',character_id:'alice',bbox:[0,.1,.4,.8]},{id:'bob',character_id:'bob',bbox:[.6,.1,.4,.8]}]}};
  const characters=[{id:'alice',configuration_id:'default',prompt_name:'Alice',entries:entries('Blue dress.'),loras:[aliceLora]},{id:'bob',configuration_id:'default',prompt_name:'Bob',entries:entries('Red dress; the embroidered words alice_trigger remain visible.'),loras:[shared?aliceLora:sameWord?{...bobLora,trigger:'alice_trigger'}:bobLora]}];
  const target={page_id:'page-001',page_prompt:prompt,characters,scenes:[],participant_ids:['alice','bob'],compiled_profile:{effective_profile:input.render.profile}};
  const compiled=modelAdapter('moss').compilePrompt({pageId:target.page_id,pageKey:{page_id:target.page_id},pagePrompt:prompt,profile:input.render.profile,characters,participantIds:target.participant_ids,dimensions:{width:960,height:1280}});
  input.loras=compiled.loras.map(value=>({...value,trigger_words:value.trigger?[value.trigger]:[]}));
  input.native_input=captureMossComparisonNative(target);input.prompt={positive:compiled.positive_prompt,negative:compiled.negative_prompt};
  return {input,compiled};
}

test('MOSS 空白输入可编辑本地人物与项目描述，最终文本只是编译证据',async()=>{
  const input=await createBlankComparisonInput(root,'moss-image');assert.equal(input.version,1);assert.equal(input.native_input.model_id,'moss');
  assert.doesNotThrow(()=>assertComparisonInput(input,{allow_empty:true}));assert.throws(()=>assertComparisonInput(input));
  input.native_input.characters.push({id:'local-hero',configuration_id:'default',prompt_name:'Hero',entries:entries('A silver-haired traveler.')});
  input.native_input.participant_ids.push('local-hero');input.native_input.prompt.layout={enabled:true,items:[{id:'hero',character_id:'local-hero',bbox:[.2,.1,.6,.8]}]};
  input.render.profile.prompt.lighting=entries('Warm light.');input.prompt.positive='STALE JSON MUST NOT WIN';
  const frozen=assertComparisonInput(input);const parsed=JSON.parse(frozen.prompt.positive);assert.match(parsed.summary.caption,/Warm light/);assert.match(parsed.items[0].caption,/silver-haired/);assert.doesNotMatch(frozen.prompt.positive,/STALE/);assert.equal(input.prompt.positive,'STALE JSON MUST NOT WIN');
});

test('MOSS preserve 保留文字，replace 仅改目标角色触发词且不修改别人的同名正文',async()=>{
  for(const layout of [false,true]){
    const {input,compiled}=await nativeFixture({layout});
    assert.equal(compileComparisonInput(input).positive,compiled.positive_prompt);
    const loras=input.loras.filter(value=>value.sha256!==aliceLora.sha256);
    assert.equal(compileComparisonInput(input,{loras,trigger_policy:'preserve',trigger_change:{target_sha256:aliceLora.sha256,words:[]}}).positive,compiled.positive_prompt);
    const replaced=compileComparisonInput(input,{loras,trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:['replacement_trigger']}});
    assert.match(replaced.positive,/Alice: replacement_trigger/);assert.match(replaced.positive,/Bob: bob_trigger/);assert.match(replaced.positive,/embroidered words alice_trigger remain visible/);
    const removed=compileComparisonInput(input,{loras,trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:[]}});
    assert.doesNotMatch(removed.positive,/Alice: alice_trigger/);assert.match(removed.positive,/Bob: bob_trigger/);assert.match(removed.positive,/style_trigger/);
    if(layout){assert.equal(JSON.parse(replaced.positive).items.length,2);assert.equal(JSON.parse(removed.positive).items[0].caption,'Alice: Blue dress.\n\nApologizes politely.');}
  }
});

test('一个 LoRA 被多个人物引用时保留所有来源，替换风格不影响角色',async()=>{
  const {input}=await nativeFixture({shared:true});
  assert.deepEqual(input.native_input.trigger_sources.filter(source=>source.lora_sha256===aliceLora.sha256).map(source=>source.owner),['alice','bob']);
  const replaced=JSON.parse(compileComparisonInput(input,{trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:['new_shared']}}).positive);
  assert.match(replaced.items[0].caption,/Alice: new_shared/);assert.match(replaced.items[1].caption,/Bob: new_shared/);
  const style=JSON.parse(compileComparisonInput(input,{trigger_policy:'replace',trigger_change:{target_sha256:styleLora.sha256,words:['new_style']}}).positive);
  assert.match(style.summary.caption,/new_style/);assert.doesNotMatch(style.summary.caption,/style_trigger/);assert.match(style.items[0].caption,/alice_trigger/);
});

test('两个不同 LoRA 使用同名触发词时，原生归属只替换选中人物',async()=>{
  const {input}=await nativeFixture({sameWord:true});
  const parsed=JSON.parse(compileComparisonInput(input,{trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:['replacement']}}).positive);
  assert.match(parsed.items[0].caption,/Alice: replacement/);assert.match(parsed.items[1].caption,/Bob: alice_trigger/);assert.match(parsed.items[1].caption,/embroidered words alice_trigger remain visible/);
});

test('先应用最终配方与画幅再编译 Layout，归一化框和冻结输入保持不变',async()=>{
  const {input}=await nativeFixture();const original=structuredClone(input);
  const recipe=structuredClone(comparisonInputRoute(input).recipe);recipe.resolutions['3:4']={width:1440,height:1920};recipe.cfg=4;
  const scaled=compileComparisonInput(input,{recipe});assert.equal(scaled.recipe.cfg,4);assert.deepEqual(scaled.dimensions,{width:1440,height:1920});assert.deepEqual(JSON.parse(scaled.positive).items[0].bbox,mossLayoutBox([0,.1,.4,.8],1440,1920));
  assert.deepEqual(input,original);input.render.canvas='4:3';const landscape=compileComparisonInput(input);assert.deepEqual(landscape.dimensions,{width:1280,height:960});assert.deepEqual(JSON.parse(landscape.positive).items[0].bbox,mossLayoutBox([0,.1,.4,.8],1280,960));
});

test('普通文本保留策略不猜归属，明确替换拒绝重复词和未知 activation',async()=>{
  const input=await createBlankComparisonInput(root,'qwen-image-2-1');input.prompt={positive:'alice_trigger\nA portrait.',negative:''};input.loras=[{...aliceLora,trigger_words:['alice_trigger']}];
  assert.equal(compileComparisonInput(input,{loras:[]}).positive,input.prompt.positive);
  assert.match(compileComparisonInput(input,{trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:['new_trigger']}}).positive,/A portrait\.[\s\S]*new_trigger/);
  input.prompt.positive='alice_trigger\nalice_trigger\nA portrait.';assert.throws(()=>compileComparisonInput(input,{trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:[]}}),error=>error.code==='comparison_trigger_target_ambiguous');
  delete input.loras[0].trigger_words;assert.throws(()=>compileComparisonInput(input,{trigger_policy:'replace',trigger_change:{target_sha256:aliceLora.sha256,words:[]}}));
});

test('历史输入只按显式legacy规则读取，不按新原生语义重编译',async()=>{
  const input=await createBlankComparisonInput(root,'qwen-image-2-1');input.prompt.positive='Historical prompt.';delete input.version;delete input.render.route;
  assert.deepEqual(assertComparisonInput(input,{legacy:true}),input);
  assert.throws(()=>assertComparisonInput(input),error=>error.code==='comparison_input_reimport_required');assert.throws(()=>compileComparisonInput(input),error=>error.code==='comparison_input_reimport_required');
});

async function projectFixture(t){
  const base=path.join(root,'Saved/Tests');await mkdir(base,{recursive:true});const localRoot=await mkdtemp(path.join(base,'comparison-native-'));t.after(()=>rm(localRoot,{recursive:true,force:true}));const directory=path.join(localRoot,'workspace/demo');
  const put=async(file,value)=>{const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));};const get=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'));const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;
  for(const folder of ['render-profiles','render-recipes','workflows','prompt-policies','visual-page-templates'])await cp(path.join(root,'library',folder),path.join(localRoot,'library',folder),{recursive:true});
  await put('project.json',{format:'story-models-v1',title:'测试',canvas:'3:4',default_render_profile:'moss-image'});
  await put('story/outline.json',{$schema:schema('story-outline'),synopsis:'测试',chapters:[{id:'main',title:'章',summary:'测试',sequences:[{id:'one',title:'节',summary:'测试'}]}]});
  await put('pages/index.json',{$schema:schema('pages-index'),pages:[]});await put('characters/index.json',{$schema:schema('character-index'),characters:[]});await put('scenes/index.json',{$schema:schema('scene-index'),scenes:[]});registerFixtureProjects(localRoot);
  await createCharacter(localRoot,'demo','hero',{name:'Hero'});const character=await get('characters/hero.prompt.json');character.models.moss.identity.lora={filename:aliceLora.filename,sha256:aliceLora.sha256,weight:.7,trigger:'alice_trigger'};character.models.moss.variants.default.entries=entries('A blue dress.');await put('characters/hero.prompt.json',character);
  await createScene(localRoot,'demo','inn',{name:'Inn'});const scene=await get('scenes/inn.prompt.json');scene.models.moss.variants.default.entries=entries('A cozy inn.');await put('scenes/inn.prompt.json',scene);
  const {page_id:id,page_key:pageKey}=await createPage(localRoot,'demo',{owner_kind:'story',sequence_id:'one'});const content=await get(`pages/${id}.content.json`);content.characters=[{character_id:'hero',variant_id:'default'}];await put(`pages/${id}.content.json`,content);
  const document=await get(`pages/${id}.prompt.json`);Object.assign(document.models.moss,{composition:entries('A traveler at the reception.'),scene_id:'inn',scene_variant_id:'default',layout:{enabled:true,items:[{id:'hero',character_id:'hero',bbox:[.2,.1,.6,.8]}]}});await put(`pages/${id}.prompt.json`,document);
  const importPage=()=>importComparisonPage({repositoryRoot:localRoot,projectDirectory:directory,projectId:'demo',pageKey});return {root:localRoot,directory,put,get,id,pageKey,importPage};
}

test('导入冻结实际页面倍率与设定，改来源事实不改变原生快照',async t=>{
  const f=await projectFixture(t);const normal=await f.importPage();assert.deepEqual(compileComparisonInput(normal).dimensions,{width:960,height:1280});assert.equal(compileComparisonInput(normal).positive,normal.prompt.positive);
  const {definition:d}=await readPageRenderDraft(f.root,'demo',f.id);await commitPageRender(f.root,{project_id:'demo',page_id:f.id,target:{sha256:hashCanonicalJson(d.persisted)},upstream:d.upstream},()=>({...d.persisted,resolution_scale:1.5}));
  const input=await f.importPage();assert.deepEqual(compileComparisonInput(input).dimensions,{width:1440,height:1920});assert.match(input.prompt.positive,/A cozy inn/);assert.match(input.prompt.positive,/alice_trigger/);
  const before=compileComparisonInput(input);const character=await f.get('characters/hero.prompt.json');character.models.moss.variants.default.entries=entries('Changed red dress.');await f.put('characters/hero.prompt.json',character);
  assert.deepEqual(compileComparisonInput(input),before);assert.doesNotMatch(input.prompt.positive,/Changed red/);assert.match((await f.importPage()).prompt.positive,/Changed red/);
});

test('分镜实际尺寸导入后不退回全局默认，之后换画幅重新编译框',async t=>{
  const f=await projectFixture(t);const converted=await convertComicPage(f.root,'demo',f.id);await splitComicPanel(f.root,'demo',f.id,{expected_sha256:converted.sha256,panel_id:f.id,axis:'y'});
  const size=await comicGenerationDimensions(f.directory,f.id);const input=await f.importPage();assert.deepEqual(compileComparisonInput(input).dimensions,size);assert.deepEqual(JSON.parse(input.prompt.positive).items[0].bbox,mossLayoutBox([.2,.1,.6,.8],size.width,size.height));
  input.render.canvas='1:1';assert.deepEqual(compileComparisonInput(input).dimensions,{width:1024,height:1024});assert.deepEqual(JSON.parse(compileComparisonInput(input).positive).items[0].bbox,mossLayoutBox([.2,.1,.6,.8],1024,1024));
});
