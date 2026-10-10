import {writeQwenFixtureJson,qwenDocument} from './helpers/qwen-fixture.mjs';
import { defaultTextPageLayout } from "../shared/text-page-layout.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile, rm, stat, unlink, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createPage } from "../server/page-facts.mjs";
import { fixture, key, json, candidateId } from "./helpers/finished-fixture.mjs";
import { candidateFileRelativePath } from "../server/candidate-storage.mjs";
import { PAGES_INDEX_SCHEMA_ID } from "../server/pages-store.mjs";
import { deleteFinishedPage, planFinishedBatch, prepareFinishedPage, readFinishedPages, readFinishedRecord, runFinishedBatch, upscaleFinishedImage, finishedModel } from "../server/finished-pages.mjs";
import { savePageContent, readProjectWorkbenchView } from "../server/project-workbench.mjs";
import { handleFinishedRequest } from "../server/finished-http.mjs";
import { listWorkspaceRenderTasks, listWorkspaceRenderHistory, readWorkspaceTaskDetail, readWorkspaceTaskResults } from "../server/render-task-workspace.mjs";

test('插画和动态页缺失或错误候选 ID 返回400，且不创建输出任务',async t=>{
  const f=await fixture(t);
  const video=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'video'});
  for(const page_key of [key,video.page_key])for(const candidate_id of [undefined,'wrong-id']){
    await assert.rejects(prepareFinishedPage(f.root,'demo',f.directory,{page_key,candidate_id}),error=>{
      assert.equal(error.status,400);assert.equal(error.code,'invalid_candidate_id');assert.equal(error.details.field,'candidate_id');return true;
    });
    await assert.rejects(readFile(path.join(f.directory,'Saved','finished',`${page_key.page_id}.json`)),{code:'ENOENT'});
  }
});

