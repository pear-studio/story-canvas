import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fsPromises,{mkdtemp,mkdir,writeFile,readFile,readdir,rm,access} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import {registerProject} from '../server/project-registry.mjs';
import {defaultLoraTrainingTarget,readLoraTrainingDataset} from '../server/lora-training-facts.mjs';
import {inspectLoraTrainingMigration,applyLoraTrainingMigration} from '../server/lora-training-migration.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
async function fixture(t) {
  const tests=path.resolve(import.meta.dirname,'../../Saved/Tests');await mkdir(tests,{recursive:true});
  const root=await mkdtemp(path.join(tests,'training-migration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const id='dataset-111111111111',directory=path.join(root,'project');await mkdir(directory);
  registerProject(root,{id,type:'training',path:directory,temporary:true});
  const group='group-111111111111';
  const dataset={version:5,name:'迁移测试',description:'保留素材',activation_terms:['veloria'],groups:[{id:group,name:'人物',enabled:true,repeats:1}],items:[]};
  const latest={version:1,items:{},tagger:null,updated_at:null};
  const images={},bytes=await sharp({create:{width:16,height:24,channels:3,background:'white'}}).png().toBuffer();
  const imageHash=hash(bytes),captions=[];
  for(const suffix of ['111111111111','222222222222']) {
    const item={id:`item-${suffix}`,asset_id:`asset-${suffix}`,group_id:group,enabled:suffix.startsWith('1')};dataset.items.push(item);
    const folder=path.join(directory,'assets',item.asset_id);await mkdir(folder,{recursive:true});
    const caption=Buffer.from(`veloria, ${suffix}\r\n`);captions.push(caption);
    await writeFile(path.join(folder,'original.png'),bytes);await writeFile(path.join(folder,'caption.txt'),caption);
    await writeFile(path.join(folder,'meta.json'),json({version:1,original:{file:'original.png',sha256:imageHash},current:{file:'original.png',sha256:imageHash},processing:null,pipeline_version:1}));
    latest.items[item.id]={image_sha256:imageHash,caption_sha256:hash(caption),base_prompt:null,raw_tags:[],confirmation:{image_sha256:imageHash,caption_sha256:hash(caption)}};
    images[imageHash]={audited_at:'2026-10-01T00:00:00Z'};
  }
  const settings={version:5,target:await defaultLoraTrainingTarget(root,'qwen-image-2-1'),training_recipe:{id:'qwen-image21-lora-v1',overrides:{network_dim:32,learning_rate:0.0001,gradient_accumulation_steps:1}},run_defaults:{max_train_steps:2000,save_every_n_steps:500,seed:42}};
  await writeFile(path.join(directory,'project.json'),json(dataset));await writeFile(path.join(directory,'settings.json'),json(settings));
  await mkdir(path.join(directory,'captioning'));await writeFile(path.join(directory,'captioning/latest.json'),json(latest));
  await writeFile(path.join(directory,'captioning/audit.json'),json({version:1,scope:{family:'anima',prompt_family:'anima'},updated_at:null,images}));
  const history=path.join(directory,'Training','history.json');await mkdir(path.dirname(history));await writeFile(history,'frozen-history');
  return {root,id,directory,dataset,settings,captions,imageHash,history};
}

test('显式迁移保留图片、ID、停用项、原始文本字节、有效确认及历史，并保留可恢复备份',async t=>{
  const f=await fixture(t);const plan=await inspectLoraTrainingMigration(f.root,f.id);
  assert.equal(plan.summary.items,2);assert.equal(plan.summary.effective,1);assert.equal(plan.summary.confirmed_preserved,2);
  await assert.rejects(access(path.join(f.directory,'captions')));
  const result=await applyLoraTrainingMigration(f.root,f.id,{expected_fingerprint:plan.fingerprint});
  const detail=await readLoraTrainingDataset(f.root,f.id,{caption_set_id:result.caption_set_id});
  assert.deepEqual(detail.dataset,{...f.dataset,version:6});assert.equal(detail.captioning.summary.confirmed,2);
  for(const [index,item] of f.dataset.items.entries()) {
    assert.deepEqual(await readFile(path.join(f.directory,'captions',result.caption_set_id,'texts',`${item.asset_id}.txt`)),f.captions[index]);
    assert.equal(hash(await readFile(path.join(f.directory,'assets',item.asset_id,'original.png'))),f.imageHash);
    assert.deepEqual(await readFile(path.join(result.backup_directory,'assets',item.asset_id,'caption.txt')),f.captions[index]);
    await assert.rejects(access(path.join(f.directory,'assets',item.asset_id,'caption.txt')));
  }
  const settings=JSON.parse(await readFile(path.join(f.directory,'settings.json'),'utf8'));
  assert.deepEqual(settings.models['qwen-image-2-1'],{...f.settings,version:6,caption_set_id:result.caption_set_id});
  assert.equal(await readFile(f.history,'utf8'),'frozen-history');
  assert.equal(JSON.parse(await readFile(path.join(result.backup_directory,'project.json'),'utf8')).version,5);
  assert.equal((await inspectLoraTrainingMigration(f.root,f.id)).required,false);
  await assert.rejects(applyLoraTrainingMigration(f.root,f.id,{expected_fingerprint:plan.fingerprint}),{code:'training_migration_not_required'});
});

test('迁移拒绝变化后的读据，重新检查时清除不匹配的文本确认',async t=>{
  const f=await fixture(t),plan=await inspectLoraTrainingMigration(f.root,f.id);
  await writeFile(path.join(f.directory,'assets',f.dataset.items[0].asset_id,'caption.txt'),'changed\n');
  await assert.rejects(applyLoraTrainingMigration(f.root,f.id,{expected_fingerprint:plan.fingerprint}),{code:'training_migration_source_changed'});
  assert.equal(JSON.parse(await readFile(path.join(f.directory,'project.json'),'utf8')).version,5);
  const fresh=await inspectLoraTrainingMigration(f.root,f.id);assert.equal(fresh.summary.confirmations_cleared,1);
  const done=await applyLoraTrainingMigration(f.root,f.id,{expected_fingerprint:fresh.fingerprint});
  assert.equal((await readLoraTrainingDataset(f.root,f.id,{caption_set_id:done.caption_set_id})).captioning.summary.confirmed,1);
});

test('迁移中途写入失败恢复旧事实、保留备份，且可重新检查后重试',async t=>{
  const f=await fixture(t),plan=await inspectLoraTrainingMigration(f.root,f.id);
  const relativeFiles=['project.json','settings.json','captioning/latest.json','captioning/audit.json',
    ...f.dataset.items.flatMap(item=>['caption.txt','meta.json','original.png'].map(file=>path.join('assets',item.asset_id,file)))];
  const original=new Map(await Promise.all(relativeFiles.map(async file=>[file,await readFile(path.join(f.directory,file))])));
  const failedTarget=path.join(f.directory,'captions',plan.caption_set.id,'texts',`${f.dataset.items[0].asset_id}.txt`);
  const rename=fsPromises.rename;let injected=false;
  t.mock.method(fsPromises,'rename',async(source,target)=>{
    if(target===failedTarget&&!injected){
      injected=true;
      assert.equal(JSON.parse(await readFile(path.join(f.directory,'project.json'),'utf8')).version,6);
      assert.equal(JSON.parse(await readFile(path.join(f.directory,'settings.json'),'utf8')).version,6);
      throw Object.assign(new Error('injected migration write failure'),{code:'EIO'});
    }
    return rename(source,target);
  });
  syncBuiltinESMExports();
  try{await assert.rejects(applyLoraTrainingMigration(f.root,f.id,{expected_fingerprint:plan.fingerprint}),{code:'EIO'});}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.equal(injected,true);
  for(const [file,bytes] of original)assert.deepEqual(await readFile(path.join(f.directory,file)),bytes,file);
  await assert.rejects(access(path.join(f.directory,'captions')));
  assert.equal(await readFile(f.history,'utf8'),'frozen-history');
  const backups=path.join(f.directory,'Training','migrations'),names=await readdir(backups);
  assert.equal(names.length,1);
  const backup=path.join(backups,names[0]);
  assert.equal(JSON.parse(await readFile(path.join(backup,'migration.json'),'utf8')).plan.fingerprint,plan.fingerprint);
  for(const [file,bytes] of original)if(!file.endsWith('original.png'))assert.deepEqual(await readFile(path.join(backup,file)),bytes);
  const fresh=await inspectLoraTrainingMigration(f.root,f.id);assert.equal(fresh.fingerprint,plan.fingerprint);
  const done=await applyLoraTrainingMigration(f.root,f.id,{expected_fingerprint:fresh.fingerprint});
  assert.equal((await readLoraTrainingDataset(f.root,f.id,{caption_set_id:done.caption_set_id})).captioning.summary.confirmed,2);
});
