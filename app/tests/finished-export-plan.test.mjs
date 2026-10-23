import test from 'node:test';
import assert from 'node:assert/strict';
import {balancedVolumes,planPixivExport,planEhExport} from '../server/finished-export-plan.mjs';
import {prepareEhAnimation} from '../server/finished-export-animation.mjs';
import {normalizeWorkTitle,exportWorkTitle,filenamePart} from '../server/work-title.mjs';
function pages(count,ends=[count]) {return Array.from({length:count},(_,index)=>({index,name:String(index+1).padStart(3,'0')+'.jpg',size:1000,media_kind:'image',chapter_id:String(ends.findIndex(end=>end>index)),sequence_id:'seq'}));}
test('Pixiv 静态章节均分，动画不占张数和卷容量，不补封面',()=>{
 const files=pages(272,[6,51,74,140,196,237,272]);
 const result=planPixivExport(files);
 assert.deepEqual(result.volumes.map(v=>v.pages),[140,132]);
 assert.equal(result.files[140].name,'静态投稿/02-141-272/141.jpg');
 const mixed=pages(202);for(let i=0;i<2;i++)mixed[i]={...mixed[i],media_kind:'video',size:15_000_000,name:String(i+1).padStart(3,'0')+'.gif'};
 const separated=planPixivExport(mixed);
 assert.deepEqual(separated.volumes.map(v=>[v.kind,v.pages,v.bytes]),[['static',200,200000],['animations',2,30000000]]);
 assert.equal(separated.files.at(-1).name,'动画GIF/002.gif');
 assert.equal(separated.files[0].index,2);
});
test('单章超张数退到页面边界，保留全局编号；只有动画也可导出',()=>{
 assert.deepEqual(planPixivExport(pages(260)).volumes.map(v=>v.pages),[130,130]);
 const clean=planPixivExport(pages(5).filter(p=>p.index!==2));assert.ok(clean.files[2].name.endsWith('/004.jpg'));
 assert.equal(planPixivExport([{...pages(1)[0],media_kind:'video',name:'001.gif'}]).volumes[0].kind,'animations');
 assert.throws(()=>planPixivExport([{...pages(1)[0],size:15_000_001,media_kind:'video'}]),e=>e.details[0].includes('超限'));
});
test('静态体积限制改变切点，不能靠分卷规避单文件限制',()=>{
 const files=pages(4).map((f,i)=>({...f,size:[8,8,2,2][i]}));
 assert.deepEqual(balancedVolumes(files,[1,2,3,4],2,{maxBytes:12}).map(v=>v.length),[1,3]);
 assert.equal(balancedVolumes(files,[1,2,3,4],1,{maxBytes:19}),null);
 assert.throws(()=>planPixivExport([{...files[0],size:30_000_000}]));
});
test('EH 多包独立根目录，章节优先，预算包含 ZIP 开销，保留混排',()=>{
 const files=pages(6,[3,6]).map((f,i)=>({...f,size:1000,...(i===2?{media_kind:'video',name:'003.webp'}:{})}));
 const result=planEhExport(files,{maxBytes:6000});
 assert.deepEqual(result.parts.map(p=>p.length),[3,3]);
 assert.equal(result.parts[0][2].name,'003.webp');assert.equal(result.parts[1][0].name,'004.jpg');
 assert.deepEqual(result.volumes.map(v=>v.bytes),[3000,3000]);
 assert.throws(()=>planEhExport(pages(2001)),e=>e.details[0].includes('2,000'));
 assert.throws(()=>planEhExport([{...files[0],size:19_000_000}]));
});
test('EH 动画两档降级有界，9.5MB软目标与19MB硬上限分开',async()=>{
 for(const [sizes,expectedCalls,warning,rejected] of [[[9_500_000],1,false,false],[[11_000_000,7_000_000],2,false,false],[[12_000_000,10_000_000],2,true,false],[[21_000_000,19_000_000],2,false,true]]){
   let calls=0;const encode=async(d,e,p)=>({size:sizes[calls++],width:p.max_width,height:800,target:'sample.webp'});
   const work=prepareEhAnimation('',{index:1},new AbortController().signal,encode);
   if(rejected)await assert.rejects(work);else assert.equal(Boolean((await work).warning),warning);
   assert.equal(calls,expectedCalls);
 }
});
test('作品名严格验证、译名回退和安全文件名',()=>{
  const project={title:'开发名',work_title:normalizeWorkTitle({zh:' 中文名称 ',en:"Claret & Roxy's Midnight Desserts",ja:''})};
  assert.equal(exportWorkTitle(project,'en'),"Claret & Roxy's Midnight Desserts");assert.equal(exportWorkTitle(project,'ja'),'中文名称');assert.equal(exportWorkTitle({title:'开发名'},'en'),'开发名');
  assert.throws(()=>normalizeWorkTitle({en:5}));assert.throws(()=>normalizeWorkTitle({fr:'titre'}));assert.throws(()=>normalizeWorkTitle([]));assert.deepEqual(normalizeWorkTitle({zh:' '}),{});
  assert.doesNotMatch(filenamePart('../标题/<>:"\\|?*\n'),/[<>:"/\\|?*\n]/);assert.ok(Buffer.byteLength(filenamePart('长'.repeat(160)))<=160);
});