test("动态成品原样复制、不超分；混排 ZIP 与 HTML 导出动画 WebP 一次，替换及删除清理封面", async t => {
  const f = await fixture(t);
  await f.run(await f.prepare());
  const video = await createPage(f.root, "demo", { owner_kind:"story", sequence_id:"sequence" }, { pageKind:"video" });
  const file = candidateFileRelativePath(video.page_key, candidateId);
  await cp(path.dirname(f.file), path.dirname(path.join(f.directory,file)), {recursive:true});
  // 媒体解码已由生成接收层及本机实测覆盖；这里用不被图片处理器接受的字节验证直出与导出边界。
  const bytes=Buffer.from("fixture-mp4-payload");
  const videoFile=file.replace(/image\.png$/, "video.mp4");
  await writeFile(path.join(f.directory,videoFile), bytes);
  await json(path.join(f.directory,file.replace(/image\.png$/, "result.json")), {version:1,status:"available",page_key:video.page_key,candidate_id:candidateId,file,task_id:"render-test",media_kind:"video",video_file:videoFile,video_sha256:createHash("sha256").update(bytes).digest("hex"),video:{width:128,height:192,fps:24,frames:73,actual_duration:73/24,audio_streams:0}});
  const prepare=()=>f.operations.mutateDerived("demo",()=>prepareFinishedPage(f.root,"demo",f.directory,{page_key:video.page_key,candidate_id:candidateId})).then(result=>result.value);
  const run=prepared=>f.run(prepared,{upscale:()=>assert.fail("视频不应超分"),render:()=>assert.fail("视频不应嵌字")});
  assert.equal((await run(await prepare())).status,"completed");
  const first=await readFinishedRecord(f.directory,video.page_id);
  assert.deepEqual(await readFile(path.join(f.directory,first.outputs.clean)),bytes);
  assert.equal(first.outputs.clean,first.outputs.lettered);
  assert.equal(first.upscale,undefined);
  // 准备生成接收层转换后的缓存，导出测试无需本机 Python 或 GPU。
  const pixels = Buffer.alloc(128 * 192 * 3 * 2);
  for (let i = 0; i < 128 * 192 * 2; i++) pixels[i * 3 + (i < 128 * 192 ? 0 : 2)] = 255;
  const animation = await sharp(pixels, {raw:{width:128,height:384,pageHeight:192,channels:3}}).webp({lossless:true,loop:0,delay:[41,42]}).toBuffer();
  const info = await stat(path.join(f.directory, first.outputs.clean));
  const cacheId = createHash('sha1').update(`animation-v1:${first.outputs.clean}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:1024`).digest('hex');
  await mkdir(path.join(f.directory, 'Saved/media-cache'), {recursive:true});
  await writeFile(path.join(f.directory, 'Saved/media-cache', `${cacheId}.webp`), animation);
  const server=createServer(async(request,response)=>{try{await handleFinishedRequest({request,response,decodedPath:new URL(request.url,"http://local").pathname,projectRoot:f.root,readFacts:f.operations.readFacts});}catch(error){response.writeHead(error.status??500);response.end(error.message);}});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const send=(preview,variant)=>fetch(`http://127.0.0.1:${server.address().port}/api/projects/demo/finished/export`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({variant,preview})});
  for (const variant of ['lettered','clean','both']) {
    const archive=await send(false,variant);assert.equal(archive.status,200);
    const zip=Buffer.from(await archive.arrayBuffer());
    const names=[];let offset=0;
    while((offset=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),offset))!==-1){const length=zip.readUInt16LE(offset+28);names.push(zip.subarray(offset+46,offset+46+length).toString());offset+=46+length;}
    assert.deepEqual(names, [...(variant==='clean'?[]:['嵌字版/001.png']),...(variant==='lettered'?[]:['无字版/001.png']),'动态页/002.webp']);
    assert.ok(zip.includes(animation));assert.ok(!zip.includes(bytes));
    const response=await send(true,variant);assert.equal(response.status,200);const html=await response.text();
    assert.doesNotMatch(html,/<video|data:video\/mp4/);
    const embedded=[...html.matchAll(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/g)].map(m=>Buffer.from(m[1],'base64'));
    assert.equal(embedded.length,variant==='both'?3:2);
    assert.equal(embedded.filter(b=>b.equals(animation)).length,1);
    const metadata=await sharp(embedded.find(b=>b.equals(animation)),{animated:true}).metadata();
    assert.equal(metadata.width,128);assert.equal(metadata.pages,2);assert.equal(metadata.loop,0);assert.deepEqual(metadata.delay,[41,42]);
    assert.equal(Number(response.headers.get("x-export-total")),Buffer.byteLength(html));
  }
  assert.equal((await run(await prepare())).status,"completed");
  for(const relative of [first.outputs.clean,first.poster])await assert.rejects(readFile(path.join(f.directory,relative)),{code:"ENOENT"});
  const current=await readFinishedRecord(f.directory,video.page_id);
  const listed=(await readFinishedPages(f.root,"demo",f.directory)).pages.find(page=>page.page_id===video.page_id);
  await f.operations.mutateTargetFacts("demo",()=>deleteFinishedPage(f.directory,{page_key:video.page_key,expected_sha256:listed.record.sha256}));
  for(const relative of [current.outputs.clean,current.poster])await assert.rejects(readFile(path.join(f.directory,relative)),{code:"ENOENT"});
  assert.deepEqual(await readFile(path.join(f.directory,videoFile)),bytes);
});

test("成品阶段进入全局任务、详情与历史，结果引用当前成品", async t => {
  const f = await fixture(t);
  const pending = await f.prepare();
  const listing = await listWorkspaceRenderTasks(f.root);
  assert.equal(listing.tasks[0].purpose, "finished");
  assert.equal(listing.tasks[0].stage, "queued");
  await f.run(pending, { render: async clean => {
    const task = (await listWorkspaceRenderTasks(f.root)).tasks[0];
    assert.equal(task.status, "running");
    assert.equal(task.stage, "lettering");
    return clean;
  } });
  assert.equal((await listWorkspaceRenderTasks(f.root)).tasks.length, 0);
  assert.equal((await listWorkspaceRenderHistory(f.root)).history[0].purpose, "finished");
  const detail = await readWorkspaceTaskDetail(f.root, "demo", pending.job.id, "finished");
  assert.equal(detail.stage, "completed");
  assert.ok(detail.completed_at);
  assert.equal((await readWorkspaceTaskResults(f.root, "demo", pending.job.id, "finished")).length, 1);
});

