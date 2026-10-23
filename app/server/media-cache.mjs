import {lstat,mkdir,readFile,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const MEDIA_CACHE_LIMIT_BYTES=2*1024**3;
export const MEDIA_CACHE_TARGET_BYTES=1.5*1024**3;
const areas=['','pixiv','export-animation'];

// 只管理这三处已发布缓存；临时文件、staging 和项目成果均不属于回收范围。
function cacheKey(relative) {
  const match=/^(?:(pixiv|export-animation)\/)?([a-f0-9]{40}|[a-f0-9]{64})\.(webp|jpg|gif|png|json|mp4)(\.json)?$/.exec(relative);
  if(!match)return null;
  return (match[1]?match[1]+'/':'')+match[2];
}
async function optionalStat(target){try{return await lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function directory(target,create=false) {
  if(create)await mkdir(target,{recursive:false}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await optionalStat(target);
  if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw Error('媒体缓存目录不能是链接或普通文件：'+target);
  return Boolean(info);
}
async function checkBoundary(root,create=false) {
  if(!await directory(root))return false;
  if(!await directory(path.join(root,'Saved'),create))return false;
  const cache=path.join(root,'Saved','media-cache');
  if(!await directory(cache,create))return false;
  for(const area of areas.slice(1))await directory(path.join(cache,area));
  const index=await optionalStat(path.join(root,'Saved','media-cache-index.json'));
  if(index&&(!index.isFile()||index.isSymbolicLink()))throw Error('媒体缓存索引必须是普通文件');
  return true;
}

export function createMediaCache({limitBytes=MEDIA_CACHE_LIMIT_BYTES,targetBytes=MEDIA_CACHE_TARGET_BYTES,now=Date.now,onError=error=>console.warn('[story-canvas] 媒体缓存维护失败：',error.message)}={}) {
  if(!(targetBytes>=0&&targetBytes<limitBytes))throw Error('无效的媒体缓存容量');
  const projects=new Map();
  async function initialize(state) {
    if(!await checkBoundary(state.root,true))throw Error('媒体缓存项目目录不存在');
    let previous;
    try{previous=JSON.parse(await readFile(state.index,'utf8'));}
    catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    const used=new Map(previous?.version===1&&Array.isArray(previous.entries)?previous.entries.filter(e=>typeof e.key==='string'&&Number.isFinite(e.lastUsed)&&e.lastUsed>=0).map(e=>[e.key,e.lastUsed]):[]);
    for(const area of areas) {
      const folder=path.join(state.cache,area);
      if(!await directory(folder))continue;
      const names=await readdir(folder);
      for(let offset=0;offset<names.length;offset+=64) {
        const batch=await Promise.all(names.slice(offset,offset+64).map(async name=>{
          const relative=(area?area+'/':'')+name,key=cacheKey(relative);
          if(!key)return null;
          const info=await optionalStat(path.join(folder,name));
          if(!info)return null;
          if(!info.isFile()||info.isSymbolicLink())throw Error('媒体缓存必须是普通文件：'+relative);
          return {relative,key,bytes:info.size};
        }));
        for(const file of batch.filter(Boolean)) {
          let entry=state.entries.get(file.key);
          if(!entry){entry={key:file.key,lastUsed:used.get(file.key)??0,files:{}};state.entries.set(file.key,entry);}
          entry.files[file.relative]=file.bytes;state.bytes+=file.bytes;
        }
      }
    }
    state.pending=state.bytes>limitBytes;
    state.flush=true;
  }
  function stateFor(root) {
    root=path.resolve(root);
    let state=projects.get(root);
    if(!state) {
      state={root,cache:path.join(root,'Saved','media-cache'),index:path.join(root,'Saved','media-cache-index.json'),entries:new Map(),bytes:0,users:0,pending:false,flush:false,touches:0,clock:0};
      state.ready=initialize(state).catch(error=>{projects.delete(root);throw error;});
      projects.set(root,state);
    }
    return state;
  }
  async function maintain(state) {
    if(!await checkBoundary(state.root)){projects.delete(state.root);return;}
    if(state.pending) {
      state.pending=false;
      const entries=[...state.entries.values()].sort((a,b)=>a.lastUsed-b.lastUsed||a.key.localeCompare(b.key));
      for(const entry of entries) {
        if(state.bytes<=targetBytes)break;
        for(const [relative,bytes] of Object.entries(entry.files)) {
          try {
            const target=path.join(state.cache,relative),info=await optionalStat(target);
            if(info&&(!info.isFile()||info.isSymbolicLink()))throw Error('拒绝清理非普通缓存文件：'+relative);
            if(info)await unlink(target);
            state.bytes-=bytes;delete entry.files[relative];
          }catch(error){onError(error);}
        }
        if(!Object.keys(entry.files).length)state.entries.delete(entry.key);
      }
      state.flush=true;
    }
    if(state.flush) {
      const temporary=state.index+'.'+randomUUID()+'.tmp';
      try {
        await writeFile(temporary,JSON.stringify({version:1,entries:[...state.entries.values()]}),{flag:'wx'});
        await rename(temporary,state.index);
        state.flush=false;state.touches=0;
      }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
  }
  function schedule(state) {
    if(state.scheduled||state.maintenance||state.users||(!state.pending&&!state.flush))return;
    state.scheduled=new Promise(resolve=>setImmediate(resolve)).then(()=>{
      state.scheduled=null;
      if(state.users)return;
      state.maintenance=maintain(state).catch(async error=>{
        // 项目整体删除或外部离线清空后，不重建目录、不留下旧运行状态。
        if(!await optionalStat(state.cache)){projects.delete(state.root);return;}
        onError(error);
      }).finally(()=>{state.maintenance=null;});
      return state.maintenance;
    });
  }
  async function acquire(root) {
    const state=stateFor(root);
    await state.ready;
    while(state.maintenance)await state.maintenance;
    state.users++;
    let released=false;
    return ()=>{if(released)return;released=true;state.users--;schedule(state);};
  }
  async function use(root,operation) {
    const release=await acquire(root);
    try{return await operation();}finally{release();await settle(root);}
  }
  async function record(root,targets,{written=false}={}) {
    const state=stateFor(root);await state.ready;
    if(!state.users)throw Error('记录媒体缓存时必须持有使用保护');
    const files=await Promise.all(targets.map(async target=>{
      const relative=path.relative(state.cache,path.resolve(target)).replaceAll('\\','/'),key=cacheKey(relative);
      if(!key)throw Error('无效的媒体缓存文件：'+relative);
      const info=await lstat(target);
      if(!info.isFile()||info.isSymbolicLink())throw Error('媒体缓存必须是普通文件：'+relative);
      return {relative,key,bytes:info.size};
    }));
    const stamp=state.clock=Math.max(now(),state.clock+1);
    for(const file of files) {
      let entry=state.entries.get(file.key);
      if(!entry){entry={key:file.key,lastUsed:stamp,files:{}};state.entries.set(file.key,entry);}
      state.bytes+=file.bytes-(entry.files[file.relative]??0);
      entry.files[file.relative]=file.bytes;entry.lastUsed=stamp;
    }
    // 命中只记内存中的使用时间；每 64 次合并保存，不触发容量回收。
    if(++state.touches>=64||written)state.flush=true;
    if(written&&state.bytes>limitBytes)state.pending=true;
  }
  async function settle(root) {
    const state=projects.get(path.resolve(root));if(!state)return;
    await state.ready;
    schedule(state);
    while(state.scheduled||state.maintenance)await(state.scheduled??state.maintenance);
  }
  async function protectResponse(response,root) {
    const release=await acquire(root);
    const done=()=>{response.off('finish',done);response.off('close',done);release();};
    response.once('finish',done);response.once('close',done);
    if(response.destroyed||response.writableEnded)done();
    return done;
  }
  return {acquire,use,record,settle,protectResponse};
}

export const mediaCache=createMediaCache();
