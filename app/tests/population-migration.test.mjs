import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {migratePopulationDocument,migrateProjectPopulation} from '../server/population-migration.mjs';
const document=()=>({$schema:'https://storyvisualizer.local/schemas/story-page-prompt.schema.json',models:{
  anima:{subject:[{id:'token-111111111111',tag:'1girl'},{id:'token-222222222222',tag:'couch',weight:1.2,enabled:false},{id:'token-333333333333',tag:'on_stomach'}],person:[],setting:[],camera:[],avoid:[]},qwen:{text:'unchanged'}
}});
test('一次性迁移保留词条属性及未绑定身份，移除全部本页 ID，不改其他模型',()=>{
 const before=document(),after=migratePopulationDocument(before,{couch:'setting',on_stomach:'person'});
 assert.equal(after.models.anima.subject,undefined);assert.equal(before.models.anima.subject.length,3);
 assert.deepEqual(after.models.anima.setting,[{tag:'couch',weight:1.2,enabled:false}]);
 assert.deepEqual(after.models.anima.person,[{tag:'on_stomach'}]);
 assert.deepEqual(after.models.anima.population,[{tag:'1girl'}]);
 assert.equal(after.models.anima.person[0].character_id,undefined);assert.deepEqual(after.models.qwen,before.models.qwen);
 assert.throws(()=>migratePopulationDocument(before,{}),/未审核分类/);
 const current=structuredClone(after);current.models.anima.camera=[{id:'token-444444444444',description:'side view'}];
 assert.deepEqual(migratePopulationDocument(current,{}).models.anima.camera,[{description:'side view'}]);
 assert.equal(current.models.anima.camera[0].id,'token-444444444444','不修改传入文档');
});
test('角色和场景的共享词分类迁移保留持久 ID',()=>{
 const row={id:'token-111111111111',description:'quiet visitor'};
 const empty=()=>({subject:[],person:[],setting:[],camera:[],avoid:[]});
 const before={models:{anima:{identity:{prompt:{...empty(),subject:[row]},lora:null},variants:{default:{prompt:empty(),loras:[]}}}}};
 const after=migratePopulationDocument(before,{'quiet visitor':'person'},'character');
 assert.deepEqual(after.models.anima.identity.prompt.person,[row]);
 assert.deepEqual(after.models.anima.variants.default.prompt.population,[]);
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
