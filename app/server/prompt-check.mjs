import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {readPageIndex} from './pages-store.mjs';
import {readPromptScope} from './prompt-scope.mjs';
import {ApiError} from './http-support.mjs';

// 每页独立 readFacts，一页错误不隐藏后续页；分页观察不是项目快照或写入凭证。
export async function checkProjectPrompts(projectRoot, input, readFacts) {
  const {project_id:projectId,offset=0,limit=20,model_id:modelId,chapter_id:chapterId,sequence_id:sequenceId}=input;
  if (Object.keys(input).some(key=>!['project_id','offset','limit','model_id','chapter_id','sequence_id'].includes(key))
    || !Number.isInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>50
    || modelId!==undefined && !['anima','qwen'].includes(modelId)
    || [chapterId,sequenceId].some(value=>value!==undefined && (typeof value!=='string'||!value))) throw new ApiError(400,'invalid_prompt_check');
  const listed=await readFacts(projectId,async ({projectDirectory})=>{
    let pages=(await readPageIndex(projectDirectory)).pages;
    if (chapterId || sequenceId) {
      const outline=JSON.parse(await readFile(path.join(projectDirectory,'story/outline.json'),'utf8'));
      if(chapterId && !outline.chapters.some(chapter=>chapter.id===chapterId))throw new ApiError(404,'chapter_not_found');
      const sequences=outline.chapters.filter(chapter=>!chapterId||chapter.id===chapterId).flatMap(chapter=>chapter.sequences);
      if(sequenceId && !sequences.some(sequence=>sequence.id===sequenceId))throw new ApiError(404,'sequence_not_found');
      const selected=new Set(sequences.filter(sequence=>!sequenceId||sequence.id===sequenceId).map(sequence=>sequence.id));
      pages=pages.filter(page=>page.owner_kind==='story'&&selected.has(page.sequence_id));
    }
    return {total:pages.length,pages:pages.slice(offset,offset+limit)};
  });
  const {total,pages}=listed.value,results=[],counts={};
  for (const page of pages) {
    try {
      const {value}=await readFacts(projectId,()=>readPromptScope({projectRoot,projectId,target:{kind:'page',id:page.page_id,...(modelId?{model_id:modelId}:{})}}));
      const diagnostics=value.diagnostics ?? [];
      for(const issue of diagnostics)counts[issue.code]=(counts[issue.code]??0)+1;
      results.push({target:value.target,status:diagnostics.some(issue=>issue.code==='source_missing')?'incomplete':'checked',issue_count:diagnostics.length,
        issue_counts:diagnostics.reduce((counts,issue)=>(counts[issue.code]=(counts[issue.code]??0)+1,counts),{}),
        samples:diagnostics.slice(0,3),...(diagnostics.length?{details:{operation:'prompt.read',args:{project_id:projectId,target:value.target}}}:{})});
    } catch(error) {
      results.push({page_id:page.page_id,status:'failed',error:{code:error.code??'prompt_read_failed',message:error.message}});
    }
  }
  return {scope:{model:modelId??'each_page_active',other_models_checked:false,chapter_id:chapterId,sequence_id:sequenceId},total,offset,
    scanned:results.length,failed:results.filter(row=>row.status==='failed').length,incomplete:results.filter(row=>row.status==='incomplete').length,
    counts,results,next_offset:offset+pages.length<total?offset+pages.length:null,
    usage:'仅本分页观察；counts 不含其他分页，失败或 incomplete 不代表通过。详情 prompt.read；修改必须基于该次读据正文构造，不能给旧数组换新指纹。未绑定和重复是核对线索，不自动删除。'};
}
