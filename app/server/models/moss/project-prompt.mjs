import {mossProjectFields} from '../../../shared/moss-prompt.mjs';
import {compileEffectiveRenderProfile} from '../../render-profile-compiler.mjs';

// 只投影项目描述，不做模型文件诊断；不可解析的配置仍允许读取、修正页面。
export async function readMossProjectPrompt({projectRoot,projectDirectory,render,projectId,document}) {
  const profile_id=render.model_id==='moss'?render.profile_id:'moss-image';
  const links={
    inspect:{operation:'generation.inspect',args:{project_id:projectId,profile_id}},
    edit:{operation:'generation.override.read',args:{project_id:projectId}},
    help:{operation:'help',target:'generation.override.save',topic:'moss'},
  };
  try {
    const bundle=await compileEffectiveRenderProfile({repositoryRoot:projectRoot,projectRoot:projectDirectory,profileId:profile_id});
    if(bundle.blocked)return {profile_id,status:'conflict',...links};
    const fields=Object.fromEntries(mossProjectFields.map(key=>{
      const project=bundle.effective_profile.prompt[key]??[],override=key==='avoid'?document.avoid:document.project_overrides?.[key];
      return [key,{project:structuredClone(project),effective:structuredClone(override??project),overridden:override!==undefined}];
    }));
    return {profile_id,status:'ready',fields,...links};
  } catch(error) {
    return {profile_id,status:'unavailable',error:{code:error.code??'project_prompt_unavailable',message:error.message},...links};
  }
}
