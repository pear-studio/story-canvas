import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdir,cp,stat,access,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultVideoPostprocess,normalizeVideoPostprocess,videoPostprocessTiming} from '../shared/video-postprocess.mjs';
import {validateStoryPageNarrativeDocument} from '../server/story-files.mjs';
import {readPageEditContext,savePageEditChanges} from '../server/page-edit-context.mjs';
import {readPromptScope,savePromptScope} from '../server/prompt-scope.mjs';
import {createPage} from '../server/page-facts.mjs';
import {candidateFileRelativePath} from '../server/candidate-storage.mjs';
import {fixture,candidateId,json} from './helpers/finished-fixture.mjs';
import {prepareFinishedPage,readFinishedPages,readFinishedRecord,deleteFinishedPage} from '../server/finished-pages.mjs';
import {ensureMediaVariant} from '../server/media-variants.mjs';
import {loadLocalConfig} from '../server/http-support.mjs';
import {requireIdleProject} from '../server/project-management.mjs';
import {readProjectWorkbenchView} from '../server/project-workbench.mjs';
import Ajv from 'ajv/dist/2020.js';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const execute=promisify(execFile);

test('页面后处理校验与裁剪帧边界',async()=>{
  assert.deepEqual(normalizeVideoPostprocess(),defaultVideoPostprocess);
  for(const value of [null,{speed:0},{speed:4.1},{speed:1.15},{speed:'1'},{trim_start_seconds:-1},{trim_end_seconds:NaN},{candidate_id:'not-page-scoped'}])assert.throws(()=>normalizeVideoPostprocess(value));
  for(const speed of [.1,.3,1.1,4])assert.equal(normalizeVideoPostprocess({speed}).speed,speed);
  const video={frames:48,fps:24};
  assert.deepEqual(videoPostprocessTiming(video,{trim_start_seconds:.5,trim_end_seconds:.25,speed:.8}),{start_frame:12,end_frame:42,frames:30,fps:19.200000000000003,duration_seconds:30/(24*.8)});
  assert.equal(videoPostprocessTiming(video,{trim_start_seconds:1/48}).start_frame,1);
  assert.throws(()=>videoPostprocessTiming(video,{trim_start_seconds:1,trim_end_seconds:1}),/至少/);
  const document={$schema:'https://storyvisualizer.local/schemas/story-page-narrative.schema.json',title:'测试',scene_description:'',characters:[],dialogue:[],video_postprocess:{speed:.8}};
  assert.ok(validateStoryPageNarrativeDocument(document).length);
  assert.deepEqual(validateStoryPageNarrativeDocument({...document,page_kind:'video'}),[]);
  const schema=JSON.parse(await readFile(path.join(appRoot,'..','library','schemas','story-page-narrative.schema.json'),'utf8'));
  const validate=new Ajv({strict:false}).compile(schema);
  for(let tenths=1;tenths<=40;tenths++)assert.equal(validate({...document,page_kind:'video',video_postprocess:{speed:tenths/10}}),true,JSON.stringify(validate.errors));
});

