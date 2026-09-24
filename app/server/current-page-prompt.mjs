import { profileModelAdapter } from './model-adapters.mjs';

// 公共入口只分派，不解释模型专用输入。
export function compileCurrentPagePrompt(input) {
  return profileModelAdapter(input.profile).compilePrompt(input);
}

// 只读展示和优化输入共用实际传图顺序及用途，不从文件名推测说明。
export function describePromptImages(compiledPage, defaultPurpose = '') {
  return (compiledPage?.images ?? []).map(image => {
    const section = (compiledPage.sections ?? []).find(entry => entry.source === image.source && entry.image_ids?.includes(image.id));
    const purpose = section?.kind === 'character' ? `${section.prompt_name}的身份与服装参考。`
      : section?.kind === 'scene' ? `${section.prompt_name}的环境外观参考。`
      : section?.kind === 'attachment' ? section.text : defaultPurpose;
    return { ...image, purpose };
  });
}
