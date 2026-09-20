// 调用方持有项目写锁。本模块统一页面生命周期及整页提交，归属不参与生成引用推导。
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, rename, lstat } from 'node:fs/promises';
import { resolveProjectLocation } from './project-operations.mjs';
import { decodePageKey } from './page-key.mjs';
import { readPageIndex, readPageEntry, readPageContent, readPagePrompt, pageRelativePath, validatePagesIndexDocument } from './pages-store.mjs';
import { FactError, factStorage as storage, readStoryPromptUpstream, narrativeDownstreamDiagnostics } from './story-facts.mjs';
import { STORY_PAGE_NARRATIVE_SCHEMA_ID, STORY_PAGE_PROMPT_SCHEMA_ID, storyPromptCategories, validateStoryPageNarrativeDocument, validateStoryPagePromptDocument, validateStoryPageTextSourcesDocument, prepareStoryPageNarrativeForPersistence, preparePromptForPersistence } from './story-files.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { commitFactChanges, applySceneSwitch, sourceSwitchImpacts, requireImpactConfirmation, readInheritanceSources, checkPageInheritance } from './prompt-inheritance-facts.mjs';
import { listFinishedJobs, finishedBusyStatuses } from './finished-jobs.mjs';
import { assertNoActivePageRender } from './render-task-storage.mjs';
import { materializeVisualPageTemplate, readVisualPageTemplates } from './visual-page-templates.mjs';
import { emptyLetteringDocument, validatePageLettering, validateLetteringDocument } from './lettering-document.mjs';
import { defaultTextPageLayout } from '../shared/text-page-layout.mjs';
import { storyContentWarnings } from '../shared/story-content-guidance.mjs';
import { preparePromptWriteAudit, capturePromptAuditInput, auditSavedPagePrompt } from './prompt-write-audit.mjs';
import { capturePagePromptSnapshot } from './page-render-resolver.mjs';
import { verifyWritingCorpusSentence } from './writing-corpus.mjs';
const fail=(code,details=[])=>{throw new FactError(code,details);};
const assertValid=errors=>{if(errors.length)fail('invalid_page_document',errors);};
const clone=value=>structuredClone(value);
async function optionalJson(directory,relative,fallback=null) {try{return JSON.parse(await readFile(path.join(directory,relative),'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
function publicDocument(document) {const {$schema,...value}=document;return clone(value);}
async function projectAt(root,id) {return resolveProjectLocation(path.resolve(root),id);}
async function requirePage(directory,id) {const entry=await readPageEntry(directory,id);if(!entry)fail('page_not_found',[id]);return entry;}
export async function assertPageOwner(directory,owner) {
  assertValid(validatePagesIndexDocument({$schema:'https://storyvisualizer.local/schemas/pages-index.schema.json',pages:[{page_id:'page-001',...owner}]}));
  if(owner.owner_kind==='story') {
    const outline=await optionalJson(directory,'story/outline.json');
    if(!outline?.chapters.some(chapter=>chapter.sequences.some(sequence=>sequence.id===owner.sequence_id)))fail('story_sequence_not_found',[owner.sequence_id]);
  } else {
    const folder=owner.owner_kind==='character'?'characters':'scenes';
    const id=owner.character_id??owner.scene_id;
    const index=await optionalJson(directory,`${folder}/index.json`);
    if(!index?.[folder]?.includes(id))fail('page_owner_not_found',[id]);
    const visual=await optionalJson(directory,`${folder}/${id}.visual.json`);
    if(!visual?.variants.some(variant=>variant.id===owner.variant_id))fail('page_owner_variant_not_found',[id,owner.variant_id]);
  }
}
function sameOwner(a,b) {return ['owner_kind','sequence_id','character_id','scene_id','variant_id'].every(key=>a[key]===b[key]);}
function insertEntry(index,entry,{afterPageId=null,beforePageId=null}={}) {
  const anchor=beforePageId??afterPageId;
  let position=index.pages.length;
  if(anchor!==null){position=index.pages.findIndex(page=>page.page_id===anchor&&sameOwner(page,entry));if(position<0)fail('page_anchor_not_found',[anchor]);if(beforePageId===null)position++;}
  else {const last=index.pages.findLastIndex(page=>sameOwner(page,entry));if(last>=0)position=last+1;}
  index.pages.splice(position,0,entry);
}
async function newPageId(directory,index) {
  for(;;){const id=`page-${randomBytes(6).toString('hex')}`;if(index.pages.some(page=>page.page_id===id))continue;
    if(await lstat(path.join(directory,pageRelativePath(id,'content'))).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error)))continue;return id;}
}
export async function createPage(root,projectId,owner,{templateId=null,afterPageId=null,pageKind=null,characterId,variantId,beforeCommit}={}) {
  const project=await projectAt(root,projectId), directory=project.projectDirectory;
  await assertPageOwner(directory,owner);
  if(pageKind!==null&&pageKind!=='text')fail('invalid_page_kind');
  if(pageKind==='text'&&templateId!==null)fail('invalid_page_kind',['文字页不支持模板']);
  if(pageKind==='text'&&owner.owner_kind!=='story')fail('text_page_story_only');
  const index=await readPageIndex(directory), next=clone(index),id=await newPageId(directory,index);
  let content={$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,title:owner.owner_kind==='story'?'未命名页面':'验证图',scene_description:owner.owner_kind==='story'?'待补充画面内容。':'',characters:[],dialogue:[]};
  let prompt={$schema:STORY_PAGE_PROMPT_SCHEMA_ID,...Object.fromEntries(storyPromptCategories.map(category=>[category,[]]))};
  const reference=owner.owner_kind==='character'?{character_id:owner.character_id,variant_id:owner.variant_id}:characterId?{character_id:characterId,variant_id:variantId}:null;
  if(reference)content.characters.push(reference);
  if(owner.owner_kind==='scene'){prompt.scene_id=owner.scene_id;prompt.scene_variant_id=owner.variant_id;}
  if(pageKind==='text')Object.assign(content,{page_kind:'text',body:'',display_title:'',text_layout:clone(defaultTextPageLayout)});
  if(templateId!==null){
    const catalog=await readVisualPageTemplates(root);if(catalog.errors.length)fail('page_template_invalid',catalog.errors);
    const template=catalog.templates.find(item=>item.id===templateId&&item.applies_to.includes(owner.owner_kind));if(!template)fail('page_template_not_found',[templateId]);
    const materialized=materializeVisualPageTemplate(template,reference?.character_id);
    content.title=materialized.title;content.scene_description=materialized.visual_goal;prompt={...prompt,...materialized.prompt};
  }
  prompt=preparePromptForPersistence(prompt,{createFragmentId:()=>`token-${randomBytes(6).toString('hex')}`});
  assertValid(validateStoryPageNarrativeDocument(content));assertValid(validateStoryPagePromptDocument(prompt));
  insertEntry(next,{page_id:id,...owner},{afterPageId});
  if(beforeCommit)await beforeCommit({page_id:id,content_file:path.join(directory,pageRelativePath(id,'content')),prompt_file:path.join(directory,pageRelativePath(id,'prompt')),index_file:path.join(directory,'pages/index.json')});
  await commitFactChanges(directory,[{relative:pageRelativePath(id,'content'),before:null,after:content},{relative:pageRelativePath(id,'prompt'),before:null,after:prompt},{relative:'pages/index.json',before:index,after:next}]);
  return {page_id:id,page_key:{page_id:id},...owner,template_id:templateId,content_file:path.join(directory,pageRelativePath(id,'content')),prompt_file:path.join(directory,pageRelativePath(id,'prompt')),index_file:path.join(directory,'pages/index.json')};
}
export async function movePage(root,projectId,pageId,owner,{beforePageId=null}={}) {
  const {projectDirectory:directory}=await projectAt(root,projectId);await assertPageOwner(directory,owner);
  const index=await readPageIndex(directory),source=index.pages.find(page=>page.page_id===pageId);if(!source)fail('page_not_found',[pageId]);
  const content=await readPageContent(directory,pageId);
  if(content.page_kind==='text'&&owner.owner_kind!=='story')fail('text_page_story_only');
  if(beforePageId===pageId){if(!sameOwner(source,owner))fail('page_anchor_not_found',[beforePageId]);return {page_id:pageId,...owner};}
  const next=clone(index);next.pages=next.pages.filter(page=>page.page_id!==pageId);insertEntry(next,{page_id:pageId,...owner},{beforePageId});
  await commitFactChanges(directory,[{relative:'pages/index.json',before:index,after:next}]);return {page_id:pageId,page_key:{page_id:pageId},...owner};
}
export async function duplicatePage(root,projectId,pageId) {
  const {projectDirectory:directory}=await projectAt(root,projectId),index=await readPageIndex(directory),source=await requirePage(directory,pageId);
  const id=await newPageId(directory,index),next=clone(index);insertEntry(next,{...source,page_id:id},{afterPageId:pageId});
  const content=await readPageContent(directory,pageId),prompt=await readPagePrompt(directory,pageId);content.title+=' 副本';
  const writes=[{relative:pageRelativePath(id,'content'),before:null,after:content},{relative:pageRelativePath(id,'prompt'),before:null,after:prompt}];
  const sources=await optionalJson(directory,pageRelativePath(pageId,'text-sources'));if(sources)writes.push({relative:pageRelativePath(id,'text-sources'),before:null,after:sources});
  const layouts=await optionalJson(directory,'lettering/dialogue-layouts.json');const layout=layouts?.pages.find(item=>item.page===pageId);
  if(layout){const updated=clone(layouts);updated.pages.push({...clone(layout),page:id});writes.push({relative:'lettering/dialogue-layouts.json',before:layouts,after:updated});}
  writes.push({relative:'pages/index.json',before:index,after:next});await commitFactChanges(directory,writes);
  return {page_id:id,page_key:{page_id:id},source_page_id:pageId};
}
export async function deletePage(root,projectId,pageId,{beforeCommit}={}) {
  const project=await projectAt(root,projectId),directory=project.projectDirectory;
  const index=await readPageIndex(directory),entry=await requirePage(directory,pageId);
  await assertNoActivePageRender(directory,{page_id:pageId});
  if((await listFinishedJobs(directory)).some(job=>job.page_id===pageId&&finishedBusyStatuses.has(job.status)))fail('page_finished_output_busy',[pageId]);
  const deletionId=`deleted-${randomBytes(6).toString('hex')}`,archive=path.join(path.resolve(root),'Saved/state/deleted-pages',project.projectId,deletionId);
  const descriptors=[...['content','prompt','text-sources'].map(kind=>pageRelativePath(pageId,kind)),`Outputs/pages/${pageId}`];
  const siblings=index.pages.filter(page=>sameOwner(page,entry)),ordinal=siblings.findIndex(page=>page.page_id===pageId);
  const position={ordinal,previous_page_id:siblings[ordinal-1]?.page_id??null,next_page_id:siblings[ordinal+1]?.page_id??null};
  if(beforeCommit)await beforeCommit();
  const moved=[];await mkdir(archive,{recursive:true});
  const next=clone(index);next.pages=next.pages.filter(page=>page.page_id!==pageId);
  const layouts=await optionalJson(directory,'lettering/dialogue-layouts.json');const writes=[{relative:'pages/index.json',before:index,after:next}];
  if(layouts)writes.push({relative:'lettering/dialogue-layouts.json',before:layouts,after:{...layouts,pages:layouts.pages.filter(page=>page.page!==pageId)}});
  try {
    for(const relative of descriptors){const source=path.join(directory,relative);if(!await lstat(source).catch(error=>error.code==='ENOENT'?null:Promise.reject(error)))continue;const target=path.join(archive,relative);await mkdir(path.dirname(target),{recursive:true});await rename(source,target);moved.push({source,target,relative});}
    await storage.writeJsonAtomic(path.join(archive,'deletion.json'),{version:1,deletion_id:deletionId,project_id:project.projectId,...entry,...position,deleted_at:new Date().toISOString(),archived_paths:moved.map(item=>item.relative)});
    await commitFactChanges(directory,writes);
  } catch(error){for(const item of moved.reverse())await rename(item.target,item.source);throw error;}
  return {page_id:pageId,deletion_id:deletionId,archive_directory:archive,archived_paths:moved.map(item=>item.relative)};
}
function checkHash(document,expected,code) {if(!/^[a-f0-9]{64}$/.test(expected??'')||hashCanonicalJson(document)!==expected)fail(code);}
// 所有验证和引用切换确认先完成，再通过同一事实提交一次落盘；失败回滚由 commitFactChanges 负责。
export async function savePage(root,projectId,value) {
  const allowed=new Set(['page_key','content','prompt','expected_content_sha256','expected_prompt_sha256','expected_context_sha256','lettering','expected_layout_sha256','text_sources','expected_text_sources_sha256','confirmation_sha256']);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.has(key))||!value.content||typeof value.content!=='object'||Array.isArray(value.content)||!value.prompt||typeof value.prompt!=='object'||Array.isArray(value.prompt))fail('invalid_page_document',['整页保存需要 content 和 prompt 对象']);
  const pageKey=decodePageKey(value.page_key),pageId=pageKey.page_id;
  const {projectDirectory:directory}=await projectAt(root,projectId);await requirePage(directory,pageId);
  const beforeContent=await readPageContent(directory,pageId),beforePrompt=await readPagePrompt(directory,pageId);
  checkHash(beforeContent,value.expected_content_sha256,'page_content_target_conflict');checkHash(beforePrompt,value.expected_prompt_sha256,'page_prompt_target_conflict');
  const upstream=await readStoryPromptUpstream(directory,pageId);checkHash(upstream,value.expected_context_sha256,'page_prompt_upstream_conflict');
  const contentInput=clone(value.content);
  const draftIds=(contentInput.dialogue??[]).map(item=>item.id);
  const temporaryIds=draftIds.filter(id=>typeof id==='string'&&id.startsWith('draft-dialogue-'));
  if(new Set(temporaryIds).size!==temporaryIds.length)fail('invalid_page_document',['临时对白 ID 重复']);
  for(const item of contentInput.dialogue??[])if(typeof item.id==='string'&&item.id.startsWith('draft-dialogue-'))delete item.id;
  const content=prepareStoryPageNarrativeForPersistence({$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,...contentInput},{baselineNarrative:beforeContent,createDialogueId:()=>`dialogue-${randomBytes(6).toString('hex')}`});
  if(content.page_kind!==beforeContent.page_kind)fail('page_kind_immutable');
  const prompt=preparePromptForPersistence({$schema:STORY_PAGE_PROMPT_SCHEMA_ID,...clone(value.prompt)},{baselinePrompt:beforePrompt,createFragmentId:()=>`token-${randomBytes(6).toString('hex')}`});
  assertValid(validateStoryPageNarrativeDocument(content));assertValid(validateStoryPagePromptDocument(prompt));
  const keep=new Set(content.characters.map(ref=>`character:${ref.character_id}:${ref.variant_id}`));
  const old=new Set(beforeContent.characters.map(ref=>`character:${ref.character_id}:${ref.variant_id}`));
  const removed=[...old].filter(source=>!keep.has(source));for(const source of removed)if(prompt.inheritance)delete prompt.inheritance[source];
  const impacts=await sourceSwitchImpacts(directory,beforePrompt,prompt,beforeContent.characters,content.characters,removed);
  const scenePlan=await applySceneSwitch(directory,beforePrompt,prompt,content.characters);impacts.push(...scenePlan.impacts);
  const sources=await readInheritanceSources(directory,content.characters,prompt.scene_id,prompt.scene_variant_id,{allowMissing:true});
  assertValid(checkPageInheritance(prompt,sources));requireImpactConfirmation({impacts,writes:[]},value.confirmation_sha256,{content:contentInput,prompt});
  const writes=[{relative:pageRelativePath(pageId,'content'),before:beforeContent,after:content},{relative:pageRelativePath(pageId,'prompt'),before:beforePrompt,after:prompt}];
  const dialogueIds=new Set(content.dialogue.map(item=>item.id));
  const dialogueIdMap=new Map(draftIds.map((id,index)=>[id,content.dialogue[index]?.id]));
  let lettering,layoutSha;
  const existingLayouts=await optionalJson(directory,'lettering/dialogue-layouts.json');
  if(value.lettering!==undefined||existingLayouts){
    const baseline=existingLayouts??emptyLetteringDocument();assertValid(validateLetteringDocument(baseline));
    if(value.lettering!==undefined)checkHash(baseline,value.expected_layout_sha256,'page_lettering_target_conflict');
    const previous=baseline.pages.find(item=>item.page===pageId)??{page:pageId,items:[]};
    lettering={page:pageId,items:clone(value.lettering?.items??previous.items).map(item=>({...item,dialogue_id:dialogueIdMap.get(item.dialogue_id)??item.dialogue_id})).filter(item=>dialogueIds.has(item.dialogue_id))};
    assertValid(validatePageLettering(lettering,{pageId,dialogueIds:[...dialogueIds]}));
    const narrationIds=new Set(content.dialogue.filter(item=>item.mode==='narration').map(item=>item.id));
    if(lettering.items.some(item=>narrationIds.has(item.dialogue_id)))fail('invalid_page_lettering',['旁白不保存手动布局']);
    const next=clone(baseline);next.pages=next.pages.filter(item=>item.page!==pageId);if(lettering.items.length)next.pages.push(lettering);
    writes.push({relative:'lettering/dialogue-layouts.json',before:existingLayouts,after:next});layoutSha=hashCanonicalJson(next);
  }
  const oldSources=await optionalJson(directory,pageRelativePath(pageId,'text-sources'));
  if(value.text_sources!==undefined||oldSources){
    if(value.text_sources!==undefined)checkHash(oldSources??{},value.expected_text_sources_sha256,'text_sources_target_conflict');
    const textSources=Object.fromEntries(Object.entries(clone(value.text_sources??oldSources)).map(([id,entry])=>[dialogueIdMap.get(id)??id,entry]));
    for(const id of Object.keys(textSources))if(id!=='$schema'&&!dialogueIds.has(id))delete textSources[id];
    assertValid(validateStoryPageTextSourcesDocument(textSources));
    const heartIds=new Set(content.dialogue.filter(item=>item.mode==='heart').map(item=>item.id));
    if(Object.keys(textSources).some(id=>heartIds.has(id)))fail('invalid_text_source_reference',['爱心条目不记录原文参考']);
    if(value.text_sources!==undefined)for(const[id,entry]of Object.entries(textSources)){if(id==='$schema')continue;await verifyWritingCorpusSentence(root,{sourceFile:entry.source_file,offset:entry.offset,sentence:entry.original_sentence,label:id});}
    writes.push({relative:pageRelativePath(pageId,'text-sources'),before:oldSources,after:textSources});
  }
  const auditPrepared=await preparePromptWriteAudit(root);
  await commitFactChanges(directory,writes);
  const captured=await capturePromptAuditInput(()=>capturePagePromptSnapshot(directory,pageId,pageKey));
  const audit=await auditSavedPagePrompt(root,directory,auditPrepared,captured);
  return {page_key:pageKey,content:publicDocument(content),prompt:publicDocument(prompt),content_sha256:hashCanonicalJson(content),prompt_sha256:hashCanonicalJson(prompt),prompt_context_sha256:hashCanonicalJson(await readStoryPromptUpstream(directory,pageId)),...(lettering?{lettering,layout_sha256:layoutSha}:{}),warnings:storyContentWarnings(content),downstream_diagnostics:await narrativeDownstreamDiagnostics(directory,pageId,content),audit};
}
