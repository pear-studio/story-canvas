import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPerformanceLog, browserPerformanceRecord } from '../server/performance-log.mjs';

test('性能日志串行写入并只保留一份轮换文件', async t => {
  const base = fileURLToPath(new URL('../../Saved/Tests/', import.meta.url));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(base, {recursive:true});
  const root = await mkdtemp(path.join(base, 'performance-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const log = createPerformanceLog(root, 180);
  await Promise.all(Array.from({length:8}, (_, index) => log({index, duration_ms:10})));
  const directory = path.join(root, 'Saved/Logs');
  assert.deepEqual((await readdir(directory)).sort(), ['performance.jsonl', 'performance.jsonl.1']);
  const records = (await readFile(path.join(directory,'performance.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).index, 7);
  assert.ok(records.every(record => record.time && record.duration_ms === 10));
});

test('浏览器计时只接收约定字段，不保留正文，拒绝无效耗时', () => {
  const record = browserPerformanceRecord({event:'workbench-load',outcome:'applied',duration_ms:12.8,request_id:'id',scope:'page',prompt:'secret'});
  assert.deepEqual(record,{kind:'browser',event:'workbench-load',outcome:'applied',duration_ms:13,request_id:'id',scope:'page'});
  assert.equal(browserPerformanceRecord({event:'workbench-load',outcome:'applied',duration_ms:-1}),null);
});

test('HTTP 计时关联请求并接收浏览器记录，日志不包含查询正文', async t => {
  const { createServer } = await import('node:http');
  const { createHttpRequestHandler } = await import('../server/http-app.mjs');
  const { mkdir } = await import('node:fs/promises');
  const base=fileURLToPath(new URL('../../Saved/Tests/',import.meta.url));
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(path.join(base,'performance-http-'));
  const server=createServer(createHttpRequestHandler({projectRoot:root,config:{},projectOperations:{}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(origin+'/api/%xx?prompt=secret',{headers:{'x-story-canvas-request-id':'test-load'}});
  assert.equal(response.status,400);
  await response.text();
  const report=await fetch(origin+'/api/performance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'workbench-load',outcome:'applied',duration_ms:30,request_id:'test-load',scope:'page'})});
  assert.equal(report.status,200);
  await report.text();
  let records=[];
  for(let i=0;i<50;i++) {
    const text=await readFile(path.join(root,'Saved/Logs/performance.jsonl'),'utf8').catch(()=> '');
    records=text.trim().split('\n').filter(Boolean).map(JSON.parse);
    if(records.length===2)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(records.length,2);
  assert.equal(records[0].kind,'http');
  assert.equal(records[0].status,400);
  assert.equal(records[1].kind,'browser');
  assert.ok(records.every(record=>record.request_id==='test-load'));
  assert.ok(!JSON.stringify(records).includes('secret'));
});
