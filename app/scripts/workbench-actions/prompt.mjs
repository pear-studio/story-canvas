import { compactSourcePool } from './prompt-source-pool.mjs';
import { requestWorkbench } from '../workbench-client.mjs';
import { schema, string, object, invalid, pagination } from './contract.mjs';
import { pageEditHelp } from './page-edit-help.mjs';

const target = schema({kind:{...string('目标类型'),enum:['page','character','scene']},id:string('页面、角色或场景 ID'),model_id:{...string('anima 或 qwen；页面省略用活动模型，设定必须提供'),enum:['anima','qwen']},scope:{...string('仅角色／场景必填：基础或单个子设定'),enum:['base','variant']},variant_id:string('scope:variant 必填；其他情况省略')},['kind','id']);
const sourceVersions = object('读取回执中的来源版本；新引用先用 prompt.sources 查询，再合并进此对象');
const fields = {project_id:string('项目 ID'),target};
const saveFields = {target,expected_sha256:string('prompt.read 原样返回的范围版本'),source_versions:sourceVersions,changes:object('窄范围的修改；对象递归合并、数组整项替换、null删除键')};
const details = '页面默认读取活动模型的本页 Prompt，target 不填 scope；角色／场景必须明确 model_id、scope:base 或 scope:variant + variant_id。返回 document 和直接可用的 save.args。document 不带 models/$schema 外壳；Anima base 为 {identity}，Qwen base 为 {prompt_name}，variant 为单个子设定对象。同时返回实际角色引用和继承词；document 仍只含本次可写范围，继承展示不得写回。不展开最终组装全文。';
const saveRules = 'Anima 页面可用 changes.person_groups:[{character_id,entries}] 替换指定角色的本页 person 词；character_id:null 为未绑定组，组内条目不填 character_id，[]清空该组。不能和 person 同传；其他组原顺序不变，新增词放到该组最后原槽位之后，无原槽位则追加末尾。计划必须基于本次读据正文，不给旧数组换新指纹。 使用原读取回执的 save.args 加 changes。对象递归合并；数组完整替换，[]清空；null删除键以恢复继承。不能写入 models/$schema 外壳或其他范围。Anima 本页词条不带 id；共享词改字／排序保留 id，新增省略 id，由服务端生成。数组替换时保留未修改词。相关上游或本范围变化报409，重读判断，不仅换指纹。单项成功返回更新后的窄 document；批量返回 target、expected_sha256、source_versions，不重复回显正文和操作外壳；诊断与 saved 分开。切换场景、子设定或 standalone→settings 前，用 prompt.sources 读取新来源，再将 source_versions 合入原保存参数；不能替换原 expected_sha256。LoRA新增、删除或替换须经用户同意。';
const helpTopics = Object.fromEntries(Object.entries(pageEditHelp).filter(([key])=>key!=='dialogue'));
const post = async (action,args,execution={}) => (await requestWorkbench(`/api/agent/prompt/${action}`,{method:'POST',body:args,signal:execution.signal})).value;
const sourceErrors = new Set(['prompt_source_conflict','prompt_source_read_required']);
const recover = (error,args) => {
  if ([400,422].includes(error.status) && /^(invalid_|prompt_source_requires_|prompt_source_target_)/.test(error.code ?? '')) return {action:'correct_changes',message:'本项未保存；按 details 修正字段后使用原保存参数提交，无需重读。若随后发生版本冲突再重读判断。'};
  const sources=sourceErrors.has(error.code)&&Array.isArray(error.details)?error.details.filter(value=>typeof value==='string'):[];
  if(sources.length) return {message:'读取列出的来源并判断原修改是否仍适用，再合并 source_versions；保留原 expected_sha256，不盲目换版本重放。',
    next:{operation:'prompt.sources',args:{project_id:args.project_id,target:args.target,source:sources[0]}},
    ...(sources.length>1?{also_read:sources.slice(1).map(source=>({operation:'prompt.sources',args:{project_id:args.project_id,target:args.target,source}}))}:{})};
  return {message:'重新读取本次作用域并判断修改，不直接换指纹覆盖。',next:{operation:'prompt.read',args:{project_id:args.project_id,target:args.target}}};
};
const items = value => ({type:'array',items:value,minItems:1,maxItems:16});

