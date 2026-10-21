import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {trimWebp} from '../server/webp-trim.mjs';
import {readWebpChunks,webpChunk,writeWebpChunks} from '../server/webp-timing.mjs';

const width=32,height=24;
async function rectangle(w,h,color) {
  const bytes=await sharp({create:{width:w,height:h,channels:4,background:color}}).webp({lossless:true}).toBuffer();
  return Buffer.concat(readWebpChunks(bytes).filter(c=>['ALPH','VP8 ','VP8L'].includes(c.type)).map(c=>c.bytes));
}
async function animation(specs,{fps=10,frames=specs.reduce((n,s)=>n+s.duration/100,0)}={}) {
  const canvas=Buffer.alloc(10);canvas[0]=0x12;
  canvas.writeUIntLE(width-1,4,3);canvas.writeUIntLE(height-1,7,3);
  const clock=Buffer.alloc(12);clock.writeUInt32LE(frames);clock.writeDoubleLE(fps,4);
  const chunks=[webpChunk('VP8X',canvas),webpChunk('ANIM',Buffer.alloc(6))];
  for(const s of specs) {
    const header=Buffer.alloc(16);
    header.writeUIntLE((s.x??0)/2,0,3);header.writeUIntLE((s.y??0)/2,3,3);
    header.writeUIntLE(s.w-1,6,3);header.writeUIntLE(s.h-1,9,3);
    header.writeUIntLE(s.duration,12,3);header[15]=s.flags??0;
    chunks.push(webpChunk('ANMF',Buffer.concat([header,await rectangle(s.w,s.h,s.color)])));
  }
  return writeWebpChunks([...chunks,webpChunk('SCVT',clock)]);
}
const decoded=async bytes=>{
  const {data,info}=await sharp(bytes,{animated:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const size=info.width*(info.pageHeight??info.height)*4;
  return Array.from({length:data.length/size},(_,i)=>data.subarray(i*size,(i+1)*size));
};
const durations=bytes=>readWebpChunks(bytes).filter(c=>c.type==='ANMF').map(c=>c.payload.readUIntLE(12,3));
const background={w:width,h:height,color:'#205080',flags:2,duration:100};

test('裁掉开头：重建局部帧/连续清除边界，后续压缩帧不变，透明和混合结果逐帧一致',async()=>{
  const source=await animation([background,
    {w:8,h:8,x:4,y:4,color:'#ff2020',flags:1,duration:100},
    {w:12,h:8,x:8,y:8,color:'#20ff2080',flags:1,duration:100},
    {w:10,h:10,x:2,y:2,color:'#ffff20',flags:0,duration:100},
    {w:8,h:8,x:20,y:10,color:'#f020f080',flags:0,duration:100},
    background]);
  const before=Buffer.from(source),expected=await decoded(source);
  const result=await trimWebp(source,{trim_start_seconds:.1,trim_end_seconds:.1});
  assert.equal(result.rebuiltFrames,3);
  assert.deepEqual(await decoded(result.bytes),expected.slice(1,5));
  const inputFrames=readWebpChunks(source).filter(c=>c.type==='ANMF');
  const outputFrames=readWebpChunks(result.bytes).filter(c=>c.type==='ANMF');
  assert.deepEqual(outputFrames[3].bytes,inputFrames[4].bytes,'稳定边界之后直接复用压缩数据');
  assert.deepEqual(source,before);
  assert.deepEqual(durations(result.bytes),[100,100,100,100]);
});

test('独立起始帧和只裁结尾无需重建；单帧、合并重复帧内裁剪保留正确时间',async()=>{
  const source=await animation([background,{...background,color:'#f04020',duration:500},background]);
  const expected=await decoded(source);
  for(const [start,end,expectedFrames,expectedDurations] of [
    [0,.1,expected.slice(0,2),[100,500]],
    [.1,.1,expected.slice(1,2),[500]],
    [.2,.2,expected.slice(1,2),[300]],
    [.6,0,expected.slice(2),[100]],
  ]) {
    const result=await trimWebp(source,{trim_start_seconds:start,trim_end_seconds:end});
    assert.equal(result.rebuiltFrames,0);
    assert.deepEqual(await decoded(result.bytes),expectedFrames);
    assert.deepEqual(durations(result.bytes),expectedDurations);
  }
  await assert.rejects(trimWebp(source,{trim_start_seconds:.7}),/至少/);
});

test('裁剪继续按最近原片帧对齐，24 fps 的累计时间不会漂移',async()=>{
  const specs=Array.from({length:24},(_,i)=>({...background,duration:Math.round((i+1)*1000/24)-Math.round(i*1000/24)}));
  const source=await animation(specs,{frames:24,fps:24});
  const result=await trimWebp(source,{trim_start_seconds:.12,trim_end_seconds:.18});
  assert.equal(durations(result.bytes).length,17);
  assert.equal(durations(result.bytes).reduce((a,b)=>a+b,0),Math.round(17*1000/24));
});

test('静止缓存与取消、缺失时间轴和损坏帧明确处理',async()=>{
  const still=await sharp({create:{width,height,channels:3,background:'#204080'}}).webp().toBuffer();
  const clock=Buffer.alloc(12);clock.writeUInt32LE(48);clock.writeDoubleLE(24,4);
  const source=writeWebpChunks([...readWebpChunks(still).map(c=>c.bytes),webpChunk('SCVT',clock)]);
  assert.deepEqual((await trimWebp(source,{trim_start_seconds:.5})).bytes,source);
  await assert.rejects(trimWebp(still,{trim_start_seconds:.5}),/时间轴/);
  await assert.rejects(trimWebp(source,{trim_start_seconds:2}),/至少/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(trimWebp(source,{},controller.signal),{name:'AbortError'});
  const animated=await animation([background,{w:8,h:8,color:'#ff0000',duration:100}]);
  const mid=new AbortController(),work=trimWebp(animated,{trim_start_seconds:.1},mid.signal);
  mid.abort();
  await assert.rejects(work,{name:'AbortError'});
});
