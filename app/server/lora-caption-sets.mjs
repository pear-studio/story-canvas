import path from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {LoraTrainingError,datasetRoot,isWithin,readJson} from './lora-training-support.mjs';

export const captionSetIdPattern=/^caption-set-[a-f0-9]{12}$/;
export function captionSetPaths(repositoryRoot,datasetId,setId){
  if(!captionSetIdPattern.test(setId??''))throw new LoraTrainingError(422,'caption_set_id_required');
  const root=path.join(datasetRoot(repositoryRoot,datasetId),'captions',setId);
  return {root,texts:path.join(root,'texts'),latest:path.join(root,'latest.json'),audit:path.join(root,'audit.json')};
}
export async function readCaptionSets(repositoryRoot,datasetId){
  const root=datasetRoot(repositoryRoot,datasetId),directory=path.join(root,'captions');
  for(const target of [directory,path.join(directory,'index.json')]){
    const info=await lstat(target).catch(()=>null);
    if(!info||info.isSymbolicLink()||(target===directory?!info.isDirectory():!info.isFile())||!isWithin(root,await realpath(target)))throw new LoraTrainingError(422,'invalid_caption_sets_storage');
  }
  const value=await readJson(path.join(directory,'index.json'));
  if(value?.version!==1||!Array.isArray(value.sets)||!value.sets.length||Object.keys(value).some(k=>!['version','sets'].includes(k)))throw new LoraTrainingError(422,'invalid_caption_sets');
  const seen=new Set();
  for(const set of value.sets){
    if(!captionSetIdPattern.test(set?.id??'')||seen.has(set.id)||typeof set.name!=='string'||!set.name.trim()||!['tags','prose'].includes(set.format)||Object.keys(set).some(k=>!['id','name','format'].includes(k)))throw new LoraTrainingError(422,'invalid_caption_sets');
    seen.add(set.id);
  }
  return value.sets;
}
export async function requireCaptionSet(repositoryRoot,datasetId,setId){
  const set=(await readCaptionSets(repositoryRoot,datasetId)).find(s=>s.id===setId);
  if(!set)throw new LoraTrainingError(422,setId?'caption_set_not_found':'caption_set_id_required');
  const {root,texts}=captionSetPaths(repositoryRoot,datasetId,setId);
  for(const target of [root,texts]){
    const info=await lstat(target).catch(()=>null);
    if(!info?.isDirectory()||info.isSymbolicLink()||!isWithin(datasetRoot(repositoryRoot,datasetId),await realpath(target)))throw new LoraTrainingError(422,'invalid_caption_sets_storage');
  }
  return set;
}
