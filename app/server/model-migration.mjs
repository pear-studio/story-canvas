import path from 'node:path';
import {mkdir, readFile, copyFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ApiError} from './http-support.mjs';
import {resolveProjectLocation} from './project-operations.mjs';
import {requireIdleProject} from './project-management.mjs';
import {factStorage, commitFactChanges} from './story-facts.mjs';
import {compileEffectiveRenderProfile} from './render-profile-compiler.mjs';
import {profileModelAdapter} from './model-adapters.mjs';
import {makeModelPromptDocument, validateModelPromptDocument} from './model-prompts.mjs';
import {pageSettingsFromDefaults} from './page-render-settings.mjs';
import {hashCanonicalJson as hash} from './workflow-definition.mjs';
import {validateStoryPageNarrativeDocument} from './story-files.mjs';
import {validateScenePromptDocument} from './scene-files.mjs';

const clone=value=>structuredClone(value);
const schema=name=>`https://storyvisualizer.local/schemas/${name}.schema.json`;
const fail=(code,details=[])=>{throw new ApiError(422,code,details);};
async function read(directory,relative,optional=false) {
  const target=factStorage.targetPath(directory,relative);
  try {
    await factStorage.assertProjectFactBoundary(directory,directory,target,relative);
    return JSON.parse(await readFile(target,'utf8'));
  } catch(error) {if(optional && error.code==='ENOENT')return null;throw error;}
}
function normalizeAnimaSetting(value) {
  const result=clone(value);
  for(const variant of Object.values(result.variants))variant.identity_disabled ??= [];
  return result;
}
function settingConfiguration(record,variantId) {
  const prompt=record.prompt,variant=prompt.variants[variantId];
  if(!variant)fail('migration_setting_missing',[record.id,variantId]);
  return {
    ...clone(variant),id:record.id,name:record.name,configuration_id:variantId,configuration_path:`variants.${variantId}`,
    identity:clone(prompt.identity),loras:[...(prompt.identity.lora?[clone(prompt.identity.lora)]:[]),...clone(variant.loras)],
  };
}
const executionLoras=compiled=>compiled.loras.map(({filename,sha256,weight})=>({filename,sha256,weight}));

