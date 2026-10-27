import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createComparisonExperiment,assertComparisonExperimentManifest} from '../server/comparison-experiment.mjs';
import {preflightComparisonExperiment,assertComparisonPreflightPlan} from '../server/comparison-preflight.mjs';
import {legacyComparisonPreflight} from '../server/comparison-preflight-legacy.mjs';
import {createBlankComparisonInput} from '../server/comparison-inputs.mjs';
import {previewComparisonCells} from '../server/comparison-cell.mjs';
import {createComparisonExperimentStorage,createComparisonExperimentExecution,readComparisonExperimentStorage,failComparisonExperiment,retryComparisonExperiment} from '../server/comparison-experiment-storage.mjs';
import {prepareComparisonExperimentExecution} from '../server/comparison-execution-plan.mjs';
import {assertComparisonExecutionPlan} from '../server/comparison-execution-contract.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';
import {comparisonFrozenLora,comparisonModelIdentity} from './helpers/comparison-identity.mjs';
import {mossLayoutBox} from '../shared/moss-prompt.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=letter=>letter.repeat(64);
const entries=description=>[{description}];
const rehash=value=>{const {canonical_sha256,...body}=value;value.canonical_sha256=hashCanonicalJson(body);return value;};
async function inputFixture(profile='qwen-image-2-1'){
  const input=await createBlankComparisonInput(root,profile);input.id='sample';input.prompt.positive='old_trigger\nA portrait.';
  if(profile==='moss-image')input.native_input.prompt.composition=entries('Two travelers at an inn.');
  return input;
}
function mounted(input,id,letter,kind='style'){
  const identity=comparisonFrozenLora(input,{id,sha:sha(letter),activation:[`${id}_trigger`]});
  return {kind,owner:id,filename:identity.relative_path.slice(6),relative_path:identity.relative_path,sha256:identity.sha256,size_bytes:identity.size_bytes,weight:.6,trigger_words:identity.activation.trigger_words,source_identity:identity};
}
function manifestFor(inputs,{testLora,application,baseline=true,id='comparison-core',cfg}={}){
  const configs=testLora?[...(baseline?[{id:'baseline',label:application?'移除该 LoRA':'原输入 LoRA',lora_ref:null,...(application?{application}:{})}]:[]),{id:'test',label:'测试',lora_ref:testLora.id,...(application?{application}:{})}]
    :application?[{id:'baseline',label:'移除该 LoRA',lora_ref:null,application}]:[];
  return createComparisonExperiment({id,created_at:'2026-10-27T00:00:00.000Z',randomSeed:()=>7,
    axes:[{type:'input',values:inputs.map(input=>({value_id:input.id,label:input.label,value:input.id}))},
      ...(configs.length?[{type:'lora_config',values:configs.map(config=>({value_id:config.id,label:config.label,value:config.id}))}]:[]),
      ...(testLora?[{type:'lora_weight',values:[{value_id:'w',label:'0.8',value:.8}]}]:[]),
      ...(cfg?[{type:'cfg',values:[{value_id:'cfg',label:String(cfg),value:cfg}]}]:[])],registries:{loras:testLora?[testLora]:[],lora_configs:configs}});
}

test('新实验只接纳同一模型家族，实际配方尺寸与默认 CFG 保持各输入独立',async()=>{
  const first=await inputFixture(),second=await inputFixture();second.id='second';
  const route=second.render.profile.operations.candidates.routes.empty_latent;
  route.recipe.cfg=5;route.recipe.resolutions['3:4']={width:768,height:1088};
  const manifest=manifestFor([first,second]),plan=preflightComparisonExperiment({manifest,inputs:[first,second]});
  assert.deepEqual(plan.cells.map(cell=>cell.cfg),[first.render.profile.operations.candidates.routes.empty_latent.recipe.cfg,5]);
  assert.deepEqual(plan.cells[1].dimensions,{width:768,height:1088});
  assert.equal(plan.version,3);assert.equal(manifest.version,2);assert.deepEqual(assertComparisonPreflightPlan(plan),plan);
  const other=await inputFixture('moss-image');other.id='moss';
  assert.throws(()=>preflightComparisonExperiment({manifest:manifestFor([first,other]),inputs:[first,other]}),{code:'comparison_mixed_architecture'});
});

