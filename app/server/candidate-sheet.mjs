import { storyPageNumbers } from '../shared/story-page-numbers.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ApiError } from './http-support.mjs';
import { readPageIndex, readPageContent } from './pages-store.mjs';
import { listProjectRenderTaskStates } from './render-task-storage.mjs';
import { readPageMedia } from './page-media.mjs';

// 事实读取边界内冻结阅读顺序；后续读取媒体和绘图不持有项目锁。
export async function captureCandidateSheet(projectDirectory, input) {
  if ([input.sequence_id,input.chapter_id,input.page_keys].filter(v=>v!==undefined).length!==1) throw new ApiError(400,'invalid_sheet_scope',['sequence_id、chapter_id、page_keys 恰好指定一项']);
  let selected;
  if(input.page_keys!==undefined) {
    if(!Array.isArray(input.page_keys)||!input.page_keys.length||input.page_keys.length>32||input.page_keys.some(p=>!p||typeof p.page_id!=='string'))throw new ApiError(400,'invalid_sheet_pages');
    selected=new Set(input.page_keys.map(p=>p.page_id));
    if(selected.size!==input.page_keys.length)throw new ApiError(400,'duplicate_sheet_page');
  }
  const outline = JSON.parse(await readFile(path.join(projectDirectory, 'story/outline.json'), 'utf8'));
  const sequences = outline.chapters.filter(c => !input.chapter_id || c.id === input.chapter_id)
    .flatMap(c => c.sequences.filter(s => !input.sequence_id || s.id === input.sequence_id).map(s => ({...s, chapter_id:c.id})));
  if (!sequences.length && !(input.chapter_id && outline.chapters.some(c=>c.id===input.chapter_id))) throw new ApiError(404, 'sheet_scope_not_found');
  const index = await readPageIndex(projectDirectory);
  const orderedChapters=outline.chapters.map(c=>({...c,sequences:c.sequences.map(s=>({...s,pages:index.pages.filter(p=>p.owner_kind==='story'&&p.sequence_id===s.id)}))}));
  const numbers=storyPageNumbers(orderedChapters);
  if(selected && [...selected].some(id=>!numbers.has(id)))throw new ApiError(404,'sheet_page_not_found',['page_keys 仅支持正式剧情页；有页面不存在或不属于剧情']);
  const pages = [];
  for (const sequence of sequences) for (const entry of index.pages.filter(p => p.owner_kind === 'story' && p.sequence_id === sequence.id)) {
    if(selected&&!selected.has(entry.page_id))continue;
    const content = await readPageContent(projectDirectory, entry.page_id);
    pages.push({page_number:numbers.get(entry.page_id),page_key:{page_id:entry.page_id}, sequence_id:sequence.id, sequence_title:sequence.title,
      title:content.title ?? '', page_kind:content.page_kind ?? 'illustration',
      ...(content.page_kind === 'text' ? {text:content.body ?? '', display_title:content.display_title ?? ''} : {})});
  }
  return {project_id:input.project_id, scope:selected?{page_keys:pages.map(p=>p.page_key)}:input.sequence_id ? {sequence_id:input.sequence_id} : {chapter_id:input.chapter_id}, captured_at:new Date().toISOString(), pages};
}

export function latestPageTask(states, pageId) {
  return [...new Map(states.map(s => [s.id,s])).values()]
    .filter(s => s.items?.some(i => i.page_key?.page_id === pageId))
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))[0];
}

export function sheetPageCells(page, ordinal, task, candidates) {
  const base = {...page, ordinal};
  if (page.page_kind === 'text') return [{...base,status:'text'}];
  if (!task) return [{...base,status:'not_generated'}];
  const items = task.items.filter(i => i.page_key?.page_id === page.page_key.page_id);
  return items.map((item,index) => {
    const candidate = candidates.find(c => c.task_id === task.id && c.candidate_id === item.candidate_id);
    return {...base,task_id:task.id,task_status:task.status,candidate_id:item.candidate_id,candidate_ordinal:index+1,
      status:candidate ? 'available' : item.status === 'available' ? 'missing' : item.status,
      ...(candidate ? {absolute_file:candidate.absolute_file,generated_at:candidate.generated_at} : {})};
  });
}

