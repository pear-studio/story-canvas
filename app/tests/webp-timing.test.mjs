import assert from 'node:assert/strict';
import test from 'node:test';
import {retimeWebp} from '../server/webp-timing.mjs';

const chunk=(type,payload)=>{
  const header=Buffer.alloc(8);header.write(type);header.writeUInt32LE(payload.length,4);
  return Buffer.concat([header,payload,Buffer.alloc(payload.length%2)]);
};
const riff=chunks=>{
  const data=Buffer.concat(chunks),header=Buffer.alloc(12);header.write('RIFF');header.writeUInt32LE(data.length+4,4);header.write('WEBP',8);
  return Buffer.concat([header,data]);
};
function animation(durations) {
  const extended=Buffer.alloc(10);extended[0]=2;
  return riff([chunk('VP8X',extended),chunk('ICCP',Buffer.from('odd')),chunk('ANIM',Buffer.from([1,2,3,4,0,0])),
    ...durations.map((duration,index)=>{
      const header=Buffer.alloc(16);header[0]=index;header[15]=index%4;header.writeUIntLE(duration,12,3);
      return chunk('ANMF',Buffer.concat([header,chunk('VP8 ',Buffer.from([22,index,33]))]));
    }),chunk('XMP ',Buffer.from('metadata'))]);
}
function frameOffsets(bytes) {
  const result=[];for(let i=12;i<bytes.length;i+=8+bytes.readUInt32LE(i+4)+(bytes.readUInt32LE(i+4)%2))if(bytes.toString('ascii',i,i+4)==='ANMF')result.push(i+20);
  return result;
}
test('只改帧时长，像素/混合/清除/透明与元数据字节保持不变，累计舍入不漂移',()=>{
  const source=animation([42,41,84,42,791]),before=Buffer.from(source),offsets=frameOffsets(source);
  for(let tenth=1;tenth<=40;tenth++) {
    const speed=tenth/10,result=retimeWebp(source,speed);
    assert.equal(result.length,source.length);
    const duration=offsets.reduce((sum,offset)=>sum+result.readUIntLE(offset,3),0);
    assert.equal(duration,Math.round(1000/speed));
    const stripped=Buffer.from(result);
    for(const offset of offsets)source.copy(stripped,offset,offset,offset+3);
    assert.deepEqual(stripped,source);
  }
  assert.deepEqual(source,before,'从不改写来源 Buffer');
  assert.deepEqual(retimeWebp(source,1),source);
});
test('损坏的容器与非法时长明确失败；静止片段不重新编码',()=>{
  const source=animation([42]);
  for(const invalid of [Buffer.alloc(0),source.subarray(0,source.length-1),riff([chunk('ANMF',Buffer.alloc(15))]),animation([0]),riff([])])
    assert.throws(()=>retimeWebp(invalid,1.2));
  const oversize=Buffer.from(source);oversize.writeUInt32LE(0xffffffff,16);assert.throws(()=>retimeWebp(oversize,1.2));
  assert.throws(()=>retimeWebp(animation([0xffffff]),.1),/范围/);
  for(const speed of [NaN,Infinity,0,-1])assert.throws(()=>retimeWebp(source,speed));
  const still=riff([chunk('VP8L',Buffer.from([1,2,3]))]);assert.deepEqual(retimeWebp(still,1.2),still);
});
