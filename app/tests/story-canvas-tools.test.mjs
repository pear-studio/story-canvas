import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t, responder = () => assert.fail('不应发送请求')) {
  const testsRoot = path.join(repositoryRoot, 'Saved', 'Tests');
  await mkdir(testsRoot, { recursive: true });
  const root = await mkdtemp(path.join(testsRoot, 'dsh-tools-'));
  assert.equal(path.dirname(root), path.resolve(testsRoot));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['.dsh/presets/story-canvas/story-canvas-tools.mjs', 'app/scripts/workbench-actions', 'app/scripts/workbench-client.mjs', 'app/scripts/story-canvas.mjs', 'app/server/page-key.mjs', 'app/server/file-replace.mjs', 'app/shared/prompt-weight-presets.mjs']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(repositoryRoot, file), path.join(root, file), { recursive: true });
  }
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const raw = Buffer.concat(chunks);
    const captured = { method: request.method, url: request.url, headers: request.headers, body: raw.length && request.headers['content-type']?.includes('application/json') ? JSON.parse(raw.toString()) : undefined, rawBody: raw };
    requests.push(captured);
    response.setHeader('content-type', 'application/json');
    try { await responder(captured, response); } catch (error) {
      response.statusCode = error.status ?? 500;
      response.end(JSON.stringify({ error: error.code, message: error.message, details: error.details }));
    }
  });
  // 避开 Fetch 禁止端口，并有界重选 Windows 已占用或保留（EACCES）的端口。
  for (let attempt=0; ; attempt++) {
    try { await new Promise((resolve,reject) => { server.once('error',reject); server.listen(randomInt(20000,40000),'127.0.0.1',()=>{server.off('error',reject);resolve();}); }); break; }
    catch(error) { if(!['EADDRINUSE','EACCES'].includes(error.code)||attempt>=9) throw error; }
  }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await mkdir(path.join(root, 'Config'));
  await writeFile(path.join(root, 'Config/local.json'), JSON.stringify({ port: server.address().port }));
  const { apply } = await import(pathToFileURL(path.join(root, '.dsh/presets/story-canvas/story-canvas-tools.mjs')));
  const tools = new Map(); apply({ tools: { register: definition => tools.set(definition.name, definition) } });
  assert.deepEqual([...tools.keys()], ['story_canvas']);
  return { root, tool: tools.get('story_canvas'), requests };
}
async function failure(tool, input) {
  try { await tool.execute(input); } catch (error) { return JSON.parse(error.message); }
  assert.fail('必须保持工具失败状态');
}

test('常见参数错误直接给出字段路径与最小例子，不发送请求',async t=>{
 const f=await fixture(t);
 const owner={owner_kind:'story',sequence_id:'unit-1',after_page_key:{page_id:'page-001'}};
 const move=await failure(f.tool,{operation:'page.move',args:{project_id:'demo',page_key:{page_id:'page-002'},owner}});
 assert.match(move.message,/owner.after_page_key/);assert.ok(move.example.after_page_key);assert.equal(move.example.owner.after_page_key,undefined);
 const sources=await failure(f.tool,{operation:'prompt.sources',args:{project_id:'demo',source:'scene:room:default'}});
 assert.equal(sources.example.target.kind,'page');
 const deletion=await failure(f.tool,{operation:'candidate.delete',args:{project_id:'demo',page_key:{page_id:'page-001'},candidate_id:'x'}});
 assert.ok(Array.isArray(deletion.example.candidate_ids));
 const both=await failure(f.tool,{operation:'page.move',args:{...move.example,before_page_key:{page_id:'page-003'}}});
 assert.match(both.message,/只能提供一个/);assert.equal(f.requests.length,0);
});

test('Prompt 来源冲突给出准确读取入口，同模型相同来源批量合并，范围冲突仍重读页面',async t=>{
 const f=await fixture(t,({body},response)=>{
   response.statusCode=409;response.end(JSON.stringify(body.target.id==='page-scope'
     ?{error:'prompt_scope_conflict',details:[]}
     :{error:'prompt_source_conflict',details:['scene:room:default']}));
 });
 const item=id=>({target:{kind:'page',id,model_id:'anima'},expected_sha256:'old',changes:{}});
 const single=await failure(f.tool,{operation:'prompt.save',args:{project_id:'demo',...item('page-a')}});
 assert.equal(single.recovery.next.operation,'prompt.sources');assert.equal(single.recovery.next.args.source,'scene:room:default');
 const result=await f.tool.execute({operation:'prompt.batch.save',args:{project_id:'demo',items:['page-a','page-b','page-scope'].map(item)}});
 assert.equal(result.counts.failed,3);assert.equal(result.recoveries.length,1);assert.equal(result.recoveries[0].affected_targets.length,2);
 assert.deepEqual(result.results[0].recovery_ids,result.results[1].recovery_ids);assert.equal(result.results[2].next.operation,'prompt.read');
});

test('字段帮助按需展开，分类与默认操作帮助不注入完整细则',async t=>{
  const f=await fixture(t);
  assert.ok((await f.tool.execute({operation:'help',args:{}})).groups);
  assert.equal((await failure(f.tool,{operation:'help',args:{wrong:true}})).error,'invalid_arguments');
  const overview=await f.tool.execute({operation:'help',target:'page'});
  assert.equal(JSON.stringify(overview).includes('negative:'),false);
  const help=await f.tool.execute({operation:'help',target:'page.editor.save'});
  assert.ok(help.topics.dialogue);assert.equal(help.helpTopics,undefined);
  const topic=await f.tool.execute({operation:'help',target:'page.editor.save',topic:'dialogue'});
  assert.match(topic.details,/不按数组索引/);
  const batch=await f.tool.execute({operation:'help',target:'prompt.batch.save',topic:'inheritance'});
  assert.equal(batch.example.changes.inheritance['scene:study:default']['identity:token-012345abcdef'].enabled,false);
  assert.equal((await failure(f.tool,{operation:'help',target:'page',topic:'dialogue'})).error,'invalid_arguments');
  assert.equal((await failure(f.tool,{operation:'page.editor.save',topic:'dialogue'})).error,'invalid_arguments');
  assert.equal(f.requests.length,0);
});

test('语义 CLI 共用操作与字段帮助，失败覆盖旧回执、部分失败非零且保护输入',async t=>{
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const f=await fixture(t,(request,response)=>{
    if(request.url==='/api/agent/page-editor/save'){
      if(request.body.page_key.page_id==='page-002'){response.statusCode=409;return response.end(JSON.stringify({error:'page_edit_conflict'}));}
      return response.end(JSON.stringify({saved:true,save:{operation:'page.editor.save',args:request.body}}));
    }
    response.end(JSON.stringify({total:1,offset:0,items:[{page_id:'page-001'}],next_offset:null}));
  });
  const input=path.join(f.root,'args.json'),output=path.join(f.root,'receipt.json'),cli=path.join(f.root,'app/scripts/story-canvas.mjs');
  const run=async args=>{try{return {code:0,...await promisify(execFile)(process.execPath,[cli,...args])};}catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}};
  const native=await f.tool.execute({operation:'help',target:'page.editor.save',topic:'dialogue'});
  const help=await run(['help','page.editor.save','dialogue']);assert.equal(help.code,0);assert.deepEqual(JSON.parse(help.stdout),native);
  await writeFile(input,JSON.stringify({project_id:'demo'}));
  assert.equal((await run(['page.list','--args',input,'--out',output])).code,0);
  assert.equal(JSON.parse(await readFile(output,'utf8')).items[0].page_id,'page-001');
  assert.equal((await run(['not.an.operation','--out',output])).code,1);
  assert.equal(JSON.parse(await readFile(output,'utf8')).error,'unknown_operation');
  const before=await readFile(input,'utf8');
  assert.equal((await run(['page.list','--args',input,'--out',input])).code,1);assert.equal(await readFile(input,'utf8'),before);
  const blocked=await run(['generation.run','--lite','--out',output]);assert.equal(blocked.code,1);
  assert.equal(JSON.parse(await readFile(output,'utf8')).error,'capability_disabled');
  await writeFile(input,JSON.stringify({project_id:'demo',section:'content',items:['page-001','page-002'].map(page_id=>({page_key:{page_id},expected_sha256:'a'.repeat(64),changes:{title:'更新'}}))}));
  assert.equal((await run(['page.editor.batch.save','--args',input,'--out',output])).code,1);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')).counts,{saved:1,failed:1});
});

test('批量页面编辑预检重复目标，遇到未知保存结果停止，不重放已保存页',async t=>{
  const f=await fixture(t,(request,response)=>{
    if(request.body.page_key.page_id==='page-002') {response.statusCode=503;return response.end(JSON.stringify({error:'unavailable'}));}
    response.end(JSON.stringify({saved:true,save:{operation:'page.editor.save',args:request.body}}));
  });
  const items=['page-001','page-002','page-003'].map(page_id=>({page_key:{page_id},expected_sha256:'a'.repeat(64),changes:{title:'修改'}}));
  const args={project_id:'demo',section:'content',items};
  const duplicate=await failure(f.tool,{operation:'page.editor.batch.save',args:{...args,items:[items[0],items[0]]}});
  assert.equal(duplicate.error,'invalid_arguments');assert.equal(f.requests.length,0);
  const bad=await failure(f.tool,{operation:'page.editor.batch.save',args:{...args,items:[items[0],{...items[1],changes:'错误'}]}});
  assert.equal(bad.error,'invalid_arguments');assert.equal(f.requests.length,0);
  const saved=await f.tool.execute({operation:'page.editor.batch.save',args});
  assert.deepEqual(saved.results.map(r=>r.status),['saved','unknown','not_executed']);
  assert.deepEqual(f.requests.map(r=>r.body.page_key.page_id),['page-001','page-002']);
  assert.equal(saved.results[1].next.args.page_key.page_id,'page-002');
});

