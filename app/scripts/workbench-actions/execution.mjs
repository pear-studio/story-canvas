import { endpoint, projectPath, pageKey, encode, projectId } from './http-action.mjs';
import { string, object, boolean, schema } from './contract.mjs';
import { submitGenerationBatch } from './generation-batch.mjs';
import {regeneratePage} from './regenerate-page.mjs';
const gen = (summary, suffix, fields, options={}) => endpoint(summary,'POST',a=>projectPath(a,suffix),fields,{project:true,capability:'generation',...options});
export const executionActions = {
  'generation.run': gen('为一页生成候选图','workbench/render',{page_key:pageKey,count:{type:'integer',minimum:1,maximum:3,description:'候选数量，插画默认3，动态页默认1'},seed:{type:'integer',minimum:0,description:'可选随机种子'},prompt_source:{...string('默认 original；rewrite 使用已有 Qwen 优化稿'),enum:['original','rewrite']}},{required:['page_key'],details:'须已有用户生成授权。提交时冻结独立快照；同页已有任务也可再次提交，后续编辑不改变已提交任务。使用该页模型与画幅，调整用 page.render.read/set。插画默认三张，H3 动态页默认一段，全部保留；多页用 generation.batch。返回任务，task.wait 等待终态，task.inspect 即时查询。超时先查任务，不重复提交。纯字幕或时间过渡用文字页 page.create page_kind:text，finished.output 输出，不生成候选。',body:a=>({page_key:a.page_key,count:a.count,seed:a.seed,prompt_source:a.prompt_source})}),
  'generation.rewrite': gen('运行页面 Prompt 模型重写','workbench/page-rewrite',{page_key:pageKey},{body:a=>({page_key:a.page_key}),details:'调用已配置重写模型；可能耗时。generation.rewrite.read 查看结果，不自动重新运行。'}),
  'generation.refresh': gen('按已扫描的生成条件补齐或重新出图','workbench/story-candidate-refresh',{page_key:pageKey,scope:{...string('范围'),enum:['missing','all']},expected_signature:string('candidate.scan 返回的 signature'),count:{type:'integer',minimum:1,maximum:3,description:'张数'}},{body:a=>({action:'generate',page_key:a.page_key,scope:a.scope,expected_signature:a.expected_signature,count:a.count}),details:'先 candidate.scan，再按授权选择补齐或全部生成；条件变化拒绝。'}),
  'finished.output': gen('从候选制作成品（可能超分）','finished/output',{page_key:pageKey,candidate_id:string('插画页和动态页必填：candidate.list 的候选 ID；文本页省略')},{required:['page_key'],body:a=>({page_key:a.page_key,candidate_id:a.candidate_id}),details:'插画页和动态页必须明确 candidate_id，不自动选择候选；仅文本页可省略。动态页直接输出 MP4，无音频和超分；图片页可能加载超分模型；文本页也由同一生成能力管控。先 finished.list 核对，返回后台任务。'}),
  'finished.output.batch': gen('批量制作章节或项目成品','finished/output-batch',{chapter_id:string('可选章节'),force:boolean('是否重制现有成品，默认false')},{required:[],body:a=>({chapter_id:a.chapter_id,force:a.force}),details:'需要用户明确批量授权；可能加载超分模型，finished.jobs 查看结果。'}),
};
executionActions['finished.output'].recover=(error,args)=>error.code==='invalid_candidate_id'
  ? {message:'本次未创建输出任务。先查询本页候选，明确 candidate_id 后提交。',next:{operation:'candidate.list',args:{project_id:args.project_id,page_key:args.page_key}}}
  : {message:'核查成品任务和记录后处理，不盲目重放输出。',next:{operation:'finished.inspect',args:{project_id:args.project_id,page_key:args.page_key}}};
