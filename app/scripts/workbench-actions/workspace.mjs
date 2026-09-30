import { requestWorkbench, projectRoute } from '../workbench-client.mjs';
import { schema, string, object, pagination, paginate, invalid } from './contract.mjs';
import { project } from './navigation.mjs';
import { putProject } from './project-settings.mjs';
import { jsonArtifact } from './http-action.mjs';
import {waitResultImages} from './wait-result-images.mjs';
import { waitForTasks } from './task-wait.mjs';
import {generationQuantity} from './generation-batch.mjs';
import {readOperationRecord} from './operation-records.mjs';
const get = async path => (await requestWorkbench(path)).value;
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
const taskIdentity={...project,task_id:string('任务 ID'),purpose:{...string('默认 candidate；全局 comparison 的 project_id 使用 _'),enum:['candidate','comparison','finished']}};
const taskPath=({project_id,task_id,purpose='candidate'})=>'/api/tasks/'+encodeURIComponent(project_id)+'/'+encodeURIComponent(task_id)+'?purpose='+purpose;
const projectQuery=id=>id?'?project_id='+encodeURIComponent(id):'';
const submissionCounts=record=>record.results.reduce((counts,row)=>(counts[row.status]=(counts[row.status]??0)+1,counts),{total:record.results.length});
async function waitForSelection(args,execution={}) {
  if(Boolean(args.batch_id)===Boolean(args.targets))throw invalid('batch_id 与 targets 必须且只能提供一项');
  const record=args.batch_id?await readOperationRecord('generation',args.batch_id):null;
  if(record && args.until && args.until!=='all_terminal')throw invalid('批次等待只支持 all_terminal');
  const targets=record?.targets??args.targets;
  if(new Set(targets.map(t=>JSON.stringify([t.project_id,t.task_id,t.purpose??'candidate']))).size!==targets.length)throw invalid('targets 不能包含重复任务');
  const result=await waitForTasks({...args,targets,until:record?'all_terminal':args.until},{signal:execution.signal,
    read:async(identity,signal)=>pick(taskSummary((await requestWorkbench(taskPath(identity)+'&view=summary',{signal})).value.task),['status','item_counts','progress','current_page_key','pending_control','error','failures'])});
  const images=await waitResultImages(result,{request:requestWorkbench,signal:execution.signal});
  if(!record)return {...result,...images};
  const problems=result.tasks.filter(t=>t.error || ['failed','cancelled','incomplete'].includes(t.task?.status??t.status));
  return {...images,batch_id:args.batch_id,reason:result.reason,elapsed_ms:result.elapsed_ms,quantity:generationQuantity(record),submission:submissionCounts(record),summary:result.summary,
    all_terminal:result.all_terminal,all_succeeded:result.all_succeeded && record.results.every(r=>r.status==='submitted'),
    ...(problems.length?{problems:problems.slice(0,5),problems_total:problems.length}:{}),
    ...(!result.all_terminal?{wait:{operation:'task.wait',args:{batch_id:args.batch_id}}}:{}),
    inspect:{operation:'task.batch.read',args:{batch_id:args.batch_id}}};
}
function taskSummary(task) {
  return {...pick(task,['id','purpose','status','project_id','project_title','created_at','started_at','completed_at','failed_at','error','progress','item_counts','current_page_key','current_page_title','page_count','pending_control']),
    failures:(task.items??[]).filter(item=>item.status==='failed').slice(0,5).map(item=>pick(item,['id','candidate_id','page_key','status','error']))};
}
async function findLora(id) {
  const list=await get('/api/lora-resources');
  const found=list.resources.find(item=>item.resource.id===id)??list.raw.find(item=>item.id===id);
  if(!found)throw Object.assign(new Error('LoRA 不存在'),{code:'lora_not_found'});
  return found;
}
const resourceId = { resource_id: string('resource.lora.list 返回的 ID') };
async function loras() {
  const list = await get('/api/lora-resources');
  return { errors: list.errors, items: [
    ...list.resources.map(({ resource, status, reason }) => ({ id: resource.id, name: resource.name, registered: true, status, reason, architecture_family: resource.architecture.family, relative_path: resource.file.relative_path })),
    ...list.raw.map(({ id, name, relative_path }) => ({ id, name, relative_path, registered: false, architecture_family: 'unknown' })),
  ] };
}
export const workspaceActions = {
  'resource.lora.list': {
    summary: '搜索已登记 LoRA 和未登记本机权重', parameters: schema({ query: string('可选名称或路径关键字'), ...pagination }, []),
    details: '统一包含训练 checkpoint；返回真实资源 ID，不必遍历磁盘。未登记权重不推断架构、触发词。resource.lora.inspect 查看详情，generation.lora.set 选择。',
    async execute({ query, ...args }) { const list = await loras(); return { errors: list.errors, ...paginate(list.items.filter(item => !query || `${item.name} ${item.relative_path}`.toLowerCase().includes(query.toLowerCase())), args) }; },
  },
  'resource.lora.inspect': {
    summary: '查看 LoRA 文件身份、推荐值和触发词', parameters: schema(resourceId),
    details: '默认仅返回选择 LoRA 所需的身份、架构、可用性、权重和触发词；完整来源与元数据用 resource.lora.details 落盘后按需读取。未登记权重不推断架构和训练设置。',
    example: {resource_id:'lora-example'},
    async execute(args) {
      const found = await findLora(args.resource_id), resource = found.resource;
      if (!resource) return {...pick(found,['id','name','relative_path','sha256','status','reason']),registered:false,architecture_family:'unknown',weight:1,trigger_words:[]};
      return {resource_id:resource.id,registered:true,...pick(resource,['name','name_zh','purpose']),file:resource.file,architecture:resource.architecture,
        ...pick(found,['status','reason','actual_sha256','size_bytes']),weight:resource.recommended_generation?.weight,trigger_words:resource.activation?.trigger_words ?? []};
    },
  },
  'resource.lora.details': {
    summary:'将 LoRA 完整来源与元数据保存为 JSON 文件',parameters:schema(resourceId),
    details:'返回本机 file 路径；按需用 read 的 offset/limit 或 grep 查询，不将完整元数据灌入上下文。通常只需 resource.lora.inspect。',
    execute:async({resource_id})=>jsonArtifact(await findLora(resource_id)),
  },
  'material.list': {
    summary: '分页查看项目参考材料目录', parameters: schema({ ...project, ...pagination }, ['project_id']),
    details: '不返回正文；material.read 单独读取文本和媒体 URL。',
    async execute({ project_id, ...args }) { const value = await get(`${projectRoute(project_id)}/materials`); return paginate(value.materials.map(({ text, ...summary }) => summary), args); },
  },
  'material.read': {
    summary: '读取一项材料的文本或媒体位置', parameters: schema({ ...project, file: string('material.list 的 file') }),
    details: '返回 {value,revision}。大文本或非文本的 text 可能为空；不能把预览缺失当作空文件覆盖。',
    async execute({ project_id, file }) { const { value, revision } = await requestWorkbench(`${projectRoute(project_id)}/materials`); const item = value.materials.find(m => m.file === file); if (!item) throw Object.assign(new Error('材料不存在'), { code: 'material_not_found' }); return { value: item, revision }; },
  },
  'material.save': {
    summary: '保存文本材料或修改材料标题', parameters: schema({ ...project, file: string('materials 内文件名'), title: string('标题'), content: { type: 'string', allowEmpty: true, description: '省略只修改标题；空串写入空文本' }, revision: string('读取时的 revision') }, ['project_id', 'file', 'title', 'revision']),
    details: '用户原文仅在明确要求时修改。以 UTF-8 保存；此工具不搬运二进制图片。新建先 project.settings.read 取得 revision。',
    execute: ({ project_id, revision, ...body }) => putProject(project_id, 'materials/item', body, revision),
  },
  'material.delete': {
    summary: '删除指定参考材料', parameters: schema({ ...project, file: string('材料文件名'), revision: string('读取时的 revision') }),
    details: '仅按用户授权删除；被引用的参考图会拒绝删除，不绕过引用检查。',
    execute: async ({ project_id, file, revision }) => (await requestWorkbench(`${projectRoute(project_id)}/materials/item?file=${encodeURIComponent(file)}`, { method: 'DELETE', revision })).value,
  },
  'agreement.read': {
    summary: '读取项目创作约定', parameters: schema(project), details: '返回 {value,revision}；只修改可写 value 后保存。',
    async execute({ project_id }) { const { value, revision } = await requestWorkbench(`${projectRoute(project_id)}/materials`); return { value: value.agreement, revision }; },
  },
  'agreement.save': {
    summary: '保存完整创作约定', parameters: schema({ ...project, value: object('agreement.read 返回的完整 value'), revision: string('读取时的 revision') }), details: '保持完整文档，不复制只读材料列表。冲突重新读取判断。',
    execute: ({ project_id, value, revision }) => putProject(project_id, 'creative-agreement', value, revision),
  },
  'task.list': {
    summary:'分页查看当前任务摘要，可按项目筛选',parameters:schema({...project,...pagination},[]),
    details:'project_id 省略查全局，指定则只查该项目。默认20条、不夹带历史正文；历史用 task.history，单项用 task.inspect。重排需读取全局列表所有分页，并保留同一 queue_revision；中途变化重新读取。',example:{project_id:'demo'},
    async execute({project_id,...paging}) { const value=await get('/api/tasks'+projectQuery(project_id)); return {...paginate(value.tasks.map(taskSummary),paging),history_count:value.history.length,...(value.queue_revision===undefined?{}:{queue_revision:value.queue_revision})}; },
  },
  'task.history': {
    summary:'分页查看任务历史摘要，可按项目筛选',parameters:schema({...project,before:string('上一页的 next_cursor')},[]),
    details:'project_id 省略查全局；翻页必须保留同一项目筛选。返回 next_cursor，不加载冻结输入。',example:{project_id:'demo'},
    async execute({project_id,before}) {const params=new URLSearchParams();if(project_id)params.set('project_id',project_id);if(before)params.set('before',before);const value=await get('/api/tasks/history'+(params.size?'?'+params:''));return {...value,history:value.history.map(taskSummary)};},
  },
  'task.inspect': {
    summary:'查看单个任务状态、进度和失败摘要',parameters:schema(taskIdentity,['project_id','task_id']),
    details:'所有单任务操作均携带 project_id 和 task_id；全局 comparison 的 project_id 使用 _。purpose 默认 candidate。完整冻结输入与执行信息用 task.details，结果图片用 task.results。最多列5项失败，失败总数见 item_counts。',
    example:{project_id:'demo',task_id:'render-example'},
    execute:async args=>({task:taskSummary((await get(taskPath(args)+'&view=summary')).task)}),
  },
  'task.wait': {
    summary:'等待单项或整批任务终态并核验结果数量',
    parameters:schema({batch_id:string('generation.batch 的批次 ID；与 targets 二选一'),targets:{type:'array',minItems:1,maxItems:32,description:'手动选择任务；最多32项',items:schema({...taskIdentity,after_cursor:string('上次 wait 返回的 cursor；首次可省略')},['project_id','task_id'])},until:{type:'string',enum:['terminal','all_terminal','change'],description:'targets 默认 terminal；batch_id 固定 all_terminal'},wait_ms:{type:'integer',minimum:0,maximum:60000,description:'默认60000毫秒；0只读快照，不能超过60000'}},[]),
    details:'批量生成后直接传 batch_id，不抄任务列表。一次最多等60秒，超时照 wait.args 续等，不用 Shell sleep、不重提生成。终态结果附带本任务图片绝对路径（总计最多12张、最多读取4个任务），用 read_image 查看；更多图片按返回的 task.results 分页入口查询，无需 candidate.list。图片查询失败不改变任务成功状态。批次返回计数和最多5项异常；逐项状态用 task.batch.read。all_terminal 表示任务已结束，all_succeeded 才表示全部提交且成功；失败、取消或未提交不算成功。targets 模式仍支持任一终态或进度变化。停止等待不取消任务；取消须 task.cancel。批次回执保存在 Saved，重启可用，清理 Saved 后按 task.list/history 找原任务。',
    example:{targets:[{project_id:'demo',task_id:'render-example'}],wait_ms:60000},
    execute:waitForSelection,
  },
  'task.batch.read': {
    summary:'分页查看批次各页的提交结果与当前状态',parameters:schema({batch_id:string('生成批次 ID'),...pagination},['batch_id']),
    details:'返回每页 submitted/rejected/unknown/not_submitted；已提交项带 task_id 和即时状态，失败按具体页处理。unknown 必须核查任务后决定，不能重放整批。等待使用 task.wait batch_id；这里只查询一页明细。',
    async execute({batch_id,...paging},execution={}) {
      const record=await readOperationRecord('generation',batch_id),page=paginate(record.results,paging);
      const items=await Promise.all(page.items.map(async row=>{
        if(!row.task_id)return row;
        try{return {...row,task:pick(taskSummary((await requestWorkbench(taskPath({project_id:record.project_id,task_id:row.task_id})+'&view=summary',{signal:execution.signal})).value.task),['status','item_counts','error'])};}
        catch(error){return {...row,read_error:{code:error.code??'task_read_failed',message:error.message}};}
      }));
      return {batch_id,project_id:record.project_id,quantity:generationQuantity(record),submission:submissionCounts(record),...page,items};
    },
  },
  'task.details': {
    summary:'将任务完整冻结输入与执行信息保存为 JSON 文件',parameters:schema(taskIdentity,['project_id','task_id']),
    details:'身份规则同 task.inspect；返回本机 file 路径，使用 read/grep 按需读取。即时查询用 task.inspect，等待用 task.wait。',
    execute:async args=>jsonArtifact(await get(taskPath(args))),
  },
  'runtime.health': {
    summary: '查看工作台与生成环境健康状态', parameters: schema(), details: '只读健康状态；环境操作见 runtime 分类帮助。', execute: () => get('/api/health'),
  },
};


