import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {ensureMediaVariant} from '../server/media-variants.mjs';
import {finishedReaderDocument} from '../shared/finished-reader.mjs';

test('动画 WebP 的缩略缓存保留帧、时长和循环，重复并发读取命中同一文件', async t => {
  const saved=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../Saved/Tests');
  await mkdir(saved,{recursive:true});const directory=await mkdtemp(path.join(saved,'animation-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const pixels=Buffer.alloc(640*480*3*2);
  for(let i=0;i<640*480*2;i++)pixels[i*3+(i<640*480 ? 0 : 2)]=255;
  const bytes=await sharp(pixels,{raw:{width:640,height:960,pageHeight:480,channels:3}}).webp({lossless:true,loop:0,delay:[41,42]}).toBuffer();
  const source=path.join(directory,'source.webp');await writeFile(source,bytes);
  const media={target:source,info:await stat(source)};
  const variants=await Promise.all([1,2,3].map(()=>ensureMediaVariant(directory,media,'Outputs/pages/demo/animation.webp',320)));
  assert.equal(new Set(variants.map(v=>v.target)).size,1);
  const meta=await sharp(await readFile(variants[0].target),{animated:true}).metadata();
  assert.equal(meta.width,320);assert.equal(meta.pageHeight,240);assert.equal(meta.pages,2);assert.equal(meta.loop,0);assert.deepEqual(meta.delay,[41,42]);
  assert.equal((await readdir(path.join(directory,'Saved/media-cache'))).length,1);
  const cached=await ensureMediaVariant(directory,media,'Outputs/pages/demo/animation.webp',320);
  assert.equal(cached.info.mtimeMs,variants[0].info.mtimeMs,'命中缓存不重写');
});

test('工作台混排阅读先载入 WebP，MP4 只在查看原图时加载', () => {
  const html=finishedReaderDocument([{src:'/cover.png?w=1024',number:1,width:768,height:1024},{src:'/clip.mp4?w=1024',original_src:'/clip.mp4',number:2,width:576,height:768,media_kind:'video'}]);
  assert.match(html,/<img loading="lazy" src="\/clip.mp4\?w=1024"/);
  assert.match(html,/<video hidden controls muted loop playsinline preload="none"/);
  assert.match(html,/data-original="\/clip.mp4">查看原图/);
  assert.doesNotMatch(html,/<video[^>]+src=/);
  assert.ok(html.indexOf('/cover.png')<html.indexOf('/clip.mp4'));
});