test('词库默认输出有界，分页可继续，完整解释由详情文件保留',async t=>{
  const entry={prompt_text:'quiet',display_text:'安静',matched:true,allowed:true,description:'解释'.repeat(20000),original_description:'完整原文',aliases:['alias'],other_names:['name'],post_count:10};
  const f=await fixture(t,(request,response)=>response.end(JSON.stringify({available:true,tags_file:'large-source',
    ...(request.method==='GET'?{suggestions:[entry],has_more:true}:{matches:request.body.prompts.map(prompt_text=>({...entry,prompt_text}))})})));
  const run=(operation,args)=>f.tool.execute({operation,args});
  const search=await run('dictionary.search',{scope:'page',q:'quiet',offset:12});
  assert.equal(search.next_offset,13);assert.equal(search.items[0].description.length,80);assert.equal(search.items[0].description_truncated,true);
  assert.equal(search.tags_file,undefined);assert.equal(search.items[0].aliases,undefined);
  assert.ok(f.requests[0].url.includes('limit=12'));
  const matches=await run('dictionary.matches',{scope:'page',prompts:Array(50).fill('quiet')});
  assert.equal(matches.items.length,50);assert.ok(JSON.stringify(matches).length<16000);
  const full=await run('dictionary.inspect',{scope:'page',prompt:'quiet'});
  const stored=JSON.parse(await readFile(full.file,'utf8'));
  assert.equal(stored.matches[0].description,entry.description);assert.deepEqual(stored.matches[0].aliases,entry.aliases);
  const tooMany=await failure(f.tool,{operation:'dictionary.matches',args:{scope:'page',prompts:Array(51).fill('quiet')}});
  assert.equal(tooMany.error,'invalid_arguments');
});

test('结构变更回执不返回整份故事骨架，保留目标身份和下游诊断',async t=>{
  const diagnostics=[{code:'downstream_problem',page_id:'page-001'}];
  const f=await fixture(t,(request,response)=>response.end(JSON.stringify(request.url.endsWith('/revision')?{revision:'r'}:
    {value:{synopsis:'长正文'.repeat(10000),chapters:[]},target_file:'outline.json',sequence_id:'unit-1',downstream_diagnostics:diagnostics})));
  const result=await f.tool.execute({operation:'sequence.move',args:{project_id:'demo',chapter_id:'chapter-1',sequence_id:'unit-1',before_sequence_id:'unit-2'}});
  assert.equal(result.value,undefined);assert.equal(result.sequence_id,'unit-1');assert.equal(result.chapter_id,'chapter-1');
  assert.equal(result.before_sequence_id,'unit-2');assert.deepEqual(result.downstream_diagnostics,diagnostics);
  assert.ok(JSON.stringify(result).length<500);
});
test('分类帮助给出必填参数签名，不展开完整参数表',async t=>{
  const f=await fixture(t,(_req,res)=>res.end('{}'));
  const help=await f.tool.execute({operation:'help',target:'structure'});
  const item=help.operations.find(item=>item.operation==='sequence.read');
  assert.equal(item.signature,'sequence.read(project_id, sequence_id)');
  assert.equal(item.parameters,undefined);
});
test('等待终态直接带本任务图片路径，结果入口支持分页',async t=>{
  const images=Array.from({length:15},(_,i)=>({candidate_id:`c${i}`,absolute_file:`C:/images/${i}.png`}));
  const f=await fixture(t,(req,res)=>res.end(JSON.stringify(req.url.includes('/results')?{images}:{task:{id:'t1',status:'completed',purpose:'candidate',item_counts:{total:15,available:15}}})));
  const done=await f.tool.execute({operation:'task.wait',args:{targets:[{project_id:'p',task_id:'t1'}]}});
  assert.equal(done.images.length,12);assert.equal(done.images[0].absolute_file,'C:/images/0.png');
  const next=await f.tool.execute(done.more_images[0]);
  assert.equal(next.items.length,3);assert.equal(next.items[0].candidate_id,'c12');assert.equal(next.next_offset,null);
});
test('task.wait 的工具契约限制数量与期限，传递取消信号且只发GET',async t=>{
  const f=await fixture(t,(_request,response)=>response.end(JSON.stringify({task:{id:'t1',status:'completed',purpose:'candidate',items:[]}})));
  const help=await f.tool.execute({operation:'help',target:'task.wait'});
  assert.match(help.details,/停止等待不取消任务/);
  for(const args of [{targets:[]},{targets:[{task_id:'t1'}]},{targets:[{project_id:'p',task_id:'t1'}],wait_ms:1800001}]){
    assert.equal((await failure(f.tool,{operation:'task.wait',args})).error,'invalid_arguments');
  }
  assert.equal(f.requests.length,0);
  const result=await f.tool.execute({operation:'task.wait',args:{targets:[{project_id:'p',task_id:'t1'}]}});
  assert.equal(result.reason,'terminal');assert.equal(f.requests[0].method,'GET');
  assert.ok(f.requests.some(r=>r.url==='/api/tasks/p/t1?purpose=candidate&view=summary'));
  assert.ok(f.requests.some(r=>r.url==='/api/tasks'));
  const blocked=await fixture(t,()=>{}),controller=new AbortController();
  const pending=blocked.tool.execute({operation:'task.wait',args:{targets:[{project_id:'p',task_id:'t1'}]}},{signal:controller.signal});
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(pending,error=>JSON.parse(error.message).error==='wait_cancelled');
  assert.ok(blocked.requests.every(request=>request.method==='GET'));
});
test('统一目录逐项可发现，help 不执行请求，未知入口返回合法目录', async t => {
  const { tool, requests } = await fixture(t);
  const catalog = await tool.execute({ operation: 'help' });
  assert.ok(catalog.groups.every(group => group.operations === undefined));
  assert.ok(JSON.stringify(catalog).length < 2600);
  const branches = await Promise.all(catalog.groups.map(group => tool.execute({ operation: 'help', target: group.id })));
  const operations = branches.flatMap(group => group.operations);
  assert.equal(new Set(operations.map(item => item.operation)).size, operations.length);
  assert.equal(catalog.groups.length, 17);
  assert.ok(operations.some(item => item.operation === 'character.variant.rename'));
  // 按工作台用户功能验收覆盖；不能只循环已有实现，让遗漏永远通过。
  for (const operation of ['project.settings.read', 'project.settings.save', 'generation.profiles', 'generation.inspect', 'generation.select', 'generation.override.read', 'generation.override.save', 'generation.lora.set', 'generation.lora.remove', 'resource.lora.list', 'resource.lora.inspect', 'material.list', 'material.read', 'material.save', 'material.delete', 'agreement.read', 'agreement.save', 'task.list', 'task.history', 'task.inspect', 'runtime.health']) {
    assert.ok(operations.some(item => item.operation === operation), `工作台功能缺少入口 ${operation}`);
  }
  for (const operation of ['generation.run','reference.save','lettering.page.save','finished.export','comparison.create','training.dataset.create','training.run.start','runtime.install','project.migration.apply','resource.inspect']) {
    assert.equal((await tool.execute({operation:'help',target:operation})).availability, 'enabled');
  }
  for (const { operation } of operations) {
    const help = await tool.execute({ operation: 'help', target: operation });
    assert.equal(help.operation, operation);
    assert.ok(help.parameters.required);
    assert.ok(help.details);
    assert.equal(help.execute, undefined);
  }
  const error = await failure(tool, { operation: 'project.clone' });
  assert.equal(error.error, 'unknown_operation');
  assert.equal(error.available_operations, undefined);
  assert.deepEqual(error.help, { operation: 'help' });
  for (const input of [
    { operation: 'help', args: { project_id: 'demo' } },
    { operation: 'project.copy', args: {} },
    { operation: 'project.copy', args: { project_id: 'demo', path: 'unexpected' } },
    { operation: 'page.list', args: { project_id: 'demo', limit: 100 } },
    { operation: 'facts.save', args: { domain: 'page', kind: 'prompt' } },
  ]) assert.equal((await failure(tool, input)).error, 'invalid_arguments');
  assert.equal(requests.length, 0);
});
test('复制项目发送正确生命周期接口、空 body 和编码 ID，不额外获取版本', async t => {
  const { tool, requests } = await fixture(t, (_request, response) => response.end(JSON.stringify({ id: 'copy-1', temporary: true })));
  const value = await tool.execute({ operation: 'project.copy', args: { project_id: '项目 一' } });
  assert.equal(value.id, 'copy-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/project-library/' + encodeURIComponent('项目 一') + '/copy');
  assert.deepEqual(requests[0].body, {});
  assert.equal(requests[0].headers['x-story-canvas-expected-revision'], undefined);
  assert.deepEqual(JSON.parse(tool.output.render({}, value)[0].text), value);
});

