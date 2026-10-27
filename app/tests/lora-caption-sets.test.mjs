import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {createLoraTrainingDataset} from './training-project-fixture.mjs';
import {registerFixtureProjects} from './project-registry-fixture.mjs';
import * as facts from '../server/lora-training-facts.mjs';
import {datasetRoot,itemPaths} from '../server/lora-training-support.mjs';

async function fixture(t){
  const temporary=new URL('../../Saved/Tests/',import.meta.url);
  await mkdir(temporary,{recursive:true});
  const root=await mkdtemp(path.join(fileURLToPath(temporary),'caption-sets-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  registerFixtureProjects(root);
  const created=await createLoraTrainingDataset(root,{name:'独立打标测试'});
  const buffer=await sharp({create:{width:64,height:64,channels:3,background:'#884422'}}).png().toBuffer();
  const detail=await facts.importLoraTrainingAssets(root,created.id,{group_id:created.dataset.groups[0].id,files:[{filename:'one.png',buffer}]});
  return {root,id:created.id,set:created.caption_sets[0].id,item:detail.items[0]};
}

test('打标集保留原文，确认与模型配置互相隔离',async t=>{
  const {root,id,set,item}=await fixture(t),other=await facts.createLoraCaptionSet(root,id,{name:'自然语言',format:'prose'}),set2=other.caption_set_id;
  const text='  A person in warm light.\r\nSecond line.  ';
  await assert.rejects(facts.runLoraCaptioning(root,root,id,'missing',{}, {caption_set_id:set2}),{code:'caption_set_requires_agent_text'});
  await facts.updateLoraCaptioningItem(root,id,item.id,'subject, portrait',{caption_set_id:set,confirm:true});
  await facts.saveLoraTrainingCaption(root,id,item.id,text,{caption_set_id:set2});
  const a=await facts.readLoraTrainingDataset(root,id,{caption_set_id:set}),b=await facts.readLoraTrainingDataset(root,id,{caption_set_id:set2});
  assert.equal(a.items[0].caption,'subject, portrait');
  assert.equal(b.items[0].caption,text);
  assert.equal(a.captioning.items[0].confirmed,true);
  assert.equal(b.captioning.items[0].confirmed,false);
  await facts.createLoraTrainingTask(root,root,{dataset_id:id,target:{family:'moss-image'},caption_set_id:set2});
  assert.equal((await facts.requireTask(root,id,{family:'moss-image'})).task.caption_set_id,set2);
  assert.equal((await facts.requireTask(root,id,{family:'qwen-image-2-1'})).task.caption_set_id,set);
  await assert.rejects(facts.saveLoraTrainingCaption(root,id,item.id,'ambiguous'),{code:'caption_set_id_required'});
  await assert.rejects(facts.requireTask(root,id),{code:'training_family_required'});
});

test('复制打标集不复制确认或审核，图片变更使所有集确认失效',async t=>{
  const {root,id,set,item}=await fixture(t);
  await facts.updateLoraCaptioningItem(root,id,item.id,'portrait',{caption_set_id:set,confirm:true});
  await facts.recordLoraCaptionAudit(root,id,{caption_set_id:set,image_sha256:[item.image_version]});
  const copy=await facts.createLoraCaptionSet(root,id,{name:'副本',source_id:set});
  assert.equal(copy.items[0].caption,'portrait');assert.equal(copy.captioning.items[0].confirmed,false);
  assert.equal((await facts.readCaptionAuditSnapshot(root,id,{caption_set_id:copy.caption_set_id})).images[item.image_version],undefined);
  await facts.updateLoraCaptioningItem(root,id,item.id,'portrait',{caption_set_id:copy.caption_set_id,confirm:true});
  await facts.invalidateLoraCaptioningItem(root,id,item.id);
  for(const caption_set_id of [set,copy.caption_set_id])assert.equal((await facts.readLoraCaptioning(root,id,{caption_set_id})).items[0].confirmed,false);
});

test('批量导入原子校验当前图像和文本 hash，且不冒充确认',async t=>{
  const {root,id,set,item}=await fixture(t);
  await facts.saveLoraTrainingCaption(root,id,item.id,'old',{caption_set_id:set});
  const copied=await facts.copyLoraTrainingItem(root,id,{source_item_id:item.id}),second=copied.items.find(entry=>entry.id!==item.id);
  await assert.rejects(facts.importLoraCaptionSet(root,id,set,{entries:[{item_id:item.id,image_sha256:item.image_version,caption:'must not commit'},{item_id:second.id,image_sha256:'0'.repeat(64),caption:'bad'}]}),{code:'caption_import_image_changed'});
  await assert.rejects(facts.importLoraCaptionSet(root,id,set,{entries:[{item_id:item.id,image_sha256:'0'.repeat(64),caption:'new'}]}),{code:'caption_import_image_changed'});
  assert.equal((await facts.readLoraTrainingDataset(root,id,{caption_set_id:set})).items[0].caption,'old');
  const caption='\nexact  text\r\n';
  await facts.importLoraCaptionSet(root,id,set,{entries:[{item_id:item.id,image_sha256:item.image_version,caption,caption_sha256:createHash('sha256').update(caption).digest('hex')}]});
  const result=await facts.readLoraTrainingDataset(root,id,{caption_set_id:set});
  assert.equal(result.items[0].caption,caption);assert.equal(result.captioning.items[0].confirmed,false);
});

test('旧结构保持只读，不因写入请求隐式迁移',async t=>{
  const {root,id,set,item}=await fixture(t),directory=datasetRoot(root,id);
  const file=path.join(directory,'project.json'),document=JSON.parse(await readFile(file,'utf8'));document.version=5;
  const settingsFile=path.join(directory,'settings.json'),settings=JSON.parse(await readFile(settingsFile,'utf8')).models['qwen-image-2-1'];
  delete settings.caption_set_id;settings.version=5;await writeFile(settingsFile,JSON.stringify(settings));
  await writeFile(itemPaths(root,id,item).caption,'legacy');await writeFile(file,JSON.stringify(document));
  assert.equal((await facts.readLoraTrainingDataset(root,id)).read_only,true);
  const legacyTask=await facts.readLoraTrainingTask(root,id,{family:'moss-image'});
  assert.equal(legacyTask.family,'qwen-image-2-1');
  assert.equal(legacyTask.task.target.family,legacyTask.family);
  await assert.rejects(facts.saveLoraTrainingCaption(root,id,item.id,'new',{caption_set_id:set}),{code:'training_project_migration_required'});
  await assert.rejects(facts.createLoraCaptionSet(root,id,{name:'new',format:'prose'}),{code:'training_project_migration_required'});
  assert.equal(await readFile(itemPaths(root,id,item).caption,'utf8'),'legacy');
});
