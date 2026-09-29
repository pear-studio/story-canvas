import { requestWorkbench } from '../workbench-client.mjs';
import { schema, string, object, invalid } from './contract.mjs';
import { pageEditHelp } from './page-edit-help.mjs';

const target = schema({kind:{...string('目标类型'),enum:['page','character','scene']},id:string('页面、角色或场景 ID'),model_id:{...string('anima 或 qwen；页面省略用活动模型，设定必须提供'),enum:['anima','qwen']},scope:{...string('仅角色／场景必填：基础或单个子设定'),enum:['base','variant']},variant_id:string('scope:variant 必填；其他情况省略')},['kind','id']);
const sourceVersions = object('读取回执中的来源版本；新引用先用 prompt.sources 查询，再合并进此对象');
const fields = {project_id:string('项目 ID'),target};
const saveFields = {target,expected_sha256:string('prompt.read 原样返回的范围版本'),source_versions:sourceVersions,changes:object('窄范围的修改；对象递归合并、数组整项替换、null删除键')};
const details = '页面默认读取活动模型的本页 Prompt，target 不填 scope；角色／场景必须明确 model_id、scope:base 或 scope:variant + variant_id。返回 document 和直接可用的 save.args。document 不带 models/$schema 外壳；Anima base 为 {identity}，Qwen base 为 {prompt_name}，variant 为单个子设定对象。只核验本次范围，不展开最终组装全文。';
const saveRules = '使用原读取回执的 save.args 加 changes。对象递归合并；数组完整替换，[]清空；null删除键以恢复继承。不能写入 models/$schema 外壳或其他范围。Anima 本页词条不带 id；共享词改字／排序保留 id，新增省略 id，由服务端生成。数组替换时保留未修改词。相关上游或本范围变化报409，重读判断，不仅换指纹。成功返回更新后的窄 document；诊断与 saved 分开。切换场景、子设定或 standalone→settings 前，用 prompt.sources 读取新来源，再将 source_versions 合入原保存参数；不能替换原 expected_sha256。LoRA新增、删除或替换须经用户同意。';
const helpTopics = Object.fromEntries(Object.entries(pageEditHelp).filter(([key])=>key!=='dialogue'));
const post = async (action,args,execution={}) => (await requestWorkbench(`/api/agent/prompt/${action}`,{method:'POST',body:args,signal:execution.signal})).value;
const recover = (_error,args) => ({message:'重新读取本次作用域并判断冲突；来源版本缺失时先读取明确来源，不能直接替换原范围指纹重放。',next:{operation:'prompt.read',args:{project_id:args.project_id,target:args.target}}});
const items = value => ({type:'array',items:value,minItems:1,maxItems:16});

async function batch(args,execution,saving) {
  const rows = saving ? args.items : args.targets.map(target=>({target}));
  const keys = rows.map(({target})=>[target.kind,target.id,target.model_id ?? '',target.scope ?? '',target.variant_id ?? ''].join(':'));
  if (new Set(keys).size !== rows.length) throw invalid('同一批不能重复同一 Prompt 范围');
  if (rows.some(({target},index)=>target.kind === 'page' && rows.some(({target:other},otherIndex)=>index !== otherIndex && other.kind === 'page' && other.id === target.id && (!target.model_id || !other.model_id)))) throw invalid('同页跨模型批处理必须每项明确 model_id，不能混用活动模型默认值与显式模型');
  const results = [];
  for (const row of rows) {
    if (execution.signal?.aborted) { results.push({target:row.target,status:'not_executed'}); continue; }
    try {
      const value = await post(saving?'save':'read',{project_id:args.project_id,...row},execution);
      if (!value?.save || saving && value.saved !== true) throw Object.assign(new Error('接口没有完整保存回执，请重读核实'),{code:'invalid_edit_receipt'});
      results.push(saving ? {target:value.target,status:'saved',save:value.save,...(value.audit?{audit:value.audit}:{}),...(value.warnings?{warnings:value.warnings}:{}),...(value.downstream_diagnostics?{downstream_diagnostics:value.downstream_diagnostics}:{})} : {status:'read',...value});
    } catch(error) {
      const uncertain = saving && (!error.status || error.status >= 500 || [408,499].includes(error.status));
      results.push({target:row.target,status:uncertain?'unknown':'failed',error:{code:error.code??'request_failed',message:error.message,details:error.details},next:{operation:'prompt.read',args:{project_id:args.project_id,target:row.target}}});
      if (uncertain || execution.signal?.aborted) { results.push(...rows.slice(results.length).map(({target})=>({target,status:'not_executed'}))); break; }
    }
  }
  return {results,counts:results.reduce((counts,row)=>(counts[row.status]=(counts[row.status]??0)+1,counts),{}),...(saving?{}:{save:{operation:'prompt.batch.save',args:{project_id:args.project_id},items_parameter:'items'}})};
}

export const promptActions = {
  'prompt.read':{summary:'读取页面或设定的单模型 Prompt 范围',parameters:schema(fields),details,helpTopics,example:{project_id:'demo',target:{kind:'page',id:'page-001'}},execute:(args,execution)=>post('read',args,execution)},
  'prompt.save':{summary:'修改已读取的 Prompt 范围，保留其余内容',parameters:schema({project_id:fields.project_id,...saveFields},['project_id','target','expected_sha256','changes']),details:saveRules,helpTopics,recover,execute:(args,execution)=>post('save',args,execution)},
  'prompt.sources':{summary:'按需查看继承来源与稳定词条键',parameters:schema({...fields,source:string('省略只列来源；指定 character:<id>:<variant> 或 scene:<id>:<variant> 返回明细，也可读取将要新引用的来源')},['project_id','target']),details:'页面省略 source 只返回当前来源索引；指定来源返回真实文字、稳定key、权重／启用和 source_versions。角色／场景 target 需 scope:variant，只查询自身。页面可查询将要新引用的来源。Anima 页面写 inheritance[source][key]；设定子设定写 identity_overrides[key]，仅能覆盖 identity: 开头的基础词，自身新增词直接改 prompt。不从原词猜key；关闭词也返回，可在下层开启。新来源的 source_versions 合并进最初 prompt.read 的保存参数，保留原范围版本。此操作只读，不返回替换范围版本的保存参数。',helpTopics,execute:(args,execution)=>post('sources',args,execution)},
  'prompt.batch.read':{summary:'读取最多16个 Prompt 范围及逐项保存参数',parameters:schema({project_id:fields.project_id,targets:items(target)}),details:`${details} 批量只返回本次范围；先完成 content 修改，再读取有关 Prompt。失败项单独处理。`,helpTopics,execute:(args,execution)=>batch(args,execution,false)},
  'prompt.batch.save':{summary:'逐项保存 Prompt 范围，返回简短逐项回执',parameters:schema({project_id:fields.project_id,items:items(schema(saveFields,['target','expected_sha256','changes']))}),details:`${saveRules} 最多16项，各自是独立事务；冲突继续其他项，不回滚成功项。网络／服务错误记 unknown 并停止后续，先核实 unknown，不能整批重放。`,helpTopics,execute:(args,execution)=>batch(args,execution,true)},
};
