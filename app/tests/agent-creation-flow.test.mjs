import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import path from 'node:path';
import {createQwenFixtureProject} from './model-fixture.mjs';
import {readProjectCreationTemplate} from '../server/project-creation.mjs';
import {handleWorkbenchRequest} from '../server/workbench-http.mjs';
import {handleAgentRequest} from '../server/agent-http.mjs';
import {readPageIndex} from '../server/pages-store.mjs';
import {createCharacter} from '../server/character-facts.mjs';
import {executeWorkbench} from '../scripts/workbench-actions/index.mjs';
import {creationEditReceipt} from '../server/creation-edit-receipt.mjs';
import {mediaActions} from '../scripts/workbench-actions/media-actions.mjs';

async function fixture(t){
 const parent=fileURLToPath(new URL('../../Saved/Tests/',import.meta.url));await mkdir(parent,{recursive:true});
 const root=await mkdtemp(path.join(parent,'agent-create-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await createQwenFixtureProject(root,await readProjectCreationTemplate(root,'demo'));
 await createCharacter(root,'demo','alice',{name:'Alice'});
 async function request(decodedPath,body){
  const request=Readable.from([Buffer.from(JSON.stringify(body))]);request.method='POST';let result;
  const handler=decodedPath.startsWith('/api/agent/')?handleAgentRequest:handleWorkbenchRequest;
  assert.equal(await handler({request,decodedPath,projectRoot:root,
   readFacts:async(id,run)=>({value:await run({projectId:id,projectDirectory:path.join(root,'workspace',id)})}),
   mutateFacts:async(id,run)=>({value:await run({projectId:id})}),mutateTargetFacts:async(id,run)=>({value:await run({projectId:id})}),
   sendOperation:(status,r)=>{assert.equal(status,200);result=r.value;},
  }),true);return result;
 }
 return {root,request,create:(action,args)=>request(`/api/projects/demo/workbench/navigation/${action}`,args),agent:(action,args)=>request(`/api/agent/${action}`,{project_id:'demo',...args})};
}

test('创建时一次提交章节单元梗概和页面正文，回执可继续编辑，无效初始内容不留下半成品',async t=>{
 const f=await fixture(t);
 const chapter=await f.create('create-chapter',{title:'测试章节',summary:'已确认的章节梗概'});
 assert.equal(chapter.edit.document.summary,'已确认的章节梗概');
 const seq=await f.create('create-sequence',{chapter_id:chapter.chapter_id,title:'抵达',summary:'在车站见面'});
 assert.equal(seq.edit.document.summary,'在车站见面');
 await f.agent('facts/story/sequence/save',{...seq.edit.save.args,target_id:seq.sequence_id,document:{...seq.edit.document,summary:'在车站等候'}});
 const owner={owner_kind:'story',sequence_id:seq.sequence_id};
 const page=await f.create('create-page',{owner,content:{title:'等候',scene_description:'角色在车站等候',characters:[{character_id:'alice',variant_id:'default'}],dialogue:[{mode:'speech',speaker:'alice',text:'你好。'}]}});
 assert.equal(page.edit.document.title,'等候');assert.match(page.edit.document.dialogue[0].id,/^dialogue-/);
 const saved=await f.agent('page-editor/save',{...page.edit.save.args,changes:{title:'到站'}});
 assert.equal(saved.document.title,'到站');
 const directory=path.join(f.root,'workspace','demo'),before=await readPageIndex(directory);
 await assert.rejects(f.create('create-page',{owner,content:{dialogue:[{id:'dialogue-111111111111',mode:'speech',speaker:'alice',text:'bad'}]}}),{code:'invalid_page_document'});
 await assert.rejects(f.create('create-page',{owner,content:{page_kind:'text'}}),{code:'invalid_page_document'});
 assert.deepEqual(await readPageIndex(directory),before);
 const text=await f.create('create-page',{owner,page_kind:'text',content:{body:'翌日',display_title:'次日'}});
 assert.equal(text.edit.document.body,'翌日');assert.equal(text.edit.document.page_kind,'text');
 const context=await f.agent('story-context',{});
 assert.ok(context.chapters.some(c=>c.id===chapter.chapter_id&&c.sequences.some(s=>s.id===seq.sequence_id)));
 assert.equal(context.chapters.find(c=>c.id===chapter.chapter_id).summary,undefined);
 assert.equal((await f.agent('story-context',{sequence_id:seq.sequence_id})).chapter.summary,'已确认的章节梗概');
 await assert.rejects(f.agent('story-context',{sequence_id:'missing'}),{code:'story_outline_target_not_found'});
});

test('页面和 Prompt 读据区分错目标与过期，不写入错误目标',async t=>{
 const f=await fixture(t),owner={owner_kind:'character',character_id:'alice',variant_id:'default'};
 const a=await f.create('create-page',{owner}),b=await f.create('create-page',{owner});
 await assert.rejects(f.agent('page-editor/save',{...a.edit.save.args,page_key:b.page_key,changes:{title:'误写'}}),{code:'edit_receipt_target_mismatch'});
 assert.equal((await f.agent('page-editor',{page_key:b.page_key,section:'content'})).document.title,'验证图');
 await f.agent('page-editor/save',{...a.edit.save.args,changes:{title:'更新'}});
 await assert.rejects(f.agent('page-editor/save',{...a.edit.save.args,changes:{title:'过期'}}),{code:'page_edit_conflict'});
 const pa=await f.agent('prompt/read',{target:{kind:'page',id:a.page_id}});
 const pb=await f.agent('prompt/read',{target:{kind:'page',id:b.page_id}});
 await assert.rejects(f.agent('prompt/save',{...pa.save.args,target:pb.target,changes:{text:'误写'}}),{code:'edit_receipt_target_mismatch'});
 await f.agent('prompt/save',{...pa.save.args,changes:{text:'window'}});
 await assert.rejects(f.agent('prompt/save',{...pa.save.args,changes:{text:'stale'}}),{code:'prompt_scope_conflict'});
 await assert.rejects(f.agent('prompt/save',{...pa.save.args,expected_sha256:'0'.repeat(64),changes:{text:'old'}}),{code:'invalid_prompt_fingerprint'});
 const base=await f.agent('prompt/read',{target:{kind:'character',id:'alice',model_id:'anima',scope:'base'}});
 await assert.rejects(f.agent('prompt/save',{...base.save.args,target:{kind:'character',id:'alice',model_id:'anima',scope:'variant',variant_id:'default'},changes:{prompt:{person:[]}}}),{code:'edit_receipt_target_mismatch'});
});

test('单页帮助指出批量入口，创建契约接受初始内容且机位说明仍按需查询',async()=>{
 const prompt=await executeWorkbench({operation:'help',target:'prompt.read'});
 assert.match(prompt.summary,/prompt.batch.read/);
 const content=await executeWorkbench({operation:'help',target:'page.editor.read'});
 assert.match(content.summary,/page.editor.batch.read/);
 for(const target of ['chapter.create','sequence.create'])assert.ok((await executeWorkbench({operation:'help',target})).parameters.properties.summary);
 const page=await executeWorkbench({operation:'help',target:'page.create'});
 assert.ok(page.parameters.properties.content);assert.match(page.details,/edit.save/);assert.match(page.details,/prompt.batch.read/);
 const camera=await executeWorkbench({operation:'help',target:'prompt.save',topic:'camera'});
 assert.match(camera.details,/changes.camera_settings/);
});

test('创建已提交而回执读取失败时保留成功状态，错目标的恢复提示不误报为过期',async()=>{
 const next={operation:'page.editor.read',args:{project_id:'demo',page_key:{page_id:'page-a'},section:'content'}};
 const result=await creationEditReceipt(async()=>{throw Object.assign(new Error('failed'),{code:'ENOENT'});},next);
 assert.equal(result.saved,true);assert.equal(result.edit_error.code,'ENOENT');assert.deepEqual(result.next,next);
 assert.match(result.edit_error.message,/不要重复创建/);
 const args=next.args;
 const wrong=mediaActions['page.editor.save'].recover({status:409,code:'edit_receipt_target_mismatch'},args);
 assert.match(wrong.message,/其他目标/);assert.doesNotMatch(wrong.message,/已变化/);assert.deepEqual(wrong.next,next);
 const stale=mediaActions['page.editor.save'].recover({status:409,code:'page_edit_conflict'},args);
 assert.match(stale.message,/版本.*不匹配/);
 const corrupt=mediaActions['page.editor.save'].recover({status:400,code:'edit_receipt_corrupted'},args);
 assert.match(corrupt.message,/转写错误/);assert.deepEqual(corrupt.next,next);
});
