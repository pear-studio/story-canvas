import {writeQwenFixtureJson, qwenDocument} from './helpers/qwen-fixture.mjs';
import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readProjectWorkbenchView} from '../server/project-workbench.mjs';
import {capturePagePromptSnapshot,resolveExactPageIdentity} from '../server/page-render-resolver.mjs';
import {defaultLetteringSettings} from '../server/lettering-settings.mjs';
import {STORY_PAGE_NARRATIVE_SCHEMA_ID,STORY_PAGE_PROMPT_SCHEMA_ID,STORY_OUTLINE_SCHEMA_ID} from '../server/story-files.mjs';
import {PAGES_INDEX_SCHEMA_ID} from '../server/pages-store.mjs';
import {CHARACTER_INDEX_SCHEMA_ID,CHARACTER_PROFILE_SCHEMA_ID,CHARACTER_VISUAL_SCHEMA_ID,CHARACTER_PROMPT_SCHEMA_ID} from '../server/character-files.mjs';
import {SCENE_INDEX_SCHEMA_ID} from '../server/scene-files.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'unified-resolution-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'workspace','demo');
 const write=async (relative,value)=>{const file=path.join(directory,relative);await mkdir(path.dirname(file),{recursive:true});await writeQwenFixtureJson(file,value);};
 await write('project.json',{format:'story-models-v1',title:'测试',canvas:'2:3',default_render_profile:'missing-profile'});
 await write('story/outline.json',{$schema:STORY_OUTLINE_SCHEMA_ID,synopsis:'测试',chapters:[{id:'chapter',title:'章节',summary:'测试',sequences:[{id:'sequence',title:'单元',summary:'测试'}]}]});
 await write('characters/index.json',{$schema:CHARACTER_INDEX_SCHEMA_ID,characters:[]});
 await write('scenes/index.json',{$schema:SCENE_INDEX_SCHEMA_ID,scenes:[]});
 await write('lettering/settings.json',defaultLetteringSettings());
 await write('pages/index.json',{$schema:PAGES_INDEX_SCHEMA_ID,pages:[{page_id:'page-001',owner_kind:'character',character_id:'deleted-owner',variant_id:'default'},{page_id:'page-002',owner_kind:'scene',scene_id:'deleted-scene',variant_id:'default'}]});
 const prompt={$schema:STORY_PAGE_PROMPT_SCHEMA_ID,text:''};
 for(const id of ['page-001','page-002']) {
  await write(`pages/${id}.content.json`,{$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,title:'验证',scene_description:'空旷环境',characters:[],dialogue:[]});
  await write(`pages/${id}.prompt.json`,prompt);
 }
 registerFixtureProjects(root); return {root,directory,write,prompt};
}
test('失效设定归属页面仍可读取且生成不会推导归属角色',async t=>{
 const {root,directory}=await fixture(t);
 const view=await readProjectWorkbenchView(root,'demo');
 assert.equal(view.pages.length,2);assert.equal(view.orphan_pages.length,2);
 assert.deepEqual(view.pages[0].characters,[]);
 assert.equal(view.pages[1].scene_id,'deleted-scene');
 for(const page of view.pages) {
  const snapshot=await capturePagePromptSnapshot(directory,page.page_id,page.page_key);
  assert.deepEqual(snapshot.characters,[]);assert.deepEqual(snapshot.character_references,[]);
  assert.deepEqual(snapshot.reference_errors,[]);
  assert.equal((await resolveExactPageIdentity(directory,page.page_key)).kind,page.kind);
 }
});
test('缺失画面引用保留在工作台并阻止有效Prompt，而不使页面读取失败',async t=>{
 const {root,directory,write,prompt}=await fixture(t);
 await write('pages/page-001.content.json',{$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,title:'验证',scene_description:'空旷环境',characters:[{character_id:'missing',variant_id:'default'}],dialogue:[]});
 await write('pages/page-001.prompt.json',{...prompt,scene_id:'missing-scene',scene_variant_id:'default'});
 const view=await readProjectWorkbenchView(root,'demo');
 assert.equal(view.pages[0].characters[0].character_id,'missing');
 assert.ok(view.diagnostics.some(item=>item.code==='dangling_scene_reference'));
 const snapshot=await capturePagePromptSnapshot(directory,'page-001');
 assert.ok(snapshot.reference_errors.some(message=>message.includes('missing')));
 assert.ok(snapshot.reference_errors.some(message=>message.includes('missing-scene')));
});

test('角色归属页按显式画面引用解析其他角色，不读取所属设定',async t=>{
 const {directory,write,prompt}=await fixture(t);
 await write('characters/index.json',{$schema:CHARACTER_INDEX_SCHEMA_ID,characters:['guest']});
 await write('characters/guest.profile.json',{$schema:CHARACTER_PROFILE_SCHEMA_ID,name:'访客',description:'访客'});
 await write('characters/guest.visual.json',{$schema:CHARACTER_VISUAL_SCHEMA_ID,variants:[{id:'default',name:'默认'}]});
 await write('characters/guest.prompt.json',{$schema:CHARACTER_PROMPT_SCHEMA_ID,prompt_name:'访客',variants:{default:{text:'访客外观。',reference_images:[]}}});
 await write('pages/page-001.content.json',{$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,title:'访客',scene_description:'访客站立',characters:[{character_id:'guest',variant_id:'default'}],dialogue:[]});
 const snapshot=await capturePagePromptSnapshot(directory,'page-001');
 assert.equal(snapshot.owner_id,'deleted-owner');
 assert.deepEqual(snapshot.characters.map(character=>character.id),['guest']);
 assert.deepEqual(snapshot.reference_errors,[]);
});
