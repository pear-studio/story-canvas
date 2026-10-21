// ANMF 的 16 字节头中，偏移 12 处是 uint24 毫秒时长。
// https://developers.google.com/speed/webp/docs/riff_container#animation
// 只改时长，保留压缩像素、帧区域、混合/清除方式和所有元数据。
export function readWebpChunks(source) {
  if(!Buffer.isBuffer(source)||source.length<12||source.toString('ascii',0,4)!=='RIFF'
    ||source.toString('ascii',8,12)!=='WEBP'||source.readUInt32LE(4)!==source.length-8)throw new Error('WebP 缓存头无效');
  const chunks=[];
  for(let offset=12;offset<source.length;) {
    if(offset+8>source.length)throw new Error('WebP 缓存块头不完整');
    const type=source.toString('ascii',offset,offset+4),size=source.readUInt32LE(offset+4);
    const end=offset+8+size+(size%2);
    if(end>source.length)throw new Error('WebP 缓存块越界');
    chunks.push({type,bytes:source.subarray(offset,end),payload:source.subarray(offset+8,offset+8+size),offset});
    offset=end;
  }
  return chunks;
}

export function webpChunk(type,payload) {
  const header=Buffer.alloc(8);header.write(type);header.writeUInt32LE(payload.length,4);
  return Buffer.concat([header,payload,Buffer.alloc(payload.length%2)]);
}

export function writeWebpChunks(chunks) {
  const size=chunks.reduce((sum,chunk)=>sum+chunk.length,4),header=Buffer.alloc(12);
  header.write('RIFF');header.writeUInt32LE(size,4);header.write('WEBP',8);
  return Buffer.concat([header,...chunks]);
}

export function retimeWebp(source, speed) {
  if(!Number.isFinite(speed)||speed<=0)throw new TypeError('WebP 播放倍率无效');
  const offsets=[];
  let animated=false,staticImage=false;
  for(const {type,payload,offset} of readWebpChunks(source)) {
    const size=payload.length;
    if(type==='ANIM') {
      if(size!==6)throw new Error('WebP 动画头无效');
      animated=true;
    }
    if(type==='VP8 '||type==='VP8L')staticImage=true;
    if(type==='ANMF') {
      if(size<16)throw new Error('WebP 动画帧头不完整');
      offsets.push(offset+8+12);
    }
  }
  if(!offsets.length) {
    // 编码器可能把完全静止的片段合并为单张图片，无需改动像素。
    if(!staticImage||animated)throw new Error('WebP 缓存没有有效图像');
    return Buffer.from(source);
  }
  if(!animated)throw new Error('WebP 缓存缺少动画头');
  const output=Buffer.from(source);
  let originalElapsed=0,scaledElapsed=0;
  for(const offset of offsets) {
    const duration=source.readUIntLE(offset,3);
    if(!duration)throw new Error('WebP 帧时长必须大于零');
    originalElapsed+=duration;
    // 累计时间取整，避免逐帧舍入累积误差；始终从 1 倍缓存派生。
    const next=Math.round(originalElapsed/speed),scaled=next-scaledElapsed;
    if(scaled<1||scaled>0xffffff)throw new Error('WebP 帧时长超出可表示范围');
    output.writeUIntLE(scaled,offset,3);
    scaledElapsed=next;
  }
  return output;
}
