import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { projectActions } from './projects.mjs';
import { pageActions } from './pages.mjs';
import { factActions } from './facts.mjs';
import { promptActions } from './prompt.mjs';
import { structureActions } from './structure.mjs';
import { settingActionsCatalog } from './settings.mjs';
import { projectSettingsActions } from './project-settings.mjs';
import { workspaceActions } from './workspace.mjs';
import { mediaActions } from './media-actions.mjs';
import { translationActions } from './translations.mjs';
import { pageBatchActions } from './page-batch.mjs';
import { dictionaryActions } from './dictionary.mjs';
import { managementActions } from './management.mjs';
import { comparisonActions } from './comparison.mjs';
import { trainingActions } from './training.mjs';
import { executionActions } from './execution.mjs';
import { workbenchRestrictions } from './access-policy.mjs';
import { videoHelp } from './video-help.mjs';
import { invalid, validate, schema, string, object } from './contract.mjs';
const actions = {};
for (const catalog of [projectActions,structureActions,settingActionsCatalog,pageActions,factActions,promptActions,projectSettingsActions,workspaceActions,mediaActions,translationActions,pageBatchActions,dictionaryActions,managementActions,comparisonActions,trainingActions,executionActions]) {
  for (const [name, definition] of Object.entries(catalog)) {
    if (Object.hasOwn(actions,name)) throw new Error(`重复工具操作 ${name}`);
    actions[name]=definition;
  }
}
const utilityHelp = {
  help: {summary:'查询分类、操作及字段主题用法',parameters:schema({target:string('省略查分类；分类 ID 查操作目录；操作名查完整用法'),topic:string('操作帮助中 topics 的主题 ID')},[]),details:'总览不返回操作清单；分类目录只含摘要与必填参数签名；操作详情才含参数、规则和示例。字段细则用 target:操作名 + topic:主题ID 按需读取。直接指定已知操作名可跳过分类。'},
  status: {summary:'工具版本与当前会话能力限制',parameters:schema(),details:'报告已加载/磁盘版本及当前限制；不代表后端版本。reload_required 为 true 时重载 DSH。'},
};
function revision() {
  const hash=createHash('sha256');
  hash.update(readFileSync(new URL('../../shared/prompt-weight-presets.mjs',import.meta.url)));
  for(const file of readdirSync(new URL('./',import.meta.url)).filter(f=>f.endsWith('.mjs')).sort()) hash.update(file).update(readFileSync(new URL(file,import.meta.url)));
  hash.update(readFileSync(new URL('../workbench-client.mjs',import.meta.url)));
  return `v3-${hash.digest('hex').slice(0,12)}`;
}
export const loadedRevision=revision();
export function toolStatus(denied=new Set()) { const diskRevision=revision(); return {loaded_revision:loadedRevision,disk_revision:diskRevision,reload_required:diskRevision!==loadedRevision,disabled_capabilities:[...denied]}; }
export const toolParameters=schema({operation:string('help 查询分类；status 查询当前能力；操作名从分类帮助取得'),target:string('仅 help：分类ID或操作名'),topic:string('仅 help：操作帮助返回的字段主题 ID'),args:object('执行参数，先查该操作 help')},['operation']);
const groups=[
  {id:'project',title:'项目与基本设置',prefixes:['project.']},
  {id:'structure',title:'故事梗概、章节与单元',prefixes:['chapter.','sequence.','story.synopsis.']},
  {id:'settings',title:'角色、场景与子设定',prefixes:['character.','scene.']},
  {id:'page',title:'页面与模板',prefixes:['page.']},
  {id:'facts',title:'正文、Prompt 与语料',prefixes:['facts.','prompt.','corpus.','story.context']},
  {id:'generation',title:'生成配置、LoRA 与出图',prefixes:['generation.']},
  {id:'resources',title:'资源目录与词库',prefixes:['resource.','dictionary.','asset.']},
  {id:'materials',title:'材料、参考图与创作约定',prefixes:['material.','reference.','agreement.','media.']},
  {id:'candidates',title:'候选图查询与清理',prefixes:['candidate.']},
  {id:'finished',title:'译文、文字布局与成品',prefixes:['translation.','lettering.','finished.']},
  {id:'tasks',title:'生成任务与队列',prefixes:['task.']},
  {id:'runtime',title:'本机环境管理',prefixes:['runtime.']},
  {id:'comparison',title:'对比实验',prefixes:['comparison.']},
  {id:'training-data',title:'训练数据集与 Caption',prefixes:['training.dataset.','training.item.','training.asset.','training.caption.','training.audit.']},
  {id:'training-image',title:'训练素材裁剪与处理',prefixes:['training.image.']},
  {id:'training',title:'训练设置、预检与运行',prefixes:['training.task.','training.run.','training.preflight','training.environment','training.recipes','training.activation-guide']},
  {id:'tools',title:'工具帮助与状态',prefixes:['help','status']},
];
const definitions={...actions,...utilityHelp};
function availability(definition,denied) {return definition.capability && denied.has(definition.capability)?'disabled':'enabled';}
function catalog(denied) {return groups.map(({prefixes,...group})=>({...group,operations:Object.entries(definitions).filter(([name])=>prefixes.some(prefix=>name.startsWith(prefix))).map(([operation,definition])=>({operation,summary:definition.summary,signature:`${operation}(${(definition.parameters.required??[]).join(", ")})`,...(availability(definition,denied)==='disabled'?{availability:'disabled',capability:definition.capability}:{})}))}));}
export async function executeWorkbench(input, execution={}) {
  const denied=workbenchRestrictions(execution.agent),operation=input?.operation;
  try {
    validate(toolParameters,input);
    if(operation==='help') {
      if(input.args!==undefined && Object.keys(input.args).length) throw invalid('help 使用 target，不接受非空 args');
      if(input.topic&&!input.target)throw invalid('topic 需要操作名 target');
      const directory=catalog(denied);
      if(!input.target) return {groups:directory.map(({operations,...group})=>({...group,operations_count:operations.length,disabled_count:operations.filter(o=>o.availability==='disabled').length})),workflows:[{target:'video',summary:'动态页导入、编辑、生成与成品的完整用法'}],usage:'help + target分类ID 查看该类操作和必填参数签名；target操作名 查看参数；target:video 一次取得动态页流程与参数。disabled 操作被当前限制插件禁用，请交给具备该能力的 Agent。'};
      if(input.target==='video'){if(input.topic)throw invalid('video 流程不支持 topic');return videoHelp(actions,definition=>availability(definition,denied));}
      const group=directory.find(g=>g.id===input.target);if(group){if(input.topic)throw invalid('topic 需要操作名，不能是分类');return group;}
      const definition=Object.hasOwn(definitions,input.target)?definitions[input.target]:null;
      if(!definition)throw Object.assign(new Error('未知帮助入口，请查分类目录'),{code:'unknown_operation'});
      const {execute,transport,recover,helpTopics,...help}=definition;
      const topics=helpTopics?Object.fromEntries(Object.entries(helpTopics).map(([key,value])=>[key,value.summary])):undefined;
      if(input.topic){
        if(!helpTopics||!Object.hasOwn(helpTopics,input.topic))throw invalid(`未知字段主题；可选：${Object.keys(helpTopics??{}).join(', ')}`);
        return {operation:input.target,topic:input.topic,...helpTopics[input.topic]};
      }
      return {operation:input.target,...help,...(topics?{topics,topic_usage:'help + target:本操作名 + topic:主题ID 查看字段用法'}:{}),availability:availability(definition,denied)};
    }
    if(input.target!==undefined||input.topic!==undefined)throw invalid('target/topic 仅用于 help');
    if(operation==='status'){if(input.args!==undefined)throw invalid('status 不接受 args');return toolStatus(denied);}
    const definition=Object.hasOwn(actions,operation)?actions[operation]:null;
    if(!definition)throw Object.assign(new Error('未知操作，请先查分类帮助'),{code:'unknown_operation'});
    if(availability(definition,denied)==='disabled')throw Object.assign(new Error(`当前限制插件禁用了 ${definition.capability} 能力，不能执行 ${operation}`),{code:'capability_disabled'});
    const args=input.args??{};validate(definition.parameters,args);
    return await definition.execute(args, execution);
  }catch(error){
    const recovery=error.code==='capability_disabled'?'请交给具有该能力的其他 Agent。'
      :error.code==='candidate_file_busy'?'文件移动失败，工具已短时重试。不要空等或重放生成；可继续其他工作，排查权限或文件占用后仅处理失败候选。'
      :error.code==='invalid_arguments'?'按参数定义修正；本次未执行。'
      :actions[operation]?.recover?.(error,input.args??{})
        ??(error.status===409?'重新读取目标并判断冲突，不直接换新指纹覆盖。':'按本操作帮助处理；写入结果不明先核实，不盲目重放。');
    throw new Error(JSON.stringify({error:error.code??'tool_failed',message:error.message,...(error.code==='invalid_arguments'&&actions[operation]?{parameters:actions[operation].parameters,...(actions[operation].example?{example:actions[operation].example}:{})}:{}),...(error.status===undefined?{}:{status:error.status}),...(error.details===undefined?{}:{details:error.details}),help:actions[operation]?{operation:'help',target:operation}:{operation:'help'},recovery}),{cause:error});
  }
}
