import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {migratePopulationDocument,migrateProjectPopulation} from '../server/population-migration.mjs';
const document=()=>({$schema:'https://storyvisualizer.local/schemas/story-page-prompt.schema.json',models:{
  anima:{subject:[{id:'token-111111111111',tag:'1girl'},{id:'token-222222222222',tag:'couch',weight:1.2,enabled:false},{id:'token-333333333333',tag:'on_stomach'}],person:[],setting:[],camera:[],avoid:[]},qwen:{text:'unchanged'}
}});
test('一次性迁移保留全部片段属性及未绑定身份，不改其他模型',()=>{
 const before=document(),after=migratePopulationDocument(before,{couch:'setting',on_stomach:'person'});
 assert.equal(after.models.anima.subject,undefined);assert.equal(before.models.anima.subject.length,3);
 assert.deepEqual(after.models.anima.setting,[before.models.anima.subject[1]]);
 assert.deepEqual(after.models.anima.person,[before.models.anima.subject[2]]);
 assert.equal(after.models.anima.person[0].character_id,undefined);assert.deepEqual(after.models.qwen,before.models.qwen);
 assert.throws(()=>migratePopulationDocument(before,{}),/未审核分类/);
});
test('预览不写文件，过期指纹拒绝，应用前备份，重复执行无写入',async t=>{
 const base=path.resolve(import.meta.dirname,'../../Saved/Tests');await mkdir(base,{recursive:true});
 const dir=await mkdtemp(path.join(base,'population-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'pages'));const file=path.join(dir,'pages/page-001.prompt.json');
 const raw=JSON.stringify(document());await writeFile(file,raw);
 const args={assignments:{couch:'setting',on_stomach:'person'}},plan=await migrateProjectPopulation(dir,args);
 assert.equal(plan.files,1);assert.equal(await readFile(file,'utf8'),raw);
 await assert.rejects(migrateProjectPopulation(dir,{...args,apply:true,fingerprint:'wrong'}),e=>e.code==='population_migration_conflict');
 const applied=await migrateProjectPopulation(dir,{...args,apply:true,fingerprint:plan.fingerprint});
 assert.equal(applied.migrated,1);assert.equal(await readFile(path.join(applied.backup,'pages/page-001.prompt.json'),'utf8'),raw);
 assert.equal((await migrateProjectPopulation(dir,args)).files,0);
});
