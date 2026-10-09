import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {readPageIndex,readPageContent} from './pages-store.mjs';
import {readPageMedia} from './page-media.mjs';
import {ApiError} from './http-support.mjs';

// 来源推荐仅用于导入时；保存后的输入不再跟随页序或候选变化。
export async function readVideoSource(root,projectId,directory,{page_key,source_page_key}) {
  const index=await readPageIndex(directory);
  const target=index.pages.find(p=>p.page_id===page_key?.page_id);
  if(!target)throw new ApiError(404,'page_not_found');
  if((await readPageContent(directory,target.page_id)).page_kind!=='video')throw new ApiError(422,'video_page_required');
  const contents=new Map(await Promise.all(index.pages.map(async p=>[p.page_id,await readPageContent(directory,p.page_id)])));
  const eligible=index.pages.filter(p=>!contents.get(p.page_id).page_kind);
  let source=source_page_key && eligible.find(p=>p.page_id===source_page_key.page_id);
  if(source_page_key&&!source)throw new ApiError(422,'illustration_source_required');
  if(!source_page_key) {
    const outline=JSON.parse(await readFile(path.join(directory,'story/outline.json'),'utf8'));
    const ordered=outline.chapters.flatMap(c=>c.sequences.flatMap(s=>index.pages.filter(p=>p.owner_kind==='story'&&p.sequence_id===s.id)));
    source=ordered.slice(0,ordered.findIndex(p=>p.page_id===target.page_id)).reverse().find(p=>!contents.get(p.page_id).page_kind);
  }
  return {page_key:{page_id:target.page_id},sources:eligible.map(p=>({page_key:{page_id:p.page_id},title:contents.get(p.page_id).title,owner_kind:p.owner_kind})),source_page_key:source?{page_id:source.page_id}:null,
    candidates:source?(await readPageMedia(root,projectId,{page_key:{page_id:source.page_id}})).media.candidates.filter(c=>c.media_kind!=='video'):[],
    import_hint:'用户选择候选后，用 reference.list/save 将其复制到动态页 materials；本查询不会挑选或导入。'};
}