test("删除成品校验当前版本和制作状态，清理双版本与记录并保留页面候选", async t => {
  const f = await fixture(t);
  await f.run(await f.prepare());
  const before = await f.operations.state("demo");
  const record = await readFinishedRecord(f.directory, key.page_id);
  const page = (await readFinishedPages(f.root, "demo", f.directory)).pages[0];
  const remove = expected_sha256 => f.operations.mutateTargetFacts("demo", () => deleteFinishedPage(f.directory, { page_key: key, expected_sha256 }));
  await assert.rejects(remove("old"), /成品已变化/);
  const pending = await f.prepare();
  await assert.rejects(remove(page.record.sha256), /正在输出/);
  await f.run(pending, { render: async () => { throw new Error("测试中断"); } });
  await remove(page.record.sha256);
  assert.equal(await readFinishedRecord(f.directory, key.page_id), null);
  for (const file of [...Object.values(record.outputs), `Saved/finished/${key.page_id}.json`]) await assert.rejects(readFile(path.join(f.directory, file)), { code: "ENOENT" });
  assert.ok((await readFile(f.file)).length);
  assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages[0].status, "missing");
  assert.notEqual(await f.operations.state("demo"), before);
});

test("远程超分上传底图并下载结果，不要求工作台本机权重", async t => {
  const calls = [];
  const result = Buffer.from("remote-output");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(String(url));
    assert.ok(String(url).startsWith("http://render.example.test:8188/"));
    if (url.endsWith("/object_info/UpscaleModelLoader")) return Response.json({ UpscaleModelLoader: { input: { required: { model_name: ["COMBO", { options: [finishedModel.name] }] } } } });
    if (url.endsWith("/upload/image")) { assert.ok(options.body instanceof FormData); return Response.json({ name: "uploaded.png" }); }
    if (url.endsWith("/prompt")) {
      const workflow = JSON.parse(options.body).prompt;
      assert.equal(workflow["1"].inputs.image, "uploaded.png");
      assert.equal(workflow["2"].inputs.model_name, finishedModel.name);
      return Response.json({ prompt_id: "remote-job" });
    }
    if (url.endsWith("/history/remote-job")) return Response.json({ "remote-job": { outputs: { "4": { images: [{ filename: "upscaled.png", type: "output" }] } } } });
    if (url.includes("/view?")) return new Response(result);
    throw new Error(`未预期请求：${url}`);
  });
  assert.deepEqual(await upscaleFinishedImage(Buffer.from("input"), { comfyui_urls: ["http://render.example.test:8188"], models_root: "not-a-local-model-directory" }, "remote-test"), result);
  assert.equal(calls.length, 5);
});
test("成品记录进入事实 revision；更新失败保留旧成品，改文案复用超分图，底图不备份", async t => {
  const f = await fixture(t);
  const before = await f.operations.state("demo");
  const prepared = await f.prepare();
  await assert.rejects(f.prepare(), /本页正在输出/);
  assert.equal((await f.run(prepared)).status, "completed");
  const record = await readFinishedRecord(f.directory, key.page_id);
  assert.equal(record.generation.seed, 1234);
  assert.equal(record.width, 256);
  assert.notEqual(await f.operations.state("demo"), before);
  assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages[0].status, "ready");
  const failure = await f.run(await f.prepare(), { render: async () => { throw new Error("嵌字失败"); } });
  assert.equal(failure.status, "failed");
  assert.deepEqual(await readFinishedRecord(f.directory, key.page_id), record);
  const view = await readProjectWorkbenchView(f.root, "demo");
  const page = view.outline.chapters[0].sequences[0].pages[0];
  await f.operations.mutateTargetFacts("demo", () => savePageContent(f.root, "demo", { page_key: key, expected_sha256: page.content_sha256,
    content: { title: page.title, scene_description: page.scene_description, characters: [], dialogue: [{ mode: "narration", text: "新文案" }] } }));
  assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages[0].status, "stale");
  await rm(path.dirname(f.file), { recursive: true });
  const next = await f.prepare();
  assert.equal(next.sourceBuffer, null);
  assert.equal((await f.run(next, { upscale: () => { throw new Error("不应重复超分"); } })).status, "completed");
  assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages[0].status, "ready");
  assert.equal((await readFinishedRecord(f.directory, key.page_id)).lettering.dialogue[0].text, "新文案");
});

