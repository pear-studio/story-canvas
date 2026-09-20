import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('视觉CLI接受v3和裸ID，场景及孤儿页无需工作台导航查找',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'visual-cli-'));
 const requests=[];
 const server=createServer(async(req,res)=>{
  let input='';for await(const chunk of req)input+=chunk;
  const body=JSON.parse(input||'{}');requests.push({url:req.url,method:req.method,body});
  res.setHeader('content-type','application/json');
  if(req.url.endsWith('/render'))res.end(JSON.stringify({task:{task_id:'queued',page_key:body.page_key}}));
  else res.end(JSON.stringify({page_key:body.page_key}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 await mkdir(path.join(directory,'scripts'),{recursive:true});await mkdir(path.join(directory,'server'));
 for(const file of ['visual-production.mjs','workbench-client.mjs'])await cp(path.join(sourceRoot,'scripts',file),path.join(directory,'scripts',file));
 await cp(path.join(sourceRoot,'server/page-key.mjs'),path.join(directory,'server/page-key.mjs'));
 await mkdir(path.join(directory,'../Config'),{recursive:true});
 await writeFile(path.join(directory,'../Config/local.json'),JSON.stringify({port:server.address().port}));
 for(const command of ['context','preview','render'])for(const key of ['v3/page-001','page-002']){
  const {stdout}=await promisify(execFile)(process.execPath,[path.join(directory,'scripts/visual-production.mjs'),command,'page','demo',key]);
  assert.deepEqual(JSON.parse(stdout).page_key,{page_id:key.split('/').at(-1)});
 }
 assert.equal(requests.length,6);
 assert.ok(requests.every(request=>request.method==='POST'));
 assert.equal(requests[0].url,'/api/agent/prompt-context');
});