test('按 SHA 替换画风，空测试项移除目标并保留其他 LoRA；默认严格保持原文本',async()=>{
  const input=await inputFixture();input.loras=[mounted(input,'old','a'),mounted(input,'character','b','character')];
  const replacement=comparisonFrozenLora(input,{id:'new',sha:sha('c')});
  const application={mode:'replace_lora',target_lora_sha256:sha('a')};
  const manifest=manifestFor([input],{testLora:replacement,application});
  assert.equal(manifest.registries.lora_configs[0].application.trigger_policy,'preserve');
  const cells=previewComparisonCells({manifest,inputs:[input]});
  assert.deepEqual(cells[0].loras.map(lora=>lora.sha256),[sha('b')]);
  assert.deepEqual(cells[1].loras.map(lora=>[lora.sha256,lora.weight]),[[sha('c'),.8],[sha('b'),.6]]);
  assert.ok(cells.every(cell=>cell.prompt.positive===input.prompt.positive));
  assert.deepEqual(input.loras.map(lora=>lora.sha256),[sha('a'),sha('b')]);
  const preflight=preflightComparisonExperiment({manifest,inputs:[input]});
  assert.equal(preflight.compatibility.length,3);assert.deepEqual(assertComparisonPreflightPlan(preflight),preflight);
});

test('同 SHA 不同路径也不能重复追加；同文件可替换权重；每个输入必须唯一匹配目标',async()=>{
  const input=await inputFixture();input.loras=[mounted(input,'old','a')];
  const same=comparisonFrozenLora(input,{id:'same',sha:sha('a'),relativePath:'loras/another/path.safetensors'});
  assert.throws(()=>preflightComparisonExperiment({manifest:manifestFor([input],{testLora:same}),inputs:[input]}),{code:'comparison_duplicate_lora'});
  const application={mode:'replace_lora',target_lora_sha256:sha('a')};
  const cells=previewComparisonCells({manifest:manifestFor([input],{testLora:same,application,baseline:false}),inputs:[input]});
  assert.equal(cells[0].loras.length,1);assert.equal(cells[0].loras[0].weight,.8);
  const missing=structuredClone(input);missing.id='missing';missing.loras=[];
  assert.throws(()=>preflightComparisonExperiment({manifest:manifestFor([input,missing],{application}),inputs:[input,missing]}),{code:'comparison_lora_target_ambiguous'});
  input.loras.push({...input.loras[0],filename:'alias.safetensors'});
  assert.throws(()=>previewComparisonCells({manifest:manifestFor([input],{application}),inputs:[input]}),{code:'comparison_duplicate_lora'});
});

test('替换触发词区分未知 activation 与显式空值，普通文本有歧义时只允许 preserve',async()=>{
  const input=await inputFixture();input.loras=[mounted(input,'old','a')];
  const application={mode:'replace_lora',target_lora_sha256:sha('a'),trigger_policy:'replace'};
  const unknown=comparisonFrozenLora(input,{id:'unknown',sha:sha('b')});
  assert.throws(()=>previewComparisonCells({manifest:manifestFor([input],{testLora:unknown,application}),inputs:[input]}),{code:'comparison_lora_activation_unknown'});
  const explicit=comparisonFrozenLora(input,{id:'empty',sha:sha('b'),activation:[]});
  const replaced=previewComparisonCells({manifest:manifestFor([input],{testLora:explicit,application}),inputs:[input]});
  assert.ok(replaced.every(cell=>!cell.prompt.positive.includes('old_trigger')));
  input.prompt.positive='old_trigger\nold_trigger\nA portrait.';
  assert.throws(()=>previewComparisonCells({manifest:manifestFor([input],{application}),inputs:[input]}),{code:'comparison_trigger_target_ambiguous'});
  assert.doesNotThrow(()=>preflightComparisonExperiment({manifest:manifestFor([input],{application:{...application,trigger_policy:'preserve'}}),inputs:[input]}));
});