test("文字页成品不需要候选图：黑底直出、记录无候选字段、改正文后标记过期", async t => {
  const f = await fixture(t);
  const textKey = { page_id: "page-002" };
  await json(path.join(f.directory, `pages/${textKey.page_id}.content.json`), {
    $schema: "https://storyvisualizer.local/schemas/story-page-narrative.schema.json",
    title: "后记", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: "作者的话。", display_title: "写在最后", text_layout: { ...defaultTextPageLayout },
  });
  await json(path.join(f.directory, `pages/${textKey.page_id}.prompt.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.prompt.json`)).then(JSON.parse));
  await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [key.page_id, textKey.page_id].map(page_id => ({ page_id, owner_kind: "story", sequence_id: "sequence" })) });
  await assert.rejects(
    f.operations.mutateDerived("demo", () => prepareFinishedPage(f.root, "demo", f.directory, { page_key: key })),
    /candidate/,
    "普通页仍必须提供候选 ID",
  );
  const prepared = await f.operations.mutateDerived("demo", () => prepareFinishedPage(f.root, "demo", f.directory, { page_key: textKey })).then(result => result.value);
  assert.equal(prepared.sourceBuffer, null);
  assert.deepEqual(prepared.textPage, { width: 1664, height: 2496 });
  let renderedLettering = null;
  const job = await f.run(prepared, {
    upscale: () => { throw new Error("文字页不应超分"); },
    render: async (clean, lettering) => { renderedLettering = lettering; return clean; },
  });
  assert.equal(job.status, "completed");
  assert.equal(renderedLettering.page_kind, "text");
  assert.equal(renderedLettering.display_title, "写在最后");
  assert.deepEqual(renderedLettering.text_layout, defaultTextPageLayout);
  const record = await readFinishedRecord(f.directory, textKey.page_id);
  assert.equal(record.page_kind, "text");
  assert.equal(Object.hasOwn(record, "candidate_id"), false);
  assert.equal(record.width, 1664);
  assert.equal(record.height, 2496);
  const listed = await readFinishedPages(f.root, "demo", f.directory);
  const textPage = listed.pages.find(page => page.page_id === textKey.page_id);
  assert.equal(textPage.status, "ready");
  assert.equal(textPage.record.candidate_id, null);
  const renderFile=path.join(f.directory,`pages/${textKey.page_id}.render.json`);
  await json(renderFile,{version:1,model_id:'anima',profile_id:'anima-base-v1',canvas:'2:3'});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages.find(page=>page.page_id===textKey.page_id).status,'ready','两模型输出尺寸统一后，文字页换模型不需要重新制作');
  await json(renderFile,{version:1,model_id:'anima',profile_id:'anima-base-v1',canvas:'1:1'});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages.find(page=>page.page_id===textKey.page_id).status,'stale','切换方形改变输出尺寸，必须重新制作');
  await json(renderFile,{version:1,model_id:'qwen',profile_id:'qwen-image-2-1',canvas:'2:3'});
  assert.equal((await readFinishedPages(f.root,'demo',f.directory)).pages.find(page=>page.page_id===textKey.page_id).status,'ready');
  const cleanPixels = await sharp(path.join(f.directory, record.outputs.clean)).stats();
  assert.deepEqual(cleanPixels.channels.map(channel => channel.mean), [0, 0, 0]);
  let view = await readProjectWorkbenchView(f.root, "demo");
  let page = view.outline.chapters[0].sequences[0].pages.find(entry => entry.page_id === textKey.page_id);
  const content = { title: "目录名称改了", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: page.body, display_title: page.display_title, text_layout: page.text_layout };
  const renamed = await f.operations.mutateTargetFacts("demo", () => savePageContent(f.root, "demo", { page_key: textKey, expected_sha256: page.content_sha256, content }));
  assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages.find(entry => entry.page_id === textKey.page_id).status, "ready");
  await f.operations.mutateTargetFacts("demo", () => savePageContent(f.root, "demo", { page_key: textKey, expected_sha256: renamed.value.content_sha256, content: { ...content, text_layout: { ...content.text_layout, position: "lower" } } }));
  assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages.find(entry => entry.page_id === textKey.page_id).status, "stale");
  view = await readProjectWorkbenchView(f.root, "demo");
  page = view.outline.chapters[0].sequences[0].pages.find(entry => entry.page_id === textKey.page_id);
  await f.operations.mutateTargetFacts("demo", () => savePageContent(f.root, "demo", { page_key: textKey, expected_sha256: page.content_sha256,
    content: { title: "后记", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: "改过的作者的话。", display_title: page.display_title, text_layout: page.text_layout } }));
  const after = await readFinishedPages(f.root, "demo", f.directory);
  assert.equal(after.pages.find(page => page.page_id === textKey.page_id).status, "stale");
});

