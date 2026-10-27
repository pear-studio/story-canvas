export function comparisonModelIdentity(input,{family=input.render.profile.architecture_family,sourceSha,sourceSize}={}){
  const model=input.render.profile.models.dit;
  return {architecture_family:family,adapted_components:['dit'],
    base_models:[{kind:'dit',name:'Fixture DiT',identity_status:'exact',relative_path:null,sha256:sourceSha??model.sha256,size_bytes:sourceSize??model.size_bytes,source:null}],
    target_audit:{component:'dit',tensor_count:2,method:'safetensors_tensor_names_v1'},
    declaration:{source:'explicit',status:'declared',note:'Isolated comparison test fixture'}};
}
export function comparisonFrozenLora(input,{id='test-lora',sha='a'.repeat(64),size=1,activation,relativePath=`loras/${id}.safetensors`}={}){
  return {id,kind:'raw',relative_path:relativePath,sha256:sha,size_bytes:size,metadata:{},model_identity:comparisonModelIdentity(input),...(activation===undefined?{}:{activation:{trigger_words:activation,tags:[]}})};
}
