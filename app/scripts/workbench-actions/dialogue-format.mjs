import { readFactDraft } from '../workbench-client.mjs';
import { schema, string, array, pagination, paginate, invalid } from './contract.mjs';
import { pageKey } from './http-action.mjs';
import { executePageBatch } from './page-batch.mjs';
import { saveOperationRecord, readOperationRecord } from './operation-records.mjs';

// 只处理已确定的机械格式，保留措辞、ID、顺序、模式、说话人和其他字段。
function unwrapThought(text) {
  const trimmed=text.trim(),pairs={'(':')','（':'）'},stack=[];
  if(!pairs[trimmed[0]])return text;
  for(let i=0;i<trimmed.length;i++) {
    const char=trimmed[i];
    if(pairs[char])stack.push(pairs[char]);
    else if(char===')'||char==='）') {
      if(stack.pop()!==char)return text;
      if(!stack.length&&i!==trimmed.length-1)return text;
    }
  }
  if(stack.length||trimmed.at(-1)!==pairs[trimmed[0]])return text;
  const start=text.indexOf(trimmed);
  return text.slice(0,start)+trimmed.slice(1,-1)+text.slice(start+trimmed.length);
}
export function normalizeDialogue(dialogue=[]) {
  return dialogue.map(entry=>{
    if(entry.mode==='narration')return entry;
    let text=entry.text;
    if(typeof text!=='string')return entry;
    text=text.replace(/。+(\s*)$/u,'$1');
    if(entry.mode==='thought') {
      let previous;
      do {previous=text;text=unwrapThought(text).replace(/。+(\s*)$/u,'$1');} while(text!==previous);
    }
    return text===entry.text?entry:{...entry,text};
  });
}
async function scopeKeys(scope) {
  if(scope.page_keys)return scope.page_keys;
  const draft=await readFactDraft('story','index',scope.project_id);
  return draft.document.pages.map(({page_id})=>({page_id}));
}
async function scan(scope,execution) {
  const keys=await scopeKeys(scope),entries=[],failures=[];
  let unchanged=0,skipped=0;
  for(let start=0;start<keys.length;start+=16) {
    const batch=await executePageBatch({project_id:scope.project_id,section:'content',page_keys:keys.slice(start,start+16)},execution);
    for(const row of batch.results) {
      if(row.status!=='read'){failures.push(row);continue;}
      const before=row.document.dialogue??[],after=normalizeDialogue(before);
      if(!before.length){skipped++;continue;}
      const edits=before.flatMap((entry,index)=>entry.text===after[index].text?[]:[{dialogue_id:entry.id,mode:entry.mode,before:entry.text,after:after[index].text}]);
      if(!edits.length){unchanged++;continue;}
      entries.push({page_key:row.page_key,title:row.document.title,edits,save_args:{...row.save.args,changes:{dialogue:after}}});
    }
  }
  return {scope,entries,failures,counts:{scanned:keys.length,changed:entries.length,unchanged,skipped,failed:failures.length}};
}
const visible = ({save_args,...entry})=>entry;
export const dialogueFormatActions={
  'page.dialogue.format.preview':{
    summary:'全范围扫描文案格式并冻结机械修改计划',
    parameters:schema({project_id:string('项目 ID'),page_keys:array('省略扫描整个页面索引（含设定验证页和分镜内部格）；提供则只扫描指定页',pageKey,256)},['project_id']),
    details:'只读不保存。只去除非旁白末尾中文句号、心理活动外围圆括号；保留省略号、内部标点、原词句、对白 ID 和布局引用。不猜爱心分句或角色语气，不改纯文字页正文。内部每16页读取并保存原始凭据，无需 Agent 抄写。counts 明确扫描、待改、合规、无对白和失败页数。预览首20个待改页，余下用 inspect。已有相应格式清理授权时可执行 apply；Saved 清理后重新预览。',
    async execute(scope,execution={}) {
      if(scope.page_keys&&new Set(scope.page_keys.map(key=>key.page_id)).size!==scope.page_keys.length)throw invalid('页面不能重复');
      if(scope.page_keys&&!scope.page_keys.length)throw invalid('page_keys 不能为空；全项目扫描应省略该字段');
      const plan=await scan(scope,execution),plan_id=await saveOperationRecord('dialogue-format',plan);
      return {plan_id,scope,counts:plan.counts,failures:plan.failures,...paginate(plan.entries.map(visible),{}),
        inspect:{operation:'page.dialogue.format.inspect',args:{plan_id}},apply:{operation:'page.dialogue.format.apply',args:{plan_id}}};
    },
  },
  'page.dialogue.format.inspect':{
    summary:'分页查看已冻结的逐条文案格式差异',
    parameters:schema({plan_id:string('preview 返回的计划 ID'),...pagination},['plan_id']),
    details:'只读取原预览中的差异和计数，不重扫或写入项目。按 next_offset 继续；Saved 清理后重新 preview。',
    async execute({plan_id,...args}) {const plan=await readOperationRecord('dialogue-format',plan_id);return {plan_id,scope:plan.scope,counts:plan.counts,failures:plan.failures,...paginate(plan.entries.map(visible),args)};},
  },
  'page.dialogue.format.apply':{
    summary:'执行格式预览并全范围复查，报告剩余违规',
    parameters:schema({plan_id:string('preview 返回的计划 ID')}),
    details:'须已有所选范围格式清理授权。逐页提交预览时冻结的 save.args，不重新取新凭据覆盖并发修改；保留已保存页。网络或服务异常停止后续写入，unknown 先核验，不重放整批。完成后重扫原范围；complete 仅在保存无失败、复查无遗漏时为true。remaining_pages 是仍有上述机械格式问题的页数，不代表创作文案已审定。失败或剩余问题重新 preview；不用手工重组对白数组。',
    async execute({plan_id},execution={}) {
      const plan=await readOperationRecord('dialogue-format',plan_id);
      const saved=await executePageBatch({project_id:plan.scope.project_id,section:'content',items:plan.entries.map(entry=>entry.save_args)},execution,true);
      let verification;
      try {verification=await scan(plan.scope,execution);}
      catch(error) {return {plan_id,...saved,complete:false,verification:{error:error.code??'verification_failed',message:error.message},recovery:'保存可能已完成，先重新 preview 核验，不重放原计划。'};}
      const counts={...saved.counts,scanned:plan.counts.scanned,unchanged:plan.counts.unchanged,skipped:plan.counts.skipped,
        remaining_pages:verification.entries.length,verification_failed:verification.failures.length,preview_failed:plan.failures.length};
      return {plan_id,counts,results:saved.results,complete:!['failed','unknown','not_executed','remaining_pages','verification_failed','preview_failed'].some(key=>counts[key]>0),
        verification:{scanned:verification.counts.scanned,compliant:verification.counts.unchanged,skipped:verification.counts.skipped},
        remaining:verification.entries.map(visible),verification_failures:verification.failures,
        next:{operation:'page.dialogue.format.preview',args:plan.scope}};
    },
  },
};
