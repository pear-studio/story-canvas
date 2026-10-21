import sharp from 'sharp';
import {videoPostprocessTiming} from '../shared/video-postprocess.mjs';
import {readWebpChunks,webpChunk,writeWebpChunks} from './webp-timing.mjs';

// 只用于本应用编码的完整原速缓存；SCVT 保存编码器合并重复帧前的时间轴。
export async function trimWebp(source,settings,signal) {
  signal?.throwIfAborted();
  const chunks=readWebpChunks(source),clock=chunks.find(c=>c.type==='SCVT')?.payload;
  if(clock?.length!==12)throw new Error('WebP 缓存缺少原片时间轴');
  const video={frames:clock.readUInt32LE(0),fps:clock.readDoubleLE(4)};
  const timing=videoPostprocessTiming(video,{...settings,speed:1});
  const frames=chunks.filter(c=>c.type==='ANMF');
  if(!frames.length) {
    if(!chunks.some(c=>c.type==='VP8 '||c.type==='VP8L'))throw new Error('WebP 缓存没有有效图像');
    return {bytes:Buffer.from(source),rebuiltFrames:0};
  }
  const canvas=chunks.find(c=>c.type==='VP8X')?.payload;
  if(canvas?.length!==10||!chunks.some(c=>c.type==='ANIM'))throw new Error('WebP 动画头无效');
  const width=canvas.readUIntLE(4,3)+1,height=canvas.readUIntLE(7,3)+1;
  let elapsed=0,previous=0,outputElapsed=0;
  const selected=[];
  for(const [index,frame] of frames.entries()) {
    if(frame.payload.length<16)throw new Error('WebP 动画帧头不完整');
    const duration=frame.payload.readUIntLE(12,3);
    if(!duration)throw new Error('WebP 帧时长必须大于零');
    elapsed+=duration;
    const next=Math.round(elapsed*video.fps/1000);
    if(next<=previous||next>video.frames)throw new Error('WebP 时间轴与原片不符');
    const start=Math.max(previous,timing.start_frame),end=Math.min(next,timing.end_frame);
    if(end>start) {
      const endMs=Math.round((end-timing.start_frame)*1000/video.fps);
      selected.push({index,frame,duration:endMs-outputElapsed});
      outputElapsed=endMs;
    }
    previous=next;
  }
  if(previous!==video.frames||!selected.length)throw new Error('WebP 时间轴与原片不符');

  // 裁掉开头后，重建依赖此前画面的首帧。重建帧覆盖完整画布且不清除。
  // 若原帧要求清除子矩形，继续重建下一帧，直到后续帧可安全复用原压缩数据。
  // 全画布、不混合的独立帧可直接复用，并终止此前的依赖链。
  let rebuild=selected[0].index>0,rebuiltFrames=0;
  const output=[];
  for(const {index,frame,duration} of selected) {
    signal?.throwIfAborted();
    let payload=Buffer.from(frame.payload);
    const full=payload.readUIntLE(0,3)===0&&payload.readUIntLE(3,3)===0
      &&payload.readUIntLE(6,3)+1===width&&payload.readUIntLE(9,3)+1===height;
    if(full&&(payload[15]&2))rebuild=false;
    if(rebuild) {
      const encoded=await sharp(source,{page:index,pages:1}).webp({lossless:true,effort:0}).toBuffer();
      signal?.throwIfAborted();
      const pixels=readWebpChunks(encoded).filter(c=>['ALPH','VP8 ','VP8L'].includes(c.type));
      if(!pixels.length)throw new Error('WebP 裁剪起点重建失败');
      const header=Buffer.alloc(16);
      header.writeUIntLE(width-1,6,3);header.writeUIntLE(height-1,9,3);header[15]=2;
      rebuild=Boolean(payload[15]&1);
      payload=Buffer.concat([header,...pixels.map(c=>c.bytes)]);
      rebuiltFrames++;
    }
    payload.writeUIntLE(duration,12,3);
    output.push(webpChunk('ANMF',payload));
  }
  const result=[];
  let inserted=false;
  for(const chunk of chunks) {
    if(chunk.type==='SCVT')continue; // 派生图不再声称具有完整原片时间轴。
    if(chunk.type==='ANMF') {
      if(!inserted)result.push(...output);
      inserted=true;
    } else result.push(chunk.bytes);
  }
  signal?.throwIfAborted();
  return {bytes:writeWebpChunks(result),rebuiltFrames};
}
