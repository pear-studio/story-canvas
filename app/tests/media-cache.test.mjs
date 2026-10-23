import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,stat,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import sharp from 'sharp';
import {createMediaCache,mediaCache} from '../server/media-cache.mjs';
import {ensureMediaVariant} from '../server/media-variants.mjs';

async function fixture(t,options={}) {
  const saved=fileURLToPath(new URL('../../Saved/Tests/',import.meta.url));await mkdir(saved,{recursive:true});
  const root=await mkdtemp(path.join(saved,'media-cache-'));
  const errors=[],cache=createMediaCache({limitBytes:100,targetBytes:70,onError:error=>errors.push(error),...options});
  const folder=path.join(root,'Saved/media-cache');await mkdir(folder,{recursive:true});
  t.after(async()=>{await cache.settle(root);assert.deepEqual(errors,[]);await rm(root,{recursive:true,force:true});});
  const file=async(name,bytes)=>{const target=path.join(folder,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.alloc(bytes));return target;};
  return {root,folder,cache,file,errors};
}
const name=(letter,ext='webp')=>letter.repeat(40)+'.'+ext;
const exists=async target=>stat(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});

test('首次使用盘点旧缓存，先保护当前命中，空闲后回收冷项且不碰成果和任务',async t=>{
  const f=await fixture(t),old=await f.file(name('a'),60),current=await f.file(name('b'),60);
  const original=path.join(f.root,'Outputs/pages/image.png'),history=path.join(f.root,'Saved/render/state.json');
  await mkdir(path.dirname(original),{recursive:true});await mkdir(path.dirname(history),{recursive:true});
  await writeFile(original,'original');await writeFile(history,'history');
  const release=await f.cache.acquire(f.root);await f.cache.record(f.root,[current]);
  await f.cache.settle(f.root);assert.equal(await exists(old),true);
  release();await f.cache.settle(f.root);
  assert.equal(await exists(old),false);assert.equal(await exists(current),true);
  assert.equal(await readFile(original,'utf8'),'original');assert.equal(await readFile(history,'utf8'),'history');
  const index=JSON.parse(await readFile(path.join(f.root,'Saved/media-cache-index.json'),'utf8'));
  assert.equal(index.entries.length,1);assert.ok(index.entries[0].lastUsed>0);
});

test('只有新增缓存超限才安排回收，使用中的项目允许超限，按实际命中时间淘汰',async t=>{
  const f=await fixture(t),a=await f.file(name('a'),40);
  await f.cache.use(f.root,()=>f.cache.record(f.root,[a]));await f.cache.settle(f.root);
  const b=await f.file(name('b'),40);
  await f.cache.use(f.root,()=>f.cache.record(f.root,[b],{written:true}));await f.cache.settle(f.root);
  assert.equal(await exists(a),true);assert.equal(await exists(b),true);
  const download=await f.cache.acquire(f.root),c=await f.file(name('c'),40);
  await f.cache.use(f.root,()=>f.cache.record(f.root,[c],{written:true}));
  await f.cache.use(f.root,()=>f.cache.record(f.root,[a]));
  await f.cache.settle(f.root);assert.equal(await exists(b),true,'下载仍使用该项目缓存');
  download();await f.cache.settle(f.root);
  assert.equal(await exists(b),false);assert.equal(await exists(c),false);assert.equal(await exists(a),true);
});

test('GIF及元数据成组回收，命中记录跨重启保留，不信任索引中的文件路径和大小',async t=>{
  const f=await fixture(t),gif=await f.file(name('a','gif'),40),poster=await f.file(name('a','png'),20),meta=await f.file(name('a','json'),10),hot=await f.file(name('b'),20);
  await f.cache.use(f.root,()=>f.cache.record(f.root,[hot]));await f.cache.settle(f.root);
  const index=path.join(f.root,'Saved/media-cache-index.json'),saved=JSON.parse(await readFile(index,'utf8'));
  saved.entries[0].files={'../../Outputs/pages/image.png':999999};await writeFile(index,JSON.stringify(saved));
  const restarted=createMediaCache({limitBytes:100,targetBytes:70,onError:error=>f.errors.push(error)});
  const release=await restarted.acquire(f.root),newest=await f.file(name('c'),30);
  await restarted.record(f.root,[newest],{written:true});release();await restarted.settle(f.root);
  assert.equal(await exists(gif),false);assert.equal(await exists(poster),false);assert.equal(await exists(meta),false);
  assert.equal(await exists(hot),true);assert.equal(await exists(newest),true);
});

test('媒体响应、等待下载和异常退出持有保护，finish/close重复释放无副作用',async t=>{
  const f=await fixture(t),old=await f.file(name('a'),80);
  const response=new EventEmitter();response.destroyed=false;response.writableEnded=false;
  await f.cache.protectResponse(response,f.root);
  const ticket=await f.cache.acquire(f.root),fresh=await f.file(name('b'),60);
  await assert.rejects(f.cache.use(f.root,async()=>{await f.cache.record(f.root,[fresh],{written:true});throw Error('cancelled');}),/cancelled/);
  response.emit('finish');response.emit('close');await f.cache.settle(f.root);
  assert.equal(await exists(old),true,'票据仍未消费或过期');
  ticket();ticket();await f.cache.settle(f.root);
  assert.equal(await exists(old),false);assert.equal(await exists(fresh),true);
});

test('目录链接不能将回收或新缓存写入引向项目外',async t=>{
  const f=await fixture(t),external=path.join(f.root,'external');await mkdir(external);await writeFile(path.join(external,name('a')),'keep');
  await symlink(external,path.join(f.folder,'pixiv'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.cache.acquire(f.root),/不能是链接/);
  assert.equal(await readFile(path.join(external,name('a')),'utf8'),'keep');
});

test('静态图片复制到不同路径后复用缓存，像素变化才生成新缓存',async t=>{
  const f=await fixture(t),one=path.join(f.root,'one.png'),two=path.join(f.root,'two.png');
  const image=await sharp({create:{width:640,height:480,channels:3,background:'#ff0000'}}).png().toBuffer();
  await writeFile(one,image);await writeFile(two,image);
  const first=await ensureMediaVariant(f.root,{target:one,info:await stat(one)},'one.png',320);
  const second=await ensureMediaVariant(f.root,{target:two,info:await stat(two)},'different/path.png',320);
  assert.equal(first.target,second.target);assert.equal(first.info.mtimeMs,second.info.mtimeMs);
  await writeFile(two,await sharp(image).tint('#0000ff').png().toBuffer());
  const changed=await ensureMediaVariant(f.root,{target:two,info:await stat(two)},'different/path.png',320);
  assert.notEqual(changed.target,first.target);
  await mediaCache.settle(f.root);
  assert.equal((await readdir(f.folder)).filter(n=>n.endsWith('.webp')).length,2);
});