test('批量生成实际走单页接口，返回可执行整批核验入口；文字页拒绝给出编辑入口',async t=>{
  const f=await fixture(t,(req,res)=>{
    if(req.method==='GET')return res.end(JSON.stringify({task:{id:'task-'+req.url,status:'completed',purpose:'candidate',item_counts:{total:3,available:3},items:[]}}));
    if(req.body.page_key.page_id==='page-002') {
      res.statusCode=422;return res.end(JSON.stringify({error:'text_page_not_renderable'}));
    }
    res.end(JSON.stringify({task:{task_id:`render-${req.body.page_key.page_id}`,status:'queued'}}));
  });
  const result=await f.tool.execute({operation:'generation.batch',args:{project_id:'demo',page_keys:[{page_id:'page-001'},{page_id:'page-002'},{page_id:'page-003'}]}});
  assert.equal(result.counts.submitted,2);assert.equal(result.counts.rejected,1);
  assert.equal(result.issues[0].recovery.next.operation,'page.editor.read');
  assert.ok(f.requests.every(r=>r.url==='/api/projects/demo/workbench/render' && r.body.count===3));
  const done=await f.tool.execute(result.wait);assert.equal(done.all_succeeded,false);assert.equal(done.summary.total,2);
  assert.equal(done.submission.rejected,1);assert.equal(done.tasks,undefined);
  const detail=await f.tool.execute(result.inspect);assert.equal(detail.items.length,3);assert.equal(detail.items[1].status,'rejected');
  const failureResult=await failure(f.tool,{operation:'generation.run',args:{project_id:'demo',page_key:{page_id:'page-002'}}});
  assert.equal(failureResult.recovery.next.operation,'page.editor.read');
  assert.match(failureResult.recovery.message,/finished.output/);
  const bad=await failure(f.tool,{operation:'page.delete',args:{project_id:'demo',page_key:{page_id:'page-001'},owner:{}}});
  assert.equal(bad.error,'invalid_arguments');assert.match(bad.recovery,/本次未执行/);
});
test('页面语义操作取得版本后提交，409 保留诊断且不重试', async t => {
  const { tool, requests } = await fixture(t, (request, response) => {
    if (request.url.endsWith('/revision')) return response.end(JSON.stringify({ revision: 'r1' }));
    response.statusCode = 409;
    response.end(JSON.stringify({ error: 'revision_conflict', message: '项目已变化', details: { changed: ['page-001'] } }));
  });
  const result = await failure(tool, { operation: 'page.copy', args: { project_id: 'demo', page_key: {page_id: 'page-001'} } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/projects/demo/workbench/navigation/duplicate-page');
  assert.equal(requests[1].headers['x-story-canvas-expected-revision'], 'r1');
  assert.deepEqual(requests[1].body, { page_id: 'page-001' });
  assert.equal(result.status, 409);
  assert.equal(result.error, 'revision_conflict');
  assert.deepEqual(result.details, { changed: ['page-001'] });
  assert.deepEqual(result.help, { operation: 'help', target: 'page.copy' });
});
test('列表分页不带正文和草稿，完整事实读取不截断', async t => {
  const text = '完整内容'.repeat(10000);
  const draft = { project_id: 'demo', document: { by_sequence: { a: ['page-001', 'page-002'], b: ['page-003'] }, text }, expected_sha256: 'a'.repeat(64), expected_context_sha256: 'b'.repeat(64) };
  const { tool } = await fixture(t, (request, response) => response.end(JSON.stringify(request.url === '/api/project-library' ? { projects: [{ id: 'demo', title: '测试', path: '省略路径', extra: text }, { id: 'other' }] }
    : request.url === '/api/agent/directory' ? { total: 2, offset: 1, items: [{ page_id: 'page-002', sequence_id: 'a' }], next_offset: null } : draft)));
  const list = await tool.execute({ operation: 'project.list', args: { limit: 1 } });
  assert.equal(list.next_offset, 1);
  assert.equal(list.items[0].path, undefined);
  assert.equal(list.items[0].extra, undefined);
  const pages = await tool.execute({ operation: 'page.list', args: { project_id: 'demo', sequence_id: 'a', offset: 1, limit: 1 } });
  assert.equal(pages.total, 2);
  assert.deepEqual(pages.items, [{ page_id: 'page-002', sequence_id: 'a' }]);
  assert.equal(pages.next_offset, null);
  assert.equal(pages.document, undefined);
  const pack=await tool.execute({ operation: 'facts.read', args: { project_id: 'demo', domain: 'story', kind: 'outline' } });
  assert.deepEqual(pack.draft,draft);assert.deepEqual(pack.save,{operation:'facts.save',args:{domain:'story',kind:'outline'},draft_parameter:'draft'});
});

test('大项目默认列表有界，完整 Git/成品信息仍可逐页查询',async t=>{
  const huge='metadata'.repeat(10000);
  const pages=Array.from({length:150},(_,i)=>({page_id:`page-${i}`,title:'测试',status:'missing',candidate_count:3,batch_skip_reason:'有3张候选',record:{sha256:'hash',extra:huge}}));
  const f=await fixture(t,(req,res)=>{
    if(req.url==='/api/project-library')return res.end(JSON.stringify({projects:[{id:'demo',title:'测试',available:true}]}));
    if(req.url.endsWith('/git'))return res.end(JSON.stringify({branch:'main',dirty:true,changes:Array.from({length:150},(_,i)=>({path:`pages/${i}.json`,status:'M'})),remotes:[],status:'ready'}));
    if(req.url.startsWith('/api/tasks'))return res.end(JSON.stringify({tasks:pages.map(p=>({id:p.page_id,status:'queued',snapshot:huge})),history:pages,queue_revision:5}));
    const id=new URL(req.url,'http://test').searchParams.get('page_id');
    res.end(JSON.stringify({pages:id?pages.filter(p=>p.page_id===id):pages}));
  });
  const info=await f.tool.execute({operation:'project.info',args:{project_id:'demo'}});
  assert.equal(info.changed_files,150);assert.equal(info.git.changes,undefined);assert.ok(JSON.stringify(info).length<500);
  const changes=await f.tool.execute({operation:'project.git.changes',args:{project_id:'demo',offset:20,limit:5}});
  assert.equal(changes.items.length,5);assert.equal(changes.total,150);assert.equal(changes.next_offset,25);
  const finished=await f.tool.execute({operation:'finished.list',args:{project_id:'demo',limit:5}});
  assert.equal(finished.items.length,5);assert.equal(finished.summary.missing,150);assert.ok(JSON.stringify(finished).length<1500);
  const detail=await f.tool.execute({operation:'finished.inspect',args:{project_id:'demo',page_key:{page_id:'page-1'}}});
  assert.equal(detail.pages[0].record.extra,huge);
  const tasks=await f.tool.execute({operation:'task.list',args:{project_id:'demo',limit:5}});
  assert.equal(tasks.items.length,5);assert.equal(tasks.total,150);assert.equal(tasks.history,undefined);assert.ok(JSON.stringify(tasks).length<1000);
});
test('Prompt 上下文只读且默认窄视图，编辑入口指向独立范围读取', async t => {
  const draft = { project_id: 'demo', target_id: 'page-001', document: { text: '内容' }, expected_sha256: 'a'.repeat(64), expected_context_sha256: 'b'.repeat(64) };
  const pack = { draft, save: { domain: 'page', kind: 'prompt' }, context: {status:'complete',model_id:'qwen',references:[{source:'character:alice:default',current_text:'只读'.repeat(10000)}],final:{positive:'完整正向',negative:'',parts:{trace:'详细追踪'}}} };
  const { tool, requests } = await fixture(t, (_request, response) => response.end(JSON.stringify(pack)));
  const result=await tool.execute({ operation: 'prompt.context', args: { project_id: 'demo', page_key: {page_id:'page-001'} } });
  assert.equal(result.final.positive,'完整正向');assert.equal(result.final.parts,undefined);assert.equal(result.draft,undefined);assert.equal(result.save,undefined);assert.equal(result.references,undefined);
  assert.deepEqual(requests[0].body.page_key, { page_id: 'page-001' });
  const edit=await tool.execute({operation:'prompt.context',args:{project_id:'demo',page_key:{page_id:'page-001'},view:'edit'}});
  assert.equal(edit.context.references['character:alice:default'].text,'只读'.repeat(10000));
  assert.equal(edit.draft,undefined);assert.equal(edit.save,undefined);
  assert.equal(edit.edit.operation,'prompt.read');
  assert.deepEqual(edit.edit.args,{project_id:'demo',target:{kind:'page',id:'page-001'}});
  const details=await tool.execute({operation:'prompt.context',args:{project_id:'demo',page_key:{page_id:'page-001'},view:'details'}});
  const complete=JSON.parse(await readFile(details.file,'utf8'));
  assert.equal(complete.draft,undefined);assert.equal(complete.save,undefined);assert.deepEqual(complete.context,pack.context);
  const narrow=await tool.execute({operation:'prompt.context',args:{project_id:'demo',page_key:{page_id:'page-001'},view:'final'}});
  assert.equal(narrow.final.positive,'完整正向');assert.equal(narrow.draft,undefined);assert.equal(narrow.references,undefined);
  const sources=await tool.execute({operation:'prompt.context',args:{project_id:'demo',page_key:{page_id:'page-001'},view:'sources',source:'character:alice:default'}});
  assert.equal(sources.references.length,1);assert.equal(sources.draft,undefined);
  assert.equal((await failure(tool,{operation:'prompt.context',args:{project_id:'demo',page_key:{page_id:'page-001'},view:'sources',source:'invalid'}})).error,'invalid_arguments');
  assert.equal(tool.output.render({},result)[0].text,JSON.stringify(result));
});
test('版本报告反映已加载代码与磁盘差异，help 不把新文件冒充已加载版本', async t => {
  const { tool, root } = await fixture(t);
  const before = await tool.execute({ operation: 'status' });
  assert.equal(before.reload_required, false);
  assert.ok(tool.description.includes(before.loaded_revision));
  await appendFile(path.join(root, 'app/scripts/workbench-actions/projects.mjs'), '\n// 磁盘新版本\n');
  const after = await tool.execute({ operation: 'status' });
  assert.equal(after.loaded_revision, before.loaded_revision);
  assert.notEqual(after.disk_revision, before.disk_revision);
  assert.equal(after.reload_required, true);
});

test('统一工具经真实 HTTP Adapter 完成结构、设定及三类页面生命周期，目录不读取 Prompt', async t => {
  const { Readable } = await import('node:stream');
  const { handleAgentRequest } = await import('../server/agent-http.mjs');
  const { handleWorkbenchRequest } = await import('../server/workbench-http.mjs');
  const { readProjectCreationTemplate } = await import('../server/project-creation.mjs');
  const { createQwenFixtureProject } = await import('./model-fixture.mjs');
  const {readPageMedia}=await import('../server/page-media.mjs');
  const { readFile } = await import('node:fs/promises');
  let root;
  const f = await fixture(t, async (captured, response) => {
    if (captured.url.endsWith('/revision')) return response.end(JSON.stringify({ revision: 'r-test' }));
    const request = Readable.from([captured.rawBody]); request.method = captured.method; request.headers=captured.headers; request.url=captured.url;
    const context = {
      request, response, requestUrl:new URL(captured.url, "http://test"), decodedPath: decodeURIComponent(new URL(captured.url, "http://test").pathname), projectRoot: root, config: {},
      pageMediaReader:{read:async(projectId,value)=>({...await readPageMedia(root,projectId,value),revision:'media-test'})},
      readFacts: async (projectId, fn) => ({ value: await fn({ projectId, projectDirectory: path.join(root, 'workspace', projectId) }) }),
      mutateFacts: async (projectId, fn) => {
        assert.equal(captured.headers['x-story-canvas-expected-revision'], 'r-test');
        return { value: await fn({ projectId, projectDirectory: path.join(root, 'workspace', projectId) }) };
      },
      sendOperation: (status, result) => { response.statusCode = status; response.end(JSON.stringify(result.value)); },
    };
    context.mutateTargetFacts = async (projectId, fn) => ({ value: await fn({ projectId, projectDirectory: path.join(root, 'workspace', projectId) }) });
    context.mutateDerived=context.mutateTargetFacts;
    if (await handleAgentRequest(context)) return;
    assert.equal(await handleWorkbenchRequest(context), true);
  });
  root = f.root;
  await createQwenFixtureProject(root, await readProjectCreationTemplate(root, 'demo'));
  const run = (operation, args = {}) => f.tool.execute({ operation, args: { project_id: 'demo', ...args } });
  const chapter = await run('chapter.create', { title: '测试章' });
  const unit = await run('sequence.create', { chapter_id: chapter.chapter_id, title: '测试单元' });
  assert.equal(unit.saved,true);assert.equal(unit.value,undefined);assert.equal(unit.target_file,undefined);
  for (const [prefix, identity, document] of [
    ['story.synopsis', {}, {synopsis:'已确认的故事梗概'}],
    ['chapter', {chapter_id:chapter.chapter_id}, {title:'测试章',summary:'章节梗概'}],
    ['sequence', {sequence_id:unit.sequence_id}, {title:'测试单元',summary:'单元梗概'}],
  ]) {
    const pack=await run(`${prefix}.read`,identity);
    await run(pack.save.operation,{...pack.save.args,document});
    assert.deepEqual((await run(`${prefix}.read`,identity)).document,document);
    const conflict=await failure(f.tool,{operation:pack.save.operation,args:{...pack.save.args,document:pack.document}});
    assert.equal(conflict.status,409);
  }
  await run('chapter.rename', { chapter_id: chapter.chapter_id, title: '新标题' });
  await run('chapter.move', { chapter_id: chapter.chapter_id, before_chapter_id: 'main' });
  assert.equal((await run('chapter.list')).items[0].title, '新标题');
  await run('sequence.rename', { sequence_id: unit.sequence_id, title: '新单元' });
  assert.equal((await run('sequence.list', { chapter_id: chapter.chapter_id })).items[0].title, '新单元');
  await run('sequence.move', { sequence_id: unit.sequence_id, chapter_id: 'main' });
  await run('character.create', { id: 'alice', name: '甲' });
  await run('character.create', { id: 'bob', name: '乙' });
  await run('character.move', { character_id: 'bob', before_character_id: 'alice' });
  const characters = await run('character.list', { limit: 1 });
  assert.equal(characters.items[0].id, 'bob'); assert.equal(characters.next_offset, 1);
  await run('character.variant.create', { character_id: 'alice', id: 'night', name: '夜间' });
  await run('character.variant.rename', { character_id: 'alice', old_id: 'night', new_id: 'evening' });
  await run('character.variant.move', { character_id: 'alice', variant_id: 'evening' });
  assert.ok((await run('character.variant.list', { character_id: 'alice' })).items.some(v => v.id === 'evening'));
  await run('scene.create', { id: 'station', name: '车站' });
  await run('scene.create', { id: 'park', name: '公园' });
  await run('scene.move', { scene_id: 'station' });
  assert.equal((await run('scene.list')).items.at(-1).id, 'station');
  await run('scene.variant.create', { scene_id: 'station', id: 'rainy', name: '雨天' });
  await run('scene.variant.rename', { scene_id: 'station', old_id: 'rainy', new_id: 'wet' });
  await run('scene.variant.move', { scene_id: 'station', variant_id: 'wet' });
  const owners = [
    { owner_kind: 'story', sequence_id: unit.sequence_id },
    { owner_kind: 'character', character_id: 'alice', variant_id: 'evening' },
    { owner_kind: 'scene', scene_id: 'station', variant_id: 'wet' },
  ];
  const factPack=await run('facts.read',{domain:'story',kind:'sequence',target_id:unit.sequence_id});
  for(const [field,value] of [['expected_sha256','PLACEHOLDER'],['expected_sha256','a'.repeat(65)],['expected_context_sha256','bad'],['document',null]]) {
    const rejected=await failure(f.tool,{operation:'facts.save',args:{domain:'story',kind:'sequence',draft:{...factPack.draft,[field]:value}}});
    assert.equal(rejected.status,400);assert.equal(rejected.details[0].field,field);
    assert.equal(rejected.recovery.next.operation,'facts.read');
    assert.equal(rejected.recovery.next.args.target_id,unit.sequence_id);
  }
  assert.deepEqual((await run('sequence.read',{sequence_id:unit.sequence_id})).document,factPack.draft.document);
  const pages = [];
  for (const owner of owners) {
    const page = await run('page.create', { owner }); pages.push(page);
    const list = await run('page.list', owner);
    assert.equal(list.items[0].page_id, page.page_id);
    assert.equal(list.items[0].prompt, undefined);
  }
  const lettering=await run('lettering.settings.read');
  assert.ok(lettering.expected_sha256);
  await run('lettering.settings.save',{...lettering,settings:{...lettering.settings,font_size:30}});
  assert.equal((await run('lettering.settings.read')).settings.font_size,30);
  const page_key={page_id:pages[0].page_id};
  const editor=await run('page.editor.read',{page_key,section:'content'});
  assert.equal(editor.context,undefined);assert.equal(editor.save.operation,'page.editor.save');
  const updated=await run(editor.save.operation,{...editor.save.args,changes:{title:'局部修改标题'}});
  assert.equal(updated.saved,true);assert.equal(updated.document.title,'局部修改标题');
  assert.deepEqual(updated.document.characters,editor.document.characters);
  const stale=await failure(f.tool,{operation:editor.save.operation,args:{...editor.save.args,changes:{title:'陈旧修改'}}});assert.equal(stale.status,409);
  const promptTarget={kind:'page',id:page_key.page_id,model_id:'qwen'};
  const localPrompt=await run('prompt.read',{target:promptTarget});assert.equal(localPrompt.document.models,undefined);assert.equal(localPrompt.context,undefined);
  const promptFile=path.join(root,`workspace/demo/pages/${page_key.page_id}.prompt.json`);
  const otherPrompt=JSON.parse(await readFile(promptFile,'utf8')).models.anima;
  assert.equal((await failure(f.tool,{operation:'prompt.read',args:{project_id:'demo',target:{...promptTarget,model_id:'anima'}}})).error,'prompt_model_missing');
  const branch=localPrompt.document;
  const changedPrompt=await run(localPrompt.save.operation,{...localPrompt.save.args,changes:{text:'局部 Prompt'}});
  assert.equal(changedPrompt.document.text,'局部 Prompt');
  assert.deepEqual(JSON.parse(await readFile(promptFile,'utf8')).models.anima,otherPrompt);
  assert.deepEqual(changedPrompt.document.reference_images,branch.reference_images);
  const emptyChange=await failure(f.tool,{operation:changedPrompt.save.operation,args:{...changedPrompt.save.args,changes:{}}});assert.equal(emptyChange.status,400);
  await run(updated.save.operation,{...updated.save.args,changes:{title:'上游内容变化'}});
  const upstream=await failure(f.tool,{operation:changedPrompt.save.operation,args:{...changedPrompt.save.args,changes:{text:'陈旧依赖'}}});
  assert.equal(upstream.status,409);assert.equal(upstream.error,'prompt_scope_conflict');
  const checked=await run('prompt.read',{target:promptTarget});assert.equal(checked.document.text,'局部 Prompt');
  const promptCheck=await run('prompt.check',{limit:1});
  assert.equal(promptCheck.scanned,1);assert.equal(promptCheck.scope.model,'each_page_active');
  assert.ok(promptCheck.results.every(row=>row.document===undefined));
  const render=await run('page.editor.read',{page_key,section:'render'});assert.ok(render.document.model_id);
  const otherRender=await run('page.render.read',{page_key:{page_id:pages[1].page_id}});
  const projectBefore=await readFile(path.join(root,'workspace/demo/project.json'),'utf8');
  const renderRead=await run('page.render.read',{page_key});
  assert.equal(renderRead.save.operation,'page.render.set');assert.ok(renderRead.options.canvases.includes('1:1'));
  const canvas=await run('page.render.set',{...renderRead.save.args,canvas:'1:1'});
  assert.equal(canvas.document.canvas,'1:1');assert.equal(canvas.document.model_id,render.document.model_id);assert.equal(canvas.document.profile_id,render.document.profile_id);
  assert.equal((await failure(f.tool,{operation:'page.render.set',args:{...renderRead.save.args,canvas:'9:16'}})).status,409);
  const model=await run('page.render.set',{...canvas.save.args,model_id:'anima'});
  assert.equal(model.document.model_id,'anima');assert.equal(model.document.profile_id,'anima-base-v1');assert.equal(model.document.canvas,'1:1');
  const mismatch=await failure(f.tool,{operation:'page.render.set',args:{...model.save.args,profile_id:'qwen-image-2-1'}});
  assert.equal(mismatch.error,'page_profile_model_mismatch');assert.equal(mismatch.recovery.next.operation,'page.render.read');
  const emptyRender=await failure(f.tool,{operation:'page.render.set',args:model.save.args});assert.equal(emptyRender.error,'empty_render_changes');
  const restored=await run('page.render.set',{...model.save.args,model_id:'qwen'});assert.equal(restored.document.profile_id,'qwen-image-2-1');
  assert.equal((await run('prompt.read',{target:promptTarget})).document.text,'局部 Prompt');
  assert.deepEqual((await run('page.render.read',{page_key:{page_id:pages[1].page_id}})).document,otherRender.document);
  assert.equal(await readFile(path.join(root,'workspace/demo/project.json'),'utf8'),projectBefore);

  // 真正发布候选成果而不运行生成模型，验证按任务保留整批及预览过期保护。
  const {createRenderTask,updateRenderTask}=await import('../server/render-task-storage.mjs');
  const {createCandidateStorageIdentity,publishCandidateResult}=await import('../server/candidate-storage.mjs');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=','base64');
  async function publishBatch(n) {
    const directory=path.join(root,'workspace/demo');
    const task={version:2,id:`render-20260927T12000${n}Z-a1b2c3d4`,project:'demo',purpose:'candidate',render_profile:'qwen-image-2-1',status:'queued',created_at:`2026-09-27T12:00:0${n}.000Z`,snapshot:{},
      items:[0,1,2].map(i=>({id:`item-${i}`,page_key,...createCandidateStorageIdentity(page_key),status:'queued'}))};
    await createRenderTask(directory,task,{project_title:'测试',pages:[]});
    await updateRenderTask(directory,task.id,t=>{t.status='completed';t.completed_at=task.created_at;for(const i of t.items)i.status='available';});
    for(const item of task.items)await publishCandidateResult(directory,task,item,png,{warm:false});
    return task;
  }
  await publishBatch(1);const second=await publishBatch(2);
  const batches=await run('candidate.batches',{page_key});
  assert.equal(batches.total,2);assert.equal(batches.candidate_count,6);assert.equal(batches.items[0].available_count,3);assert.equal(batches.items[0].complete,true);
  const listed=await run('candidate.list',{page_key,task_id:second.id,limit:2});
  assert.equal(listed.total,3);assert.equal(listed.items.length,2);assert.ok(path.isAbsolute(listed.items[0].absolute_file));
  const preview=await run('candidate.cleanup.preview',{selections:[{page_key}]});
  assert.equal(preview.pages[0].kept,3);assert.equal(preview.pages[0].delete_count,3);
  await publishBatch(3);
  const staleCleanup=await f.tool.execute(preview.apply);
  assert.equal(staleCleanup.failed,1);assert.equal(staleCleanup.results[0].error.code,'candidate_cleanup_conflict');
  assert.equal((await run('candidate.batches',{page_key})).candidate_count,9);
  const currentPreview=await run('candidate.cleanup.preview',{selections:[{page_key}]});
  const cleaned=await f.tool.execute(currentPreview.apply);
  assert.equal(cleaned.deleted,6);assert.equal(cleaned.failed,0);assert.equal(cleaned.results[0].kept,3);
  assert.equal((await run('candidate.list',{page_key})).total,3);
  assert.equal((await f.tool.execute(currentPreview.apply)).failed,1);

  const layout=await run('lettering.page.read',{page_key});
  await run('lettering.page.save',{page_key,lettering:{items:layout.lettering.items},expected_sha256:layout.expected_sha256});
  const target={kind:'page',id:pages[0].page_id};
  const beforeRefs=await run('reference.list',{target});
  const imagePath=path.join(root,'reference.png');
  await (await import('sharp')).default({create:{width:16,height:16,channels:3,background:'green'}}).png().toFile(imagePath);
  const added=await run('reference.save',{target,expected_sha256:beforeRefs.value.sha256,file:imagePath,title:'中性参考'});
  assert.equal(added.value.entries.length,1);
  await assert.rejects(run('reference.delete',{target,expected_sha256:beforeRefs.value.sha256,id:added.value.entries[0].id}),e=>JSON.parse(e.message).status===409);
  await run('reference.delete',{target,expected_sha256:added.value.sha256,id:added.value.entries[0].id});
  assert.equal((await run('reference.list',{target})).value.entries.length,0);
  // 设定参考图显式选择 Qwen；页面则直接使用当前 render 的模型。
  for (const target of [
    {kind:'character',id:'alice',variant_id:'evening',model_id:'qwen'},
    {kind:'scene',id:'station',variant_id:'wet',model_id:'qwen'},
  ]) {
    const {model_id,...missingModel}=target;
    const rejected=await failure(f.tool,{operation:'reference.list',args:{project_id:'demo',target:missingModel}});
    assert.equal(rejected.error,'reference_model_unsupported');
    const before=await run('reference.list',{target});
    const saved=await run('reference.save',{target,expected_sha256:before.value.sha256,file:imagePath,title:'设定参考'});
    assert.equal(saved.value.entries.length,1);
    assert.deepEqual((await run('reference.list',{target})).value.entries,saved.value.entries);
    const reordered=await run('reference.reorder',{target,expected_sha256:saved.value.sha256,ids:saved.value.entries.map(entry=>entry.id)});
    await run('reference.delete',{target,expected_sha256:reordered.value.sha256,id:saved.value.entries[0].id});
    assert.equal((await run('reference.list',{target})).value.entries.length,0);
  }
  const templates = await run('page.templates', { owner_kind: 'character' });
  assert.ok(templates.items.length); assert.equal(templates.items[0].page, undefined);
  const templatePage = await run('page.create', { owner: owners[1], template_id: templates.items[0].id });
  await run('page.delete', { page_key:{page_id: templatePage.page_id} });
  const textPage = await run('page.create', { owner: owners[0], page_kind: 'text' });
  const textKey={page_id:textPage.page_id};
  const textEdit=await run('page.editor.read',{page_key:textKey,section:'content'});
  const textSaved=await run(textEdit.save.operation,{...textEdit.save.args,changes:{display_title:'次日',body:'第一行\n第二行',text_layout:{body_font_size:48,position:'lower'}}});
  assert.equal(textSaved.document.body,'第一行\n第二行');
  assert.equal(textSaved.document.display_title,'次日');
  assert.equal(textSaved.document.page_kind,'text');
  assert.equal(textSaved.document.text_layout.body_font_size,48);
  assert.equal(textSaved.document.text_layout.title_align,textEdit.document.text_layout.title_align);
  assert.deepEqual((await run('page.editor.read',{page_key:textKey,section:'content'})).document,textSaved.document);
  const textStale=await failure(f.tool,{operation:textEdit.save.operation,args:{...textEdit.save.args,changes:{body:'陈旧正文'}}});
  assert.equal(textStale.status,409);
  const cleared=await run(textSaved.save.operation,{...textSaved.save.args,changes:{body:'',display_title:''}});
  assert.equal(cleared.document.body,'');assert.equal(cleared.document.display_title,'');
  // 批量保存遇到冲突仍处理其他页，既不覆盖旧事实也不回滚已成功项。
  const keys=[...pages.map(p=>({page_id:p.page_id})),textKey];
  const batchRead=await run('page.editor.batch.read',{section:'content',page_keys:keys});
  assert.deepEqual(batchRead.counts,{read:4});
  await run('page.editor.save',{...batchRead.results[0].save.args,changes:{title:'用户的新标题'}});
  const rows=batchRead.results.map(({page_key,save},i)=>({page_key,expected_sha256:save.args.expected_sha256,changes:{title:`批量标题${i}`}}));
  const batchSaved=await run('page.editor.batch.save',{section:'content',items:rows});
  assert.deepEqual(batchSaved.counts,{failed:1,saved:3});
  assert.equal(batchSaved.results[0].error.code,'page_edit_conflict');
  assert.equal(batchSaved.results[0].next.operation,'page.editor.read');
  assert.equal(batchSaved.results[1].document,undefined);
  const afterBatch=await run('page.editor.batch.read',{section:'content',page_keys:keys});
  assert.equal(afterBatch.results[0].document.title,'用户的新标题');
  for(let i=1;i<4;i++) {
    assert.equal(afterBatch.results[i].document.title,`批量标题${i}`);
    assert.deepEqual(afterBatch.results[i].document.characters,batchRead.results[i].document.characters);
  }
  const malformed=await failure(f.tool,{operation:'page.editor.save',args:{...afterBatch.results[0].save.args,expected_sha256:'PLACEHOLDER',changes:{title:'不应写入'}}});
  assert.equal(malformed.status,400);assert.equal(malformed.details[0].field,'expected_sha256');
  const sheet = await run('candidate.sheet',{sequence_id:owners[0].sequence_id});
  assert.ok(sheet.pages >= 2); assert.ok(sheet.sheets.length); assert.equal(sheet.images,3);
  const sheetManifest=JSON.parse(await readFile(sheet.manifest,'utf8'));
  assert.ok(sheetManifest.cells.some(c=>c.page_kind==='text'));
  assert.ok(sheetManifest.cells.some(c=>c.status==='available' && c.task_id && c.candidate_id));
  const blocked = await failure(f.tool, { operation: 'page.move', args: { project_id: 'demo', page_key:{page_id: textPage.page_id}, owner: owners[1] } });
  assert.equal(blocked.error, 'text_page_story_only');
  await run('page.move', { page_key:{page_id: pages[0].page_id}, owner: owners[2], before_page_key:{page_id: pages[2].page_id} });
  assert.equal((await run('page.list', owners[2])).items[0].page_id, pages[0].page_id);
  const copy = await run('page.copy', { page_key:{page_id: pages[2].page_id} });
  await run('page.delete', { page_key:{page_id: copy.page_id} });
  // 目录只需索引，不会因不相关 Prompt 损坏而失败，也不返回其内容。
  const promptPath = path.join(root, 'workspace/demo/pages', pages[1].page_id + '.prompt.json');
  const original = await readFile(promptPath, 'utf8'); await writeFile(promptPath, 'invalid json');
  assert.equal((await run('page.list', owners[1])).items.length, 1);
  await writeFile(promptPath, original);
  const { requestWorkbench } = await import(pathToFileURL(path.join(root,'app/scripts/workbench-client.mjs')));
  await assert.rejects(requestWorkbench('/api/agent/directory',{method:'POST',body:{project_id:'demo',kind:'character',sequence_id:'wrong'}}), error=>error.code==='unknown_directory_filter');
  for (const p of [...pages, textPage]) await run('page.delete', { page_key:{page_id: p.page_id} });
  await run('character.variant.delete', { character_id: 'alice', variant_id: 'evening' });
  await run('scene.variant.delete', { scene_id: 'station', variant_id: 'wet' });
  await run('character.delete', { character_id: 'alice' });
  await run('scene.delete', { scene_id: 'station' });
  await run('sequence.delete', { sequence_id: unit.sequence_id });
  await run('chapter.delete', { chapter_id: chapter.chapter_id });
  assert.equal((await run('page.list')).total, 0);
});

test('项目设置经真实 HTTP Adapter 读写，旧 revision 拒绝且材料文本按需读取', async t => {
  const { Readable } = await import('node:stream');
  const { handleProjectRequest } = await import('../server/project-http.mjs');
  const { readProjectCreationTemplate } = await import('../server/project-creation.mjs');
  const { createQwenFixtureProject } = await import('./model-fixture.mjs');
  let root, revision = 'r1';
  const f = await fixture(t, async (captured, response) => {
    if (captured.url === '/api/lora-resources') return response.end(JSON.stringify({ resources: [], raw: [{ id: 'raw-fixture', name: '测试资源', relative_path: 'loras/fixture.safetensors', sha256: 'a'.repeat(64), status: 'available' }], errors: [] }));
    const request = Readable.from(captured.body ? [Buffer.from(JSON.stringify(captured.body))] : []); request.method = captured.method;
    const requestUrl = new URL(captured.url, 'http://test');
    const context = { request, response, requestUrl, decodedPath: decodeURIComponent(requestUrl.pathname), projectRoot: root, config: {},
      readFacts: async (projectId, fn) => ({ value: await fn({ projectId, projectDirectory: path.join(root, 'workspace', projectId) }), revision }),
      mutateFacts: async (projectId, fn) => {
        if (captured.headers['x-story-canvas-expected-revision'] !== revision) throw Object.assign(new Error('stale'), { status: 409, code: 'revision_conflict' });
        const value = await fn({ projectId, projectDirectory: path.join(root, 'workspace', projectId) }); revision += 'x'; return { value, revision };
      },
      sendOperation(status, result, body) { response.statusCode = status; response.setHeader('x-story-canvas-revision', result.revision); response.end(JSON.stringify(body ?? result.value)); },
    };
    assert.equal(await handleProjectRequest(context), true);
  });
  root = f.root;
  await createQwenFixtureProject(root, await readProjectCreationTemplate(root, 'demo'));
  const run = (operation, args = {}) => f.tool.execute({ operation, args: { project_id: 'demo', ...args } });
  const initial = await run('project.settings.read');
  assert.deepEqual(Object.keys(initial.value).sort(), ['canvas', 'default_render_profile', 'title']);
  await run('project.settings.save', { value: { ...initial.value, title: '中性测试' }, revision: initial.revision });
  assert.equal((await run('project.settings.read')).value.title, '中性测试');
  assert.equal((await failure(f.tool, { operation: 'project.settings.save', args: { project_id: 'demo', ...initial } })).status, 409);
  const inspection = await run('generation.inspect'); assert.ok(inspection.value.inspection);
  await run('generation.lora.set', { resource_id: 'raw-fixture', revision: inspection.revision });
  const withLora = await run('generation.inspect');
  assert.equal(withLora.value.inspection.style_loras['raw-fixture'].filename, 'fixture.safetensors');
  assert.equal(withLora.value.inspection.style_loras['raw-fixture'].weight, 1);
  await run('generation.lora.remove', { lora_id: 'raw-fixture', revision: withLora.revision });
  assert.equal((await run('generation.inspect')).value.inspection.style_loras['raw-fixture'], undefined);
  const document = await run('generation.override.read');
  await run('generation.override.save', { document: document.value.override, revision: document.revision });
  await run('material.save', { file: 'sample.txt', title: '参考', content: '原始文本', revision });
  assert.equal((await run('material.list')).items[0].text, undefined);
  const material = await run('material.read', { file: 'sample.txt' }); assert.equal(material.value.text, '原始文本');
  await run('material.save', { file: 'sample.txt', title: '改名', revision: material.revision });
  assert.equal((await run('material.read', { file: 'sample.txt' })).value.text, '原始文本');
  await run('material.delete', { file: 'sample.txt', revision });
  assert.equal((await run('material.list')).total, 0);
});

test('LoRA 工具查询未登记资源、保留其他调整，替换和删除保留基础值且不覆盖陈旧读取', async t => {
  let rev = 'r1';
  let document = { version: 1, profiles: { base: { changes: [{ target: 'prompt.text', original: { exists: true, value: '' }, project: { exists: true, value: 'neutral' } }] } } };
  let active = { existing: { id: 'existing', filename: 'base.safetensors', sha256: 'b'.repeat(64), weight: 0.7 } };
  const resource = { id: 'raw-test', name: '测试', relative_path: 'loras/test.safetensors', sha256: 'a'.repeat(64), status: 'available' };
  const f = await fixture(t, (req, res) => {
    res.setHeader('x-story-canvas-revision', rev);
    if (req.url === '/api/lora-resources') return res.end(JSON.stringify({ resources: [], raw: [resource], errors: [] }));
    if (req.url.includes('/render-profile-override')) {
      if (req.method === 'PUT') {
        assert.equal(req.headers['x-story-canvas-expected-revision'], rev);
        document = req.body; rev += 'x';
        active = Object.fromEntries(Object.entries(active).filter(([id]) => !document.profiles.base.changes.some(c => c.target === `style_loras.${id}` && !c.project.exists)));
        for (const c of document.profiles.base.changes) if (c.target.startsWith('style_loras.') && c.project.exists) { const id = c.target.slice('style_loras.'.length); active[id] = { id, ...c.project.value }; }
      }
      return res.end(JSON.stringify({ override: document }));
    }
    assert.ok(req.url.includes('/render-profile'));
    res.end(JSON.stringify({ current_profile_id: 'base', render_profiles: [{ id: 'base', architecture_family: 'anima', inspection: { style_loras: active, project_override: { status: 'none' } } }] }));
  });
  const list = await f.tool.execute({ operation: 'resource.lora.list', args: { query: 'test' } });
  assert.equal(list.items[0].id, resource.id);
  assert.equal(list.items[0].sha256, undefined);
  assert.equal((await f.tool.execute({ operation: 'resource.lora.inspect', args: { resource_id: resource.id } })).sha256, resource.sha256);
  const run = (operation, args) => f.tool.execute({ operation, args: { project_id: 'demo', revision: rev, ...args } });
  await run('generation.lora.set', { resource_id: resource.id, trigger: '' });
  assert.equal(active['raw-test'].weight, 1); assert.equal(active['raw-test'].filename, 'test.safetensors');
  assert.equal(active.existing.weight, 0.7);
  assert.equal(document.profiles.base.changes[0].project.value, 'neutral');
  await run('generation.lora.remove', { lora_id: 'raw-test' });
  assert.ok(!document.profiles.base.changes.some(c => c.target === 'style_loras.raw-test'));
  await run('generation.lora.set', { resource_id: resource.id, lora_id: 'existing', weight: 0.5 });
  const replaced = document.profiles.base.changes.find(c => c.target === 'style_loras.existing');
  assert.equal(replaced.original.value.filename, 'base.safetensors');
  assert.equal(replaced.project.value.weight, 0.5);
  await run('generation.lora.remove', { lora_id: 'existing' });
  assert.equal(document.profiles.base.changes.find(c => c.target === 'style_loras.existing').project.exists, false);
  const before = f.requests.length;
  const error = await failure(f.tool, { operation: 'generation.lora.set', args: { project_id: 'demo', resource_id: resource.id, revision: 'stale' } });
  assert.equal(error.status, 409); assert.equal(f.requests.length, before + 1);
});



test('完整能力只有一份，限制按 Agent 生效且执行前拦截，撤销后恢复', async t => {
  const f=await fixture(t,(request,response)=>response.end(JSON.stringify({task:{id:'test-task'}})));
  const {restrictWorkbench}=await import(pathToFileURL(path.join(f.root,'app/scripts/workbench-actions/access-policy.mjs')));
  const lite={},full={}; const release=restrictWorkbench(lite,['generation','training']);
  const catalog=await f.tool.execute({operation:'help'},{agent:lite});
  assert.ok(catalog.groups.every(g=>g.operations===undefined));
  let blocked=0;
  for(const group of catalog.groups){
    const detail=await f.tool.execute({operation:'help',target:group.id},{agent:lite});
    for(const item of detail.operations){
      const help=await f.tool.execute({operation:'help',target:item.operation},{agent:lite});
      assert.equal((await f.tool.execute({operation:'help',target:item.operation},{agent:full})).availability,'enabled');
      if(item.availability==='disabled'){
        blocked++;
        await assert.rejects(f.tool.execute({operation:item.operation},{agent:lite}),e=>JSON.parse(e.message).error==='capability_disabled');
        assert.ok(['generation','training'].includes(help.capability));
      }
    }
  }
  assert.equal(blocked,15);
  assert.equal(f.requests.length,0);
  assert.equal((await failure(f.tool,{operation:'api.request',args:{method:'POST',path:'/api/projects/demo/workbench/render'}})).error,'unknown_operation');
  await assert.rejects(f.tool.execute({operation:'training.image.crop',args:{dataset_id:'demo',item_id:'x',crop:{},etag:'r',upscale:true}},{agent:lite}),e=>JSON.parse(e.message).error==='invalid_arguments');
  assert.equal(f.requests.length,0);
  release();
  assert.equal((await f.tool.execute({operation:'help',target:'generation.run'},{agent:lite})).availability,'enabled');
  await f.tool.execute({operation:'generation.run',args:{project_id:'demo',page_key:{page_id:'page-001'}}},{agent:lite});
  assert.deepEqual(f.requests.at(-1).body,{page_key:{page_id:'page-001'},count:3});
});

test('训练封装经真实后端完成创建、导入、Caption、裁剪与恢复，不隐式加载模型', async t=>{
  const {Readable}=await import('node:stream');
  const {handleLoraTrainingRequest}=await import('../server/lora-training-http.mjs');
  const {createLoraTrainingOperations}=await import('../server/lora-training-operations.mjs');
  const {readJsonBody,readOptionalJsonBody,readLoraAssetRequest}=await import('../server/http-support.mjs');
  const sharp=(await import('sharp')).default;
  let root,trainingOperations;
  const f=await fixture(t,async(c,res)=>{
    const request=Readable.from([c.rawBody]); request.method=c.method;request.headers=c.headers;request.url=c.url;
    const handled=await handleLoraTrainingRequest({request,response:res,decodedPath:new URL(c.url,'http://test').pathname,resolvedProjectRoot:root,config:{},trainingOperations,readJsonBody,readOptionalJsonBody,readLoraAssetRequest});
    assert.ok(handled);
  });root=f.root;
  await cp(new URL('../../library/lora-training',import.meta.url),path.join(root,'library/lora-training'),{recursive:true});
  trainingOperations=createLoraTrainingOperations(root);
  const {restrictWorkbench}=await import(pathToFileURL(path.join(root,'app/scripts/workbench-actions/access-policy.mjs')));
  const agent={};t.after(restrictWorkbench(agent,['generation','training']));
  const call=(operation,args)=>f.tool.execute({operation,...(args?{args}:{})},{agent});
  const list=await call('training.dataset.list');
  const created=await call('training.dataset.create',{name:'中性测试',etag:list.etag});
  const id=created.value.id;
  const initial=await call('training.dataset.read',{dataset_id:id});
  const file=path.join(root,'sample.png');await sharp({create:{width:64,height:64,channels:3,background:'blue'}}).png().toFile(file);
  const imported=await call('training.asset.import',{dataset_id:id,group_id:initial.value.dataset.groups[0].id,files:[file],etag:initial.etag});
  const item=imported.value.items[0];
  assert.equal(item.preparation_error,undefined);
  assert.equal(item.preparation,undefined);
  await assert.rejects(call('training.caption.save',{dataset_id:id,item_id:item.id,caption:'blue square',etag:initial.etag}),e=>JSON.parse(e.message).status===409);
  const saved=await call('training.caption.save',{dataset_id:id,item_id:item.id,caption:'blue square',etag:imported.etag});
  const crop={x:0,y:0,width:32,height:32};
  const preview=await call('training.image.crop',{dataset_id:id,item_id:item.id,crop,etag:saved.etag});
  const applied=await call('training.image.apply',{dataset_id:id,item_id:item.id,crop,upscale:false,preview_id:preview.value.preview_id,etag:preview.etag});
  assert.equal(applied.value.items[0].preparation_error,undefined);
  const restored=await call('training.image.restore',{dataset_id:id,item_id:item.id,etag:applied.etag});
  assert.equal(restored.value.items[0].caption,'blue square');
  assert.equal(restored.value.items[0].preparation_error,undefined);
  const task=await call('training.task.read',{task_id:id});
  assert.ok(task.value.task);
  const dataset=await call('training.dataset.read',{dataset_id:id});
  await call('training.dataset.save',{dataset_id:id,document:{...dataset.value.dataset,name:'更新名称'},etag:dataset.etag});
  assert.equal((await call('training.dataset.read',{dataset_id:id})).value.dataset.name,'更新名称');
});


test('对比实验封装经真实后端完成输入、创建、查询、审阅和删除，不启动生成',async t=>{
  const {Readable}=await import('node:stream');
  const {handleComparisonRequest}=await import('../server/comparison-http.mjs');
  const {installModelResources}=await import('./model-fixture.mjs');
  let root;
  const f=await fixture(t,async(c,response)=>{
    const request=Readable.from([c.rawBody]);request.method=c.method;request.url=c.url;request.headers=c.headers;
    assert.ok(await handleComparisonRequest({request,response,decodedPath:c.url,projectRoot:root,config:{},activeComparisonProcesses:new Map()}));
  });root=f.root;await installModelResources(root);
  const call=(operation,args)=>f.tool.execute({operation,...(args?{args}:{})});
  const blank=await call('comparison.blank',{profile_id:'qwen-image-2-1',canvas:'1:1'});
  const input={...blank.value.input,prompt:{positive:'A blue square.',negative:''}};
  await call('comparison.create',{id:'tool-acceptance',inputs:[input],axes:[{type:'seed',values:[{value_id:'one',label:'一',value:1}]}]});
  const listed=await call('comparison.list',{limit:1});assert.equal(listed.items[0].id,'tool-acceptance');
  const detail=await call('comparison.inspect',{experiment_id:'tool-acceptance'});assert.equal(detail.value.experiment.status.status,'queued');
  const review=await call('comparison.review',{selections:[{experiment_id:'tool-acceptance'}]});assert.equal(review.value.rows.length,1);
  await call('comparison.delete',{experiment_id:'tool-acceptance'});
  assert.equal((await call('comparison.list')).total,0);
});

test('参数错误携带精确 schema，PageKey 与任务身份统一',async t=>{
  const f=await fixture(t,(_req,res)=>res.end(JSON.stringify({task:{id:'t',status:'completed'},images:[]})));
  const error=await failure(f.tool,{operation:'prompt.context',args:{project_id:'demo',page_key:'page-001'}});
  assert.equal(error.parameters.properties.page_key.type,'object');
  assert.deepEqual(error.example.page_key,{page_id:'page-001'});
  for(const operation of ['task.inspect','task.details','task.cancel','task.results']) {
    const help=await f.tool.execute({operation:'help',target:operation});
    assert.ok(help.parameters.required.includes('project_id'));
    assert.ok(help.parameters.required.includes('task_id'));
    assert.ok(!help.parameters.required.includes('purpose'));
  }
  const help=await f.tool.execute({operation:'help',target:'generation.run'});
  assert.deepEqual(help.parameters.properties.page_key,error.parameters.properties.page_key);
});

test('LoRA 与任务摘要不泄出大块元数据，完整详情文件可恢复',async t=>{
  const {readFile}=await import('node:fs/promises');
  const huge='metadata-'.repeat(20000);
  const resource={resource:{id:'lora-test',name:'测试',file:{relative_path:'loras/demo.safetensors',sha256:'a'.repeat(64)},architecture:{family:'anima'},activation:{trigger_words:['demo']},recommended_generation:{weight:{default:0.8}},source:{description:huge}},status:'available',metadata:huge};
  const task={id:'task-1',status:'failed',purpose:'candidate',project_id:'demo',progress:null,error:'render failed',item_counts:{failed:8},snapshot:{large:huge},execution_units:[{large:huge}],items:Array.from({length:8},(_,id)=>({id,status:'failed',error:'failed',render_profile:{large:huge}}))};
  const f=await fixture(t,(req,res)=>{
    if(req.url==='/api/lora-resources')return res.end(JSON.stringify({resources:[resource],raw:[],errors:[]}));
    if(req.url.startsWith('/api/tasks/history'))return res.end(JSON.stringify({history:[task],next_cursor:'cursor'}));
    if(req.url.startsWith('/api/tasks?'))return res.end(JSON.stringify({tasks:[task],history:[],tracked:[],queue_revision:3}));
    res.end(JSON.stringify({task}));
  });
  const summary=await f.tool.execute({operation:'resource.lora.inspect',args:{resource_id:'lora-test'}});
  assert.equal(summary.weight.default,0.8);assert.deepEqual(summary.trigger_words,['demo']);assert.ok(JSON.stringify(summary).length<1500);
  const detail=await f.tool.execute({operation:'resource.lora.details',args:{resource_id:'lora-test'}});
  assert.deepEqual(JSON.parse(await readFile(detail.file,'utf8')),resource);
  const args={project_id:'demo',task_id:'task-1'};
  const result=await f.tool.execute({operation:'task.inspect',args});
  assert.equal(result.task.error,'render failed');assert.equal(result.task.failures.length,5);assert.equal(result.task.item_counts.failed,8);assert.ok(JSON.stringify(result).length<2000);
  const full=await f.tool.execute({operation:'task.details',args});assert.deepEqual(JSON.parse(await readFile(full.file,'utf8')),{task});
  const list=await f.tool.execute({operation:'task.list',args:{project_id:'demo'}});assert.ok(JSON.stringify(list).length<2000);assert.equal(list.queue_revision,3);
  const history=await f.tool.execute({operation:'task.history',args:{project_id:'demo',before:'next/a'}});assert.equal(history.next_cursor,'cursor');
  assert.ok(f.requests.some(r=>r.url==='/api/tasks?project_id=demo'));
  assert.ok(f.requests.some(r=>r.url==='/api/tasks/history?project_id=demo&before=next%2Fa'));
});

test('真实 HTTP 保存拒绝新增片段自编 ID，返回字段诊断且不改变事实',async t=>{
  const {Readable}=await import('node:stream');
  const {createHttpRequestHandler}=await import('../server/http-app.mjs');
  const {createProjectOperations}=await import('../server/project-operations.mjs');
  const {createProject,readProjectCreationTemplate}=await import('../server/project-creation.mjs');
  const {installModelResources}=await import('./model-fixture.mjs');
  let handler;
  const f=await fixture(t,async(req,res)=>{const request=Readable.from([req.rawBody]);Object.assign(request,{method:req.method,url:req.url,headers:req.headers});await handler(request,res);});
  await installModelResources(f.root);
  await createProject(f.root,await readProjectCreationTemplate(f.root,'demo'));
  const operations=createProjectOperations({projectRoot:f.root});t.after(()=>operations.close());
  handler=createHttpRequestHandler({projectRoot:f.root,config:{},projectOperations:operations});
  await f.tool.execute({operation:'character.create',args:{project_id:'demo',id:'alice',name:'测试角色'}});
  const target={kind:'character',id:'alice',model_id:'anima',scope:'base'};
  const read=()=> f.tool.execute({operation:'prompt.read',args:{project_id:'demo',target}});
  const draft=await read();const baseline=structuredClone(draft);
  const prompt=draft.document.identity.prompt;
  prompt.person.push({id:'token-aaaaaaaaaaaa',tag:'blue_hair'});
  const error=await failure(f.tool,{operation:'prompt.save',args:{...draft.save.args,changes:draft.document}});
  assert.equal(error.status,400);assert.equal(error.error,'invalid_prompt_fragment');assert.match(error.message,/省略 id/);assert.equal(error.details[0].field,'person[0].id');
  assert.deepEqual(await read(),baseline);
  delete prompt.person[0].id;
  await f.tool.execute({operation:'prompt.save',args:{...draft.save.args,changes:draft.document}});
  const saved=await read();assert.match(saved.document.identity.prompt.person[0].id,/^token-[a-f0-9]{12}$/);
  saved.document.identity.prompt.person.push({...saved.document.identity.prompt.person[0]});
  const duplicate=await failure(f.tool,{operation:'prompt.save',args:{...saved.save.args,changes:saved.document}});
  assert.equal(duplicate.status,400);assert.match(duplicate.message,/重复/);
});


test('Prompt 校验错误直接修正，批量继承去重且保存参数无需逐页操作外壳',async t=>{
 const f=await fixture(t,({body,url},response)=>{
   if(url.endsWith('/save')){response.statusCode=422;return response.end(JSON.stringify({error:'invalid_story_edit_document',details:['person[0]: 人数词应放 population']}));}
   response.end(JSON.stringify({target:body.target,document:{person:[]},references:{characters:[{character_id:'alice',variant_id:'default'}]},inherited_sources:[{source:'character:alice:default',id:'alice',entries:[{text:'blue_jacket',enabled:true}]}],save:{operation:'prompt.save',args:{project_id:'demo',target:body.target,expected_sha256:'abc',source_versions:{source:'hash'}}}}));
 });
 const targets=['page-a','page-b'].map(id=>({kind:'page',id,model_id:'anima'}));
 const read=await f.tool.execute({operation:'prompt.batch.read',args:{project_id:'demo',targets}});
 assert.equal(read.sources.length,1);assert.equal(read.sources[0].ref,'source-1');assert.equal(read.sources[0].id,'alice');
 assert.deepEqual(read.results[0].inherited_source_refs,read.results[1].inherited_source_refs);
 assert.equal(read.results[0].save,undefined);assert.equal(read.results[0].expected_sha256,'abc');
 const items=read.results.map(r=>({target:r.target,expected_sha256:r.expected_sha256,source_versions:r.source_versions,changes:{person:[]}}));
 const saved=await f.tool.execute({operation:'prompt.batch.save',args:{project_id:'demo',items}});
 assert.equal(saved.counts.failed,2);assert.equal(saved.results[0].recovery.action,'correct_changes');assert.equal(saved.results[0].next,undefined);
 const one=await failure(f.tool,{operation:'prompt.save',args:{project_id:'demo',...items[0]}});
 assert.equal(one.recovery.action,'correct_changes');
});

test('批量读取跨页有效继承展示可复用，页面指纹和引用保持独立',async t=>{
 const f=await fixture(t,({body},res)=>{
  const entries=Array.from({length:8},(_,i)=>({key:'key-'+i,text:'appearance-'+i,enabled:!(body.target.id==='page-b'&&i===1),weight:1}));
  res.end(JSON.stringify({target:body.target,document:{person:[]},inherited_sources:[{source:'character:alice:default',entries}],save:{args:{expected_sha256:body.target.id,source_versions:{alice:'hash'}}}}));
 });
 const targets=['page-a','page-b'].map(id=>({kind:'page',id,model_id:'anima'}));
 const result=await f.tool.execute({operation:'prompt.batch.read',args:{project_id:'demo',targets}});
 assert.equal(result.sources[1].base_ref,result.sources[0].ref);
 assert.deepEqual(result.sources[1].entries,[{key:'key-1',text:'appearance-1',enabled:false,weight:1}]);
 assert.deepEqual(result.results.map(r=>r.expected_sha256),['page-a','page-b']);
 assert.deepEqual(result.results.map(r=>r.inherited_source_refs),[['source-1'],['source-2']]);
});