test("文字页成品尺寸对齐当前渲染配置的候选出图尺寸", async t => {
  const f = await fixture(t);
  await json(path.join(f.directory, "project.json"), { $schema: "https://storyvisualizer.local/schemas/project.schema.json", format: "story-models-v1", title: "成品测试", canvas: "3:4", default_render_profile: "qwen-image-2-1" });
  const textKey = { page_id: "page-002" };
  await json(path.join(f.directory, `pages/${textKey.page_id}.content.json`), {
    $schema: "https://storyvisualizer.local/schemas/story-page-narrative.schema.json",
    title: "后记", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: "作者的话。", display_title: "写在最后", text_layout: { ...defaultTextPageLayout },
  });
  await json(path.join(f.directory, `pages/${textKey.page_id}.prompt.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.prompt.json`)).then(JSON.parse));
  await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [key.page_id, textKey.page_id].map(page_id => ({ page_id, owner_kind: "story", sequence_id: "sequence" })) });
  const prepared = await f.operations.mutateDerived("demo", () => prepareFinishedPage(f.root, "demo", f.directory, { page_key: textKey })).then(result => result.value);
  assert.deepEqual(prepared.textPage, { width: 1920, height: 2560 });
  const job = await f.run(prepared, { upscale: () => { throw new Error("文字页不应超分"); } });
  assert.equal(job.status, "completed");
  const record = await readFinishedRecord(f.directory, textKey.page_id);
  assert.equal(record.width, prepared.textPage.width);
  assert.equal(record.height, prepared.textPage.height);
  const view = await readProjectWorkbenchView(f.root, "demo");
  assert.deepEqual(view.render_capabilities.text_page.dimensions, prepared.textPage, "预览和成品消费同一尺寸投影");
  await json(path.join(f.directory, "project.json"), { $schema: "https://storyvisualizer.local/schemas/project.schema.json", format: "story-models-v1", title: "成品测试", canvas: "3:4", default_render_profile: "missing-profile" });
  const unavailable = await readProjectWorkbenchView(f.root, "demo");
  assert.equal(unavailable.render_capabilities.text_page.dimensions, null);
  assert.match(unavailable.render_capabilities.text_page.error, /无法确定成品尺寸/);
  assert.equal(unavailable.outline.chapters[0].sequences[0].pages.find(page => page.page_id === textKey.page_id).display_title, "写在最后", "生成配置不可用时仍能读取和编辑文字");
});

