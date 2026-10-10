import assets from './heart-shapes.json' with { type: 'json' };

export const heartColor = '#d52587';
/** 爱心相对项目字号（lettering/settings.json 的 font_size）的倍率。 */
export const heartFontScale = 2;
export function heartFontSize(styleFontSize) {
  return Math.round(Number.isFinite(styleFontSize) && styleFontSize > 0 ? styleFontSize * heartFontScale : 30 * heartFontScale);
}
export function heartDefaults(id, styleFontSize) {
  let seed = 2166136261;
  for (const ch of id) seed = Math.imul(seed ^ ch.codePointAt(0), 16777619);
  return { font_size: heartFontSize(styleFontSize), rotation: -8, seed: seed >>> 0 };
}
export function random(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle(values, rng) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

// 所有形状在 100 单位字号下计算；字号、角度、位置不参与随机抽样。
export function createHeartComposition(text, boxes, seed, decorationText=text) {
  const letters = [...decorationText].filter(ch => /[\p{L}\p{N}]/u.test(ch)).length;
  const count = letters ? letters + 1 + Math.floor(random(seed)() * 2) : 0;
  const rng = random(seed + 32917), leaders = letters > 3 ? 2 : Math.min(1, count);
  const hollow = shuffle(Array.from({ length: count }, (_, i) => i < Math.max(1, Math.round(count * .35))), rng);
  const sizes = shuffle(Array.from({ length: count - leaders }, (_, i) => i < Math.round((count - leaders) * .35) ? [.65, .76] : [.52, .62]), rng);
  const weights = [.6, .25, .15].map(w => w * count), quotas = weights.map(Math.floor);
  const order = [0, 1, 2].sort((a, b) => (weights[b] - quotas[b]) - (weights[a] - quotas[a]));
  for (let i = 0, left = count - quotas.reduce((a, b) => a + b, 0); i < left; i++) quotas[order[i]]++;
  const families = shuffle(['handwritten', 'slender', 'expressive'].flatMap((f, i) => Array(quotas[i]).fill(f)), rng);
  const previous = {};
  const hearts = Array.from({ length: count }, (_, i) => {
    let pool = assets.filter(a => a.family === families[i] && a.empty === hollow[i]);
    if (pool.length > 1) pool = pool.filter(a => a.id !== previous[families[i]]);
    const asset = pool[Math.floor(rng() * pool.length)]; previous[families[i]] = asset.id;
    const [lo, hi] = i < leaders ? [.88, 1.02] : sizes[i - leaders];
    return { scale: lo + rng() * (hi - lo), angle: -28 + rng() * 56, side: rng() < .5 ? 'top' : 'bottom', leader: i < leaders, asset };
  });
  return placeHearts(boxes, hearts, seed);
}

// 旋转排布轴，只移动每个字和装饰的中心，不旋转其轮廓。
export function orientHeartComposition(boxes, hearts, rotation) {
  const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const centers = boxes.map(b => ({ x: (b.l+b.r)/2, y: (b.t+b.b)/2 }));
  let stretch = 1;
  for (let i=1;i<boxes.length;i++) {
    const a=boxes[i-1], b=boxes[i], advance=centers[i].x-centers[i-1].x;
    if (advance <= 0) continue;
    const horizontal=((a.r-a.l+b.r-b.l)/2+2)/Math.max(Math.abs(cos),1e-6);
    const vertical=((a.b-a.t+b.b-b.t)/2+2)/Math.max(Math.abs(sin),1e-6);
    stretch=Math.max(stretch,Math.min(horizontal,vertical)/advance);
  }
  const axisY=centers.length?centers.reduce((sum,p)=>sum+p.y,0)/centers.length:0;
  const turn=(x,y)=>({x:x*stretch*cos-(y-axisY)*sin,y:x*stretch*sin+(y-axisY)*cos+axisY});
  const offsets=centers.map(p=>{const q=turn(p.x,p.y);return {x:q.x-p.x,y:q.y-p.y};});
  const orientedBoxes=boxes.map((b,i)=>({l:b.l+offsets[i].x,r:b.r+offsets[i].x,t:b.t+offsets[i].y,b:b.b+offsets[i].y}));
  const placed=[];
  const valid=(p,r)=>!orientedBoxes.some(b=>Math.hypot(Math.max(b.l-p.x,0,p.x-b.r),Math.max(b.t-p.y,0,p.y-b.b))<r+.5)&&!placed.some(h=>Math.hypot(h.x-p.x,h.y-p.y)<h.r+r+1);
  for(const heart of hearts) {
    const desired=turn(heart.x,heart.y);
    let point=desired;
    if(!valid(point,heart.r)) {
      // 正立字形的边界与旋转后的边界不同，局部避让，优先保留原簇。
      search: for(let radius=3;radius<=300;radius+=3) for(let i=0;i<48;i++) {
        const theta=i*Math.PI/24;
        const candidate={x:desired.x+radius*Math.cos(theta),y:desired.y+radius*Math.sin(theta)};
        if(valid(candidate,heart.r)){point=candidate;break search;}
      }
    }
    placed.push({...heart,...point});
  }
  return {boxes:orientedBoxes,hearts:placed,offsets};
}

export function heartBounds(boxes, hearts) {
  const bounds = { l: 0, t: -80, r: 1, b: 20 };
  for (const b of boxes) { bounds.l = Math.min(bounds.l, b.l); bounds.t = Math.min(bounds.t, b.t); bounds.r = Math.max(bounds.r, b.r); bounds.b = Math.max(bounds.b, b.b); }
  for (const h of hearts) { bounds.l = Math.min(bounds.l, h.x - h.r); bounds.t = Math.min(bounds.t, h.y - h.r); bounds.r = Math.max(bounds.r, h.x + h.r); bounds.b = Math.max(bounds.b, h.y + h.r); }
  return [bounds.l-8,bounds.t-8,bounds.r-bounds.l+16,bounds.b-bounds.t+16];
}

function placeHearts(boxes,source,seed){
 const rng=random(seed+58391);
 if(!source.length)return [];
 const leaders=source.filter(h=>h.leader).length;
 const result=[],anchors=[];
 const companions=Math.min(leaders*4,Math.round((source.length-leaders)*.6));
 const distance=(x,y,b)=>Math.hypot(Math.max(b.l-x,0,x-b.r),Math.max(b.t-y,0,y-b.b));
 for(let i=0;i<source.length;i++){
  const h=source[i],r=28.7*h.scale+1;
  const group=i<leaders?i:(i-leaders)%leaders;
  const clustered=i<leaders+companions;
  const anchor=anchors[group];
  const side=i<leaders?(i%2?'bottom':'top'):(clustered?anchor.side:h.side);
  const targetIndex=leaders===1?Math.floor(boxes.length*.55):Math.round((group===0?.22:.77)*(boxes.length-1));
  const targetX=i<leaders?(boxes[targetIndex].l+boxes[targetIndex].r)/2:anchor.x;
  let best;
  for(let k=0;k<2800;k++){
   const b=boxes[Math.floor(rng()*boxes.length)],gap=1+rng()*5;
   const x=b.l-r+rng()*(b.r-b.l+2*r),rawY=side==='top'?b.t-r-gap:b.b+r+gap;
   const qx=Math.max(b.l,Math.min(b.r,x)),qy=side==='top'?b.t:b.b;
   const dx=x-qx,dy=rawY-qy,d=Math.hypot(dx,dy);
   let px=qx+dx/d*(r+gap),py=qy+dy/d*(r+gap);
   if(clustered&&i>=leaders&&k<2400){
    // 在椭圆内部取点，而不是投到字形边缘的一条等距线上。
    const theta=rng()*Math.PI*2,rho=Math.sqrt(rng());
    px=anchor.x+Math.cos(theta)*rho*58;
    py=anchor.y+(side==='top'?-22:22)+Math.sin(theta)*rho*46;
   }
   if(boxes.some(b=>distance(px,py,b)<r+.5))continue;
   if(result.some(a=>Math.hypot(px-a.x,py-a.y)<r+a.r+1))continue;
   let score=rng()*3;
   if(i<leaders)score-=Math.abs(px-targetX);
   else if(clustered){
    const own=result.filter(a=>a.group===group&&a.clustered);
    const edge=Math.min(...own.map(a=>Math.hypot(px-a.x,py-a.y)-r-a.r));
    const cx=anchor.x,cy=anchor.y+(side==='top'?-22:22);
    const elliptical=Math.hypot((px-cx)/58,(py-cy)/46);
    // 紧凑贴邻，同时优先占用簇的纵深，避免横向串成链。
    score-=edge*.8+elliptical*9;
    score-=own.reduce((sum,a)=>sum+Math.exp(-Math.abs(py-a.y)/12),0)*5;
   }else{
    const nearest=Math.min(...result.map(a=>Math.hypot(px-a.x,py-a.y)-r-a.r));
    score+=Math.min(nearest,65)*.3;
   }
   if(!best||score>best.score)best={...h,x:px,y:py,r,side,group,clustered,score};
  }
  if(!best){
   // 单字等极小字形的同侧候选环可能整圈被已有装饰占据：放宽装饰间距兜底，仍避开字形。
   for(let k=0;k<600&&!best;k++){
    const b=boxes[Math.floor(rng()*boxes.length)],gap=1+rng()*5;
    const x=b.l-r+rng()*(b.r-b.l+2*r),rawY=side==='top'?b.t-r-gap:b.b+r+gap;
    const qx=Math.max(b.l,Math.min(b.r,x)),qy=side==='top'?b.t:b.b;
    const dx=x-qx,dy=rawY-qy,d=Math.hypot(dx,dy);
    const px=qx+dx/d*(r+gap),py=qy+dy/d*(r+gap);
    if(boxes.some(b=>distance(px,py,b)<r+.5))continue;
    best={...h,x:px,y:py,r,side,group,clustered,score:0};
   }
  }
  if(!best)throw Error('聚簇候选不足：'+source.length+' / '+i);
  result.push(best);if(i<leaders)anchors.push(best);
 }
 return result;
}
