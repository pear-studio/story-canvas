import {assertComparisonExperimentManifest} from './comparison-experiment.mjs';
import {assertComparisonInput} from './comparison-inputs.mjs';
import {previewComparisonCells} from './comparison-cell.mjs';
import {checkComparisonLoraCompatibility,assertFrozenComparisonLoraCompatibility} from './comparison-model-compatibility.mjs';
import {legacyComparisonPreflight} from './comparison-preflight-legacy.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';

export const COMPARISON_PREFLIGHT_VERSION=3;
export class ComparisonPreflightError extends Error{
  constructor(code,message,details=[]){super(message);this.code=code;this.details=details;this.status=422;}
}
function fail(message){throw new ComparisonPreflightError('invalid_comparison_preflight_plan',message);}
function identity({canonical_sha256,...value}){return value;}

function compatibilityFor(manifest,inputs,frozenEvidence){
  if(frozenEvidence!==undefined&&!Array.isArray(frozenEvidence))fail('预检兼容证据必须为数组');
  const result=[];
  function add(input,entry,source,index){
    const previous=frozenEvidence?.[result.length];
    if(frozenEvidence!==undefined){
      if(!previous||previous.input_id!==input.id||previous.source!==source||previous.index!==index)fail('预检兼容证据与输入 LoRA 不一致');
      assertFrozenComparisonLoraCompatibility(previous.evidence,entry,input);
    }
    result.push({input_id:input.id,source,index,evidence:previous?structuredClone(previous.evidence):checkComparisonLoraCompatibility(entry,input)});
  }
  for(const input of inputs){
    input.loras.forEach((entry,index)=>add(input,entry,'input',index));
    manifest.registries.loras.forEach((entry,index)=>add(input,entry,'test',index));
  }
  if(frozenEvidence!==undefined&&frozenEvidence.length!==result.length)fail('预检兼容证据数量不一致');
  return result;
}

function createPlan({manifest,inputs},frozenEvidence){
  const verified=assertComparisonExperimentManifest(manifest);
  if(verified.version!==2)throw new ComparisonPreflightError('comparison_legacy_requires_reimport','旧版实验只允许使用已有冻结执行计划；请重新导入创建实验');
  if(!Array.isArray(inputs)||!inputs.length)fail('实验需要测试输入');
  const frozen=inputs.map(input=>assertComparisonInput(input)),byId=new Map(frozen.map(input=>[input.id,input]));
  const axis=verified.axes.find(axis=>axis.type==='input');
  if(byId.size!==frozen.length||new Set(axis.values.map(value=>value.value)).size!==frozen.length||axis.values.some(value=>!byId.has(value.value)))fail('测试输入必须恰好覆盖 input 轴');
  if(new Set(frozen.map(input=>input.render.profile.architecture_family)).size!==1)
    throw new ComparisonPreflightError('comparison_mixed_architecture','一个实验只能包含同一模型家族的输入，请分别建立实验');
  const previews=previewComparisonCells({manifest:verified,inputs:frozen});
  const compatibility=compatibilityFor(verified,frozen,frozenEvidence);
  const cells=previews.map(cell=>({id:cell.id,ordinal:cell.ordinal,input_id:cell.input_id,cfg:cell.cfg,dimensions:cell.dimensions}));
  const plan={version:3,kind:'comparison_preflight',manifest_id:verified.id,manifest_sha256:verified.canonical_sha256,manifest:verified,inputs:frozen,cells,compatibility};
  return {...plan,canonical_sha256:hashCanonicalJson(plan)};
}

export function preflightComparisonExperiment(options={}){return createPlan(options);}
export function assertComparisonPreflightPlan(plan){
  if(![2,3].includes(plan?.version)||plan.kind!=='comparison_preflight')fail('预检版本无效');
  if(plan.version===3&&!Array.isArray(plan.compatibility))fail('预检缺少冻结兼容证据');
  const expected=plan.version===2?legacyComparisonPreflight(plan):createPlan(plan,plan.compatibility);
  if(hashCanonicalJson(identity(plan))!==expected.canonical_sha256||plan.canonical_sha256!==expected.canonical_sha256)fail('预检输入身份不一致');
  return structuredClone(plan);
}
export function validateComparisonPreflightPlan(plan){try{assertComparisonPreflightPlan(plan);return [];}catch(error){return [error.message];}}
export const createComparisonPreflightPlan=preflightComparisonExperiment;
