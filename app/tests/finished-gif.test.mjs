import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,truncate,unlink,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,json,candidateId} from './helpers/finished-fixture.mjs';
import {createPage} from '../server/page-facts.mjs';
import {readFinishedRecord,readFinishedPages} from '../server/finished-pages.mjs';
import {optimizeFinishedGif} from '../server/finished-gif.mjs';
import {hashCanonicalJson} from '../server/workflow-definition.mjs';
import {gifPolicy} from '../server/animation-output.mjs';

async function setup(t){
  const f=await fixture(t),page=await createPage(f.root,'demo',{owner_kind:'story',sequence_id:'sequence'},{pageKind:'video'});
  const prefix=`Outputs/finished/${page.page_id}/original`;await mkdir(path.join(f.directory,prefix),{recursive:true});
  const source=Buffer.from('frozen-video-source'),pixels=Buffer.alloc(64*128*3);pixels.fill(200,64*64*3);
  const gif=await sharp(pixels,{raw:{width:64,height:128,pageHeight:64,channels:3}}).gif({delay:[500,500],loop:0}).toBuffer();
  const webp=await sharp(pixels,{raw:{width:64,height:128,pageHeight:64,channels:3}}).webp({delay:[500,500],loop:0}).toBuffer();
  const record={$schema:'https://storyvisualizer.local/schemas/finished-page.schema.json',page_key:page.page_key,page_kind:'video',candidate_id:candidateId,source_sha256:createHash('sha256').update(source).digest('hex'),source_backup:prefix+'/source.mp4',source_video:{width:64,height:64,fps:24,frames:24},video:{width:64,height:64,fps:24,frames:24,duration_seconds:1},video_postprocess:{trim_start_seconds:0,trim_end_seconds:0,speed:1},lettering:{page_kind:'video',canvas:'1:1'},media_format:'webp',width:64,height:64,created_at:'2026-10-01T00:00:00Z',outputs:{clean:prefix+'/animation.webp',lettered:prefix+'/animation.webp',gif:prefix+'/animation.gif'},gif:{width:64,height:64,encoded_frames:2,duration_seconds:1,bytes:15000001},warnings:['GIF 超过 16 MB，发布前请检查平台文件限制']};
  await writeFile(path.join(f.directory,record.source_backup),source);await writeFile(path.join(f.directory,record.outputs.clean),webp);await writeFile(path.join(f.directory,record.outputs.gif),gif);await truncate(path.join(f.directory,record.outputs.gif),15000001);
  const recordFile=path.join(f.directory,'finished',`${page.page_id}.json`);await json(recordFile,record);
  const encoding={policy:gifPolicy.version,max_bytes:gifPolicy.max_bytes,tier:1,...gifPolicy.tiers[1],original_bytes:15000001,attempts:[{...gifPolicy.tiers[0],bytes:15000001},{...gifPolicy.tiers[1],bytes:gif.length}]};
  const encoded={gif,metadata:{gif:{width:64,height:64,encoded_frames:2,duration_seconds:1,bytes:gif.length,encoding},warnings:[]}};
  const run=(encode=async()=>encoded,expected=hashCanonicalJson(record))=>optimizeFinishedGif({repositoryRoot:f.root,projectId:'demo',value:{page_key:page.page_key,expected_sha256:expected},readFacts:f.operations.readFacts,mutateTargetFacts:f.operations.mutateTargetFacts,encode});
  return {...f,page,record,recordFile,source,webp,gif,encoded,run};
}

test('已有超限GIF只换GIF并保留备份、源片和WebP；重复优化不重编码',async t=>{
  const f=await setup(t),oldGif=await readFile(path.join(f.directory,f.record.outputs.gif));
  const result=(await f.run(async(bytes,directory,settings)=>{assert.deepEqual(bytes,f.source);assert.deepEqual(settings,f.record.video_postprocess);return f.encoded;})).value;
  assert.equal(result.changed,true);assert.ok(result.bytes<=15000000);
  const record=await readFinishedRecord(f.directory,f.page.page_id);
  assert.deepEqual({...record,outputs:f.record.outputs,gif:f.record.gif,warnings:f.record.warnings},f.record);
  assert.deepEqual(await readFile(path.join(f.directory,f.record.outputs.clean)),f.webp);
  assert.deepEqual(await readFile(path.join(f.directory,f.record.source_backup)),f.source);
  assert.deepEqual(await readFile(path.join(f.directory,result.backup_gif)),oldGif);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory,result.backup_record),'utf8')),f.record);
  assert.deepEqual(await readFile(path.join(f.directory,record.outputs.gif)),f.gif);
  const listed=(await readFinishedPages(f.root,'demo',f.directory)).pages.find(p=>p.page_id===f.page.page_id);
  assert.equal(listed.record.gif.encoding.tier,1);assert.deepEqual(listed.record.warnings,[]);
  const repeated=(await f.run(()=>assert.fail('合规文件不应重编码'),hashCanonicalJson(record))).value;assert.equal(repeated.changed,false);
});

test('GIF优化的编码失败、时长异常、源丢失、并发更改都保留现有成果',async t=>{
  for(const reason of ['encode','duration','source','conflict'])await t.test(reason,async t=>{
    const f=await setup(t),before=await readFile(f.recordFile),oldGif=await readFile(path.join(f.directory,f.record.outputs.gif));
    if(reason==='source')await unlink(path.join(f.directory,f.record.source_backup));
    let concurrent;
    await assert.rejects(f.run(async()=>{
      if(reason==='encode')throw Error('全部五档仍超限');
      if(reason==='duration')return {...f.encoded,metadata:{...f.encoded.metadata,gif:{...f.encoded.metadata.gif,duration_seconds:2}}};
      if(reason==='conflict'){concurrent={...f.record,created_at:'2026-10-02T00:00:00Z'};await json(f.recordFile,concurrent);}
      return f.encoded;
    }));
    if(concurrent)assert.deepEqual(JSON.parse(await readFile(f.recordFile,'utf8')),concurrent);else assert.deepEqual(await readFile(f.recordFile),before);
    assert.deepEqual(await readFile(path.join(f.directory,f.record.outputs.gif)),oldGif);
    assert.deepEqual(await readdir(path.join(f.directory,'Outputs/finished',f.page.page_id)),['original']);
  });
});