// 在 readFacts 内 dry-run；正式提交会在写锁内重算并核对指纹，不信任浏览器传来的写入计划。
export async function planModelMigration(root,projectId) {
  const {projectDirectory:directory}=await resolveProjectLocation(root,projectId);
  await requireIdleProject(directory);
  const project=await read(directory,'project.json');
  if(project.format==='story-models-v1')return {current:true,project_id:projectId,writes:[],pages:[],fingerprint:hash(project)};
  const bundle=await compileEffectiveRenderProfile({repositoryRoot:root,projectRoot:directory,profileId:project.default_render_profile});
  if(bundle.blocked)fail('render_profile_override_conflict');
  const profile=bundle.effective_profile,adapter=profileModelAdapter(profile),modelId=adapter.id;
  if(modelId!=='anima' || profile.id!=='anima-base-v1')fail('migration_model_unsupported',['仅恢复旧 Anima Basic 项目']);
  const writes=[],records={characters:new Map(),scenes:new Map()};
  for(const folder of ['characters','scenes']) {
    const index=await read(directory,`${folder}/index.json`,true);
    for(const id of index?.[folder]??[]) {
      const relative=`${folder}/${id}.prompt.json`,before=await read(directory,relative);
      const prompt=normalizeAnimaSetting(before);
      const metadata=await read(directory,`${folder}/${id}.profile.json`);
      records[folder].set(id,{id,name:metadata.name,prompt});
      const native=clone(prompt);
      const after=makeModelPromptDocument(before.$schema,modelId,native);
      const errors=folder==='scenes'?validateScenePromptDocument(after):validateModelPromptDocument(after,'setting');
      if(errors.length)fail('migration_prompt_invalid',[relative,...errors]);
      writes.push({relative,before,after});
    }
  }
  const index=await read(directory,'pages/index.json'),pages=[];
  for(const entry of index.pages) {
    const id=entry.page_id,relative=`pages/${id}.prompt.json`,before=await read(directory,relative),content=await read(directory,`pages/${id}.content.json`);
    const errors=validateStoryPageNarrativeDocument(content);if(errors.length)fail('migration_page_invalid',[id,...errors]);
    const participantIds=content.characters.map(ref=>ref.character_id);
    const characters=content.characters.map(ref=>{const record=records.characters.get(ref.character_id);if(!record)fail('migration_setting_missing',[ref.character_id]);return settingConfiguration(record,ref.variant_id);});
    const scenes=before.scene_id?[settingConfiguration(records.scenes.get(before.scene_id)??fail('migration_setting_missing',[before.scene_id]),before.scene_variant_id)]:[];
    const input={pageId:id,pageKey:{page_id:id},pagePrompt:before,characters,scenes,participantIds,profile};
    const original=adapter.compilePrompt(input);
    if(original.errors.length)fail('migration_page_not_compilable',[id,...original.errors]);
    const native=clone(before);native.loras=[];
    const migrated=adapter.compilePrompt({...input,pagePrompt:native});
    const equivalent=original.positive_prompt===migrated.positive_prompt && original.negative_prompt===migrated.negative_prompt && hash(executionLoras(original))===hash(executionLoras(migrated));
    if(!equivalent)fail('migration_generation_changed',[id]);
    const after=makeModelPromptDocument(schema('story-page-prompt'),modelId,native);
    const promptErrors=validateModelPromptDocument(after,'page');if(promptErrors.length)fail('migration_prompt_invalid',[id,...promptErrors]);
    writes.push({relative,before,after});
    const renderRelative=`pages/${id}.render.json`,oldRender=await read(directory,renderRelative,true);
    writes.push({relative:renderRelative,before:oldRender,after:oldRender?{...oldRender,model_id:modelId}:pageSettingsFromDefaults(project,modelId)});
    pages.push({page_id:id,model_id:modelId,equivalent:true,positive_sha256:hash(original.positive_prompt),negative_sha256:hash(original.negative_prompt),loras:executionLoras(original)});
  }
  writes.push({relative:'project.json',before:project,after:{...project,format:'story-models-v1'}});
  return {project_id:projectId,model_id:modelId,writes,pages,fingerprint:hash({files:writes.map(({relative,before})=>({relative,before})),pages,index,profile:bundle.source_identity})};
}

export function modelMigrationSummary(plan) {
  return {current:plan.current??false,project_id:plan.project_id,model_id:plan.model_id,fingerprint:plan.fingerprint,files:plan.writes.map(write=>write.relative),pages:plan.pages};
}
export async function commitModelMigration(root,projectId,expectedFingerprint) {
  const {projectDirectory:directory}=await resolveProjectLocation(root,projectId);
  const plan=await planModelMigration(root,projectId);
  if(plan.fingerprint!==expectedFingerprint)throw new ApiError(409,'model_migration_conflict');
  if(plan.current)return modelMigrationSummary(plan);
  // 备份保存于项目旁，包含每个待改事实的原始字节，不属于 Saved 可清理区域。
  const backup=path.join(path.dirname(directory),`${path.basename(directory)}.before-models-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(backup);
  for(const write of plan.writes)if(write.before!==null){const target=path.join(backup,write.relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(directory,write.relative),target);}
  await writeFile(path.join(backup,'migration.json'),JSON.stringify(modelMigrationSummary(plan),null,2)+'\n',{flag:'wx'});
  await commitFactChanges(directory,plan.writes);
  for(const write of plan.writes)if(hash(await read(directory,write.relative))!==hash(write.after))fail('model_migration_readback_failed',[write.relative,backup]);
  return {...modelMigrationSummary(plan),backup_directory:backup};
}