test("批量输出计划：零张或多张候选跳过，唯一候选与文字页入选，排除已就绪和输出中的页面", async t => {
  const f = await fixture(t);
  const newer = "candidate-22222222-2222-4222-8222-222222222222";
  await json(path.join(f.directory, candidateFileRelativePath(key, newer).replace("image.png", "result.json")),
    { version: 1, status: "available", page_key: key, candidate_id: newer, file: candidateFileRelativePath(key, newer), seed: 99, task_id: "render-20260827T010203Z", generated_at: "2099-01-01T00:00:00.000Z" });
  const second = "page-002";
  for (const suffix of ["content", "prompt", "render"]) await writeFile(path.join(f.directory, `pages/${second}.${suffix}.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.${suffix}.json`)));
  const textKey = { page_id: "page-003" };
  await json(path.join(f.directory, `pages/${textKey.page_id}.content.json`), {
    $schema: "https://storyvisualizer.local/schemas/story-page-narrative.schema.json",
    title: "后记", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: "作者的话。", display_title: "写在最后", text_layout: { ...defaultTextPageLayout },
  });
  await json(path.join(f.directory, `pages/${textKey.page_id}.prompt.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.prompt.json`)).then(JSON.parse));
  await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [key.page_id, second, textKey.page_id].map(page_id => ({ page_id, owner_kind: "story", sequence_id: "sequence" })) });
  const plan = await planFinishedBatch(f.root, "demo", f.directory, {});
  assert.deepEqual(plan.targets, [{locale:"zh", page_key: textKey, page_label: "003" }]);
  assert.deepEqual(plan.skipped.map(page => page.page_id), [key.page_id, second]);
  assert.match(plan.skipped[0].reason, /2 张候选/);
  assert.match(plan.skipped[1].reason, /没有候选/);
  await unlink(path.join(f.directory, candidateFileRelativePath(key, newer).replace("image.png", "result.json")));
  assert.deepEqual((await planFinishedBatch(f.root, "demo", f.directory)).targets, [{locale:"zh", page_key: key, candidate_id: candidateId, page_label: "001" }, {locale:"zh", page_key: textKey, page_label: "003" }]);
  assert.deepEqual(await planFinishedBatch(f.root, "demo", f.directory, { chapter_id: "other-chapter" }), { targets: [], skipped: [] });
  const pending = await f.prepare();
  assert.deepEqual((await planFinishedBatch(f.root, "demo", f.directory, {})).targets, [{locale:"zh", page_key: textKey, page_label: "003" }], "输出中的页面不重复排队");
  await f.run(pending);
  assert.deepEqual((await planFinishedBatch(f.root, "demo", f.directory, {})).targets, [{locale:"zh", page_key: textKey, page_label: "003" }], "已就绪页面不排队");
  const forced = await planFinishedBatch(f.root, "demo", f.directory, { force: true });
  assert.deepEqual(forced.targets, [{locale:"zh", page_key: key, candidate_id: candidateId, page_label: "001" }, {locale:"zh", page_key: textKey, page_label: "003" }], "强制模式已就绪页面也排队");
  const view = await readProjectWorkbenchView(f.root, "demo");
  const page = view.outline.chapters[0].sequences[0].pages[0];
  await f.operations.mutateTargetFacts("demo", () => savePageContent(f.root, "demo", { page_key: key, expected_sha256: page.content_sha256,
    content: { title: page.title, scene_description: page.scene_description, characters: [], dialogue: [{ mode: "narration", text: "新文案" }] } }));
  const stale = await planFinishedBatch(f.root, "demo", f.directory, {});
  assert.deepEqual(stale.targets, [{locale:"zh", page_key: key, candidate_id: candidateId, page_label: "001" }, {locale:"zh", page_key: textKey, page_label: "003" }], "内容过时页使用当前唯一候选");
});

