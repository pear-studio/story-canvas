import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,stat,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {loadLocalConfig} from '../server/http-support.mjs';
import {prepareAnimationFiles} from '../server/animation-output.mjs';
import {ensureMediaVariant} from '../server/media-variants.mjs';
import {fixture,json} from './helpers/finished-fixture.mjs';
import {createPage} from '../server/page-facts.mjs';
import {handleFinishedRequest} from '../server/finished-http.mjs';
import {prepareExportAnimation,prepareEhAnimation} from '../server/finished-export-animation.mjs';
import {createHash} from 'node:crypto';

const appRoot=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);

test('EH 与 MP4 从冻结源精确应用裁剪/倍率，缓存复用；哈希不匹配不编码',async t=>{
  const saved=path.resolve(appRoot,'../Saved/Tests');await mkdir(saved,{recursive:true});
  const directory=await mkdtemp(path.join(saved,'export-animation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=await video(t,directory,1280);if(!source)return;
  const entry={index:2,relative:'animation.webp',source_backup:'test-source.mp4',source_sha256:createHash('sha256').update(source.bytes).digest('hex'),video_postprocess:{trim_start_seconds:.5,trim_end_seconds:.25,speed:2.5},duration_seconds:.5};
  const signal=new AbortController().signal;
  const webp=await prepareEhAnimation(directory,entry,signal);
  const meta=await sharp(await readFile(webp.target),{animated:true}).metadata();assert.equal(meta.width,640);assert.ok(meta.pages<=9);assert.equal(meta.delay.reduce((a,b)=>a+b),500);
  const mp4=await prepareExportAnimation(directory,entry,{format:'mp4',crf:20,preset:'medium'},signal);
  const inspection=JSON.parse((await run(source.python,['-B',path.join(appRoot,'tests/helpers/video-postprocess-fixture.py'),'video',mp4.target],{windowsHide:true})).stdout);
  assert.equal(inspection.frames,30);assert.equal(inspection.fps,60);assert.equal(inspection.duration_seconds,.5);assert.ok(Math.abs(inspection.first_pixel[0]-48)<10);
  const stamp=(await stat(mp4.target)).mtimeMs;assert.equal((await prepareExportAnimation(directory,entry,{format:'mp4',crf:20,preset:'medium'},signal)).target,mp4.target);assert.equal((await stat(mp4.target)).mtimeMs,stamp);
  await assert.rejects(prepareExportAnimation(directory,{...entry,source_sha256:'0'.repeat(64)},{format:'mp4',crf:20,preset:'medium'},signal),e=>e.details[0].includes('校验失败'));
  assert.deepEqual(await readFile(source.source),source.bytes);
});
test('GIF五档真实编码：15MB策略首档达标即停，保持时长，全档失败不发布',async t=>{
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root){t.skip('未配置视频环境');return;}
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const saved=path.resolve(appRoot,'../Saved/Tests');await mkdir(saved,{recursive:true});
  const directory=await mkdtemp(path.join(saved,'gif-fallback-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const result=await run(python,['-B',path.join(appRoot,'tests/helpers/gif-fallback-test.py'),directory],{windowsHide:true});
  assert.equal(JSON.parse(result.stdout).tiers_verified,5);
});
async function video(t,directory,width=64){
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root){t.skip('未配置视频环境');return null;}
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const source=path.join(directory,'test-source.mp4');
  await run(python,['-B',path.join(appRoot,'tests/helpers/video-postprocess-fixture.py'),'create',source,String(width)],{windowsHide:true});
  return {source,bytes:await readFile(source),python};
}

test('真实双格式：原尺寸Q80、最终时间轴12fps、短尾保护及缓存复用',async t=>{
  const saved=path.resolve(appRoot,'../Saved/Tests');await mkdir(saved,{recursive:true});
  const directory=await mkdtemp(path.join(saved,'animation-pair-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=await video(t,directory,1280);if(!source)return;
  const settings={trim_start_seconds:.5,trim_end_seconds:.25,speed:2.5};
  const first=await prepareAnimationFiles(source.bytes,directory,settings);
  const webp=await sharp(first.webp,{animated:true}).metadata(),gif=await sharp(first.gif,{animated:true}).metadata();
  assert.equal(webp.width,1280,'原尺寸不能被1024封顶');assert.equal(gif.width,480);
  assert.equal(first.metadata.duration_seconds,.5);assert.equal(first.metadata.frames,30);
  assert.equal(first.metadata.gif.duration_seconds,.5);assert.equal(first.metadata.gif.encoded_frames,6);
  assert.ok(gif.delay.every(ms=>ms>=20));assert.equal(gif.delay.reduce((a,b)=>a+b),500);
  const poster=await sharp(first.poster).raw().toBuffer();assert.ok(Math.abs(poster[0]-48)<8);
  const savedInfo=await stat(first.gifTarget);
  const second=await prepareAnimationFiles(source.bytes,directory,settings);
  assert.deepEqual(second.webp,first.webp);assert.deepEqual(second.gif,first.gif);assert.equal((await stat(second.gifTarget)).mtimeMs,savedInfo.mtimeMs);
  const candidate=await ensureMediaVariant(directory,{target:source.source,info:await stat(source.source)},'candidate.mp4','original',settings);
  assert.equal(candidate.target,first.webpTarget,'候选与冻结成品共用原尺寸缓存');
  await assert.rejects(prepareAnimationFiles(source.bytes,directory,{trim_end_seconds:47/24,speed:4}),/20ms/);
  assert.deepEqual(await readFile(source.source),source.bytes);
  assert.deepEqual(await readdir(path.join(directory,'Saved/staging')),[]);
});

test('不同参数共享冷缓存，先发消费者取消不会删除后发任务的输入',async t=>{
  const saved=path.resolve(appRoot,'../Saved/Tests');await mkdir(saved,{recursive:true});
  const directory=await mkdtemp(path.join(saved,'animation-cancel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=await video(t,directory,1280);if(!source)return;
  const a=new AbortController(),b=new AbortController();
  const first=prepareAnimationFiles(source.bytes,directory,{speed:1.2},a.signal);
  const firstResult=assert.rejects(first,error=>error.name==='AbortError');
  const second=prepareAnimationFiles(source.bytes,directory,{trim_start_seconds:.25,speed:1.8},b.signal);
  await new Promise(resolve=>setTimeout(resolve,100));a.abort();
  await firstResult;const result=await second;
  assert.equal(result.metadata.frames,42);assert.ok(result.gif.length>0);
  for(let i=0;i<50&&(await readdir(path.join(directory,'Saved/staging'))).length;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(await readdir(path.join(directory,'Saved/staging')),[]);
  assert.equal((await readdir(path.join(directory,'Saved/media-cache'))).some(name=>name.endsWith('.tmp')||name.endsWith('.mp4')),false);
});

test('旧MP4按模式导出WebP或GIF：不重复后处理、不改记录、第二次复用缓存',async t=>{
  const f=await fixture(t),source=await video(t,f.directory);if(!source)return;
  await f.run(await f.prepare());
  const page=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'video'});
  const contentPath=path.join(f.directory,'pages',page.page_id+'.content.json'),content=JSON.parse(await readFile(contentPath,'utf8'));
  content.video_postprocess={trim_start_seconds:0,trim_end_seconds:0,speed:2};await json(contentPath,content);
  const prefix=`Outputs/finished/${page.page_id}/legacy`;await mkdir(path.join(f.directory,prefix),{recursive:true});
  await writeFile(path.join(f.directory,prefix,'video.mp4'),source.bytes);
  await writeFile(path.join(f.directory,prefix,'poster.png'),await readFile(f.file));
  const recordPath=path.join(f.directory,'finished',page.page_id+'.json');
  await json(recordPath,{page_key:page.page_key,page_kind:'video',candidate_id:'candidate-11111111-1111-4111-8111-111111111111',source_sha256:'0'.repeat(64),video:{width:64,height:48,frames:48,fps:24,duration_seconds:2},video_postprocess:{trim_start_seconds:0,trim_end_seconds:0,speed:2},lettering:{page_kind:'video',canvas:'2:3'},width:64,height:48,created_at:new Date().toISOString(),outputs:{clean:prefix+'/video.mp4',lettered:prefix+'/video.mp4'},poster:prefix+'/poster.png'});
  const before=await readFile(recordPath);
  const server=createServer(async(request,response)=>{try{await handleFinishedRequest({request,response,decodedPath:new URL(request.url,'http://local').pathname,projectRoot:f.root,readFacts:f.operations.readFacts});}catch(error){response.writeHead(500);response.end(error.stack);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const send=async (preview,mode='standard')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/demo/finished/export`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({variant:'lettered',preview,mode})});assert.equal(response.status,200,await response.clone().text());return Buffer.from(await response.arrayBuffer());};
  const zip=await send(false);assert.ok(!zip.includes(Buffer.from('002.gif')));assert.ok(zip.includes(Buffer.from('002.webp')));assert.ok(!zip.includes(source.bytes));
  const pixiv=await send(false,'pixiv');assert.ok(pixiv.includes(Buffer.from('动画GIF/002.gif')));assert.ok(!pixiv.includes(Buffer.from('002.webp')));
  const pair=await prepareAnimationFiles(source.bytes,f.directory);
  assert.equal(pair.metadata.gif.duration_seconds,2,'旧MP4已处理，不能再应用记录中的2倍速');assert.ok(pixiv.includes(pair.gif));
  const stamp=(await stat(pair.gifTarget)).mtimeMs;
  const html=(await send(true)).toString();assert.equal((html.match(/data:image\/webp;base64/g)||[]).length,1);assert.equal((html.match(/data:video\/mp4;base64/g)||[]).length,1);assert.doesNotMatch(html,/<video[^>]* controls|image\/gif/);
  assert.equal((await stat(pair.gifTarget)).mtimeMs,stamp);assert.deepEqual(await readFile(recordPath),before);
});
