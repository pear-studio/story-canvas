import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,rm,readFile} from 'node:fs/promises';
import {createQwenFixtureProject} from './model-fixture.mjs';
import {readProjectCreationTemplate} from '../server/project-creation.mjs';
import {createCharacter} from '../server/character-facts.mjs';
import {createScene} from '../server/scene-facts.mjs';
import {createPage} from '../server/page-facts.mjs';
import {saveSetting} from '../server/setting-save.mjs';
import {readWorkbenchSettingDetail} from '../server/project-workbench.mjs';
import {readPromptScope,savePromptScope} from '../server/prompt-scope.mjs';
import {reconcileDraft} from '../shared/reconcile-draft.mjs';

async function fixture(t,kind='character') {
  const parent=fileURLToPath(new URL('../../Saved/Tests/',import.meta.url));await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'setting-save-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await createQwenFixtureProject(root,await readProjectCreationTemplate(root,'demo'));
  await (kind==='character'?createCharacter:createScene)(root,'demo','alice',{name:'Alice'});
  const directory=path.join(root,'workspace','demo');
  const target=(model_id='qwen',scope='base')=>({kind,id:'alice',model_id,scope,...(scope==='variant'?{variant_id:'default'}:{})});
  const read=()=>readWorkbenchSettingDetail(directory,'demo',kind,'alice');
  const save=(value)=>saveSetting(root,'demo',value);
  return {root,directory,target,read,save};
}
test('保守合并只合并独立字段；同字段和 Prompt 不拼接',()=>{
  assert.deepEqual(reconcileDraft({name:'A',description:'a'},{name:'B',description:'a'},{name:'A',description:'b'},['name','description']),{value:{name:'B',description:'b'},discarded:false});
  assert.equal(reconcileDraft({name:'A'},{name:'B'},{name:'C'},['name']).discarded,true);
  assert.equal(reconcileDraft({text:'a'},{text:'b'},{text:'c'}).discarded,true);
});
for(const kind of ['character','scene'])test(`${kind} 基础保存原子提交，独立名称与描述安全合并`,async t=>{
  const f=await fixture(t,kind),before=await f.read(),baseline={name:before.name,description:before.description};
  await f.save({target:f.target(),profile:{baseline,value:{...baseline,description:'external'}}});
  const result=await f.save({target:f.target(),profile:{baseline,value:{...baseline,name:'Renamed'}},prompt:{prompt_name:'New prompt name'},expected_prompt_sha256:before.prompt_scope_versions.qwen.base});
  assert.equal(result.setting.name,'Renamed');assert.equal(result.setting.description,'external');assert.equal(result.setting.prompt.prompt_name,'New prompt name');
  await assert.rejects(f.save({target:f.target(),profile:{baseline,value:{...baseline,name:'obsolete'}},prompt:{prompt_name:'must not persist'},expected_prompt_sha256:result.setting.prompt_scope_versions.qwen.base}),{code:'setting_scope_conflict',refresh_required:true});
  assert.equal((await f.read()).prompt.prompt_name,'New prompt name');
});
for(const kind of ['character','scene'])test(`${kind} ID、名称、Prompt 一次提交并更新页面引用`,async t=>{
  const f=await fixture(t,kind),page=await createPage(f.root,'demo',{owner_kind:kind,[`${kind}_id`]:'alice',variant_id:'default'}),before=await f.read();
  const request={target:f.target('qwen','variant'),variant:{baseline:{id:'default',name:before.visual.variants[0].name},value:{id:'day',name:'白天'}},prompt:{text:'sunny portrait'},expected_prompt_sha256:before.prompt_scope_versions.qwen.variants.default};
  await assert.rejects(f.save({...request,prompt:{text:42}}));
  assert.equal((await f.read()).visual.variants[0].id,'default','Prompt 无效时不先改 ID');
  const saved=await f.save(request);
  assert.equal(saved.setting.visual.variants[0].id,'day');assert.equal(saved.setting.prompt.variants.day.text,'sunny portrait');
  const index=JSON.parse(await readFile(path.join(f.directory,'pages/index.json'),'utf8'));
  assert.equal(index.pages.find(p=>p.page_id===page.page_id).variant_id,'day');
  assert.equal((await f.read()).prompt.variants.default,undefined);
});
test('Anima 上游变更拒绝旧子设定且不保存附带名称；Qwen 独立范围继续保存',async t=>{
  const f=await fixture(t),options={projectRoot:f.root,projectId:'demo'};
  const base=await readPromptScope({...options,target:f.target('anima')});
  await savePromptScope({...options,target:base.target,expectedSha256:base.save.args.expected_sha256,changes:{identity:{prompt:{person:[{tag:'blue_eyes'}]}}}});
  const before=await f.read(),variant=await readPromptScope({...options,target:f.target('anima','variant')});
  const newer=await readPromptScope({...options,target:f.target('anima')});
  await savePromptScope({...options,target:newer.target,expectedSha256:newer.save.args.expected_sha256,changes:{identity:{prompt:{person:[{tag:'red_eyes'}]}}}});
  await assert.rejects(f.save({target:variant.target,prompt:variant.document,expected_prompt_sha256:variant.save.args.expected_sha256,variant:{baseline:{id:'default',name:before.visual.variants[0].name},value:{id:'default',name:'不保存'}}}),{code:'prompt_scope_conflict',refresh_required:true});
  const saved=await f.save({target:f.target('qwen','variant'),prompt:{text:'still independent'},expected_prompt_sha256:before.prompt_scope_versions.qwen.variants.default});
  assert.equal(saved.setting.visual.variants[0].name,before.visual.variants[0].name);
  assert.equal(saved.setting.model_prompts.models.anima.identity.prompt.person[0].tag,'red_eyes');
});

for(const kind of ['character','scene'])for(const model of ['qwen','anima'])test(`${kind} 从 ${model} 改名保留已有 Anima 词条身份`,async t=>{
  const f=await fixture(t,kind),options={projectRoot:f.root,projectId:'demo'};
  const original=await readPromptScope({...options,target:f.target('anima','variant')});
  await savePromptScope({...options,target:original.target,expectedSha256:original.save.args.expected_sha256,changes:{prompt:{setting:[{tag:'sunlight'}]}}});
  const before=await f.read(),scope=await readPromptScope({...options,target:f.target(model,'variant')});
  const fragment=before.model_prompts.models.anima.variants.default.prompt.setting[0];
  const prompt=structuredClone(scope.document);
  if(model==='anima')prompt.prompt.setting[0].weight=1.2;
  else prompt.text='updated Qwen description';
  const value={target:scope.target,variant:{baseline:{id:'default',name:before.visual.variants[0].name},value:{id:'day',name:'白天'}},prompt,expected_prompt_sha256:scope.save.args.expected_sha256};
  // 改名不能放宽词条身份校验，也不能在校验失败时留下部分改名。
  if(model==='anima'){
    const invalid=structuredClone(value);invalid.prompt.prompt.setting[0].id='token-123456789abc';
    await assert.rejects(f.save(invalid),{code:'invalid_prompt_fragment'});
    assert.equal((await f.read()).visual.variants[0].id,'default');
  }
  await f.save(value);
  const after=await f.read(),variants=after.model_prompts.models.anima.variants;
  assert.equal(variants.default,undefined);
  assert.equal(variants.day.prompt.setting[0].id,fragment.id);
  assert.equal(variants.day.prompt.setting[0].tag,fragment.tag);
  if(model==='anima')assert.equal(variants.day.prompt.setting[0].weight,1.2);
  else assert.equal(after.model_prompts.models.qwen.variants.day.text,'updated Qwen description');
});
