import { endpoint, projectPath, pageKey, encode, projectId } from './http-action.mjs';
import { string, object, boolean, schema } from './contract.mjs';
import { submitGenerationBatch } from './generation-batch.mjs';
const gen = (summary, suffix, fields, options={}) => endpoint(summary,'POST',a=>projectPath(a,suffix),fields,{project:true,capability:'generation',...options});
export const executionActions = {
  'generation.run': gen('为一页生成候选图','workbench/render',{page_key:pageKey,count:{type:'integer',minimum:1,maximum:3,description:'候选数量，默认3'},seed:{type:'integer',minimum:0,description:'可选随机种子'},prompt_source:{...string('默认 original'),enum:['original','rewritten']}},{required:['page_key'],details:'须已有用户生成授权。使用该页模型与画幅，调整用 page.render.read/set。默认三张且全部保留；多页用 generation.batch。返回任务，task.wait 等待终态，task.inspect 即时查询。超时先查任务，不重复提交。纯字幕或时间过渡用文字页 page.create page_kind:text，finished.output 输出，不生成候选。',body:a=>({page_key:a.page_key,count:a.count??3,seed:a.seed,prompt_source:a.prompt_source})}),
  'generation.rewrite': gen('运行页面 Prompt 模型重写','workbench/page-rewrite',{page_key:pageKey},{body:a=>({page_key:a.page_key}),details:'调用已配置重写模型；可能耗时。generation.rewrite.read 查看结果，不自动重新运行。'}),
  'generation.refresh': gen('按已扫描的生成条件补齐或重新出图','workbench/story-candidate-refresh',{page_key:pageKey,scope:{...string('范围'),enum:['missing','all']},expected_signature:string('candidate.scan 返回的 signature'),count:{type:'integer',minimum:1,maximum:3,description:'张数'}},{body:a=>({action:'generate',page_key:a.page_key,scope:a.scope,expected_signature:a.expected_signature,count:a.count}),details:'先 candidate.scan，再按授权选择补齐或全部生成；条件变化拒绝。'}),
  'finished.output': gen('从候选制作成品（可能超分）','finished/output',{page_key:pageKey,candidate_id:string('图片页的唯一候选 ID；文本页省略')},{required:['page_key'],body:a=>({page_key:a.page_key,candidate_id:a.candidate_id}),details:'图片页可能加载超分模型；文本页也由同一生成能力管控。先 finished.list 核对，返回后台任务。'}),
  'finished.output.batch': gen('批量制作章节或项目成品','finished/output-batch',{chapter_id:string('可选章节'),force:boolean('是否重制现有成品，默认false')},{required:[],body:a=>({chapter_id:a.chapter_id,force:a.force}),details:'需要用户明确批量授权；可能加载超分模型，finished.jobs 查看结果。'}),
};
executionActions['generation.run'].recover=(error,args)=>error.code==='text_page_not_renderable'
  ? {message:'文字页无需候选图。用 page.editor.read（content）编辑正文，lettering.page.read/save 调整布局，finished.output 输出成品。',next:{operation:'page.editor.read',args:{project_id:args.project_id,page_key:args.page_key,section:'content'}}}
  : (!error.status || error.status>=500)
    ? {message:'提交结果不确定，先核查当前队列及历史中的该页任务，不能直接重提。',next:{operation:'task.list',args:{project_id:args.project_id}}}
    : {message:'本次未提交。检查该页生成诊断，修正后再提交。',next:{operation:'generation.page.inspect',args:{project_id:args.project_id,page_key:args.page_key}}};
executionActions['generation.batch']={
  summary:'批量提交多页候选并返回整批等待入口',capability:'generation',
  parameters:schema({...projectId,page_keys:{type:'array',items:pageKey,minItems:1,maxItems:32,description:'明确授权的页面，不可重复，最多32页'},
    ...Object.fromEntries(Object.entries(executionActions['generation.run'].parameters.properties).filter(([key])=>['count','seed','prompt_source'].includes(key)))},['project_id','page_keys']),
  details:'须已有整批生成授权。每页沿用自己的模型与画幅，默认3张；count/seed/prompt_source 对全批适用。顺序提交，每页最多一次。返回 batch_id、计数和简短 wait 入口；task.wait 只传 batch_id 即可，不抄任务列表、不用 Shell sleep。逐页提交/运行结果用 task.batch.read。部分失败保留已提交任务；断线或回执不明停止后续提交，不重放整批。Saved 中保留派生回执，重启可继续查询。纯文字页不生成候选。极简预设禁用此操作。',
  execute:(args,execution={})=>submitGenerationBatch(args,{submit:executionActions['generation.run'].execute,recover:executionActions['generation.run'].recover,signal:execution.signal}),
};
for (const action of ['start','retry']) executionActions[`comparison.${action}`] = endpoint(`运行对比实验：${action}`,'POST',a=>`/api/comparison-experiments/${encode(a.experiment_id)}/${action}`,{experiment_id:string('已创建实验 ID')},{capability:'generation',details:'需明确授权；先 comparison.inspect 检查预检和状态。会加载生成模型。失败后先查询任务，不能盲目重放。'});

