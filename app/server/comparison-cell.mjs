import {assertComparisonExperimentManifest,resolveComparisonCellSelection} from './comparison-experiment.mjs';
import {assertComparisonInput,comparisonInputRoute,compileComparisonInput} from './comparison-inputs.mjs';
import {buildWorkflow} from './render-task-contract.mjs';

const clone=value=>structuredClone(value);
function fail(code,message){throw Object.assign(new Error(message),{code,status:422,details:[message]});}
function comfyLoraName(relativePath){
  if(typeof relativePath!=='string'||!relativePath.startsWith('loras/'))fail('comparison_execution_lora_path','LoRA 路径必须位于 models_root/loras');
  const name=relativePath.slice(6);
  if(!name||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))fail('comparison_execution_lora_path','LoRA 路径无效');
  return name;
}

function selectedLoras(input,selection){
  let base=clone(input.loras);
  const seen=new Set();
  for(const entry of base){
    if(seen.has(entry.sha256))fail('comparison_duplicate_lora','输入包含重复 SHA 的 LoRA，请先合并为一次挂载');
    seen.add(entry.sha256);
  }
  if(selection.character_lora_weight!==null){
    const targets=base.filter(entry=>entry.kind==='character');
    if(targets.length!==1)fail('comparison_character_lora_weight_target_ambiguous','character_lora_weight 轴要求输入恰好包含一个角色 LoRA');
    base=base.map(entry=>entry===targets[0]?{...entry,weight:selection.character_lora_weight}:entry);
  }
  const application=selection.application;
  let target=null,targetIndex=-1;
  if(application){
    if(application.mode!=='replace_lora')fail('comparison_legacy_requires_reimport','旧版实验只允许使用已有冻结执行计划；请重新导入创建实验');
    const matches=base.flatMap((entry,index)=>entry.sha256===application.target_lora_sha256?[index]:[]);
    if(matches.length!==1)fail('comparison_lora_target_ambiguous','每个输入必须按 SHA 唯一匹配要替换的 LoRA');
    targetIndex=matches[0];target=base[targetIndex];
  }
  const test=selection.test_lora;
  const added=test?{
    kind:target?.kind??'comparison',owner:target?.owner??test.id,source_id:test.id,
    relative_path:test.relative_path,filename:comfyLoraName(test.relative_path),sha256:test.sha256,size_bytes:test.size_bytes,
    weight:selection.test_lora_weight,source_identity:clone(test),
    ...(test.activation?{trigger_words:clone(test.activation.trigger_words)}:{}),
  }:null;
  const remaining=base.filter((_,index)=>index!==targetIndex);
  if(added&&remaining.some(entry=>entry.sha256===added.sha256))fail('comparison_duplicate_lora','测试 LoRA 已在输入中挂载；请选择替换该 SHA，不能重复追加');
  const loras=targetIndex<0?[...base,...(added?[added]:[])]:base.flatMap((entry,index)=>index===targetIndex?(added?[added]:[]):[entry]);
  const triggerPolicy=application?.trigger_policy??'preserve';
  let triggerChange;
  if(triggerPolicy==='replace'){
    if(test&&!Array.isArray(test.activation?.trigger_words))fail('comparison_lora_activation_unknown','测试权重的触发词未知；请选择 preserve 或明确提供 activation.trigger_words');
    triggerChange={target_sha256:target.sha256,words:test?clone(test.activation.trigger_words):[]};
  }
  return {loras,triggerPolicy,triggerChange};
}

// 预览与执行共用：只消费冻结输入，不读取页面、全局配置或模型文件。
export function buildComparisonCell({experimentId,manifest,input,sourceCell}){
  if(manifest.version!==2)fail('comparison_legacy_requires_reimport','旧版实验只允许使用已有冻结执行计划；请重新导入创建实验');
  const selection=resolveComparisonCellSelection(manifest,sourceCell);
  if(selection.input_id!==input.id)fail('comparison_input_mismatch','cell 与输入身份不一致');
  const route=comparisonInputRoute(input),profile=input.render.profile,definition=input.render.workflows[route.workflow];
  const cfg=selection.cfg??route.recipe.cfg;
  const {loras,triggerPolicy,triggerChange}=selectedLoras(input,selection);
  if(loras.length&&!definition.manifest.modifiers.includes('lora.model_only'))fail('comparison_lora_unsupported',`${definition.id} 不支持 LoRA`);
  const compiled=compileComparisonInput(input,{loras,recipe:{...clone(route.recipe),cfg},trigger_policy:triggerPolicy,...(triggerChange?{trigger_change:triggerChange}:{})});
  const item={id:`comparison.${sourceCell.id}`,task:`comparison-${experimentId}`,input_id:input.id,
    output_prefix:`StoryCanvas/comparisons/${experimentId}/${sourceCell.id}`,seed:sourceCell.effective_seed,
    positive_prompt:compiled.positive,negative_prompt:compiled.negative,prompt_parts:compiled.parts,
    loras:clone(loras),reference_images:clone(input.reference_images??[])};
  const workflow=buildWorkflow(definition,profile,compiled.recipe,item);
  const match=/^(\d+)\.inputs\.filename_prefix$/.exec(definition.manifest.bindings.filename_prefix??'');
  if(!match)fail('comparison_execution_workflow_changed',`${definition.id} 缺少可冻结的输出节点绑定`);
  const output={node_id:match[1],image_index:0,cell_id:sourceCell.id,relative_path:`results/${sourceCell.id}/image.png`};
  const unit={id:sourceCell.id,ordinal:sourceCell.ordinal,axis_values:clone(sourceCell.axis_values),input_id:input.id,
    seed:sourceCell.effective_seed,cfg,prompt:{positive:compiled.positive,negative:compiled.negative,parts:clone(compiled.parts)},loras,
    reference_images:clone(input.reference_images??[]),workflow:{source_id:definition.id,api:workflow},
    extra_data:{extra_pnginfo:{storyvisualizer:{version:1,kind:'comparison',experiment_id:experimentId,cell_id:sourceCell.id,
      ordinal:sourceCell.ordinal,input_id:input.id,axis_values:clone(sourceCell.axis_values),seed:sourceCell.effective_seed,cfg,outputs:[clone(output)]}}},outputs:[output]};
  return {cell:unit,dimensions:clone(compiled.dimensions)};
}

export function previewComparisonCells({manifest,inputs}){
  const verified=assertComparisonExperimentManifest(manifest);
  const frozen=inputs.map(input=>assertComparisonInput(input));
  return verified.cells.map(sourceCell=>{
    const selection=resolveComparisonCellSelection(verified,sourceCell),input=frozen.find(value=>value.id===selection.input_id);
    if(!input)fail('comparison_input_missing','cell 缺少对应测试输入');
    const {cell,dimensions}=buildComparisonCell({experimentId:verified.id,manifest:verified,input,sourceCell});
    return {...cell,dimensions};
  });
}
