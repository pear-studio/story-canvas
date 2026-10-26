import {animaAdapter} from './models/anima/adapter.mjs';
import {qwenAdapter} from './models/qwen/adapter.mjs';
import {h3Adapter} from './models/h3/adapter.mjs';

// 模型拥有 Prompt 和能力；候选/队列只消费编译结果。显式注册，不扫描或运行外部插件。
const adapters = Object.freeze({
  h3:h3Adapter,
  anima:animaAdapter,
  qwen:qwenAdapter,
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
export const settingModelIds = Object.freeze(Object.values(adapters).filter(adapter=>adapter.settingBaseFields).map(adapter=>adapter.id));
