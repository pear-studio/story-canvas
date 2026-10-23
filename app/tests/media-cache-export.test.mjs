import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fixture,key,candidateId} from './helpers/finished-fixture.mjs';
import {prepareFinishedPage} from '../server/finished-pages.mjs';
import {handleFinishedRequest} from '../server/finished-http.mjs';
import {exportFinishedLocal} from '../server/finished-export.mjs';
import {createMediaCache,mediaCache} from '../server/media-cache.mjs';

test('极小预算下，下载票据持有缓存直到下载完成或过期，本机导出写完才回收',async t=>{
  const errors=[],cache=createMediaCache({limitBytes:1,targetBytes:0,onError:error=>errors.push(error)});
  for(const [name,method] of Object.entries(cache))t.mock.method(mediaCache,name,method);
  const f=await fixture(t);
  const prepared=await prepareFinishedPage(f.root,'demo',f.directory,{page_key:key,candidate_id:candidateId});
  assert.equal((await f.run(prepared)).status,'completed');
  const timers=[],timeout=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
    const timer=timeout(callback,ms,...args);
    if(ms===15*60_000)timers.push({callback,timer});
    return timer;
  });
  t.after(()=>{for(const {timer} of timers)clearTimeout(timer);});
  const server=createServer(async(request,response)=>{
    try{await handleFinishedRequest({request,response,decodedPath:new URL(request.url,'http://local').pathname,projectRoot:f.root,readFacts:f.operations.readFacts});}
    catch(error){response.writeHead(error.status??500);response.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/projects/demo/finished/export`;
  const prepare=async()=>{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({variant:'lettered',mode:'pixiv',prepare:true})});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  const pixiv=path.join(f.directory,'Saved/media-cache/pixiv');
  const ticket=await prepare();await cache.settle(f.directory);
  let files=await readdir(pixiv);assert.equal(files.length,1,'即使超过预算，待下载的JPEG仍存在');
  const jpeg=await readFile(path.join(pixiv,files[0]));
  const response=await fetch(new URL(ticket.download_url,url));assert.equal(response.status,200);
  assert.ok(Buffer.from(await response.arrayBuffer()).includes(jpeg));
  await cache.settle(f.directory);assert.deepEqual(await readdir(pixiv),[],'流式下载结束后才能清理');
  const expired=await prepare();assert.equal((await readdir(pixiv)).length,1);
  const expiration=timers.at(-1);clearTimeout(expiration.timer);expiration.callback();
  await cache.settle(f.directory);assert.deepEqual(await readdir(pixiv),[],'票据过期释放使用保护');
  const gone=await fetch(new URL(expired.download_url,url));assert.equal(gone.status,404);await gone.text();
  const local=await exportFinishedLocal({projectRoot:f.root,projectId:'demo',value:{modes:['pixiv','preview'],editions:['zh']},readFacts:f.operations.readFacts,signal:new AbortController().signal,progress:()=>{}});
  assert.equal(local.artifacts.length,2);
  assert.ok((await readFile(local.artifacts[0].file)).includes(jpeg));
  assert.match(await readFile(local.artifacts[1].file,'utf8'),/data:image\/webp;base64/);
  await cache.settle(f.directory);assert.deepEqual(await readdir(pixiv),[]);assert.deepEqual(errors,[]);
});