test('页面后处理保存保留正文和候选，冻结输出、过时检测与失败保留旧成品',async t=>{
  const f=await fixture(t),video=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'video'});
  const relative=candidateFileRelativePath(video.page_key,candidateId),candidateDir=path.dirname(path.join(f.directory,relative));
  await cp(path.dirname(f.file),candidateDir,{recursive:true});
  const original=Buffer.from('immutable original video'),videoRelative=relative.replace('image.png','video.mp4');
  await writeFile(path.join(f.directory,videoRelative),original);
  await json(path.join(candidateDir,'result.json'),{version:1,status:'available',page_key:video.page_key,candidate_id:candidateId,file:relative,task_id:'render-test',media_kind:'video',video_file:videoRelative,video_sha256:sha(original),video:{width:128,height:192,frames:48,fps:24,duration_seconds:2}});
  const tracked=['video.mp4','image.png','result.json','generation.json'];
  const before=await Promise.all(tracked.map(name=>readFile(path.join(candidateDir,name)).then(sha)));
  const options={projectRoot:f.root,projectId:'demo',pageKey:video.page_key,section:'content'};
  const read=()=>readPageEditContext(options);
  const save=async edit=>{
    const scope=await read();
    return f.operations.mutateTargetFacts('demo',()=>savePageEditChanges({...options,expectedSha256:scope.save.args.expected_sha256,changes:{video_postprocess:edit}}));
  };
  // 与界面一样：先保存 Prompt，再使用原 content 读据保存后处理。
  const contentBefore=await read(),promptOptions={projectRoot:f.root,projectId:'demo',target:{kind:'page',id:video.page_id}};
  const prompt=await readPromptScope(promptOptions);
  await f.operations.mutateTargetFacts('demo',()=>savePromptScope({...promptOptions,expectedSha256:prompt.save.args.expected_sha256,sourceVersions:prompt.save.args.source_versions,changes:{text:'树叶轻摆'}}));
  const edit={trim_start_seconds:.5,trim_end_seconds:.25,speed:.8};
  await f.operations.mutateTargetFacts('demo',()=>savePageEditChanges({...options,expectedSha256:contentBefore.save.args.expected_sha256,changes:{video_postprocess:edit}}));
  assert.deepEqual((await read()).document,{...contentBefore.document,video_postprocess:edit});
  const directory=await readProjectWorkbenchView(f.root,'demo',{kind:'directory'});
  assert.deepEqual(directory.outline.chapters.flatMap(c=>c.sequences.flatMap(s=>s.pages)).find(p=>p.page_id===video.page_id).video_postprocess,edit,'目录携带后处理参数，时长可随保存立即更新');
  const prepare=()=>f.operations.mutateDerived('demo',()=>prepareFinishedPage(f.root,'demo',f.directory,{page_key:video.page_key,candidate_id:candidateId})).then(x=>x.value);
  const prepared=await prepare();
  await save({speed:1.2});
  const processed=Buffer.from('separate processed video');
  assert.equal((await f.run(prepared,{processVideo:async(bytes,directory,settings)=>{
    assert.deepEqual(bytes,original);assert.deepEqual(settings,edit);
    await assert.rejects(requireIdleProject(directory),e=>e.status===409);
    return {webp:processed,gif:Buffer.from('gif'),poster:await readFile(f.file),metadata:{width:128,height:192,gif:{},warnings:[],...videoPostprocessTiming({frames:48,fps:24},settings)}};
  }})).status,'completed');
  const first=await readFinishedRecord(f.directory,video.page_id);
  assert.deepEqual(first.video_postprocess,edit);
  assert.deepEqual(await readFile(path.join(f.directory,first.outputs.clean)),processed);
  assert.equal((await readFinishedPages(f.root,'demo',f.directory,{page_id:video.page_id})).pages[0].status,'stale');
  assert.equal((await f.run(await prepare(),{processVideo:async()=>{throw Error('encoder failed');}})).status,'failed');
  assert.deepEqual(await readFinishedRecord(f.directory,video.page_id),first);
  assert.deepEqual(await readFile(path.join(f.directory,first.outputs.clean)),processed);
  const listed=(await readFinishedPages(f.root,'demo',f.directory,{page_id:video.page_id})).pages[0];
  await f.operations.mutateTargetFacts('demo',()=>deleteFinishedPage(f.directory,{page_key:video.page_key,locale:'zh',expected_sha256:listed.record.sha256}));
  assert.deepEqual(await Promise.all(tracked.map(name=>readFile(path.join(candidateDir,name)).then(sha))),before);
  await save({trim_start_seconds:2,trim_end_seconds:0,speed:1});
  await assert.rejects(prepare(),/至少/);
});

