import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,unlink,cp,truncate,readdir,stat} from 'node:fs/promises';
import {exportFinishedLocal,createExportDirectory} from '../server/finished-export.mjs';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,key,json,candidateId} from './helpers/finished-fixture.mjs';
import {createPage} from '../server/page-facts.mjs';
import {prepareFinishedPage,readFinishedPages,readFinishedRecord} from '../server/finished-pages.mjs';
import {handleFinishedRequest} from '../server/finished-http.mjs';
import {candidateFileRelativePath} from '../server/candidate-storage.mjs';
import {executeWorkbench} from '../scripts/workbench-actions/index.mjs';
import {handleProjectRequest} from '../server/project-http.mjs';

async function exporter(t,f){
  const server=createServer(async(request,response)=>{
    try{await handleFinishedRequest({request,response,decodedPath:new URL(request.url,'http://local').pathname,projectRoot:f.root,readFacts:f.operations.readFacts});}
    catch(error){response.writeHead(error.status??500,{'content-type':'application/json'});response.end(JSON.stringify({error:error.code,message:error.message,details:error.details}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return value=>fetch(`http://127.0.0.1:${server.address().port}/api/projects/demo/finished/export`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
}
function zipNames(zip){
  const names=[];let offset=0;
  while((offset=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),offset))!==-1){const size=zip.readUInt16LE(offset+28);names.push(zip.subarray(offset+46,offset+46+size).toString());offset+=46+size;}
  return names;
}
async function make(f,page_key,locale='zh',options={}){
  const prepared=(await f.operations.mutateDerived('demo',()=>prepareFinishedPage(f.root,'demo',f.directory,{page_key,locale,...(page_key.page_id===key.page_id?{candidate_id:candidateId}:{})}))).value;
  assert.equal((await f.run(prepared,options)).status,'completed');
}

test('四版独立下载，无字省略未制作文字页并保留页码；语言版精确检查自己的成果',async t=>{
  const f=await fixture(t),text=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'text'});
  const indexPath=path.join(f.directory,'pages/index.json'),index=JSON.parse(await readFile(indexPath,'utf8'));
  index.pages.reverse();await json(indexPath,index);
  await make(f,key);
  const send=await exporter(t,f),before=await readFile(path.join(f.directory,'finished/page-001.json'));
  const missing=await send({variant:'lettered'});assert.equal(missing.status,409);assert.match((await missing.json()).details.join('\n'),/第 1 页.*尚未制作/);
  const clean=await send({variant:'clean',locale:'ja'});assert.equal(clean.status,200);assert.deepEqual(zipNames(Buffer.from(await clean.arrayBuffer())),['002.png']);
  assert.deepEqual(await readFile(path.join(f.directory,'finished/page-001.json')),before,'无字导出不迁移或修改原记录');
  const filenames=new Set();
  for(const locale of ['zh','en','ja']){
    await make(f,key,locale,{render:async source=>sharp(source).tint({zh:'#ff0000',en:'#00ff00',ja:'#0000ff'}[locale]).png().toBuffer()});
    await make(f,text.page_key,locale);
    const response=await send({variant:'lettered',locale});assert.equal(response.status,200);
    filenames.add(response.headers.get('content-disposition'));
    const zip=Buffer.from(await response.arrayBuffer());assert.deepEqual(zipNames(zip),['001.png','002.png']);
    const record=await readFinishedRecord(f.directory,key.page_id,locale);assert.ok(zip.includes(await readFile(path.join(f.directory,record.outputs.lettered))));
  }
  const cleanResponse=await send({variant:'clean'});filenames.add(cleanResponse.headers.get('content-disposition'));await cleanResponse.arrayBuffer();assert.equal(filenames.size,4);
  const htmlResponse=await send({variant:'clean',preview:true});assert.equal(htmlResponse.status,200);
  assert.deepEqual([... (await htmlResponse.text()).matchAll(/data-page="(\d+)"/g)].map(m=>m[1]),['2']);
  const english=await readFinishedRecord(f.directory,key.page_id,'en');await unlink(path.join(f.directory,english.outputs.lettered));
  const blocked=await send({variant:'lettered',locale:'en'});assert.equal(blocked.status,409);assert.match((await blocked.json()).details.join('\n'),/第 2 页.*文件缺失/);
  const zh=await send({variant:'lettered',locale:'zh'});assert.equal(zh.status,200);await zh.arrayBuffer();
});

test('对白和译文变化只阻止有字版；底图更换也阻止无字，跨语言复用匹配的干净图',async t=>{
  const f=await fixture(t);await make(f,key);
  const send=await exporter(t,f),contentPath=path.join(f.directory,'pages/page-001.content.json'),content=JSON.parse(await readFile(contentPath,'utf8'));
  content.dialogue=[{id:'dialogue-123456789abc',mode:'narration',text:'新对白'}];await json(contentPath,content);
  for(const preview of [false,true]){
    const response=await send({variant:'lettered',preview});assert.equal(response.status,409);assert.match((await response.json()).details.join('\n'),/文字内容/);
    const clean=await send({variant:'clean',preview});assert.equal(clean.status,200);await clean.arrayBuffer();
  }
  // 重新制作中文版后，英文译文缺失不影响无字。
  await make(f,key);assert.equal((await readFinishedPages(f.root,'demo',f.directory,{variant:'clean',locale:'en'})).pages[0].status,'ready');
  const next='candidate-22222222-2222-4222-8222-222222222222',nextFile=path.join(f.directory,candidateFileRelativePath(key,next));
  await cp(path.dirname(f.file),path.dirname(nextFile),{recursive:true});
  await json(nextFile.replace('image.png','result.json'),{version:1,status:'available',page_key:key,candidate_id:next,file:candidateFileRelativePath(key,next),seed:5678,task_id:'render-new'});
  await unlink(f.file.replace('image.png','result.json'));
  const blocked=await send({variant:'clean'});assert.equal(blocked.status,409);assert.match((await blocked.json()).details.join('\n'),/候选已变化/);
  // 无对白的英文新成品可以提供新底图，不必先覆盖中文版的旧成果。
  content.dialogue=[];await json(contentPath,content);
  const prepared=await prepareFinishedPage(f.root,'demo',f.directory,{page_key:key,locale:'en',candidate_id:next});assert.equal((await f.run(prepared)).status,'completed');
  const listing=await readFinishedPages(f.root,'demo',f.directory,{variant:'clean'});assert.equal(listing.pages[0].status,'ready');assert.equal(listing.pages[0].locale,'en');
  assert.equal((await readFinishedRecord(f.directory,key.page_id)).candidate_id,candidateId,'复用英文底图不改中文记录');
  const cleanRecord=await readFinishedRecord(f.directory,key.page_id,'en');await unlink(path.join(f.directory,cleanRecord.outputs.clean));
  assert.equal((await send({variant:'clean'})).status,409,'不能用过时中文版掩盖新底图缺失');
});

test('Agent 成品查询与导出契约提供无字检查和四个独立版本',async()=>{
  const help=await executeWorkbench({operation:'help',target:'finished.export'});assert.deepEqual(help.parameters.properties.variant.enum,['lettered','clean']);
  for(const target of ['finished.list','finished.inspect']){
    const read=await executeWorkbench({operation:'help',target});assert.deepEqual(read.parameters.properties.variant.enum,['lettered','clean']);assert.deepEqual(read.parameters.properties.locale.enum,['zh','en','ja']);
  }
});

test('下载准备只返回清单地址，原生下载包含准确长度并保持校验失败可见',async t=>{
  const f=await fixture(t);await make(f,key);
  const send=await exporter(t,f);
  for(const preview of [false,true]){
    const response=await send({variant:'clean',prepare:true,preview});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);
    const prepared=await response.json();assert.match(prepared.filename,preview?/无字-网页\.html$/:/无字-高清\.zip$/);
    const url=new URL(prepared.download_url,response.url);
    const wrongProject=await fetch(url.href.replace('/projects/demo/','/projects/other/'));assert.equal(wrongProject.status,404);await wrongProject.text();
    const download=await fetch(url);assert.equal(download.status,200);
    const bytes=Buffer.from(await download.arrayBuffer());assert.equal(Number(download.headers.get('content-length')),bytes.length);
    if(preview)assert.match(bytes.toString(),/data-page="1"/);else assert.deepEqual(zipNames(bytes),['001.png']);
    const reused=await fetch(url);assert.equal(reused.status,404);await reused.text();
  }
  const record=await readFinishedRecord(f.directory,key.page_id);await unlink(path.join(f.directory,record.outputs.clean));
  const blocked=await send({variant:'clean',prepare:true});assert.equal(blocked.status,409);assert.match((await blocked.json()).details.join('\n'),/文件缺失/);
});

test('大包取消传输后服务仍可正常准备和下载下一版本',async t=>{
  const f=await fixture(t);await make(f,key);
  const record=await readFinishedRecord(f.directory,key.page_id);
  await truncate(path.join(f.directory,record.outputs.lettered),128*1024*1024);
  const send=await exporter(t,f),preparedResponse=await send({variant:'lettered',prepare:true});
  const prepared=await preparedResponse.json();
  const controller=new AbortController();
  const response=await fetch(new URL(prepared.download_url,preparedResponse.url),{signal:controller.signal});
  const reader=response.body.getReader();assert.ok((await reader.read()).value.length>0);controller.abort();
  await reader.cancel().catch(()=>{});
  const next=await send({variant:'clean'});assert.equal(next.status,200);assert.deepEqual(zipNames(Buffer.from(await next.arrayBuffer())),['001.png']);
});

test('浏览器批量下载共用用途和版本选择，先完整校验再提供所有文件',async t=>{
  const f=await fixture(t);await make(f,key);
  const send=await exporter(t,f),selection={modes:['standard','preview'],editions:['zh','en'],prepare:true,progress:true};
  const blocked=await send(selection);assert.equal(blocked.status,409);assert.match((await blocked.json()).details.join('\n'),/英文/);
  await make(f,key,'en');
  const response=await send(selection),events=(await response.text()).trim().split('\n').map(JSON.parse),result=events.at(-1).result;
  assert.equal(result.artifacts.length,4);assert.equal(result.groups.length,4);
  assert.equal(new Set(result.artifacts.map(a=>a.download_url)).size,4);
  for(const artifact of result.artifacts){
    assert.match(artifact.filename,/-全文-(中文|英文)-(高清\.zip|网页\.html)$/);
    const downloaded=await fetch(new URL(artifact.download_url,response.url));assert.equal(downloaded.status,200);
    const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(bytes.length,Number(downloaded.headers.get('content-length')));
    if(artifact.filename.endsWith('.zip'))assert.deepEqual(zipNames(bytes),['001.png']);else assert.match(bytes.toString(),/data-page="1"/);
  }
  const invalid=await send({...selection,editions:[]});assert.equal(invalid.status,400);await invalid.text();
});

test('作品名称经项目接口保存、读取、回退与清空，改名不使成品过时',async t=>{
  const f=await fixture(t);await make(f,key);
  const server=createServer(async(request,response)=>{
    try{await handleProjectRequest({request,response,decodedPath:new URL(request.url,'http://local').pathname,projectRoot:f.root,readFacts:f.operations.readFacts,mutateFacts:(id,fn)=>f.operations.mutateFacts(id,{expectedRevision:request.headers['if-match']},fn),sendOperation:(status,result,extra={})=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({...result,...extra}));}});}
    catch(error){response.writeHead(error.status??500);response.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/projects/demo/project`;
  const settings=(await(await fetch(url)).json()).value;
  const save=async work_title=>{const read=await(await fetch(url)).json();return fetch(url,{method:'PUT',headers:{'content-type':'application/json','if-match':read.revision},body:JSON.stringify({...settings,work_title})});};
  const saved=await save({zh:'作品中文',en:"Claret & Roxy's Midnight Desserts"});assert.equal(saved.status,200,await saved.clone().text());
  const reread=(await(await fetch(url)).json()).value;assert.equal(reread.title,settings.title);assert.equal(reread.work_title.zh,'作品中文');
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages[0].status,'ready');
  await make(f,key,'en');await make(f,key,'ja');
  const send=await exporter(t,f);
  for(const [locale,variant,expected] of [['zh','lettered','作品中文'],['en','lettered',"Claret & Roxy's Midnight Desserts"],['ja','lettered','作品中文'],['ja','clean','作品中文']]){
    const preparation=await send({locale,variant,mode:'pixiv',prepare:true,progress:true}),prepared=await preparation.text();
    const events=prepared.trim().split('\n').map(JSON.parse),result=events.at(-1).result;
    assert.ok(events.some(e=>e.progress));assert.ok(result.filename.startsWith(expected));assert.equal(result.volumes[0].pages,1);
    const download=await fetch(new URL(result.download_url,preparation.url));assert.ok(decodeURIComponent(download.headers.get('content-disposition')).includes(expected));assert.deepEqual(zipNames(Buffer.from(await download.arrayBuffer())),['静态投稿/01-001-001/001.jpg']);
  }
  const invalid=await save({fr:'wrong'});assert.equal(invalid.status,422);
  const clear=await save({});assert.equal(clear.status,200);assert.equal((await(await fetch(url)).json()).value.work_title,undefined);
});

test('批量本机导出先检查四版，平铺保存所有文件且不改记录；重复导出新目录',async t=>{
  const f=await fixture(t);await make(f,key);
  const invoke=(modes,editions)=>exportFinishedLocal({projectRoot:f.root,projectId:'demo',value:{modes,editions},readFacts:f.operations.readFacts,signal:new AbortController().signal,progress:()=>{}});
  await assert.rejects(invoke(['standard','eh'],['zh','en']),e=>e.code==='finished_export_not_ready');
  await assert.rejects(readdir(path.join(f.directory,'Outputs/exports')),{code:'ENOENT'},'预检失败不创建导出目录');
  await make(f,key,'en');await make(f,key,'ja');
  const before=await readFile(path.join(f.directory,'finished/page-001.json'));
  const result=await invoke(['standard','eh','pixiv','preview'],['zh','en','ja','clean']);
  assert.equal(result.artifacts.length,16);
  assert.match(path.basename(result.directory),/^全文-中文_英文_日文_无字-高清_EH_Pixiv_网页-\d{4}-\d{2}-\d{2}-\d{4}$/);
  assert.equal((await readdir(result.directory)).length,16);
  assert.ok(result.artifacts.every(a=>path.dirname(a.file)===result.directory));
  for(const artifact of result.artifacts){
    assert.equal((await stat(artifact.file)).size,artifact.bytes);
    const bytes=await readFile(artifact.file);
    if(artifact.mode==='standard')assert.deepEqual(zipNames(bytes),['001.png']);
    if(artifact.mode==='eh')assert.deepEqual(zipNames(bytes),['001.jpg']);
    if(artifact.mode==='pixiv')assert.deepEqual(zipNames(bytes),['静态投稿/01-001-001/001.jpg']);
    if(artifact.mode==='preview')assert.match(bytes.toString(),/data:image\/webp;base64/);
  }
  assert.deepEqual(await readFile(path.join(f.directory,'finished/page-001.json')),before);
  const again=await invoke(['standard'],['zh']);assert.notEqual(again.directory,result.directory);
  assert.equal((await stat(result.artifacts[0].file)).size,result.artifacts[0].bytes);
  await assert.rejects(invoke(['standard','standard'],['zh']),e=>e.status===400);
});

test('批量取消保留已完成文件，不留下当前.partial',async t=>{
  const f=await fixture(t);await make(f,key);
  const controller=new AbortController();
  let savedDirectory;
  await assert.rejects(exportFinishedLocal({projectRoot:f.root,projectId:'demo',value:{modes:['standard','preview'],editions:['zh']},readFacts:f.operations.readFacts,signal:controller.signal,progress:event=>{if(event.message.startsWith('网页 ·'))controller.abort();}}),e=>{savedDirectory=e.exportDirectory;return e.name==='AbortError';});
  const files=await readdir(savedDirectory);assert.equal(files.length,1);assert.ok(files[0].endsWith('.zip'));
});


test('多章导出按作品顺序合并、仅检查所选章节并使用显示名称',async t=>{
  const f=await fixture(t),outlineFile=path.join(f.directory,'story/outline.json');
  const outline=JSON.parse(await readFile(outlineFile,'utf8'));
  outline.chapters.push({id:'second',title:'第二章',summary:'测试',sequences:[{id:'seq-two',title:'第二段',summary:'测试'}]},{id:'third',title:'第三章',summary:'测试',sequences:[{id:'seq-three',title:'第三段',summary:'测试'}]});
  await json(outlineFile,outline);
  const second=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'seq-two'},{pageKind:'text'});
  await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'seq-three'},{pageKind:'text'});
  await make(f,key);await make(f,second.page_key);
  const send=await exporter(t,f),selection={modes:['standard','preview'],editions:['zh'],chapter_ids:['second','chapter'],prepare:true};
  const response=await send(selection);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.artifacts.length,2);
  for(const artifact of result.artifacts){
    assert.match(artifact.filename,/成品测试-第一章_第二章-中文-/);
    const downloaded=await fetch(new URL(artifact.download_url,response.url)),bytes=Buffer.from(await downloaded.arrayBuffer());
    if(artifact.filename.endsWith('.zip'))assert.deepEqual(zipNames(bytes),['001.png','002.png']);
    else assert.deepEqual([...bytes.toString().matchAll(/data-page="(\d+)"/g)].map(m=>m[1]),['1','2']);
  }
  const full=await send({variant:'lettered'});assert.equal(full.status,409);await full.text();
  for(const chapter_ids of [[],['unknown'],['chapter','unknown'],['chapter','chapter'],null]){
    const invalid=await send({...selection,chapter_ids});assert.equal(invalid.status,400);await invalid.text();
  }
  const local=await exportFinishedLocal({projectRoot:f.root,projectId:'demo',value:{...selection,editions:['clean']},readFacts:f.operations.readFacts,signal:new AbortController().signal,progress:()=>{}});
  assert.match(path.basename(local.directory),/^第一章_第二章-无字-高清_网页-/);
  assert.deepEqual(zipNames(await readFile(local.artifacts[0].file)),['001.png'],'选择中的纯文字章可被无字版省略');
  for(const operation of ['finished.export','finished.export.local']){
    const help=await executeWorkbench({operation:'help',target:operation});assert.equal(help.parameters.properties.chapter_ids.type,'array');assert.equal(help.parameters.properties.chapter_id,undefined);
  }
});

test('导出目录使用本地分钟时间，并发重名追加序号，不覆盖旧目录',async t=>{
  const f=await fixture(t),selections=[{scopeName:'第一章_第二章',edition:'en',mode:'preview'},{scopeName:'第一章_第二章',edition:'zh',mode:'standard'}],date=new Date(2026,9,23,14,13,58);
  const directories=await Promise.all([1,2,3].map(()=>createExportDirectory(f.directory,selections,date)));
  const name='第一章_第二章-中文_英文-高清_网页-2026-10-23-1413';
  assert.deepEqual(directories.map(d=>path.basename(d)).sort(),[name,name+'-2',name+'-3']);
});