executionActions['finished.output'].details+=' 输出前保存页面事实；插画生成2倍超分 clean/lettered PNG，文字页直接排版。只改文字时可复用当前无字成品；源候选与无字成品都缺失则不能重制。重新输出替换当前记录及媒体，不维护历史版本；事实或选图变化可能使记录过时，移动顺序不要求重制。';
executionActions['finished.output.batch'].details+=' 仅采用当前唯一候选，零张或多张跳过，不自动选图；文字页直接制作，单页失败不阻断后续，检查逐项回执。';
executionActions['generation.run'].recover=(error,args)=>error.code==='text_page_not_renderable'
  ? {message:'文字页无需候选图。用 page.editor.read（content）编辑正文，lettering.page.read/save 调整布局，finished.output 输出成品。',next:{operation:'page.editor.read',args:{project_id:args.project_id,page_key:args.page_key,section:'content'}}}
  : (!error.status || error.status>=500)
    ? {message:'提交结果不确定，先核查当前队列及历史中的该页任务，不能直接重提。',next:{operation:'task.list',args:{project_id:args.project_id}}}
    : {message:'本次未提交。检查该页生成诊断，修正后再提交。',next:{operation:'generation.page.inspect',args:{project_id:args.project_id,page_key:args.page_key}}};
executionActions['generation.batch']={
  summary:'批量提交多页候选并返回整批等待入口',capability:'generation',
  parameters:schema({...projectId,clear_candidates:boolean('显式清空旧候选并生成；须已有删除授权；默认false'),page_keys:{type:'array',items:pageKey,minItems:1,maxItems:32,description:'明确授权的页面，不可重复，最多32页'},
    ...Object.fromEntries(Object.entries(executionActions['generation.run'].parameters.properties).filter(([key])=>['count','seed','prompt_source'].includes(key)))},['project_id','page_keys']),
  details:'须已有整批生成授权。每页沿用自己的模型与画幅；插画默认3张、动态页默认1段；count/seed/prompt_source 对全批适用。clear_candidates:true 复用单页 regenerate：成功提交该页任务后才清理调用时的旧候选；提交失败保留旧候选，清理失败仍保留任务ID，在 task.batch.read 查看 cleanup，不重放生成。顺序提交，每页最多一次。返回 batch_id、quantity（页数／每页张数／已提交图片总数）、任务计数和简短 wait 入口；一页三张对应一个任务，不因任务数为1再补交；task.wait 只传 batch_id 即可，不抄任务列表、不用 Shell sleep。逐页提交/运行结果用 task.batch.read。部分失败保留已提交任务；断线或回执不明停止后续提交，不重放整批。Saved 中保留派生回执，重启可继续查询。纯文字页不生成候选。极简预设禁用此操作。',
  execute:({clear_candidates=false,...args},execution={})=>submitGenerationBatch(args,{submit:clear_candidates?executionActions['generation.regenerate'].execute:executionActions['generation.run'].execute,recover:executionActions['generation.run'].recover,signal:execution.signal}),
};
executionActions['generation.regenerate']={
  summary:'清空单页旧候选并重新生成，返回精简回执',capability:'generation',
  parameters:executionActions['generation.run'].parameters,
  details:'须已有清空该页全部旧候选及生成的明确授权。参数同 generation.run，默认3张。记录调用时全部候选，成功提交新任务后删除这份旧快照；不删除新任务候选，不选择优胜图。提交失败不清理；提交结果不明先查任务，不能重试。删除不可恢复，清理失败可能已部分删除，但返回的新任务 ID 仍有效，只等待原任务并核验剩余旧候选。只返回清理计数、task_id 和 task.wait 入口。需要 generation 能力，极简预设禁用。',
  recover:executionActions['generation.run'].recover,
  execute:(args,execution={})=>regeneratePage(args,{submit:executionActions['generation.run'].execute,signal:execution.signal}),
};
for (const action of ['start','retry']) executionActions[`comparison.${action}`] = endpoint(`运行对比实验：${action}`,'POST',a=>`/api/comparison-experiments/${encode(a.experiment_id)}/${action}`,{experiment_id:string('已创建实验 ID')},{capability:'generation',details:'需明确授权；先 comparison.inspect 检查预检和状态。会加载生成模型。失败后先查询任务，不能盲目重放。'});

