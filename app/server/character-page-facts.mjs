import path from 'node:path';
import { resolveProjectLocation } from './project-operations.mjs';
import { readPageIndex, readPageContent, readPagePrompt, validatePagesIndexDocument } from './pages-store.mjs';
import { createPage, duplicatePage, deletePage, assertPageOwner } from './page-facts.mjs';
import { readStoryFactDraft, commitStoryFact, readStoryPromptUpstream, FactError } from './story-facts.mjs';
import { commitFactChanges } from './prompt-inheritance-facts.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { CHARACTER_PAGES_INDEX_SCHEMA_ID, validateCharacterPagesIndexDocument } from './character-files.mjs';
import { materializeVisualPageTemplate } from './visual-page-templates.mjs';
import { STORY_PAGE_NARRATIVE_SCHEMA_ID, STORY_PAGE_PROMPT_SCHEMA_ID } from './story-files.mjs';
function projection(index){return {$schema:CHARACTER_PAGES_INDEX_SCHEMA_ID,pages:index.pages.filter(page=>page.owner_kind==='character').map(({page_id,character_id,variant_id})=>({page_id,character_id,variant_id}))};}
export async function readCharacterPagesIndexDraft(root,projectId){
  const project=await resolveProjectLocation(path.resolve(root),projectId),persisted=projection(await readPageIndex(project.projectDirectory));
  return {project,definition:{targetRelative:'pages/index.json',persisted,upstream:{},identity:{}}};
}
export async function commitCharacterPagesIndex(root,context,readDocument,_kind,{beforeCommit}={}){
  const project=await resolveProjectLocation(path.resolve(root),context.project_id),index=await readPageIndex(project.projectDirectory),baseline=projection(index);
  if(hashCanonicalJson(baseline)!==context.target.sha256)throw new FactError('character_page_target_conflict');
  const edited=await readDocument(),errors=validateCharacterPagesIndexDocument(edited);if(errors.length)throw new FactError('invalid_character_page_document',errors);
  const ids=new Set(baseline.pages.map(page=>page.page_id));
  if(edited.pages.length!==ids.size||edited.pages.some(page=>!ids.has(page.page_id)))throw new FactError('character_page_index_membership_invalid');
  for(const page of edited.pages){const old=baseline.pages.find(item=>item.page_id===page.page_id);if(old.character_id!==page.character_id||old.variant_id!==page.variant_id)await assertPageOwner(project.projectDirectory,{owner_kind:'character',character_id:page.character_id,variant_id:page.variant_id});}
  for (const page of edited.pages) {
    try { await Promise.all([readPageContent(project.projectDirectory,page.page_id),readPagePrompt(project.projectDirectory,page.page_id)]); }
    catch (error) { if(error.code==='ENOENT')throw new FactError('character_pages_pairing_mismatch',[page.page_id]); throw error; }
  }
  const next={...index,pages:[...index.pages.filter(page=>page.owner_kind!=='character'),...edited.pages.map(page=>({...page,owner_kind:'character'}))]};
  const nextErrors=validatePagesIndexDocument(next);if(nextErrors.length)throw new FactError('invalid_character_page_document',nextErrors);
  if(beforeCommit)await beforeCommit();await commitFactChanges(project.projectDirectory,[{relative:'pages/index.json',before:index,after:next}]);
  return {target_file:path.join(project.projectDirectory,'pages/index.json'),value:edited};
}
export function readCharacterPageFactDraft(root,projectId,pageId,kind){return readStoryFactDraft(root,projectId,pageId,kind==='goal'?'narrative':kind);}
export function readCharacterPagePromptUpstream(directory,pageId){return readStoryPromptUpstream(directory,pageId);}
export function commitCharacterPageFact(root,context,readDocument,kind,options){return commitStoryFact(root,context,readDocument,kind==='goal'?'narrative':kind,options);}
export function createCharacterPage(root,projectId,characterId,variantId,options){return createPage(root,projectId,{owner_kind:'character',character_id:characterId,variant_id:variantId},options);}
export function duplicateCharacterPage(root,projectId,pageId){return duplicatePage(root,projectId,pageId);}
export function deleteCharacterPage(root,projectId,pageId){return deletePage(root,projectId,pageId);}
export function convertVisualPageTemplate(template,characterId){const value=materializeVisualPageTemplate(template,characterId);return {content:{$schema:STORY_PAGE_NARRATIVE_SCHEMA_ID,title:value.title,scene_description:'',characters:[],dialogue:[]},prompt:{$schema:STORY_PAGE_PROMPT_SCHEMA_ID,...value.prompt}};}
