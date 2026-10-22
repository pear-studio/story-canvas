import test from 'node:test';
import assert from 'node:assert/strict';
import {placeTranslatedHeart} from '../shared/translated-heart-placement.mjs';

test('已容纳的译文位置不变；轻微越界内移且保留边距',()=>{
  const source={x:.7,y:.2,w:.28,h:.1};
  assert.deepEqual(placeTranslatedHeart(source,source),source);
  const result=placeTranslatedHeart({...source,w:.302},source);
  assert.ok(result.x<source.x && result.x+result.w<=.995+1e-9);
  assert.equal(result.w,.302);
});
test('贴右边的中文装饰扩宽后保留右侧锚点',()=>{
  const source={x:.82,y:.2,w:.16,h:.1};
  const result=placeTranslatedHeart({...source,w:.3},source);
  assert.ok(Math.abs(result.x+result.w-.98)<1e-9);
  assert.equal(result.y,.2);
});
test('阻止修正造成新重叠；过宽且超过位移上限的对象仍报告越界',()=>{
  const source={x:.82,y:.2,w:.16,h:.1},box={...source,w:.3};
  assert.deepEqual(placeTranslatedHeart(box,source,[{x:.66,y:.2,w:.15,h:.1}]),box);
  const huge={x:.6,y:.2,w:1.3,h:.1};
  assert.deepEqual(placeTranslatedHeart(huge,{...huge,w:.2}),huge);
});
test('上下边界采用同样规则，不通过裁剪文字消除越界',()=>{
  const source={x:.3,y:.9,w:.2,h:.08};
  const result=placeTranslatedHeart({...source,h:.2},source);
  assert.ok(result.y+result.h<=1);
  assert.equal(result.h,.2);
});
test('带正常页边距的右侧短句也保持右对齐，长译文无需强制缩小',()=>{
  for(const source of [{x:.725,y:.06,w:.2497,h:.13},{x:.708,y:.06,w:.2313,h:.13},{x:.898,y:.698,w:.0669,h:.115}]){
    const box={...source,w:source.w<.1?.1774:.812,h:.12};
    const result=placeTranslatedHeart(box,source);
    assert.ok(Math.abs(result.x+result.w-source.x-source.w)<1e-9);
    assert.equal(result.y,source.y);
    assert.equal(result.w,box.w);
    assert.ok(result.x>=0 && result.x+result.w<=1);
  }
});
test('接近两侧的框按较近的边对齐；普通居中文字不被改成右对齐',()=>{
  const source={x:.03,y:.2,w:.9,h:.1};
  assert.ok(Math.abs(placeTranslatedHeart({...source,w:.98},source).x-.015)<1e-9);
  const central={x:.4,y:.2,w:.2,h:.1};
  const result=placeTranslatedHeart({...central,w:.7},central);
  assert.ok(Math.abs(result.x-.15)<1e-9);
});
