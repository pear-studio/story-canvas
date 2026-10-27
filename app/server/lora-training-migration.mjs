import {createHash,randomBytes} from 'node:crypto';
import {lstat,mkdir,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {requireDataset,requireTask,readCaptioningLatest,readCaptionAuditSnapshot} from './lora-training-facts.mjs';
import {datasetRoot,itemPaths,readSafeDatasetFile,sha256File,commitFileChanges,LoraTrainingError,isWithin} from './lora-training-support.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';

async function migrationSource(repositoryRoot,datasetId) {
  const {dataset,storedDataset}=await requireDataset(repositoryRoot,datasetId);
  if(dataset.version!==5)return {required:false,dataset_id:datasetId,version:dataset.version};
  const directory=datasetRoot(repositoryRoot,datasetId);
  // 新目录存在时不能合并未知内容；迁移是单次、显式、可恢复的操作。
  if(await lstat(path.join(directory,'captions')).catch(error=>error.code==='ENOENT'?null:Promise.reject(error)))throw new LoraTrainingError(409,'training_migration_destination_exists');
  const {task}=await requireTask(repositoryRoot,datasetId);
  const latest=structuredClone(await readCaptioningLatest(repositoryRoot,datasetId));
  const audit=structuredClone(await readCaptionAuditSnapshot(repositoryRoot,datasetId));
  const sourceFiles=new Map();
  async function source(relative,optional=false) {
    const bytes=await readSafeDatasetFile(repositoryRoot,datasetId,path.join(directory,relative),relative);
    if(!bytes&&!optional)throw new LoraTrainingError(422,'training_migration_source_missing',[relative]);
    sourceFiles.set(relative,bytes);return bytes;
  }
  for(const relative of ['project.json','settings.json'])await source(relative);
  for(const relative of ['captioning/latest.json','captioning/audit.json'])await source(relative,true);
  const captions=[],images=[];
  let keptConfirmations=0,clearedConfirmations=0;
  const currentImageHashes=new Set();
  for(const item of dataset.items) {
    const files=itemPaths(repositoryRoot,datasetId,item);
    const relative=path.relative(directory,files.caption);
    const caption=await source(relative);
    const metaBytes=await source(path.relative(directory,files.meta));
    const meta=JSON.parse(metaBytes.toString('utf8'));
    const imageHash=await sha256File(files.image);
    const originalFile=path.join(files.assetDirectory,meta.original.file);
    const originalHash=originalFile===files.image?imageHash:await sha256File(originalFile);
    currentImageHashes.add(imageHash);
    images.push({item_id:item.id,asset_id:item.asset_id,image_sha256:imageHash,original_sha256:originalHash,caption_sha256:hash(caption)});
    captions.push({asset_id:item.asset_id,bytes:caption});
    const record=latest.items[item.id];
    if(record?.confirmation) {
      if(record.image_sha256===imageHash&&record.confirmation.image_sha256===imageHash&&record.confirmation.caption_sha256===hash(caption))keptConfirmations++;
      else {record.confirmation=null;clearedConfirmations++;}
    }
  }
  const currentIds=new Set(dataset.items.map(item=>item.id));
  latest.items=Object.fromEntries(Object.entries(latest.items).filter(([id])=>currentIds.has(id)));
  audit.scope={kind:'images'};
  audit.images=Object.fromEntries(Object.entries(audit.images).filter(([imageHash])=>currentImageHashes.has(imageHash)));
  const fingerprints=[...sourceFiles].map(([file,bytes])=>({file,sha256:bytes?hash(bytes):null})).sort((a,b)=>a.file.localeCompare(b.file));
  const fingerprint=hash(JSON.stringify({files:fingerprints,images}));
  const captionSetId=`caption-set-${hash(`${datasetId}:original`).slice(0,12)}`;
  const enabledGroups=new Set(dataset.groups.filter(group=>group.enabled).map(group=>group.id));
  return {required:true,dataset_id:datasetId,version:5,target_version:6,fingerprint,
    caption_set:{id:captionSetId,name:'原始打标',format:'tags'},family:task.target.family,
    summary:{items:dataset.items.length,effective:dataset.items.filter(item=>item.enabled&&enabledGroups.has(item.group_id)).length,confirmed_preserved:keptConfirmations,confirmations_cleared:clearedConfirmations},
    directory,dataset:storedDataset,task,latest,audit,sourceFiles,captions,images,fingerprints};
}

function publicPlan(source) {
  if(!source.required)return source;
  const {required,dataset_id,version,target_version,fingerprint,caption_set,family,summary}=source;
  return {required,dataset_id,version,target_version,fingerprint,caption_set,family,summary,
    effects:['共享素材与图片保持原样','当前 Caption 转入原始打标集','当前配置归入对应模型','历史训练及权重保持原样'],
    backup_location:'Training/migrations/'};
}

export async function inspectLoraTrainingMigration(repositoryRoot,datasetId) {
  return publicPlan(await migrationSource(repositoryRoot,datasetId));
}

export async function applyLoraTrainingMigration(repositoryRoot,datasetId,{expected_fingerprint}={}) {
  const {activeRunStatuses}=await import('./lora-training-plan.mjs');
  if((await activeRunStatuses(repositoryRoot)).length)throw new LoraTrainingError(409,'training_migration_active_run');
  const source=await migrationSource(repositoryRoot,datasetId);
  if(!source.required)throw new LoraTrainingError(409,'training_migration_not_required');
  if(!expected_fingerprint||source.fingerprint!==expected_fingerprint)throw new LoraTrainingError(409,'training_migration_source_changed');
  const {directory,caption_set,sourceFiles}=source;
  const trainingDirectory=path.join(directory,'Training');
  const trainingInfo=await lstat(trainingDirectory).catch(error=>error.code==='ENOENT'?null:Promise.reject(error));
  if(trainingInfo&&(!trainingInfo.isDirectory()||trainingInfo.isSymbolicLink()))throw new LoraTrainingError(422,'unsafe_training_migration_backup');
  const backups=path.join(trainingDirectory,'migrations');
  const backupInfo=await lstat(backups).catch(error=>error.code==='ENOENT'?null:Promise.reject(error));
  if(backupInfo&&(!backupInfo.isDirectory()||backupInfo.isSymbolicLink()))throw new LoraTrainingError(422,'unsafe_training_migration_backup');
  const backup=path.join(backups,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(4).toString('hex')}`);
  if(!isWithin(directory,backup))throw new LoraTrainingError(422,'unsafe_training_migration_backup');
  await mkdir(backup,{recursive:true});
  for(const [file,bytes] of sourceFiles) {
    if(bytes===null)continue;
    const target=path.join(backup,file);
    await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,bytes,{flag:'wx'});
  }
  const receipt={version:1,created_at:new Date().toISOString(),plan:publicPlan(source),source_files:source.fingerprints,images:source.images};
  await writeFile(path.join(backup,'migration.json'),json(receipt),{flag:'wx'});
  const config={version:6,target:source.task.target,caption_set_id:caption_set.id,training_recipe:source.task.training_recipe,run_defaults:source.task.run_defaults};
  const setRoot=path.join(directory,'captions',caption_set.id);
  const changes=[
    {target:path.join(directory,'project.json'),content:json({...source.dataset,version:6})},
    {target:path.join(directory,'settings.json'),content:json({version:6,models:{[source.family]:config}})},
    {target:path.join(directory,'captions','index.json'),content:json({version:1,sets:[caption_set]})},
    {target:path.join(setRoot,'latest.json'),content:json(source.latest)},
    {target:path.join(setRoot,'audit.json'),content:json(source.audit)},
    ...source.captions.map(caption=>({target:path.join(setRoot,'texts',`${caption.asset_id}.txt`),content:caption.bytes})),
    ...[...sourceFiles].filter(([file,bytes])=>bytes!==null&&(file.startsWith('captioning/')||file.endsWith('caption.txt'))).map(([file])=>({target:path.join(directory,file),content:null})),
  ];
  // 备份期间的外部修改也会被发现；正式调用还持有训练事实队列与 ETag。
  if((await migrationSource(repositoryRoot,datasetId)).fingerprint!==source.fingerprint)throw new LoraTrainingError(409,'training_migration_source_changed');
  try {await commitFileChanges(changes);}
  catch(error) {
    // commitFileChanges 已回滚文件；仅移除本次创建的空目录，便于显式重试。
    for(const empty of [path.join(setRoot,'texts'),setRoot,path.join(directory,'captions')])await rmdir(empty).catch(()=>undefined);
    throw error;
  }
  return {migrated:true,dataset_id:datasetId,caption_set_id:caption_set.id,family:source.family,summary:source.summary,backup_directory:backup,fingerprint:source.fingerprint};
}