const statusText = value => ({available:'已出图',completed:'已完成',queued:'排队中',running:'生成中',failed:'失败',cancelled:'已取消',missing:'图片缺失',image_unavailable:'图片无法读取',not_generated:'未生成',text:'文字页',discarded:'已删除',skipped:'已跳过'}[value] ?? value);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const textImage = (text,width) => sharp({text:{text:escape(String(text).trim() || '（空白文字页）'),font:'Microsoft YaHei 24',width,rgba:true,wrap:'word-char'}}).png().toBuffer();
export async function renderCandidateSheet(cells) {
  const width=480,height=700,columns=Math.min(3,cells.length),layers=[];
  for (const [index,cell] of cells.entries()) {
    const left=index%columns*width,top=Math.floor(index/columns)*height;
    let body;
    if (cell.absolute_file) {
      try { body=await sharp(await readFile(cell.absolute_file)).resize(width-24,height-160,{fit:'contain',background:'#eeeeee'}).png().toBuffer(); }
      catch { cell.status='image_unavailable'; delete cell.absolute_file; }
    }
    if (!body) body=await sharp(await textImage(cell.page_kind==='text' ? `${cell.display_title}\n${cell.text}` : `无画面：${statusText(cell.status)}`,width-40))
      .resize(width-24,height-160,{fit:'contain',background:'#eeeeee',withoutEnlargement:true}).png().toBuffer();
    const label=`${cell.page_number??cell.ordinal}. ${cell.title}\n${cell.page_key.page_id}${cell.candidate_ordinal ? ' / 候选 '+cell.candidate_ordinal : ''}\n${statusText(cell.status)}${cell.task_status ? ' · '+statusText(cell.task_status) : ''}`;
    const caption=await sharp(await textImage(label,width-24)).resize(width-24,130,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
    layers.push({input:caption,left:left+12,top:top+8});
    layers.push({input:body,left:left+12,top:top+148});
  }
  return sharp({create:{width:columns*width,height:Math.ceil(cells.length/columns)*height,channels:3,background:'white'}}).composite(layers).png().toBuffer();
}

export async function exportCandidateSheet(projectRoot, projectDirectory, snapshot) {
  // 严格读取两遍任务身份，遇到归档/新增变化再试一次，不把坏状态当成没有任务。
  let states;
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const first=await listProjectRenderTaskStates(projectDirectory,{scope:'all',strict:true});
      const second=await listProjectRenderTaskStates(projectDirectory,{scope:'all',strict:true});
      const ids=rows=>JSON.stringify([...new Set(rows.map(s=>s.id))].sort());
      if(ids(first)!==ids(second))throw new Error('生成任务集合读取期间发生变化');
      states=second;break;
    } catch(error) { if(attempt===1)throw new ApiError(409,'sheet_tasks_unstable',[error.message]); }
  }
  const cells=[];
  for(const [index,page] of snapshot.pages.entries()) {
    const task=latestPageTask(states,page.page_key.page_id);
    const media=page.page_kind==='text'||!task ? {candidates:[]} : (await readPageMedia(projectRoot,snapshot.project_id,{page_key:page.page_key})).media;
    cells.push(...sheetPageCells(page,index+1,task,media.candidates));
  }
  const folder=path.join(projectRoot,'Saved','Agent','candidate-sheets',randomUUID());
  await mkdir(folder,{recursive:true});
  const sheets=[];
  for(let offset=0;offset<cells.length;offset+=12) {
    const file=path.join(folder,`${sheets.length+1}.png`),part=cells.slice(offset,offset+12);
    await writeFile(file,await renderCandidateSheet(part));
    sheets.push({file,first_page:part[0].page_number??part[0].ordinal,last_page:part.at(-1).page_number??part.at(-1).ordinal});
  }
  const problems=cells.filter(c=>!['available','text'].includes(c.status)||c.task_status&&c.task_status!=='completed');
  const manifest=path.join(folder,'manifest.json');
  await writeFile(manifest,JSON.stringify({...snapshot,cells,sheets},null,2));
  return {captured_at:snapshot.captured_at,pages:snapshot.pages.length,images:cells.filter(c=>c.absolute_file).length,
    sheets,manifest,problem_count:problems.length,problems:problems.slice(0,8).map(({page_key,status,task_status})=>({page_key,status,task_status})),
    read:'按 sheets 顺序用 read_image 读取 file；manifest 保存完整页序和候选身份。此为读取时快照，不自动追踪后续生成。'};
}