test('MOSS Layout 替换仅改变目标归属，并以实际尺寸编译有效 JSON 和工作流',async()=>{
  const input=await inputFixture('moss-image');
  input.loras=[mounted(input,'alice','a','character'),mounted(input,'bob','b','character')];
  const native=input.native_input;native.characters=[{id:'alice',configuration_id:'default',prompt_name:'Alice',entries:entries('Blue dress.')},{id:'bob',configuration_id:'default',prompt_name:'Bob',entries:entries('Red dress with alice_trigger embroidery.')}];
  native.participant_ids=['alice','bob'];native.trigger_sources=input.loras.map(lora=>({lora_sha256:lora.sha256,kind:'character',owner:lora.owner,words:lora.trigger_words}));
  native.prompt.layout={enabled:true,items:[{id:'a',character_id:'alice',bbox:[0,.1,.4,.8]},{id:'b',character_id:'bob',bbox:[.6,.1,.4,.8]}]};
  input.render.profile.operations.candidates.routes.empty_latent.recipe.resolutions['3:4']={width:1440,height:1920};
  const replacement=comparisonFrozenLora(input,{id:'new',sha:sha('c'),activation:['new_trigger']});
  const application={mode:'replace_lora',target_lora_sha256:sha('a'),trigger_policy:'replace'};
  const manifest=manifestFor([input],{testLora:replacement,application});
  const cells=previewComparisonCells({manifest,inputs:[input]});
  const parsed=JSON.parse(cells[1].prompt.positive);
  assert.match(parsed.items[0].caption,/Alice: new_trigger/);assert.match(parsed.items[1].caption,/Bob: bob_trigger/);assert.match(parsed.items[1].caption,/alice_trigger embroidery/);
  assert.deepEqual(parsed.items[0].bbox,mossLayoutBox([0,.1,.4,.8],1440,1920));
  assert.deepEqual(cells[1].dimensions,{width:1440,height:1920});
  assert.ok(Object.values(cells[1].workflow.api).some(node=>node.inputs?.text===cells[1].prompt.positive));
  assert.equal(JSON.parse(cells[0].prompt.positive).items[0].caption,'Alice: Blue dress.');
  assert.doesNotThrow(()=>preflightComparisonExperiment({manifest,inputs:[input]}));
});

test('BF16 到 INT8 的兼容证据冻结入计划；历史回读不拿当前规则重写证据',async()=>{
  const input=await inputFixture('moss-image');
  const lora=comparisonFrozenLora(input,{id:'sft-bf16'});
  lora.model_identity=comparisonModelIdentity(input,{sourceSha:'f96738d8116d78b7316b57c663d8c98591ddafab7488f48e3099b7655e34ab6f',sourceSize:10164655808});
  const manifest=manifestFor([input],{testLora:lora});
  const plan=preflightComparisonExperiment({manifest,inputs:[input]});
  const evidence=plan.compatibility[0].evidence;
  assert.equal(evidence.matches[0].method,'declared_conversion');
  assert.equal(evidence.target_models[0].sha256,input.render.profile.models.dit.sha256);
  const historical=structuredClone(plan);
  historical.compatibility[0].evidence.matches[0].rule.id='historical-rule-retired-from-current-table';
  rehash(historical.compatibility[0].evidence);rehash(historical);
  assert.deepEqual(assertComparisonPreflightPlan(historical),historical);
  assert.notEqual(preflightComparisonExperiment({manifest,inputs:[input]}).canonical_sha256,historical.canonical_sha256);
  historical.compatibility[0].evidence.target_models[0].sha256=sha('d');rehash(historical.compatibility[0].evidence);rehash(historical);
  assert.throws(()=>assertComparisonPreflightPlan(historical),{code:'comparison_lora_incompatible'});
});