async function batch(args,execution,saving) {
  const rows = saving ? args.items : args.targets.map(target=>({target}));
  const keys = rows.map(({target})=>[target.kind,target.id,target.model_id ?? '',target.scope ?? '',target.variant_id ?? ''].join(':'));
  if (new Set(keys).size !== rows.length) throw invalid('同一批不能重复同一 Prompt 范围');
  if (rows.some(({target},index)=>target.kind === 'page' && rows.some(({target:other},otherIndex)=>index !== otherIndex && other.kind === 'page' && other.id === target.id && (!target.model_id || !other.model_id)))) throw invalid('同页跨模型批处理必须每项明确 model_id，不能混用活动模型默认值与显式模型');
  const results = [];
  const recoveries = [];
  const recoveryGroups = new Map();
  for (const row of rows) {
    if (execution.signal?.aborted) { results.push({target:row.target,status:'not_executed'}); continue; }
    try {
      const value = await post(saving?'save':'read',{project_id:args.project_id,...row},execution);
      if (!value?.save || saving && value.saved !== true) throw Object.assign(new Error('接口没有完整保存回执，请重读核实'),{code:'invalid_edit_receipt'});
      results.push(saving ? {target:value.target,status:'saved',save:value.save,...(value.diagnostics?.length?{diagnostics:value.diagnostics}:{}),...(value.audit?{audit:value.audit}:{}),...(value.warnings?{warnings:value.warnings}:{}),...(value.downstream_diagnostics?{downstream_diagnostics:value.downstream_diagnostics}:{})} : {status:'read',...value});
    } catch(error) {
      const uncertain = saving && (!error.status || error.status >= 500 || [408,499].includes(error.status));
      const recovery=recover(error,{project_id:args.project_id,target:row.target});
      const sourceSteps=recovery.next?.operation==='prompt.sources'?[recovery.next,...(recovery.also_read??[])]:[];
      const recoveryIds=sourceSteps.map(next=>{
        // 来源读据包含模型身份；缺少模型和读据时不能假设不同页的活动模型相同。
        const group=JSON.stringify([next.args.source,row.target.model_id??row.source_versions?.[next.args.source]??row.target]);
        let entry=recoveryGroups.get(group);
        if(!entry){entry={id:`recovery-${recoveries.length+1}`,source:next.args.source,message:recovery.message,next,affected_targets:[]};recoveries.push(entry);recoveryGroups.set(group,entry);}
        entry.affected_targets.push(row.target);return entry.id;
      });
      results.push({target:row.target,status:uncertain?'unknown':'failed',error:{code:error.code??'request_failed',message:error.message,...(!recoveryIds.length?{details:error.details}:{})},
        ...(recoveryIds.length?{recovery_ids:recoveryIds}:{recovery,...(recovery.next?{next:recovery.next}:{})})});
      if (uncertain || execution.signal?.aborted) { results.push(...rows.slice(results.length).map(({target})=>({target,status:'not_executed'}))); break; }
    }
  }
  const sourcePool = [], sourceIds = new Map();
  for (const result of results) {
    if (result.save) {
      result.expected_sha256 = result.save.args.expected_sha256;
      if (result.save.args.source_versions) result.source_versions = result.save.args.source_versions;
      delete result.save;
    }
    if (result.inherited_sources) {
      result.inherited_source_refs = result.inherited_sources.map(source=>{
        const key=JSON.stringify([result.target.model_id,source]);
        if (!sourceIds.has(key)) {const id='source-'+(sourcePool.length+1);sourceIds.set(key,id);sourcePool.push({...source,ref:id,model_id:result.target.model_id});}
        return sourceIds.get(key);
      });
      delete result.inherited_sources;
    }
    delete result.read_hint;
    if (result.references) delete result.references.edit;
  }
  return {...(!saving?{read_hint:'document 仅为本页词；references.characters 是实际引用；inherited_source_refs 指向 sources 中已应用本页调整的继承词。含 base_ref 的来源先取该基准展示，再按 key 用自身 entries 完整替换同名条目；未列出的保持基准，最多一层。这是只读展示复用，不是上游默认值，不要复制回 document。角色增删先 page.editor.read(section:content) 再保存 characters；人数和对白不会解除引用。Anima 角色词优先用 person_groups 编辑；bindings 为0起始位置，diagnostics 提供归属和权重证据，不自动删词。'}:{}),...(sourcePool.length?{sources:compactSourcePool(sourcePool)}:{}),results,counts:results.reduce((counts,row)=>(counts[row.status]=(counts[row.status]??0)+1,counts),{}),...(recoveries.length?{recoveries}:{}),save:{operation:'prompt.batch.save',args:{project_id:args.project_id},items_parameter:'items',usage:'逐项取 target、expected_sha256、source_versions，加 changes；不要回传 document/references/继承展示。'}};
}