test('真实视频：裁剪、0.1/0.8/1.1/4倍输出及WebP时间轴，原片字节不变',async t=>{
  const config=await loadLocalConfig(appRoot);
  if(!config.comfyui_root)return t.skip('未配置本机视频运行环境');
  const python=path.resolve(appRoot,'..',config.comfyui_root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  try {await access(python);}catch{return t.skip('本机视频 Python 不存在');}
  const f=await fixture(t),video=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'video'});
  const relative=candidateFileRelativePath(video.page_key,candidateId).replace('image.png','video.mp4'),source=path.join(f.directory,relative);
  await mkdir(path.dirname(source),{recursive:true});
  const helper=path.join(appRoot,'tests','helpers','video-postprocess-fixture.py');
  const pythonRun=async args=>JSON.parse((await execute(python,['-B',helper,...args],{windowsHide:true})).stdout||'null');
  await pythonRun(['create',source]);
  const bytes=await readFile(source),before=sha(bytes);
  const {processVideoBytes}=await import('../server/video-media.mjs');
  const base=await ensureMediaVariant(f.directory,{target:source,info:await stat(source)},relative,320);
  const media={target:source,info:await stat(source)};
  const trimmed=await ensureMediaVariant(f.directory,media,relative,320,{trim_start_seconds:.5,trim_end_seconds:.25,speed:1});
  const trimmedBytes=await readFile(trimmed.target),trimmedAnimation=await pythonRun(['webp',trimmed.target]);
  const baseAnimation=await pythonRun(['webp',base.target]);
  const expectedHashes=timing=>{
    let elapsed=0,previous=0;
    return baseAnimation.frame_sha256.filter((_,i)=>{
      elapsed+=baseAnimation.durations_ms[i];
      const end=Math.round(elapsed*24/1000),keep=end>timing.start_frame&&previous<timing.end_frame;
      previous=end;return keep;
    });
  };
  assert.deepEqual(trimmedAnimation.frame_sha256,expectedHashes({start_frame:12,end_frame:42}),'裁剪只保留对应画面，边界重建不能改变解码像素');
  for(const speed of [.1,.8,1.1,4]){
    const settings={trim_start_seconds:.5,trim_end_seconds:.25,speed},timing=videoPostprocessTiming({frames:48,fps:24},settings);
    const output=await processVideoBytes(bytes,f.directory,settings);
    const outputPath=path.join(f.directory,'Saved',`check-${speed}.mp4`);await writeFile(outputPath,output.bytes);
    const actual=await pythonRun(['video',outputPath]);
    assert.equal(actual.frames,30);assert.ok(Math.abs(actual.fps-24*speed)<.001);
    assert.ok(Math.abs(actual.duration_seconds-timing.duration_seconds)<.001);
    assert.ok(Math.abs(actual.first_pixel[0]-48)<8,'首帧须来自裁剪后的第12帧');
    const preview=await ensureMediaVariant(f.directory,{target:source,info:await stat(source)},relative,320,settings);
    assert.notEqual(preview.target,base.target);
    const animation=await pythonRun(['webp',preview.target]);
    // WebP 编码器可合并视觉相同的帧，合并后必须保留总播放时间。
    assert.ok(animation.frames>1&&animation.frames<=30);assert.ok(Math.abs(animation.duration_ms-timing.duration_seconds*1000)<=1);
    assert.ok(Math.abs(animation.first_pixel[0]-48)<12);
    assert.deepEqual(animation.frame_sha256,trimmedAnimation.frame_sha256,'倍率只改时间信息，每帧解码画面必须完全相同');
    assert.deepEqual(await readFile(trimmed.target),trimmedBytes,'原速缓存不可被覆盖');
    assert.equal(sha(await readFile(source)),before);
  }
  // 原片暂时不可读仍可从已有 1 倍缓存派生新倍率，证明未重新解码视频。
  await rename(source,source+'.held');
  try {
    for(const speed of [1.3,1.7]) {
      const preview=await ensureMediaVariant(f.directory,media,relative,320,{trim_start_seconds:.5,trim_end_seconds:.25,speed});
      const animation=await pythonRun(['webp',preview.target]);
      assert.equal(animation.duration_ms,Math.round(trimmedAnimation.duration_ms/speed));
      assert.deepEqual(animation.frame_sha256,trimmedAnimation.frame_sha256);
    }
    for(const settings of [{trim_start_seconds:.25,trim_end_seconds:.5},{trim_start_seconds:.75},{trim_end_seconds:.5}]) {
      const preview=await ensureMediaVariant(f.directory,media,relative,320,settings);
      const animation=await pythonRun(['webp',preview.target]);
      const timing=videoPostprocessTiming({frames:48,fps:24},settings);
      assert.deepEqual(animation.frame_sha256,expectedHashes(timing),'新裁剪范围无需读取 MP4');
    }
  } finally {await rename(source+'.held',source);}
  const records=[],originalLog=console.info;
  console.info=line=>{try{records.push(JSON.parse(line));}catch{}};
  try {
    await Promise.all([1.2,1.8].map((speed,i)=>ensureMediaVariant(f.directory,media,relative,1024,{trim_start_seconds:i*.25,trim_end_seconds:.5,speed})));
  } finally {console.info=originalLog;}
  assert.equal(records.filter(r=>r.event==='video_processing'&&r.status==='started'&&r.kind==='webp_preview').length,1,'并发不同裁剪范围和倍率共用一次完整基础编码');
  assert.equal(records.filter(r=>r.event==='video_preview_trim'&&r.status==='completed').length,2);
  assert.equal(records.filter(r=>r.event==='video_preview_retime'&&r.status==='completed').length,2);
  assert.equal((await ensureMediaVariant(f.directory,media,relative,320)).target,base.target);
  assert.equal(sha(await readFile(source)),before);
});
