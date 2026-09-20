import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {savePage,movePage,duplicatePage} from '../server/page-facts.mjs';
import {readPageContent,readPagePrompt,PAGES_INDEX_SCHEMA_ID} from '../server/pages-store.mjs';
import {readStoryPromptUpstream} from '../server/story-facts.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';
import {STORY_OUTLINE_SCHEMA_ID,STORY_PAGE_NARRATIVE_SCHEMA_ID,STORY_PAGE_PROMPT_SCHEMA_ID,storyPromptCategories} from '../server/story-files.mjs';
import {emptyLetteringDocument} from '../server/lettering-document.mjs';
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'unified-save-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'workspace','test');
 const write=async(relative,value)=>{const file=path.join(directory,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
 await write('project.json',{title:'测试',canvas:'2:3'});
 await write('story/outline.json',{$schema:STORY_OUTLINE_SCHEMA_ID,synopsis:'测试',chapters:[{id:'chapter',title:'章',summary:'摘要',sequences:[{id:'a',title:'一',summary:'摘要'},{id:'b',title:'二',summary:'摘要'}]}]});
 await write('characters/index.json',{$schema:'https://storyvisualizer.local/schemas/character-index.schema.json',characters:[]});
 await write('scenes/index.json',{$schema:'https://storyvisualizer.local/schemas/scene-index.schema.json',scenes:[]});
 await write('pages/index.json',{$schema:PAGES_INDEX_SCHEMA_ID,pages:[{page_id:'page-001',owner_kind:'scene',scene_id:'removed',variant_id:'default'}]});
 await write('pages/page-001.content.json',{$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,title:'验证',scene_description:'',characters:[],dialogue:[]});
 await write('pages/page-001.prompt.json',{$schema:STORY_PAGE_PROMPT_SCHEMA_ID,...Object.fromEntries(storyPromptCategories.map(key=>[key,[]]))});
 async function request(){const content=await readPageContent(directory,'page-001'),prompt=await readPagePrompt(directory,'page-001');return {page_key:{page_id:'page-001'},content,prompt,expected_content_sha256:hashCanonicalJson(content),expected_prompt_sha256:hashCanonicalJson(prompt),expected_context_sha256:hashCanonicalJson(await readStoryPromptUpstream(directory,'page-001'))};}
 registerFixtureProjects(root); return {root,directory,write,request};
}
test('整页保存同时分配对白ID并映射布局，失效归属不阻止编辑',async t=>{
 const f=await fixture(t),request=await f.request();request.content.title='新标题';request.content.dialogue=[{id:'draft-dialogue-0',mode:'speech',speaker:'npc',text:'你好'}];
 request.lettering={items:[{dialogue_id:'draft-dialogue-0',box:{x:.1,y:.1,w:.3,h:.2}}]};request.expected_layout_sha256=hashCanonicalJson(emptyLetteringDocument());
 const result=await savePage(f.root,'test',request);assert.match(result.content.dialogue[0].id,/^dialogue-[a-f0-9]{12}$/);assert.equal(result.lettering.items[0].dialogue_id,result.content.dialogue[0].id);
 assert.equal((await readPageContent(f.directory,'page-001')).title,'新标题');
});
test('整页保存先验证所有草稿，布局失败不留下内容或Prompt半次保存',async t=>{
 const f=await fixture(t),request=await f.request(),before=await readPageContent(f.directory,'page-001');request.content.title='不会落盘';request.content.dialogue=[{id:'draft-dialogue-0',mode:'speech',speaker:'npc',text:'你好'}];
 request.prompt.setting=[{tag:'sky'}];request.lettering={items:[{dialogue_id:'draft-dialogue-0',box:{x:-1,y:.1,w:.3,h:.2}}]};request.expected_layout_sha256=hashCanonicalJson(emptyLetteringDocument());
 await assert.rejects(savePage(f.root,'test',request),error=>error.code==='invalid_page_document');assert.deepEqual(await readPageContent(f.directory,'page-001'),before);assert.deepEqual((await readPagePrompt(f.directory,'page-001')).setting,[]);
});
test('整页保存拒绝陈旧Prompt且保留失效实际引用与绑定供修复',async t=>{
 const f=await fixture(t),request=await f.request();request.content.characters=[{character_id:'missing',variant_id:'default'}];request.prompt.person=[{tag:'standing',character_id:'missing'}];
 await savePage(f.root,'test',request);
 const next=await f.request();next.content.characters=[];next.content.title='修复中';await savePage(f.root,'test',next);
 assert.equal((await readPagePrompt(f.directory,'page-001')).person[0].character_id,'missing');
 await assert.rejects(savePage(f.root,'test',request),error=>error.code.endsWith('_conflict'));
});
test('重新归属只更改索引，复制保留内容和布局但不复制生成媒体',async t=>{
 const f=await fixture(t),before=await readPagePrompt(f.directory,'page-001');await movePage(f.root,'test','page-001',{owner_kind:'story',sequence_id:'b'});
 assert.deepEqual(await readPagePrompt(f.directory,'page-001'),before);const result=await duplicatePage(f.root,'test','page-001');assert.notEqual(result.page_id,'page-001');
 assert.deepEqual(await readPagePrompt(f.directory,result.page_id),before);
 const index=JSON.parse(await readFile(path.join(f.directory,'pages/index.json'),'utf8'));assert.equal(index.pages.find(page=>page.page_id===result.page_id).sequence_id,'b');
});
test('引用切换影响确认与新对白同时保存时确认指纹稳定',async t=>{
 const f=await fixture(t),categories=Object.fromEntries(storyPromptCategories.map(key=>[key,[]]));
 await f.write('scenes/index.json',{$schema:'https://storyvisualizer.local/schemas/scene-index.schema.json',scenes:['park']});
 await f.write('scenes/park.profile.json',{$schema:'https://storyvisualizer.local/schemas/scene-profile.schema.json',name:'公园',description:''});
 await f.write('scenes/park.visual.json',{$schema:'https://storyvisualizer.local/schemas/scene-visual.schema.json',variants:[{id:'default',name:'默认'}]});
 await f.write('scenes/park.prompt.json',{$schema:'https://storyvisualizer.local/schemas/scene-prompt.schema.json',identity:{prompt:{...categories,setting:[{tag:'tree'}]},lora:null},variants:{default:{prompt:categories,loras:[],identity_disabled:[]}}});
 await f.write('pages/page-001.prompt.json',{$schema:STORY_PAGE_PROMPT_SCHEMA_ID,...categories,scene_id:'park',scene_variant_id:'default',inheritance:{'scene:park:default':{tree:{weight:2}}}});
 const request=await f.request();delete request.prompt.scene_id;delete request.prompt.scene_variant_id;
 request.content.dialogue=[{id:'draft-dialogue-0',mode:'speech',speaker:'npc',text:'你好'}];
 await assert.rejects(savePage(f.root,'test',request),error=>{assert.equal(error.code,'inheritance_confirmation_required');request.confirmation_sha256=error.details[0].confirmation_sha256;return true;});
 const result=await savePage(f.root,'test',request);assert.equal(result.content.dialogue[0].text,'你好');assert.equal(result.prompt.scene_id,undefined);
});
test('新对白出处映射到正式ID，heart出处被拒绝且不落盘',async t=>{
 const f=await fixture(t),request=await f.request();const corpus=path.join(f.root,'library/writing-corpus');await mkdir(corpus,{recursive:true});await writeFile(path.join(corpus,'test.txt'),'你好');
 request.content.dialogue=[{id:'draft-dialogue-0',mode:'speech',speaker:'npc',text:'你好'}];request.text_sources={'draft-dialogue-0':{source_file:'test.txt',offset:0,original_sentence:'你好'}};request.expected_text_sources_sha256=hashCanonicalJson({});
 const result=await savePage(f.root,'test',request);const sources=JSON.parse(await readFile(path.join(f.directory,'pages/page-001.text-sources.json'),'utf8'));assert.deepEqual(Object.keys(sources),[result.content.dialogue[0].id]);
 const next=await f.request();next.content.dialogue[0].mode='heart';delete next.content.dialogue[0].speaker;await assert.rejects(savePage(f.root,'test',next),error=>error.code==='invalid_text_source_reference');assert.equal((await readPageContent(f.directory,'page-001')).dialogue[0].mode,'speech');
});
test('文字页不能移到设定，活动成品任务阻止删除页面',async t=>{
 const f=await fixture(t);await f.write('scenes/index.json',{$schema:'https://storyvisualizer.local/schemas/scene-index.schema.json',scenes:['park']});await f.write('scenes/park.visual.json',{variants:[{id:'default'}]});
 const content=await readPageContent(f.directory,'page-001');content.page_kind='text';content.body='正文';await f.write('pages/page-001.content.json',content);
 await assert.rejects(movePage(f.root,'test','page-001',{owner_kind:'scene',scene_id:'park',variant_id:'default'}),error=>error.code==='text_page_story_only');
 await f.write('Saved/finished/active.json',{id:'active',page_id:'page-001',status:'lettering',pid:process.pid});
 const {deletePage}=await import('../server/page-facts.mjs');await assert.rejects(deletePage(f.root,'test','page-001'),error=>error.code==='page_finished_output_busy');assert.deepEqual(await readPageContent(f.directory,'page-001'),content);
});
