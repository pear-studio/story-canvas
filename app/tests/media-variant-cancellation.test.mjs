import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createMediaVariantTasks} from '../server/media-variant-tasks.mjs';
import {runVideoProcess} from '../server/video-media.mjs';

test('共享编码只在最后一个消费者退出时取消，新请求可以重新编码',async()=>{
  const join=createMediaVariantTasks(),a=new AbortController(),b=new AbortController();
  let signal,resolve,starts=0;
  const generate=s=>{starts++;signal=s;return new Promise(r=>{resolve=r;});};
  const first=join('same',generate,a.signal),second=join('same',generate,b.signal);
  await Promise.resolve();a.abort();
  await assert.rejects(first,{name:'AbortError'});
  assert.equal(signal.aborted,false);assert.equal(starts,1);
  b.abort();await assert.rejects(second,{name:'AbortError'});
  assert.equal(signal.aborted,true);
  const third=join('same',()=>Promise.resolve('new'));
  resolve('old');assert.equal(await third,'new');
});

test('后台预热仍需要共享编码时，取消浏览器请求不终止它',async()=>{
  const join=createMediaVariantTasks(),controller=new AbortController();
  let signal,resolve;
  const warm=join('warm',s=>{signal=s;return new Promise(r=>{resolve=r;});});
  const request=join('warm',()=>assert.fail(),controller.signal);
  await Promise.resolve();controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(signal.aborted,false);resolve('done');assert.equal(await warm,'done');
});

test('取消会终止真实子进程并记录单次耗时',async()=>{
  const directory=fileURLToPath(new URL('../../Saved/Tests/video-cancellation/',import.meta.url));
  await mkdir(directory,{recursive:true});
  const marker=directory+'pid-'+Date.now()+'.txt',controller=new AbortController(),logs=[];
  const original=console.info;console.info=line=>logs.push(JSON.parse(line));
  try {
    const work=runVideoProcess(process.execPath,['-e',`require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`,marker],{signal:controller.signal,kind:'test_preview'});
    const rejected=assert.rejects(work,{name:'AbortError'});
    let pid;
    for(let n=0;n<100;n++){try{pid=Number(await readFile(marker,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
    assert.ok(pid);controller.abort();await rejected;
    assert.throws(()=>process.kill(pid,0));
    assert.equal(logs.at(-1).status,'cancelled');
    assert.ok(logs.at(-1).elapsed_ms>=0);
    assert.equal(logs[0].id,logs.at(-1).id);
  } finally {controller.abort();console.info=original;}
});
