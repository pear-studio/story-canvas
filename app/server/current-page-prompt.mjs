import { profileModelAdapter } from './model-adapters.mjs';

// 公共入口只分派，不解释模型专用输入。
export function compileCurrentPagePrompt(input) {
  return profileModelAdapter(input.profile).compilePrompt(input);
}
