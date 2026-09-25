import { endpoint, projectPath, pageKey, encode } from './http-action.mjs';
import { string, object, boolean } from './contract.mjs';
const gen = (summary, suffix, fields, options={}) => endpoint(summary,'POST',a=>projectPath(a,suffix),fields,{project:true,capability:'generation',...options});
export const executionActions = {
  'generation.run': gen('为一页生成候选图','workbench/render',{page_key:pageKey,count:{type:'integer',minimum:1,maximum:3,description:'候选数量，默认3'},seed:{type:'integer',minimum:0,description:'可选随机种子'},prompt_source:{...string('默认 original'),enum:['original','rewritten']}},{required:['page_key'],details:'须已有用户生成授权。默认三张且全部保留；返回任务，task.inspect 查询进度。超时先查任务，不重复提交。',body:a=>({page_key:a.page_key,count:a.count??3,seed:a.seed,prompt_source:a.prompt_source})}),
  'generation.rewrite': gen('运行页面 Prompt 模型重写','workbench/page-rewrite',{page_key:pageKey},{body:a=>({page_key:a.page_key}),details:'调用已配置重写模型；可能耗时。generation.rewrite.read 查看结果，不自动重新运行。'}),
  'generation.refresh': gen('按已扫描的生成条件补齐或重新出图','workbench/story-candidate-refresh',{page_key:pageKey,scope:{...string('范围'),enum:['missing','all']},expected_signature:string('candidate.scan 返回的 signature'),count:{type:'integer',minimum:1,maximum:3,description:'张数'}},{body:a=>({action:'generate',page_key:a.page_key,scope:a.scope,expected_signature:a.expected_signature,count:a.count}),details:'先 candidate.scan，再按授权选择补齐或全部生成；条件变化拒绝。'}),
  'finished.output': gen('从候选制作成品（可能超分）','finished/output',{page_key:pageKey,candidate_id:string('图片页的唯一候选 ID；文本页省略')},{required:['page_key'],body:a=>({page_key:a.page_key,candidate_id:a.candidate_id}),details:'图片页可能加载超分模型；文本页也由同一生成能力管控。先 finished.list 核对，返回后台任务。'}),
  'finished.output.batch': gen('批量制作章节或项目成品','finished/output-batch',{chapter_id:string('可选章节'),force:boolean('是否重制现有成品，默认false')},{required:[],body:a=>({chapter_id:a.chapter_id,force:a.force}),details:'需要用户明确批量授权；可能加载超分模型，finished.jobs 查看结果。'}),
};
for (const action of ['start','retry']) executionActions[`comparison.${action}`] = endpoint(`运行对比实验：${action}`,'POST',a=>`/api/comparison-experiments/${encode(a.experiment_id)}/${action}`,{experiment_id:string('已创建实验 ID')},{capability:'generation',details:'需明确授权；先 comparison.inspect 检查预检和状态。会加载生成模型。失败后先查询任务，不能盲目重放。'});

