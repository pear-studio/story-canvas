import { requestWorkbench } from '../workbench-client.mjs';
import { schema, string, object, invalid } from './contract.mjs';
import { pageKey } from './http-action.mjs';
import { pageEditHelp } from './page-edit-help.mjs';

const section = {type:'string',enum:['content','render','prompt'],description:'本批统一编辑content/render；旧prompt分支返回指引，改用prompt.batch.read/save'};
const items = item => ({type:'array',minItems:1,maxItems:16,items:item});
function unique(rows) {
  if(new Set(rows.map(row=>row.page_key.page_id)).size!==rows.length)throw invalid('同一批页面不能重复');
}
async function executeBatch(args, execution, saving) {
  const rows=saving?args.items:args.page_keys.map(page_key=>({page_key}));
  unique(rows);
  const results=[];
  for(const row of rows) {
    if(execution.signal?.aborted) {results.push({page_key:row.page_key,status:'not_executed'});continue;}
    try {
      const {value}=await requestWorkbench(`/api/agent/page-editor${saving?'/save':''}`,{method:'POST',signal:execution.signal,
        body:{project_id:args.project_id,section:args.section,...row}});
      if(!value?.save || (saving && value.saved!==true))throw Object.assign(new Error('接口未返回完整回执，请重新读取核验'),{code:'invalid_edit_receipt'});
      results.push(saving?{page_key:row.page_key,status:'saved',save:value.save,
        ...(value.audit?{audit:value.audit}:{}),...(value.warnings?{warnings:value.warnings}:{}),
        ...(value.downstream_diagnostics?{downstream_diagnostics:value.downstream_diagnostics}:{})}
        :{page_key:row.page_key,status:'read',...value});
    }catch(error) {
      const uncertain=saving&&(!error.status||error.status>=500||[408,499].includes(error.status));
      results.push({page_key:row.page_key,status:uncertain?'unknown':'failed',error:{code:error.code??'request_failed',message:error.message,details:error.details},
        next:{operation:'page.editor.read',args:{project_id:args.project_id,page_key:row.page_key,section:args.section}}});
      if(uncertain||execution.signal?.aborted) {
        results.push(...rows.slice(results.length).map(r=>({page_key:r.page_key,status:'not_executed'})));break;
      }
    }
  }
  return {results,counts:results.reduce((counts,row)=>(counts[row.status]=(counts[row.status]??0)+1,counts),{}),
    ...(saving?{}:{save:{operation:'page.editor.batch.save',args:{project_id:args.project_id,section:args.section},items_parameter:'items'}})};
}
export const pageBatchActions={
  'page.editor.batch.read':{
    helpTopics:pageEditHelp,
    summary:'读取最多16页的同一文件部分及逐页保存凭据',
    parameters:schema({project_id:string('项目 ID'),section,page_keys:items(pageKey)}),
    details:'每页返回content/render完整document与save.args。Prompt批量编辑已统一为prompt.batch.read/save，旧section:prompt只给迁移指引。先完成content，再读取有关Prompt，避免指纹过期。失败页单独处理。',
    execute:(args,execution)=>executeBatch(args,execution,false),
  },
  'page.editor.batch.save':{
    helpTopics:pageEditHelp,
    summary:'带逐页指纹批量修改，返回简短逐页回执',
    parameters:schema({project_id:string('项目 ID'),section,items:items(schema({page_key:pageKey,expected_sha256:string('该页 read 返回的指纹'),expected_reference_sha256:string('content 读取回执原样保留；变更 characters 时使用'),changes:object('该页修改；语义同 page.editor.save')},['page_key','expected_sha256','changes']))}),
    details:'每项取读取回执的page_key、expected_sha256、expected_reference_sha256（如有），加changes；不可自编指纹。content/render逐页保存：对象合并、数组替换、null删除。Prompt统一用prompt.batch.save。不是整批事务，失败不回滚成功页。冲突继续其他页；网络或服务异常标unknown并停止后续，先核实unknown，不重放整批。回执不重复正文。',
    execute:(args,execution)=>executeBatch(args,execution,true),
  },
};
