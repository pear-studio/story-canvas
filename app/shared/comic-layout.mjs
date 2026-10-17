// 分格几何由编辑器、生成冻结和成品输出共同使用。
export function comicLeaves(node) {
  return node.page_id ? [node.page_id] : [...comicLeaves(node.first), ...comicLeaves(node.second)];
}
export function validateComicDocument(value, pageId) {
  const errors = [], leaves = [], nodes = new Set();
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));
  if (!exact(value, ['version','canvas','margin','gutter','layout','order','panels']) || value.version !== 1) return ['分镜文档格式无效'];
  if (!['3:4','1:1','4:3','2:3','9:16'].includes(value.canvas)) errors.push('整页画幅无效');
  for (const key of ['margin','gutter']) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 64) errors.push(`${key} 必须为 0–64`);
  function visit(node, depth = 0) {
    if (depth > 12 || !node || typeof node !== 'object') { errors.push('分格层级无效'); return; }
    if (Object.hasOwn(node, 'page_id')) {
      if (!exact(node,['page_id']) || !/^page-(?:\d{3}|[a-f0-9]{12})$/.test(node.page_id)) errors.push('分镜身份无效');
      leaves.push(node.page_id); return;
    }
    if (!exact(node,['id','axis','ratio','first','second']) || !/^split-[a-f0-9]{12}$/.test(node.id) || nodes.has(node.id) || !['x','y'].includes(node.axis) || !Number.isFinite(node.ratio) || node.ratio < .1 || node.ratio > .9) errors.push('分隔线格式无效');
    nodes.add(node.id); visit(node.first,depth+1); visit(node.second,depth+1);
  }
  visit(value.layout);
  if (leaves.length > 12 || new Set(leaves).size !== leaves.length || !leaves.includes(pageId)) errors.push('分镜必须唯一且包含原页面，最多 12 格');
  if (!Array.isArray(value.order) || value.order.length !== leaves.length || new Set(value.order).size !== leaves.length || value.order.some(id => !leaves.includes(id))) errors.push('阅读顺序必须恰好包含各分镜');
  if (!value.panels || typeof value.panels !== 'object' || Array.isArray(value.panels) || Object.keys(value.panels).length !== leaves.length) errors.push('分镜选图设置无效');
  for (const id of leaves) {
    const panel = value.panels?.[id];
    if (!exact(panel,['candidate_id','crop','size_mode']) || ![null,undefined].includes(panel.candidate_id) && !/^candidate-[a-f0-9-]{36}$/.test(panel.candidate_id) || !['panel','preset'].includes(panel?.size_mode)) { errors.push(`分镜设置无效：${id}`); continue; }
    if (!exact(panel.crop,['x','y','zoom']) || !Number.isFinite(panel.crop?.x) || panel.crop.x < 0 || panel.crop.x > 1 || !Number.isFinite(panel.crop?.y) || panel.crop.y < 0 || panel.crop.y > 1 || !Number.isFinite(panel.crop?.zoom) || panel.crop.zoom < 1 || panel.crop.zoom > 4) errors.push(`裁切设置无效：${id}`);
  }
  if(!errors.length){const geometry=comicGeometry(value);if(Object.values(geometry.frames).some(frame=>frame.w*geometry.width<48||frame.h*geometry.height<48))errors.push('分格过小，请调整分隔线后保存');}
  return errors;
}
export function comicGeometry(document) {
  const [cw,ch] = document.canvas.split(':').map(Number), width = 1024, height = width * ch / cw;
  const frames = {}, dividers = [];
  function visit(node, box) {
    if (node.page_id) { frames[node.page_id] = {x:box.x/width,y:box.y/height,w:box.w/width,h:box.h/height}; return; }
    const horizontal = node.axis === 'x', length = horizontal ? box.w : box.h;
    const gap = Math.min(document.gutter,length*.08), first = (length-gap)*node.ratio;
    dividers.push({id:node.id,axis:node.axis,ratio:node.ratio,box:{x:box.x/width,y:box.y/height,w:box.w/width,h:box.h/height},position:(first+gap/2)/length});
    visit(node.first,{...box,...(horizontal?{w:first}:{h:first})});
    visit(node.second,{...box,...(horizontal?{x:box.x+first+gap,w:length-first-gap}:{y:box.y+first+gap,h:length-first-gap})});
  }
  visit(document.layout,{x:document.margin,y:document.margin,w:width-document.margin*2,h:height-document.margin*2});
  return {width,height,frames,dividers};
}
export function updateComicNode(node, id, update) {
  if (node.page_id === id || node.id === id) return update(node);
  return node.page_id ? node : {...node,first:updateComicNode(node.first,id,update),second:updateComicNode(node.second,id,update)};
}
export function comicPanelDimensions(document, pageId) {
  const geometry = comicGeometry(document), frame = geometry.frames[pageId];
  if (!frame) throw new Error('分镜不在布局中');
  const ratio = frame.w*geometry.width/(frame.h*geometry.height);
  const rawWidth=Math.sqrt(1024*1024*ratio),rawHeight=Math.sqrt(1024*1024/ratio),scale=Math.min(1,2048/Math.max(rawWidth,rawHeight));
  const width = Math.max(64,Math.round(rawWidth*scale/32)*32);
  const height = Math.max(64,Math.round(rawHeight*scale/32)*32);
  return {width,height};
}
