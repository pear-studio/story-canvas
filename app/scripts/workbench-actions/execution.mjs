import { endpoint, projectPath, pageKey, encode, projectId } from './http-action.mjs';
import { string, object, boolean, schema } from './contract.mjs';
import { submitGenerationBatch } from './generation-batch.mjs';
import {regeneratePage} from './regenerate-page.mjs';
const gen = (summary, suffix, fields, options={}) => endpoint(summary,'POST',a=>projectPath(a,suffix),fields,{project:true,capability:'generation',...options});
export const executionActions = {
  'candidate.iterate': gen('用 Qwen 迭代指定静态候选','workbench/candidate-iterate',{
    page_key:pageKey,candidate_id:string('候选 ID；普通迭代传来源图，重新迭代传已迭代结果'),instruction:{...string('本次修改要求，原样记录；不继承页面 Prompt 或上一轮指令'),minLength:1,maxLength:8000},
    use_project_loras:boolean('默认true，使用项目Qwen配置中的风格LoRA；false仅本次停用，不改项目设置'),
    reiterate:boolean('默认false；true为重新迭代，candidate_id传已迭代结果，使用它上次的直接来源图；instruction仍须显式提供'),
    count:{type:'integer',minimum:1,maximum:3,description:'数量，默认1'},seed:{type:'integer',minimum:0,maximum:2147483647,description:'可选起始种子，全部候选须在有效范围内'},
  },{required:['page_key','candidate_id','instruction'],body:a=>({page_key:a.page_key,candidate_id:a.candidate_id,instruction:a.instruction,count:a.count,seed:a.seed,use_project_loras:a.use_project_loras,reiterate:a.reiterate}),details:'须有用户修图生成授权。Anima/Qwen 插画页均可用；使用指定候选、本次指令和项目 Qwen-Image-2.1 配置，默认加载其中的风格 LoRA 并自动前置去重后的触发词；use_project_loras:false 仅本次停用。不会带入页面/角色的 LoRA、项目 Prompt 或历史指令，不改页面事实。版本和权重在项目生成设置管理，提交时冻结，后续配置变化不影响已提交任务。保持来源尺寸（对齐32像素），默认1张。输入图片和指令随任务冻结，后续修改/删除来源不改变已排队任务。结果发布到原页面，记录直接来源。task.wait 等待同一任务，candidate.inspect 查看指令与来源；提交结果不明先 task.list，不能直接重提。迭代及其现存来源链不参与过期/整批清理，需要删除时明确 candidate.delete。'}),
  'generation.run': gen('为一页生成候选图','workbench/render',{page_key:pageKey,count:{type:'integer',minimum:1,maximum:3,description:'候选数量，插画默认3，动态页默认1'},seed:{type:'integer',minimum:0,description:'可选随机种子'},prompt_source:{...string('默认 original；rewrite 使用已有 Qwen 优化稿'),enum:['original','rewrite']}},{required:['page_key'],details:'须已有用户生成授权。提交时冻结独立快照；同页已有任务也可再次提交，后续编辑不改变已提交任务。使用该页模型与画幅，调整用 page.render.read/set。插画默认三张，H3 动态页默认一段，全部保留；多页用 generation.batch。返回任务，task.wait 等待终态，task.inspect 即时查询。超时先查任务，不重复提交。纯字幕或时间过渡用文字页 page.create page_kind:text，finished.output 输出，不生成候选。',body:a=>({page_key:a.page_key,count:a.count,seed:a.seed,prompt_source:a.prompt_source})}),
  'generation.rewrite': gen('运行页面 Prompt 模型重写','workbench/page-rewrite',{page_key:pageKey},{body:a=>({page_key:a.page_key}),details:'调用已配置重写模型；可能耗时。generation.rewrite.read 查看结果，不自动重新运行。'}),
  'generation.refresh': gen('按已扫描的生成条件补齐或重新出图','workbench/story-candidate-refresh',{page_key:pageKey,scope:{...string('范围'),enum:['missing','all']},expected_signature:string('candidate.scan 返回的 signature'),count:{type:'integer',minimum:1,maximum:3,description:'张数'}},{body:a=>({action:'generate',page_key:a.page_key,scope:a.scope,expected_signature:a.expected_signature,count:a.count}),details:'先 candidate.scan，再按授权选择补齐或全部生成；条件变化拒绝。'}),
  'finished.output': gen('从候选制作成品（可能超分）','finished/output',{locale:{...string('成品语言，默认中文'),enum:['zh','en','ja']},page_key:pageKey,candidate_id:string('插画页和动态页必填：candidate.list 的候选 ID；文本页省略')},{required:['page_key'],body:a=>({locale:a.locale,page_key:a.page_key,candidate_id:a.candidate_id}),details:'插画页和动态页必须明确 candidate_id，不自动选择候选；仅文本页可省略。动态页直接输出 MP4，无音频和超分；图片页可能加载超分模型；文本页也由同一生成能力管控。先 finished.list 核对，返回后台任务。'}),
  'finished.output.batch': gen('批量制作章节或项目成品','finished/output-batch',{locale:{...string('成品语言，默认中文'),enum:['zh','en','ja']},chapter_id:string('可选章节'),force:boolean('是否重制现有成品，默认false')},{required:[],body:a=>({locale:a.locale,chapter_id:a.chapter_id,force:a.force}),details:'需要用户明确批量授权；可能加载超分模型，finished.jobs 查看结果。'}),
};
executionActions['finished.output'].recover=(error,args)=>error.code==='invalid_candidate_id'
  ? {message:'本次未创建输出任务。先查询本页候选，明确 candidate_id 后提交。',next:{operation:'candidate.list',args:{project_id:args.project_id,page_key:args.page_key}}}
  : {message:'核查成品任务和记录后处理，不盲目重放输出。',next:{operation:'finished.inspect',args:{project_id:args.project_id,page_key:args.page_key}}};
