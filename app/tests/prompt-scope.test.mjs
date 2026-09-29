import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createQwenFixtureProject} from './model-fixture.mjs';
import {readProjectCreationTemplate} from '../server/project-creation.mjs';
import {createCharacter} from '../server/character-facts.mjs';
import {createScene} from '../server/scene-facts.mjs';
import {createPage} from '../server/page-facts.mjs';
import {readFactDraft} from '../server/fact-drafts.mjs';
import {readPromptScope,savePromptScope,readPromptScopeSources} from '../server/prompt-scope.mjs';
import {readPageRenderDraft,commitPageRender} from '../server/page-render-settings.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';

const repositoryRoot = fileURLToPath(new URL('../../',import.meta.url));
async function fixture(t) {
  const parent=path.join(repositoryRoot,'Saved','Tests');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'prompt-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await createQwenFixtureProject(root,await readProjectCreationTemplate(root,'demo'));
  await createCharacter(root,'demo','alice',{name:'Alice'});
  const options={projectRoot:root,projectId:'demo'};
  const read=target=>readPromptScope({...options,target});
  const save=(receipt,changes,sourceVersions=receipt.save.args.source_versions)=>savePromptScope({...options,target:receipt.target,expectedSha256:receipt.save.args.expected_sha256,sourceVersions,changes});
  return {root,options,read,save};
}
const character=(model_id,scope='variant')=>({kind:'character',id:'alice',model_id,scope,...(scope==='variant'?{variant_id:'default'}:{})});

test('设定scope独立合并；同scope/Anima基础冲突；nullable LoRA完整回执可保存',async t=>{
  const f=await fixture(t);
  const qwenBase=await f.read(character('qwen','base')),qwenVariant=await f.read(character('qwen'));
  await f.save(qwenBase,{prompt_name:'Alice updated'});
  await f.save(qwenVariant,{text:'A quiet portrait.'});
  assert.equal((await f.read(character('qwen','base'))).document.prompt_name,'Alice updated');
  await assert.rejects(f.save(qwenBase,{prompt_name:'stale'}),{code:'prompt_scope_conflict'});

  let animaBase=await f.read(character('anima','base'));
  animaBase.document.identity.prompt.person=[{tag:'blue_jacket'}];
  animaBase=await f.save(animaBase,animaBase.document);
  assert.equal(animaBase.document.identity.lora,null);
  assert.match(animaBase.document.identity.prompt.person[0].id,/^token-/);
  const animaVariant=await f.read(character('anima'));
  const freshQwenVariant=await f.read(character('qwen'));
  await f.save(freshQwenVariant,{text:'Preserve this unrelated edit.'});
  await f.save(animaVariant,{prompt:{camera:[{description:'side view'}]}});
  assert.equal((await f.read(character('qwen'))).document.text,'Preserve this unrelated edit.');
  const staleVariant=await f.read(character('anima'));
  const tokens=structuredClone(animaBase.document.identity.prompt.person);tokens[0].tag='navy_jacket';
  await f.save(animaBase,{identity:{prompt:{person:tokens}}});
  await assert.rejects(f.save(staleVariant,{identity_overrides:{["identity:"+tokens[0].id]:{enabled:false}}}),{code:'prompt_scope_conflict'});
  const all=await readFactDraft(f.root,{domain:'character',kind:'prompt',projectId:'demo',targetId:'alice'});
  assert.equal(all.document.models.qwen.prompt_name,'Alice updated');
  assert.equal(all.document.models.anima.variants.default.prompt.camera[0].description,'side view');
});

test('新来源须先读据，sources不替换原scope版本，公共来源返回稳定词键',async t=>{
  const f=await fixture(t);
  await createScene(f.root,'demo','room',{name:'Room'});
  const page=await createPage(f.root,'demo',{owner_kind:'character',character_id:'alice',variant_id:'default'});
  const target={kind:'page',id:page.page_id};
  const pageRead=await f.read(target);
  const source='scene:room:default';
  await assert.rejects(f.save(pageRead,{scene_id:'room',scene_variant_id:'default'}),{code:'prompt_source_read_required'});
  const sourceRead=await readPromptScopeSources({...f.options,target,source});
  assert.equal(sourceRead.save,undefined,'来源读取不能悄悄更新旧页面指纹');
  assert.match(sourceRead.source_versions[source],/^[a-f0-9]{64}$/);
  const saved=await f.save(pageRead,{scene_id:'room',scene_variant_id:'default'},{...pageRead.save.args.source_versions,...sourceRead.source_versions});
  assert.equal(saved.document.scene_id,'room');

  const base=await f.read(character('anima','base'));
  const next=await f.save(base,{identity:{prompt:{person:[{tag:'blue_jacket'}]}}});
  const inherited=await readPromptScopeSources({...f.options,target:character('anima')});
  assert.equal(inherited.sources[0].entries[0].key,'identity:'+next.document.identity.prompt.person[0].id);
  assert.equal(inherited.sources[0].entries[0].text,'blue_jacket');
  assert.ok(inherited.sources[0].entries.every(entry=>entry.key.startsWith('identity:')));
});

test('显式非活动模型只依赖自身来源，保留活动模型并明确审计未运行',async t=>{
  const f=await fixture(t);
  await f.save(await f.read(character('anima','base')),{identity:{prompt:{person:[{tag:'blue_jacket'}]}}});
  const page=await createPage(f.root,'demo',{owner_kind:'character',character_id:'alice',variant_id:'default'});
  const switchTo=async modelId=>{
    const {project,definition}=await readPageRenderDraft(f.root,'demo',page.page_id);
    await commitPageRender(f.root,{project_id:project.projectId,page_id:page.page_id,target:{relative_path:definition.targetRelative,sha256:hashCanonicalJson(definition.targetBaseline??definition.persisted)},upstream:definition.upstream},()=>({...definition.persisted,model_id:modelId,profile_id:modelId==='anima'?'anima-base-v1':'qwen-image-2-1'}));
  };
  await switchTo('anima');await switchTo('qwen');
  const inactive=await f.read({kind:'page',id:page.page_id,model_id:'anima'});
  const active=await f.read({kind:'page',id:page.page_id});
  await f.save(active,{text:'Keep the active branch.'});
  await f.save(await f.read(character('qwen','base')),{prompt_name:'Changed only in Qwen'});
  const result=await f.save(inactive,{camera:[{description:'wide view'}]});
  assert.deepEqual(result.audit,{status:'not_run',model_id:'anima',reason:'inactive_model'});
  assert.equal(result.document.camera[0].id,undefined);
  assert.equal((await f.read({kind:'page',id:page.page_id})).document.text,'Keep the active branch.');
});
