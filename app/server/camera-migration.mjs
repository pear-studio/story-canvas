// 显式格式迁移；普通读取不隐式改写事实。
import {readFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateModelPromptDocument} from './model-prompts.mjs';
import {factStorage} from './story-facts.mjs';
import {ApiError} from './http-support.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const assignments={
 'from front':['direction','front'],'from side':['direction','side'],'from behind':['direction','back'],
 'from above':['height','above'],'from below':['height','below'],
 'close-up':['shot','close_up'],'full body':['shot','full_body'],'wide shot':['shot','wide_shot'],
 'pov':['view','pov'],'blurry background':['backgroundBlur',true],'blurry foreground':['foregroundBlur',true],
};
export function migrateCameraDocument(document,kind='page') {
 const next=structuredClone(document),model=next.models?.anima;if(!model)return next;
 function convert(prompt,extract) {
  const settings={...prompt.camera_settings};
  for(const category of ['population','person','setting','camera','avoid'])prompt[category]=(prompt[category]??[]).flatMap(fragment=>{
   if(!Object.hasOwn(fragment,'camera_settings'))return [fragment];
   const {camera_settings:old,...plain}=fragment;
   // 被手动改写、加权、关闭或绑定角色的词保持原始语义，不根据过期面板元数据重新生成。
   if(!extract || category!=='camera' || plain.enabled===false || (plain.weight??1)!==1 || plain.character_id || !plain.description)return [plain];
   const rest=[];
   for(const text of plain.description.split(',').map(x=>x.trim())) {
    const pair=assignments[text];
    const oldValue=pair && (pair[0]==='shot'?{'近景':'close_up','全身':'full_body','远景':'wide_shot'}[old.shot]:old[pair[0]]);
    if(pair && oldValue===pair[1] && (settings[pair[0]]===undefined||settings[pair[0]]===pair[1]))settings[pair[0]]=pair[1];
    else rest.push(text);
   }
   return rest.length?[{...plain,description:rest.join(', ')}]:[];
  });
  if(extract&&Object.keys(settings).length)prompt.camera_settings=settings;
 }
 if(kind==='page')convert(model,true);
 else {convert(model.identity.prompt,false);for(const variant of Object.values(model.variants))convert(variant.prompt,false);}
 return next;
}
export async function migrateProjectCamera(directory,input) {
 const writes=[];
 for(const folder of ['pages','characters','scenes'])for(const name of (await readdir(path.join(directory,folder))).filter(x=>x.endsWith('.prompt.json'))) {
  const relative=folder+'/'+name,target=path.join(directory,relative),raw=await readFile(target,'utf8'),before=JSON.parse(raw),kind=folder==='pages'?'page':'character',after=migrateCameraDocument(before,kind);
  if(JSON.stringify(before)===JSON.stringify(after))continue;
  const errors=validateModelPromptDocument(folder==='scenes'?{...after,$schema:'https://storyvisualizer.local/schemas/character-prompt.schema.json'}:after,kind);
  if(errors.length)throw new ApiError(422,'camera_migration_invalid',[relative,...errors]);
  writes.push({relative,target,raw,before,after});
 }
 const fingerprint=hash(JSON.stringify(writes.map(w=>[w.relative,hash(w.raw),w.after])));
 if(!input.apply)return {files:writes.length,fingerprint,targets:writes.map(w=>w.relative)};
 if(input.fingerprint!==fingerprint)throw new ApiError(409,'camera_migration_conflict');
 if(!writes.length)return {migrated:0};
 const backup=path.join(directory,'.migration-backups','camera',randomUUID());
 for(const w of writes){const target=path.join(backup,w.relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(w.target,target);}
 const completed=[];
 try{for(const w of writes){if(hash(await readFile(w.target,'utf8'))!==hash(w.raw))throw new ApiError(409,'camera_migration_conflict',[w.relative]);await factStorage.writeJsonAtomic(w.target,w.after);completed.push(w);}}
 catch(error){for(const w of completed.reverse())await factStorage.writeJsonAtomic(w.target,w.before);throw error;}
 return {migrated:writes.length,backup};
}