executionActions['finished.output'].details+=' en/ja 输出前用 translation.read/save 保存译文，translation.inspect 检查实际排版；缺译或原文变化阻止输出。固定中文为原文；不 OCR，不擦图，不启动翻译模型。 输出前保存页面事实；插画生成2倍超分 clean/lettered PNG，文字页直接排版。只改文字时可复用当前无字成品；源候选与无字成品都缺失则不能重制。重新输出替换当前记录及媒体，不维护历史版本；事实或选图变化可能使记录过时，移动顺序不要求重制。';
executionActions['finished.output.batch'].details+=' 仅采用当前唯一候选，零张或多张跳过，不自动选图；文字页直接制作，单页失败不阻断后续，检查逐项回执。';
executionActions['generation.run'].recover=(error,args)=>error.code==='text_page_not_renderable'
  ? {message:'文字页无需候选图。用 page.editor.read（content）编辑正文，lettering.page.read/save 调整布局，finished.output 输出成品。',next:{operation:'page.editor.read',args:{project_id:args.project_id,page_key:args.page_key,section:'content'}}}
  : (!error.status || error.status>=500)
    ? {message:'提交结果不确定，先核查当前队列及历史中的该页任务，不能直接重提。',next:{operation:'task.list',args:{project_id:args.project_id}}}
    : {message:'本次未提交。检查该页生成诊断，修正后再提交。',next:{operation:'generation.page.inspect',args:{project_id:args.project_id,page_key:args.page_key}}};
executionActions['candidate.iterate'].recover=(error,args)=>(!error.status || error.status>=500)
  ? {message:'提交结果不确定，先核查队列及历史中的该页任务，不重复提交。',next:{operation:'task.list',args:{project_id:args.project_id}}}
  : {message:'本次未提交。核对来源候选、修改要求及参数后再操作。',next:{operation:'candidate.list',args:{project_id:args.project_id,page_key:args.page_key}}};
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
executionActions['candidate.iterate'].details+=' 重新迭代用 reiterate:true，candidate_id 指向已迭代结果；先 candidate.inspect 读取 generation.prompt.sections 中 kind:page 的原始指令及 seed，修改指令并显式传 seed。服务端使用该结果的直接来源图并核验上次来源 SHA-256，不沿来源链跳到最初原图；来源已删除或变化拒绝提交。LoRA 和其他生成配置使用当前项目 Qwen 设置，结果作为新候选保存。';