test("更换唯一候选使成品过时，批量采用新候选；排队后候选变化不得静默输出旧图", async t => {
  const f = await fixture(t);
  await f.run(await f.prepare());
  const replacement = "candidate-22222222-2222-4222-8222-222222222222";
  const file = candidateFileRelativePath(key, replacement);
  await cp(path.dirname(f.file), path.join(f.directory, path.dirname(file)), { recursive: true });
  const result = JSON.parse(await readFile(f.file.replace("image.png", "result.json"), "utf8"));
  await json(path.join(f.directory, file.replace("image.png", "result.json")), { ...result, candidate_id: replacement, file });
  await unlink(f.file.replace("image.png", "result.json"));
  const listing = await readFinishedPages(f.root, "demo", f.directory);
  assert.equal(listing.pages[0].status, "stale");
  const plan = await planFinishedBatch(f.root, "demo", f.directory);
  assert.deepEqual(plan.targets, [{locale:"zh", page_key: key, candidate_id: replacement, page_label: "001" }]);
  await json(f.file.replace("image.png", "result.json"), result);
  await assert.rejects(prepareFinishedPage(f.root, "demo", f.directory, plan.targets[0], { queuedJob: { id: "queued-test" } }), /候选已变化/);
  assert.deepEqual((await planFinishedBatch(f.root, "demo", f.directory, { force: true })).targets, []);
});

test("批量输出先为全部目标写入排队任务，再逐页串行执行", async t => {
  const f = await fixture(t);
  const textKey = { page_id: "page-002" };
  await json(path.join(f.directory, `pages/${textKey.page_id}.content.json`), {
    $schema: "https://storyvisualizer.local/schemas/story-page-narrative.schema.json",
    title: "后记", scene_description: "", characters: [], dialogue: [], page_kind: "text", body: "作者的话。", display_title: "写在最后", text_layout: { ...defaultTextPageLayout },
  });
  await json(path.join(f.directory, `pages/${textKey.page_id}.prompt.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.prompt.json`)).then(JSON.parse));
  await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [key.page_id, textKey.page_id].map(page_id => ({ page_id, owner_kind: "story", sequence_id: "sequence" })) });
  const plan = await planFinishedBatch(f.root, "demo", f.directory, {});
  const observed = [];
  const results = await runFinishedBatch({ repositoryRoot: f.root, projectId: "demo", directory: f.directory, targets: plan.targets, config: {}, origin: "", mutateDerived: f.operations.mutateDerived, mutateTargetFacts: f.operations.mutateTargetFacts,
    upscale: source => sharp(source).resize(256, 384).png().toBuffer(),
    render: async clean => { observed.push((await listWorkspaceRenderTasks(f.root)).tasks.map(task => `${task.pages[0].page_id}:${task.status}`)); return clean; } });
  assert.deepEqual(results, { completed: 2, failed: 0 });
  assert.deepEqual(observed[0].sort(), [`${key.page_id}:running`, `${textKey.page_id}:queued`], "第一页执行时第二页已在队列中");
  assert.equal((await listWorkspaceRenderTasks(f.root)).tasks.length, 0, "批量结束后没有活动任务");
});

