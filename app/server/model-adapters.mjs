import { compileCurrentPagePrompt as compileAnima } from './models/anima/current-page-prompt.mjs';
import { compileCurrentPagePrompt as compileQwen } from './models/qwen/prompt-compiler.mjs';
import * as animaProfile from './models/anima/profile.mjs';
import * as animaPage from './models/anima/story-files.mjs';
import * as animaSetting from './models/anima/character-files.mjs';
import * as qwenPrompt from './models/qwen/prompt-contract.mjs';

// 模型拥有 Prompt 和能力；候选/队列只消费编译结果。显式注册，不扫描或运行外部插件。
const adapters = Object.freeze({
  anima: Object.freeze({
    id: 'anima', architecture: 'anima', label: 'Anima Basic', defaultProfile: 'anima-base-v1',
    capabilities: Object.freeze({ references: false, rewrite: false }),
    emptyPrompt: () => ({ subject: [], person: [], setting: [], camera: [], avoid: [] }),
    compilePrompt: compileAnima,
    validatePagePrompt: animaPage.validateStoryPagePromptDocument,
    preparePagePrompt: animaPage.preparePromptForPersistence,
    validateSettingPrompt: animaSetting.validateCharacterPromptDocument,
    prepareSettingPrompt: animaSetting.prepareCharacterPromptForPersistence,
    validateProfilePrompt: animaProfile.validateProfilePrompt,
    resolveProfilePrompt: animaProfile.resolveProfilePrompt,
    resolveEffectivePrompt: animaProfile.resolveEffectivePrompt,
  }),
  qwen: Object.freeze({
    id: 'qwen', architecture: 'qwen-image-2-1', label: 'Qwen-Image-2.1', defaultProfile: 'qwen-image-2-1',
    capabilities: Object.freeze({ references: true, rewrite: true }),
    emptyPrompt: () => ({ text: '', composition: 'settings' }),
    compilePrompt: compileQwen,
    validatePagePrompt: qwenPrompt.validateStoryPagePromptDocument,
    preparePagePrompt: prompt => structuredClone(prompt),
    validateSettingPrompt: qwenPrompt.validateCharacterPromptDocument,
    prepareSettingPrompt: prompt => structuredClone(prompt),
    validateProfilePrompt(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => key !== 'text') || typeof value.text !== 'string') {
        throw new TypeError('Qwen prompt.text 必须是字符串，且不允许未知字段');
      }
    },
    async resolveProfilePrompt(_root, profile) { return { prompt: structuredClone(profile.prompt), identity: {} }; },
    async resolveEffectivePrompt(_root, bundle) { return structuredClone(bundle.source_identity); },
  }),
});

export function modelAdapter(id) {
  const adapter = Object.hasOwn(adapters, id) ? adapters[id] : null;
  if (!adapter) throw new TypeError(`未知生成模型：${id}`);
  return adapter;
}
export function profileModelAdapter(profile) {
  const adapter = Object.values(adapters).find(item => item.architecture === profile?.architecture_family);
  if (!adapter) throw new TypeError(`未知生成模型家族：${profile?.architecture_family}`);
  return adapter;
}
export async function defaultProfileAdapter(repositoryRoot, profileId) {
  const adapter = Object.values(adapters).find(item => item.defaultProfile === profileId);
  if (adapter) return adapter;
  const {readResolvedRenderProfile}=await import('./render-profile-compiler.mjs');
  return profileModelAdapter((await readResolvedRenderProfile(repositoryRoot,profileId)).resolved_profile);
}
export const generationModels = Object.freeze(Object.values(adapters).map(({ id, architecture, label, capabilities }) => Object.freeze({ id, architecture, label, capabilities })));
