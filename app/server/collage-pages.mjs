import {storyPageNumbers} from '../shared/story-page-numbers.mjs';
import path from 'node:path';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {ApiError} from './http-support.mjs';
import {factConflict} from './fact-conflict.mjs';
import {commitFactChanges} from './fact-commit.mjs';
import {readPageIndex,readPageContent,pageRelativePath} from './pages-store.mjs';
import {readGenerationCandidateRecords,uniqueCandidateSelection} from './candidate-storage.mjs';
import {resolveExistingProjectMedia,resolveProjectMediaTarget} from './render-media.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {validateCollage,visibleCollageItems,collageSourceIds,collageSize,imagePlacement,fullCrop} from '../shared/collage-layout.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(message)=>{throw new ApiError(422,'invalid_collage',[message]);};
async function isSourcePage(directory,entry,content){
  if(entry.parent_page_id||['text','video','comic','collage'].includes(content.page_kind))return false;
  // 分镜母页仍沿用普通 content，通过独立 comic 文档区分。
  return !await stat(path.join(directory,pageRelativePath(entry.page_id,'comic'))).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
}
export async function readCollage(directory,id){
  const file=pageRelativePath(id,'collage');let doc;
  try{doc=JSON.parse(await readFile(path.join(directory,file),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const errors=validateCollage(doc);if(errors.length)fail(errors.join('；'));return doc;
}
export async function collageContext(directory,id){
  if((await readPageContent(directory,id)).page_kind!=='collage')fail('需要组图页');
  const doc=await readCollage(directory,id);if(!doc)fail('组图文档缺失');return {document:doc,sha256:hashCanonicalJson(doc)};
}
// 选择列表和实时预览仅读 result 与图片头；原始像素只在正式合成时读取。
export async function resolveCollagePage(directory,pageId,index){
  const missing=error=>({page_id:pageId,width:1,height:1,error});
  index??=await readPageIndex(directory);
  const entry=index.pages.find(p=>p.page_id===pageId);
  if(!entry)return missing('来源页面已移除');
  const content=await readPageContent(directory,pageId);
  if(!await isSourcePage(directory,entry,content))return missing('需要普通静态图片页');
  const {candidate,reason}=uniqueCandidateSelection(await readGenerationCandidateRecords(directory,{pageKey:{page_id:pageId}}));
  if(reason)return missing(reason);
  if(candidate.media_kind==='video')return missing('需要静态候选图');
  const media=await resolveExistingProjectMedia(directory,candidate.file);
  if(!media)return missing('候选图片缺失');
  const meta=await sharp(media.target).metadata().catch(()=>null);
  if(!meta||(meta.pages??1)>1||!['png','jpeg','webp'].includes(meta.format))return missing('需要静态候选图');
  const rotated=(meta.orientation??1)>=5;
  const info=await stat(media.target);
  return {page_id:pageId,candidate_id:candidate.candidate_id,file:candidate.file,
    width:rotated?meta.height:meta.width,height:rotated?meta.width:meta.height,
    ...(candidate.image_sha256?{image_sha256:candidate.image_sha256}:{}),
    sha256:hashCanonicalJson({file:candidate.file,image_sha256:candidate.image_sha256??null,size:info.size,mtime:info.mtimeMs,ctime:info.ctimeMs})};
}
export async function resolveCollageMedia(directory,document){
  const errors=validateCollage(document);if(errors.length)fail(errors.join('；'));
  const index=await readPageIndex(directory),resolved=new Map();
  const outline=JSON.parse(await readFile(path.join(directory,'story/outline.json'),'utf8'));
  const chapters=outline.chapters.map(c=>({...c,sequences:c.sequences.map(s=>({...s,pages:index.pages.filter(p=>!p.parent_page_id&&p.owner_kind==='story'&&p.sequence_id===s.id)}))}));
  const numbers=storyPageNumbers(chapters),chapterNames=new Map(chapters.flatMap(c=>c.sequences.flatMap(s=>s.pages.map(p=>[p.page_id,c.title]))));
  return Object.fromEntries(await Promise.all(Object.entries(document.assets).map(async([id,asset])=>{
    if(!resolved.has(asset.page_id))resolved.set(asset.page_id,resolveCollagePage(directory,asset.page_id,index));
    const media=await resolved.get(asset.page_id);
    const title=index.pages.some(p=>p.page_id===asset.page_id)?(await readPageContent(directory,asset.page_id)).title:'来源已移除';
    return [id,{...media,label:'#'+(numbers.get(asset.page_id)??'?')+'-'+(chapterNames.get(asset.page_id)??'未归入章节')+'-'+title}];
  })));
}
export function collageMediaFingerprint(document,media){
  const ids=collageSourceIds(document).sort();
  return hashCanonicalJson(Object.fromEntries(ids.map(id=>{const {label,...source}=media[id];return [id,source];})));
}
export async function collageAssetBytes(directory,asset){
  if(asset.error)fail(asset.page_id+'：'+asset.error);
  const media=await resolveExistingProjectMedia(directory,asset.file);if(!media)fail('候选图片缺失');
  const bytes=await readFile(media.target);
  if(asset.image_sha256&&sha(bytes)!==asset.image_sha256)fail('候选图片版本已变化，请重试');
  const meta=await sharp(bytes).metadata(),rotated=(meta.orientation??1)>=5;
  if((rotated?meta.height:meta.width)!==asset.width||(rotated?meta.width:meta.height)!==asset.height)fail('候选图片尺寸已变化，请重试');
  return meta.orientation>1?sharp(bytes).rotate().png().toBuffer():bytes;
}
export async function saveCollage(directory,id,value){
  if((await readPageContent(directory,id)).page_kind!=='collage')fail('需要组图页');
  // 显式保存也用于修复旧格式；只校验新文档，不在读取时隐式改写。
  const previous=JSON.parse(await readFile(path.join(directory,pageRelativePath(id,'collage')),'utf8'));
  const before={document:previous,sha256:hashCanonicalJson(previous)};
  if(value.expected_sha256!==before.sha256)throw factConflict('collage_conflict');
  const doc=structuredClone(value.document),errors=validateCollage(doc);if(errors.length)fail(errors.join('；'));
  // 保存引用和排版，不复制候选。来源暂时未就绪也可保存，预览与输出明确报错。
  const used=new Set([...doc.items.map(i=>i.asset_id),...(doc.background?[doc.background.asset_id]:[])]);
  doc.assets=Object.fromEntries(Object.entries(doc.assets).filter(([key])=>used.has(key)));
  const index=await readPageIndex(directory);
  for(const [key,asset] of Object.entries(doc.assets)){
    if(before.document.assets[key]?.page_id===asset.page_id)continue;
    const entry=index.pages.find(p=>p.page_id===asset.page_id);if(!entry)fail('来源页面不存在');
    const content=await readPageContent(directory,asset.page_id);
    if(!await isSourcePage(directory,entry,content))fail('来源需要普通静态图片页');
  }
  await commitFactChanges(directory,[{relative:pageRelativePath(id,'collage'),before:before.document,after:doc}]);
  return {document:doc,sha256:hashCanonicalJson(doc)};
}
export async function listCollageSources(directory,projectId,value={}){
  const index=await readPageIndex(directory),outline=JSON.parse(await readFile(path.join(directory,'story/outline.json'),'utf8'));
  const sequences=outline.chapters.flatMap(c=>c.sequences.map(s=>({...s,chapter_id:c.id,chapter_title:c.title})));
  const ordered=sequences.flatMap(s=>index.pages.filter(p=>p.owner_kind==='story'&&!p.parent_page_id&&p.sequence_id===s.id).map(p=>({...p,sequence:s})));
  const rows=[];
  for(const p of ordered){if(value.sequence_id&&p.sequence_id!==value.sequence_id||value.chapter_id&&p.sequence.chapter_id!==value.chapter_id)continue;
    const content=await readPageContent(directory,p.page_id);if(!await isSourcePage(directory,p,content)||value.query&&!content.title.toLowerCase().includes(String(value.query).toLowerCase()))continue;
    rows.push({...p,title:content.title});}
  const offset=Number.isInteger(value.offset)?Math.max(0,value.offset):0,limit=48;
  const pages=await Promise.all(rows.slice(offset,offset+limit).map(async p=>({
    page_id:p.page_id,title:p.title,path:p.sequence.chapter_title+' / '+p.sequence.title,
    asset:{page_id:p.page_id},media:await resolveCollagePage(directory,p.page_id,index)
  })));
  return {pages,next:offset+limit<rows.length?offset+limit:null,chapters:outline.chapters.map(c=>({id:c.id,title:c.title,sequences:c.sequences.map(s=>({id:s.id,title:s.title}))}))};
}
export async function captureCollage(directory,document){
  const media=await resolveCollageMedia(directory,document),buffers={};
  const ids=collageSourceIds(document);
  for(const id of ids)buffers[id]=await collageAssetBytes(directory,media[id]);
  return {buffers,media,sha256:collageMediaFingerprint(document,media)};
}
export async function composeCollage(document,{buffers,media},width){
  const size=collageSize(document.canvas,width),layers=[];
  const layer=async(assetId,box,crop,cover=false,opacity=1)=>{
    const asset=media[assetId],g=imagePlacement(asset,box,crop,document.canvas,cover),s=g.source,b=g.box;
    const left=Math.min(size.width-1,Math.round(b.x*size.width)),top=Math.min(size.height-1,Math.round(b.y*size.height)),w=Math.max(1,Math.min(size.width-left,Math.round((b.x+b.w)*size.width)-left)),h=Math.max(1,Math.min(size.height-top,Math.round((b.y+b.h)*size.height)-top));
    const sx=Math.min(asset.width-1,Math.round(s.x*asset.width)),sy=Math.min(asset.height-1,Math.round(s.y*asset.height));
    let image=sharp(buffers[assetId]).extract({left:sx,top:sy,width:Math.max(1,Math.min(asset.width-sx,Math.round(s.w*asset.width))),height:Math.max(1,Math.min(asset.height-sy,Math.round(s.h*asset.height)))}).resize(w,h).ensureAlpha();
    if(opacity!==1){const {data,info}=await image.raw().toBuffer({resolveWithObject:true});for(let i=3;i<data.length;i+=4)data[i]=Math.round(data[i]*opacity);image=sharp(data,{raw:info});}
    layers.push({input:await image.png().toBuffer(),left,top});
  };
  const b=document.background;if(b?.enabled)await layer(b.asset_id,fullCrop(),b.crop,true,b.opacity);
  for(const item of visibleCollageItems(document))await layer(item.asset_id,item.box,item.crop);
  return sharp({create:{...size,channels:3,background:'#000000'}}).composite(layers).png().toBuffer();
}
export async function previewCollage(root,directory,projectId,document){
  const bytes=await composeCollage(document,await captureCollage(directory,document),1024),name=`collage-${randomUUID()}.png`,relative=`Saved/collage-previews/${name}`;
  const target=await resolveProjectMediaTarget(directory,relative,{createParent:true});await writeFile(target.target,bytes,{flag:'wx'});
  return {absolute_file:path.join(directory,relative),url:`/api/projects/${encodeURIComponent(projectId)}/media/${relative}`,...collageSize(document.canvas,1024)};
}

// 给 Agent 同时提供可视素材、真实合成和可编辑坐标；所有图像仅写 Saved。
export async function inspectCollage(root,directory,projectId,value){
  if(Boolean(value.document)===Boolean(value.page_key))fail('提供 page_key 或 document 其中之一');
  const scope=value.document?{document:value.document}:await collageContext(directory,value.page_key.page_id);
  const document=scope.document,media=await resolveCollageMedia(directory,document),size=collageSize(document.canvas);
  const pixels=rect=>({x:Math.round(rect.x*size.width),y:Math.round(rect.y*size.height),w:Math.round(rect.w*size.width),h:Math.round(rect.h*size.height)});
  const layers=[...(document.background?[{id:'background',...document.background,box:fullCrop(),kind:'background'}]:[]),...document.items.map(item=>({...item,kind:'image'}))].map((item,index)=>{
    const source=media[item.asset_id],background=item.kind==='background';
    const placement=source.error?null:imagePlacement(source,item.box,item.crop,document.canvas,background);
    const {page_id,width,height,file,error}=source;
    return {number:index+1,id:item.id,kind:item.kind,asset_id:item.asset_id,enabled:item.enabled,label:source.label,source:{page_id,width,height,...(file?{file}:{}),...(error?{error}:{})},box:item.box,box_pixels:pixels(item.box),visible_box_pixels:placement?pixels(placement.box):null,crop:item.crop,...(background?{opacity:item.opacity}:{})};
  });
  const cellWidth=240,cellHeight=240,columns=Math.min(4,Math.max(1,layers.length)),composites=[];
  for(const [index,item] of layers.entries()){
    const left=index%columns*cellWidth,top=Math.floor(index/columns)*cellHeight;
    if(!item.source.error){
      const source=await resolveExistingProjectMedia(directory,item.source.file);
      if(source){const input=await sharp(source.target).rotate().resize(224,204,{fit:'inside'}).png().toBuffer(),meta=await sharp(input).metadata();composites.push({input,left:left+Math.round((240-meta.width)/2),top:top+8+Math.round((204-meta.height)/2)});}
    }
    const caption=`${item.number}${item.kind==='background'?' BG':''}${item.enabled?'':' OFF'}${item.source.error?' UNAVAILABLE':''}`;
    composites.push({input:Buffer.from(`<svg width="240" height="24"><text x="120" y="18" text-anchor="middle" font-family="sans-serif" font-size="15" fill="white">${caption}</text></svg>`),left,top:top+212});
  }
  const sheet=await sharp({create:{width:columns*cellWidth,height:Math.max(1,Math.ceil(layers.length/columns))*cellHeight,channels:3,background:'#202724'}}).composite(composites).png().toBuffer();
  const relative=`Saved/collage-previews/sources-${randomUUID()}.png`,target=await resolveProjectMediaTarget(directory,relative,{createParent:true});await writeFile(target.target,sheet,{flag:'wx'});
  const issues=collageSourceIds(document).filter(id=>media[id].error).map(id=>({asset_id:id,error:media[id].error}));
  const preview=issues.length?null:await previewCollage(root,directory,projectId,document);
  return {...scope,canvas:{ratio:document.canvas,...size},layers,issues,source_sheet:{absolute_file:path.join(directory,relative),url:`/api/projects/${encodeURIComponent(projectId)}/media/${relative}`},preview};
}