test("成品按当前索引排序，新增缺页可见，删除页不发布；分享 ZIP 附缺页说明", async t => {
  const f = await fixture(t);
  await f.run(await f.prepare());
  const record = await readFinishedRecord(f.directory, key.page_id);
  const second = "page-002";
  for (const suffix of ["content", "prompt"]) await writeFile(path.join(f.directory, `pages/${second}.${suffix}.json`), await readFile(path.join(f.directory, `pages/${key.page_id}.${suffix}.json`)));
  const setIndex = ids => json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: ids.map(page_id => ({ page_id, owner_kind: "story", sequence_id: "sequence" })) });
  await setIndex([second, key.page_id]);
  const listing = await readFinishedPages(f.root, "demo", f.directory);
  assert.deepEqual(listing.pages.map(page => page.page_id), [second, key.page_id]);
  assert.equal(listing.pages[0].status, "missing");
  const server = createServer(async (request, response) => {
    try { await handleFinishedRequest({ request, response, decodedPath: new URL(request.url, "http://local").pathname, projectRoot: f.root, readFacts: f.operations.readFacts }); }
    catch (error) { response.writeHead(error.status ?? 500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = value => fetch(`http://127.0.0.1:${server.address().port}/api/projects/demo/finished/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const response = await send({ variant: "both" });
  assert.equal(response.status, 200);
  const outputs = record.outputs;
  const rawTotal = (await stat(path.join(f.directory, outputs.lettered))).size + (await stat(path.join(f.directory, outputs.clean))).size;
  assert.equal(Number(response.headers.get("x-export-total")), rawTotal, "ZIP 导出通告原始图片总大小");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const names = []; let offset = 0;
  while ((offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset)) !== -1) { const size = bytes.readUInt16LE(offset + 28); names.push(bytes.subarray(offset + 46, offset + 46 + size).toString()); offset += 46 + size; }
  assert.deepEqual(names, ["嵌字版/002.png", "无字版/002.png", "缺页说明.txt"]);
  const previewResponse = await send({ variant: "both", preview: true });
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get("content-type"), /text\/html/);
  const html = await previewResponse.text();
  assert.equal(Number(previewResponse.headers.get("x-export-total")), Buffer.byteLength(html), "预览 HTML 通告精确总大小");
  assert.ok(html.includes("<title>demo-zh-预览</title>"), "标题使用项目名和语言");
  const embedded = [...html.matchAll(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/g)].map(item => Buffer.from(item[1], "base64"));
  assert.equal(embedded.length, 2, "两个版本各一张内嵌压缩图");
  for (const bytes of embedded) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 256, "小图不放大，保持原尺寸");
  }
  assert.deepEqual([...html.matchAll(/data-page="(\d+)"/g)].map(match => match[1]), ["1", "2","1","2"], "两个版本均保留正式页码和缺页占位");
  assert.ok(html.includes('reader-placeholder')&&html.includes('第 1 页'),"缺失页明确显示占位");
  const pending = await f.prepare();
  await setIndex([second]);
  assert.equal((await f.run(pending)).status, "failed");
  assert.deepEqual(await readFinishedRecord(f.directory, key.page_id), record);
  assert.deepEqual((await readFinishedPages(f.root, "demo", f.directory)).pages.map(page => page.page_id), [second]);
});



test("设定验证页可单页输出与重新归属，系列成品排除验证页", async t => {
  for (const owner_kind of ["character", "scene"]) await t.test(owner_kind, async context => {
    const f = await fixture(context);
    const owner = owner_kind === "character" ? { character_id: "missing-character" } : { scene_id: "missing-scene" };
    await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID,
      pages: [{ page_id: key.page_id, owner_kind, ...owner, variant_id: "default" }] });
    assert.deepEqual((await readFinishedPages(f.root, "demo", f.directory)).pages, []);
    assert.equal((await readFinishedPages(f.root, "demo", f.directory, { page_id: key.page_id })).pages[0].status, "missing");
    assert.equal((await f.run(await f.prepare())).status, "completed");
    assert.equal((await readFinishedPages(f.root, "demo", f.directory, { page_id: key.page_id })).pages[0].status, "ready");
    assert.deepEqual((await planFinishedBatch(f.root, "demo", f.directory)).targets, []);
    const record = await readFinishedRecord(f.directory, key.page_id);
    await json(path.join(f.directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID,
      pages: [{ page_id: key.page_id, owner_kind: "story", sequence_id: "sequence" }] });
    assert.deepEqual(await readFinishedRecord(f.directory, key.page_id), record);
    assert.equal((await readFinishedPages(f.root, "demo", f.directory)).pages[0].status, "ready");
  });
});
