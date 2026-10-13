import { readFactDraft } from './fact-drafts.mjs';
import { resolveProjectLocation } from './project-operations.mjs';
import { factStorage, commitFactChanges } from './story-facts.mjs';
import { prepareCharacterVariantRename } from './character-facts.mjs';
import { prepareSceneVariantRename } from './scene-facts.mjs';
import { normalizePromptTarget, settingPromptScopeVersion, replaceSettingPromptScope } from './prompt-scope-version.mjs';
import { assertEditFingerprint } from './edit-fingerprint.mjs';
import { replaceModelPrompt, modelPrompt } from './model-prompts.mjs';
import { prepareSettingFact } from './setting-persistence.mjs';
import { workbenchSettingDetail } from './project-workbench.mjs';
import { reconcileDraft } from '../shared/reconcile-draft.mjs';
import { factConflict } from './fact-conflict.mjs';
import { ApiError } from './http-support.mjs';
import { savePageReferenceInputs, removeUnusedFile } from './reference-materials.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
function mergeFields(change, current, fields) {
  if (!record(change?.baseline) || !record(change?.value)
    || [change.baseline, change.value].some(value => Object.keys(value).some(key => !fields.includes(key)))) throw new ApiError(400, 'invalid_setting_update');
  const result = reconcileDraft(change.baseline, change.value, current, fields);
  if (result.discarded) throw factConflict('setting_scope_conflict');
  return result.value;
}

// 调用方持有项目写锁。只提交当前基础/子设定；验证、ID 连带修改、图片与事实一起完成。
export async function saveSetting(root, projectId, value) {
  if (!record(value) || Object.keys(value).some(key => !['target','profile','variant','prompt','expected_prompt_sha256','reference_inputs'].includes(key))) throw new ApiError(400, 'invalid_setting_update');
  const target = normalizePromptTarget(value.target);
  if (target.kind === 'page' || (target.scope === 'base' ? value.variant !== undefined : value.profile !== undefined)) throw new ApiError(400, 'invalid_setting_update');
  const {kind, id, model_id:modelId} = target;
  const {projectDirectory:directory} = await resolveProjectLocation(root, projectId);
  const entries = await Promise.all(['profile','visual','prompt'].map(section => readFactDraft(root, {domain:kind, kind:section, projectId, targetId:id})));
  const [beforeProfile, beforeVisual, beforePrompt] = entries.map(entry => entry.document);
  let profile = beforeProfile, visual = structuredClone(beforeVisual), document = structuredClone(beforePrompt);
  if (value.profile !== undefined) {
    const current = {name:profile.name, description:profile.description};
    profile = prepareSettingFact(kind, 'profile', beforeProfile, {...profile,...mergeFields(value.profile,current,['name','description'])});
  }
  if (target.scope === 'variant' && !visual.variants.some(v => v.id === target.variant_id)) throw factConflict('setting_scope_conflict');
  if (value.prompt !== undefined) {
    assertEditFingerprint(value.expected_prompt_sha256, settingPromptScopeVersion({projectId,target,document,visual}), {invalidCode:'invalid_prompt_fingerprint',conflictCode:'prompt_scope_conflict'});
    document = replaceModelPrompt(document, modelId, replaceSettingPromptScope({target,document,visual,value:value.prompt}));
  }
  let variantId = target.variant_id;
  if (value.variant !== undefined) {
    const current = visual.variants.find(v => v.id === variantId);
    const next = mergeFields(value.variant, {id:current.id,name:current.name}, ['id','name']);
    visual.variants = visual.variants.map(v => v.id === variantId ? {...v,...next} : v);
    variantId = next.id;
  }
  let writes = [], promptBaseline = beforePrompt;
  if (target.scope === 'variant' && variantId !== target.variant_id) {
    // 复用导航操作的引用重命名计划，不先写入一次再保存 Prompt。
    const plan = await (kind === 'character' ? prepareCharacterVariantRename : prepareSceneVariantRename)(root,projectId,id,target.variant_id,variantId);
    writes = plan.writes;
    // 校验也沿用改名后的持久基线，已有词条身份与失效覆盖仍属于原子设定。
    promptBaseline = plan.result.prompt;
    for (const input of Object.values(document.models)) {
      input.variants[variantId] = input.variants[target.variant_id]; delete input.variants[target.variant_id];
    }
  }
  visual = prepareSettingFact(kind,'visual',beforeVisual,visual);
  document = prepareSettingFact(kind,'prompt',promptBaseline,document,visual);
  const folder = kind === 'character' ? 'characters' : 'scenes';
  for (const [section,before,after] of [['profile',beforeProfile,profile],['visual',beforeVisual,visual],['prompt',beforePrompt,document]]) {
    const relative = `${folder}/${id}.${section}.json`, existing = writes.find(write => write.relative === relative);
    if (existing) existing.after = after;
    else if (JSON.stringify(before) !== JSON.stringify(after)) writes.push({relative,before,after});
  }
  for (const write of writes) await factStorage.assertProjectFactBoundary(root,directory,factStorage.targetPath(directory,write.relative),write.relative);
  // 在落盘前构造回执；保存后不再依赖另一次读取才能确认成功。
  const setting = workbenchSettingDetail(projectId,kind,id,{profile,visual,document});
  setting.model_id = modelId; setting.prompt = modelPrompt(document,modelId);
  const created = [];
  let warnings;
  try {
    await savePageReferenceInputs(directory,projectId, target.scope === 'variant' ? modelPrompt(document,modelId).variants[variantId] : {}, value.reference_inputs ?? [],created);
    ({warnings} = await commitFactChanges(directory,writes));
  } catch (error) {
    for (const file of created) await removeUnusedFile(directory,file);
    throw error;
  }
  return {saved:true, setting, setting_id:target.scope === 'base' ? 'profile' : variantId, ...(warnings.length ? {warnings} : {})};
}
