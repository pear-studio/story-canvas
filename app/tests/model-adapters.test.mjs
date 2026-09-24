import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { modelAdapter, profileModelAdapter } from '../server/model-adapters.mjs';
import { readResolvedRenderProfile } from '../server/render-profile-compiler.mjs';
import { pageSettingsFromDefaults, readPageRenderSettings } from '../server/page-render-settings.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
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
  const first=pageSettingsFromDefaults(project);project.canvas='4:3';project.default_render_profile='qwen-image-2-1';
  await writeFile(path.join(dir,'pages/page-001.render.json'),JSON.stringify(first));
  assert.deepEqual(await readPageRenderSettings(dir,'page-001',project),{version:1,profile_id:'anima-base-v1',canvas:'2:3'});
  await assert.rejects(readPageRenderSettings(dir,'page-002',project),e=>e.code==='page_render_settings_missing');
});
