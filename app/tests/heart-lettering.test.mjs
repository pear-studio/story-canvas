import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeartComposition, heartBounds, orientHeartComposition } from '../shared/heart-lettering.mjs';
import { validatePageLettering } from '../server/lettering-document.mjs';

test('爱心数量按有效字数加一至二，固定种子可复现且不遮挡文字或其他爱心', () => {
  for (const n of [1,2,3,8,16]) for (const seed of [0,703,842,4294967295]) {
    const boxes = Array.from({length:n},(_,i)=>({l:i*100,t:-80,r:i*100+85,b:5}));
    const hearts = createHeartComposition('呜'.repeat(n)+'～！', boxes, seed);
    assert.ok(hearts.length === n+1 || hearts.length === n+2);
    assert.deepEqual(createHeartComposition('呜'.repeat(n)+'～！', boxes, seed), hearts);
    for (const [i,h] of hearts.entries()) {
      assert.ok(h.scale >= .52 && h.scale <= 1.02);
      for (const b of boxes) assert.ok(Math.hypot(Math.max(b.l-h.x,0,h.x-b.r),Math.max(b.t-h.y,0,h.y-b.b)) >= h.r+.49);
      for (const other of hearts.slice(i+1)) assert.ok(Math.hypot(h.x-other.x,h.y-other.y) >= h.r+other.r+.99);
    }
    const oriented = orientHeartComposition(boxes,hearts,90);
    const view = heartBounds(oriented.boxes,oriented.hearts);
    for(const h of oriented.hearts) { assert.ok(h.x-h.r>=view[0] && h.x+h.r<=view[0]+view[2]); assert.ok(h.y-h.r>=view[1] && h.y+h.r<=view[1]+view[3]); }
    for(const [i,b] of oriented.boxes.entries()) { assert.ok(Math.abs((b.r-b.l)-85)<1e-6); assert.ok(Math.abs((b.b-b.t)-85)<1e-6); if(i) assert.ok(b.t>oriented.boxes[i-1].b); }
  }
  assert.deepEqual(createHeartComposition('～！',[],0),[]);
});

test('极小字形找不到无重叠位置时放宽装饰间距兜底，不再抛错', () => {
  // 来自真实崩溃：单字 "a" 的 50×53 字形框 + 种子 1047985024，第 3 颗装饰的同侧候选环被前 2 颗完全占据。
  const boxes = [{ l: -3, r: 47, t: -53, b: 0 }];
  const hearts = createHeartComposition('a', boxes, 1047985024);
  assert.ok(hearts.length >= 2);
  assert.deepEqual(createHeartComposition('a', boxes, 1047985024), hearts);
  for (const h of hearts) {
    for (const b of boxes) assert.ok(Math.hypot(Math.max(b.l-h.x,0,h.x-b.r),Math.max(b.t-h.y,0,h.y-b.b)) >= h.r+.49);
  }
});

test('布局只接受完整且有界的独立爱心参数', () => {
  const layout = {page:'page-001',items:[{dialogue_id:'dialogue-a1b2c3d4e5f6',box:{x:.1,y:.1,w:.3,h:.1},heart:{font_size:64,rotation:-15,seed:703}}]};
  assert.deepEqual(validatePageLettering(layout),[]);
  for(const [key,value] of [['font_size',0],['rotation',181],['seed',-1],['seed',1.5]]) {
    const bad=structuredClone(layout);bad.items[0].heart[key]=value;
    assert.ok(validatePageLettering(bad).some(e=>e.includes('.heart.'+key)));
  }
});