function oldManifest(current){
  const result=structuredClone(current);result.version=1;
  const {version,id,created_at,shared_seed,axes,registries,cells}=result;
  result.canonical_sha256=hashCanonicalJson({version,id,created_at,shared_seed,axes,registries,cells:cells.map(({status,...cell})=>cell)});
  return result;
}
async function temporary(t){
  const parent=path.join(root,'Saved','Tests');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'comparison-core-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
test('旧 manifest/preflight 不隐式升级；无执行计划拒绝启动，已有计划按原字节读取并可补跑',async t=>{
  const dir=await temporary(t),input=await inputFixture(),current=manifestFor([input],{id:'legacy'});
  const cells=previewComparisonCells({manifest:current,inputs:[input]}).map(({dimensions,...cell})=>cell);
  const manifest=oldManifest(current),legacyInput=structuredClone(input);delete legacyInput.version;delete legacyInput.render.route;
  const preflight=legacyComparisonPreflight({manifest,inputs:[legacyInput]});
  await createComparisonExperimentStorage({projectRoot:dir,manifest,preflight});
  const file=path.join(dir,'Saved','comparison-results','legacy','preflight.json'),before=await readFile(file,'utf8');
  await assert.rejects(prepareComparisonExperimentExecution({repositoryRoot:root,projectRoot:dir,localConfig:{},experimentId:'legacy'}),{code:'comparison_legacy_requires_reimport'});
  const execution=rehash({version:1,kind:'comparison_execution_plan',experiment_id:'legacy',manifest_sha256:manifest.canonical_sha256,preflight_sha256:preflight.canonical_sha256,cells});
  assert.deepEqual(assertComparisonExecutionPlan(execution,{manifest,preflight}),execution);
  await createComparisonExperimentExecution(dir,'legacy',execution);
  await failComparisonExperiment(dir,'legacy',new Error('interrupted'));
  const retried=await retryComparisonExperiment(dir,'legacy');assert.deepEqual(retried.execution,execution);
  assert.equal(await readFile(file,'utf8'),before);
  assert.throws(()=>preflightComparisonExperiment({manifest,inputs:[legacyInput]}),{code:'comparison_legacy_requires_reimport'});
  assert.equal(assertComparisonExperimentManifest(manifest).version,1);
});

function tensorBytes(fill){
  const header=Buffer.from(JSON.stringify({'__metadata__':{},'diffusion_model.transformer_blocks.0.attn.to_q.lora_A.weight':{dtype:'F32',shape:[1,1],data_offsets:[0,4]},'diffusion_model.transformer_blocks.0.attn.to_q.lora_B.weight':{dtype:'F32',shape:[1,1],data_offsets:[4,8]}}));
  const length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(header.length));return Buffer.concat([length,header,Buffer.alloc(8,fill)]);
}
test('Start 复核输入原有和测试 LoRA 的 SHA 与大小，预览和实际冻结 cell 完全一致',async t=>{
  const dir=await temporary(t),models=path.join(dir,'models');await mkdir(path.join(models,'loras'),{recursive:true});
  const input=await inputFixture();const originalBytes=tensorBytes(1),testBytes=tensorBytes(2);
  const original=comparisonFrozenLora(input,{id:'original',sha:createHash('sha256').update(originalBytes).digest('hex'),size:originalBytes.length});
  const tested=comparisonFrozenLora(input,{id:'tested',sha:createHash('sha256').update(testBytes).digest('hex'),size:testBytes.length});
  await writeFile(path.join(models,original.relative_path),originalBytes);await writeFile(path.join(models,tested.relative_path),testBytes);
  input.loras=[{kind:'style',owner:'original',filename:original.relative_path.slice(6),relative_path:original.relative_path,sha256:original.sha256,size_bytes:original.size_bytes,weight:.4,source_identity:original}];
  const config={models_root:models};
  for(const [id,changed] of [['original-changed',original],['test-changed',tested]]){
    const manifest=manifestFor([input],{id,testLora:tested}),preflight=preflightComparisonExperiment({manifest,inputs:[input]});
    await createComparisonExperimentStorage({projectRoot:dir,manifest,preflight});
    await writeFile(path.join(models,changed.relative_path),tensorBytes(3));
    await assert.rejects(prepareComparisonExperimentExecution({repositoryRoot:root,projectRoot:dir,localConfig:config,experimentId:id}),{code:'comparison_lora_changed'});
    assert.equal((await readComparisonExperimentStorage(dir,id)).execution,null);
    await writeFile(path.join(models,changed.relative_path),changed===original?originalBytes:testBytes);
  }
  const manifest=manifestFor([input],{id:'correct',testLora:tested}),preflight=preflightComparisonExperiment({manifest,inputs:[input]});
  await createComparisonExperimentStorage({projectRoot:dir,manifest,preflight});
  const prepared=await prepareComparisonExperimentExecution({repositoryRoot:root,projectRoot:dir,localConfig:config,experimentId:'correct'});
  const preview=previewComparisonCells({manifest,inputs:[input]}).map(({dimensions,...cell})=>cell);
  assert.deepEqual(prepared.execution.cells,preview);
});
