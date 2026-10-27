import {assertComparisonExperimentManifest,resolveComparisonCellSelection} from './comparison-experiment.mjs';
import {assertComparisonInput} from './comparison-inputs.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';

function fail(message){throw Object.assign(new Error(message),{code:'invalid_comparison_preflight_plan',status:422});}

// manifest v1 / preflight v2 的固定只读规则；不调用新版兼容关系或原生输入编译。
export function legacyComparisonPreflight({manifest,inputs}){
  const verified=assertComparisonExperimentManifest(manifest);
  if(verified.version!==1)fail('旧预检必须引用 manifest v1');
  if(!Array.isArray(inputs)||!inputs.length)fail('实验需要测试输入');
  const frozen=inputs.map(input=>assertComparisonInput(input,{legacy:true}));
  const byId=new Map(frozen.map(input=>[input.id,input])),axis=verified.axes.find(axis=>axis.type==='input');
  if(byId.size!==frozen.length||new Set(axis.values.map(value=>value.value)).size!==frozen.length||axis.values.some(value=>!byId.has(value.value)))fail('测试输入必须恰好覆盖 input 轴');
  const cells=verified.cells.map(cell=>{
    const selection=resolveComparisonCellSelection(verified,cell),input=byId.get(selection.input_id),lora=selection.test_lora;
    const profile=input.render.profile,route=profile.operations.candidates.routes[input.reference_images?.length?'reference_image':'empty_latent'];
    const workflow=input.render.workflows[route.workflow];
    if((lora||input.loras.length)&&!workflow.manifest.modifiers.includes('lora.model_only'))fail(`${workflow.id} 不支持 LoRA`);
    if(lora?.kind==='resource'){
      if(lora.architecture.family!==profile.architecture_family)fail('比较 LoRA 与测试输入的模型家族不一致');
      const modelShas=new Set(Object.values(profile.models).map(model=>model.sha256));
      if(lora.base_models.some(model=>model.sha256&&!modelShas.has(model.sha256)))fail('比较 LoRA 的底座模型不一致');
    }
    if(selection.character_lora_weight!==null&&input.loras.filter(lora=>lora.kind==='character').length!==1)fail('角色权重轴要求测试输入恰好包含一个角色 LoRA');
    if(selection.application?.mode==='replace_character'&&!input.loras.some(lora=>lora.kind==='character'&&lora.owner===selection.application.target_character_id))fail('测试输入不包含要替换的角色 LoRA');
    return {id:cell.id,ordinal:cell.ordinal,input_id:input.id,cfg:selection.cfg??route.recipe.cfg};
  });
  const plan={version:2,kind:'comparison_preflight',manifest_id:verified.id,manifest_sha256:verified.canonical_sha256,manifest:verified,inputs:frozen,cells};
  return {...plan,canonical_sha256:hashCanonicalJson(plan)};
}
