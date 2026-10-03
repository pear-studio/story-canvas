import {promptModelEntries} from './model-prompts.mjs';
import {cleanPageCharacterInput} from '../shared/page-character-cleanup.mjs';
import {readPagePromptSources} from './prompt-source-context.mjs';
import {readPageRenderSettings} from './page-render-settings.mjs';
import {compileEffectiveRenderProfile} from './render-profile-compiler.mjs';

// 只清理明确解除引用的角色绑定词；不推断自由文字、人数或显式 LoRA 的归属。
export async function cleanRemovedPageCharacters(prompt, beforeCharacters, afterCharacters, context) {
  const warnings=[];
  const changed=JSON.stringify(beforeCharacters)!==JSON.stringify(afterCharacters);
  for(const [modelId,input] of promptModelEntries(prompt)) {
    let loraScope;
    if (changed && context && Object.keys(input.lora_overrides ?? {}).length) {
      const {root,directory,projectId,pageId}=context;
      try {
        const beforeSources=await readPagePromptSources(directory,{projectId,modelId,narrative:{characters:beforeCharacters},prompt:input});
        const afterSources=await readPagePromptSources(directory,{projectId,modelId,narrative:{characters:afterCharacters},prompt:input});
        const render=await readPageRenderSettings(directory,pageId);
        // 非活动模型没有自己的当前 profile，不凭活动模型的风格列表删除它的共享覆盖。
        const bundle=render.model_id===modelId ? await compileEffectiveRenderProfile({repositoryRoot:root,projectRoot:directory,profileId:render.profile_id}) : null;
        const styleLoras=bundle && !bundle.override_resolution?.conflicts?.length ? Object.values(bundle.effective_profile.style_loras ?? {}) : undefined;
        loraScope={beforeSources,afterSources,styleLoras};
        if (!styleLoras || Object.values({...beforeSources,...afterSources}).some(source=>source.missing)) warnings.push(`模型 ${modelId} 的 LoRA 来源不完整，保留文件名覆盖，需切换该模型后核对。`);
      } catch(error) { warnings.push(`模型 ${modelId} 的 LoRA 覆盖保留待核对：${error.code ?? error.message}`); }
    }
    Object.assign(input,cleanPageCharacterInput(input,beforeCharacters,afterCharacters,loraScope));
  }
  return warnings;
}