export const promptActions = {
  'prompt.check':{summary:'分页检查项目 Prompt 的引用、绑定与重复线索',parameters:schema({project_id:fields.project_id,chapter_id:string('限定章节'),sequence_id:string('限定单元'),model_id:{...string('省略逐页活动模型；不检查其他分支'),enum:['anima','qwen']},...pagination},['project_id']),details:'按正式页面索引分页，默认20页最多50页。返回本分页问题计数、每页最多3个样例及详情入口；继续 next_offset 直到 null，失败页和 incomplete 不能当通过。未绑定、相同文字只是核对线索，不自动删词；不同角色或权重不能合并。各页为独立观察，不是全项目快照或保存凭证。修改前 prompt.read，基于该正文生成 changes。',execute:(args,execution)=>post('check',args,execution)},
  'prompt.read':{summary:'读取页面或设定的单模型 Prompt 范围',parameters:schema(fields),details,helpTopics,example:{project_id:'demo',target:{kind:'page',id:'page-001'}},execute:(args,execution)=>post('read',args,execution)},
  'prompt.save':{summary:'修改已读取的 Prompt 范围，保留其余内容',parameters:schema({project_id:fields.project_id,...saveFields},['project_id','target','expected_sha256','changes']),details:saveRules,helpTopics,recover,execute:(args,execution)=>post('save',args,execution)},
  'prompt.sources':{example:{project_id:'demo',target:{kind:'page',id:'page-001'},source:'character:alice:default'},summary:'按需查看继承来源与稳定词条键',parameters:schema({...fields,source:string('省略只列来源；指定 character:<id>:<variant> 或 scene:<id>:<variant> 返回明细，也可读取将要新引用的来源')},['project_id','target']),details:'页面省略 source 只返回当前来源索引；指定来源返回真实文字、稳定key、权重／启用和 source_versions。角色／场景 target 需 scope:variant，只查询自身。页面可查询将要新引用的来源。Anima 页面写 inheritance[source][key]；设定子设定写 identity_overrides[key]，仅能覆盖 identity: 开头的基础词，自身新增词直接改 prompt。不从原词猜key；关闭词也返回，可在下层开启。新来源的 source_versions 合并进最初 prompt.read 的保存参数，保留原范围版本。此操作只读，不返回替换范围版本的保存参数。',helpTopics,execute:(args,execution)=>post('sources',args,execution)},
  'prompt.batch.read':{summary:'读取最多16个 Prompt 范围及逐项保存参数',parameters:schema({project_id:fields.project_id,targets:items(target)}),details:`${details} 批量返回本次范围、角色引用，继承来源在 sources 中去重，各项 inherited_source_refs 引用它；sources 的 base_ref 只复用展示，entries 按 key 替换完整有效条目（包括启用、权重和 consumed），不是删除其余条目；各项指纹加 changes 即可保存。先完成 content 修改，再读取有关 Prompt。失败项单独处理。`,helpTopics,execute:(args,execution)=>batch(args,execution,false)},
  'prompt.batch.save':{summary:'逐项保存 Prompt 范围，返回简短逐项回执',parameters:schema({project_id:fields.project_id,items:items(schema(saveFields,['target','expected_sha256','changes']))}),details:`${saveRules} 最多16项，各自是独立事务；来源冲突按 recovery_ids 查 recoveries 中的 prompt.sources 入口，同源同模型合并读取；范围冲突按 next 重读。冲突继续其他项，不回滚成功项。网络／服务错误记 unknown 并停止后续，先核实 unknown，不能整批重放。`,helpTopics,execute:(args,execution)=>batch(args,execution,true)},
};
