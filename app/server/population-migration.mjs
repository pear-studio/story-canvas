// 一次性显式迁移入口；正常读写不接受旧 subject。
import {readFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isPopulationControl} from '../shared/prompt-population.mjs';
import {inheritanceCategories} from '../shared/prompt-inheritance.mjs';
import {validateModelPromptDocument} from './model-prompts.mjs';
import {factStorage} from './story-facts.mjs';
import {ApiError} from './http-support.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

export function migratePopulationDocument(document, assignments, kind='page') {
  const next=structuredClone(document),model=next.models?.anima;
  if(!model)return next;
  function convert(prompt) {
    if(!Object.hasOwn(prompt,'subject'))return;
    if(Object.hasOwn(prompt,'population'))throw new Error('新旧人数字段同时存在');
    const moved={population:[],person:[],setting:[],camera:[],avoid:[]};
    for(const fragment of prompt.subject) {
      const text=fragment.tag??fragment.description;
      const target=isPopulationControl(text)?'population':assignments[text];
      if(!Object.hasOwn(moved,target))throw new Error('未审核分类：'+text);
      moved[target].push(fragment);
    }
    delete prompt.subject;prompt.population=moved.population;
    for(const category of ['person','setting','camera','avoid'])prompt[category]=[...moved[category],...(prompt[category]??[])];
  }
  if(kind==='page') {
    convert(model);
    // 一次性迁移直接产出当前页面契约；持久身份只属于角色/场景共享词。
    for(const category of inheritanceCategories)for(const fragment of model[category]??[])delete fragment.id;
  }
  else {convert(model.identity.prompt);for(const v of Object.values(model.variants))convert(v.prompt);}
  return next;
}

export async function migrateProjectPopulation(projectDirectory, input) {
  const writes=[];
  for(const folder of ['pages','characters','scenes']) {
    const names=await readdir(path.join(projectDirectory,folder)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const name of names.filter(n=>n.endsWith('.prompt.json'))) {
      const relative=`${folder}/${name}`,target=path.join(projectDirectory,relative),raw=await readFile(target,'utf8');
      const before=JSON.parse(raw),kind=folder==='pages'?'page':'character';
      const after=migratePopulationDocument(before,input.assignments??{},kind);
      if(JSON.stringify(before)===JSON.stringify(after))continue;
      const errors=validateModelPromptDocument(folder==='scenes'?{...after,$schema:'https://storyvisualizer.local/schemas/character-prompt.schema.json'}:after,kind);
      if(errors.length)throw new ApiError(422,'population_migration_invalid',[relative,...errors]);
      writes.push({relative,target,raw,sha256:hash(raw),before,after});
    }
  }
  const fingerprint=hash(JSON.stringify(writes.map(w=>[w.relative,w.sha256,w.after])));
  if(!input.apply)return {files:writes.length,fingerprint,targets:writes.map(w=>w.relative)};
  if(input.fingerprint!==fingerprint)throw new ApiError(409,'population_migration_conflict');
  if(!writes.length)return {migrated:0};
  // 完整备份先于任何事实写入；最终失败可按 manifest 恢复，不覆盖用户后续修改。
  const backup=path.join(projectDirectory,'.migration-backups','population',randomUUID());
  for(const w of writes){const file=path.join(backup,w.relative);await mkdir(path.dirname(file),{recursive:true});await copyFile(w.target,file);}
  await factStorage.writeJsonAtomic(path.join(backup,'manifest.json'),{writes:writes.map(w=>({relative:w.relative,before_sha256:w.sha256,after:w.after}))});
  for(const w of writes)if(hash(await readFile(w.target,'utf8'))!==w.sha256)throw new ApiError(409,'population_migration_conflict',[w.relative]);
  const completed=[];
  try {for(const w of writes){await factStorage.writeJsonAtomic(w.target,w.after);completed.push(w);}}
  catch(error){for(const w of completed.reverse())await factStorage.writeJsonAtomic(w.target,w.before);throw error;}
  return {migrated:writes.length,backup,fingerprint};
}
