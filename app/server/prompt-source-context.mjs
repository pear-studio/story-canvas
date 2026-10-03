import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { modelPrompt, promptModelEntries } from './model-prompts.mjs';
import { readPageContent, readPagePrompt } from './pages-store.mjs';
import { readPageRenderSettings } from './page-render-settings.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { ApiError } from './http-support.mjs';
import { variantPrompt, inheritanceCategories, adjustmentKey, validateAdjustments } from '../shared/prompt-inheritance.mjs';

const schemaVersion = 1;
const inputModel = (document, modelId) => document && promptModelEntries(document).some(([id]) => id === modelId) ? modelPrompt(document, modelId) : null;
async function json(directory, relative, fallback = null) {
  try { return JSON.parse(await readFile(path.join(directory, relative), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// 同一来源的读据由工作台投影和 Agent 共用；不包含其他子设定或其他模型。
export function settingPromptSourceVersion({ projectId, kind, id, modelId, variantId, document, visual }) {
  const input = inputModel(document, modelId);
  const variant = visual?.variants?.find(value => value.id === variantId);
  const configuration = input?.variants?.[variantId];
  return hashCanonicalJson({ protocol: schemaVersion, project_id: projectId, kind, id, model_id: modelId,
    variant_id: variantId, visual: variant ? { id: variant.id, name: variant.name ?? null } : null,
    prompt: configuration ? { ...(modelId === 'anima' ? { identity: input.identity ?? null } : { prompt_name: input.prompt_name ?? null }), configuration } : null });
}

export function settingPromptSourceVersions({ projectId, kind, id, document, visual }) {
  return Object.fromEntries(promptModelEntries(document).map(([modelId, input]) => [modelId,
    Object.fromEntries(Object.keys(input?.variants ?? {}).map(variantId => [variantId,
      settingPromptSourceVersion({ projectId, kind, id, modelId, variantId, document, visual })]))]));
}

export async function readPagePromptSources(projectDirectory, { projectId, modelId, narrative, prompt }) {
  if (prompt.composition === 'standalone') return {};
  const references = [
    ...(narrative.characters ?? []).map(ref => ({ kind: 'character', id: ref.character_id, variant_id: ref.variant_id })),
    ...(prompt.scene_id ? [{ kind: 'scene', id: prompt.scene_id, variant_id: prompt.scene_variant_id }] : []),
  ];
  return Object.fromEntries(await Promise.all(references.map(async reference => {
    const { kind, id, variant_id: variantId } = reference, folder = kind === 'character' ? 'characters' : 'scenes';
    const [index, visual, document] = await Promise.all([
      json(projectDirectory, `${folder}/index.json`, { [folder]: [] }),
      json(projectDirectory, `${folder}/${id}.visual.json`), json(projectDirectory, `${folder}/${id}.prompt.json`),
    ]);
    const input = inputModel(document, modelId);
    const variant = input?.variants?.[variantId];
    const missing = !index[folder]?.includes(id) ? kind : !visual?.variants?.some(v => v.id === variantId) ? 'variant' : !variant ? 'prompt' : null;
    const sourceHash = settingPromptSourceVersion({ projectId, kind, id, modelId, variantId, document, visual });
    const sha256 = missing ? hashCanonicalJson({ source_sha256: sourceHash, missing }) : sourceHash;
    return [`${kind}:${id}:${variantId}`, { ...reference, sha256, ...(missing ? { missing } : {}),
      ...(input?.identity ? { identity: structuredClone(input.identity) } : {}),
      ...(input?.prompt_name ? { prompt_name: input.prompt_name } : {}), ...(variant ? { variant: structuredClone(variant) } : {}) }];
  })));
}

export async function readPagePromptDependencies(projectDirectory, { projectId, pageId, modelId, narrative, prompt, sources }) {
  narrative ??= await readPageContent(projectDirectory, pageId);
  prompt ??= inputModel(await readPagePrompt(projectDirectory, pageId), modelId);
  if (!prompt) throw new ApiError(422, 'page_model_input_missing', [pageId, modelId]);
  const render = await readPageRenderSettings(projectDirectory, pageId);
  sources ??= await readPagePromptSources(projectDirectory, { projectId, modelId, narrative, prompt });
  return { model_id: modelId, narrative_sha256: hashCanonicalJson(narrative), render_sha256: hashCanonicalJson(render),
    sources: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.sha256])) };
}

// 旧来源已由读取时的 context 保护；新来源或非活动模型必须携带明确读取过的版本。
export async function assertPagePromptSourceVersions(projectDirectory, { projectId, modelId, narrative, prompt,
  baselineNarrative, baselinePrompt, sourceVersions = {}, protectBaseline = true }) {
  const sources = await readPagePromptSources(projectDirectory, { projectId, modelId, narrative, prompt });
  const previous = protectBaseline && baselinePrompt ? await readPagePromptSources(projectDirectory,
    { projectId, modelId, narrative: baselineNarrative ?? narrative, prompt: baselinePrompt }) : {};
  const missing = [], changed = [];
  for (const [key, source] of Object.entries(sources)) {
    if (source.missing) throw new ApiError(422, 'prompt_source_missing', [{ source: key, reason: source.missing }]);
    if (sourceVersions[key] !== undefined) { if (sourceVersions[key] !== source.sha256) changed.push(key); }
    else if (!Object.hasOwn(previous, key)) missing.push(key);
  }
  if (missing.length) throw new ApiError(409, 'prompt_source_read_required', missing);
  if (changed.length) throw new ApiError(409, 'prompt_source_conflict', changed);
  return sources;
}

// 已悬空的覆盖可原样保留或删除；不得新增/修改不存在的条目。整来源缺失另行拒绝。
export async function validatePagePromptInheritance(projectDirectory, { projectId, modelId, narrative, prompt, baselinePrompt, sources }) {
  if (modelId !== 'anima') return [];
  sources ??= await readPagePromptSources(projectDirectory, { projectId, modelId, narrative, prompt });
  const errors = [];
  for (const [source, adjustments] of Object.entries(prompt.inheritance ?? {})) {
    const current = sources[source];
    if (!current || current.missing) { errors.push(`inheritance.${source} 的角色／场景或子设定不存在`); continue; }
    const inherited = variantPrompt(current.identity, current.variant);
    const availableKeys = new Set(inheritanceCategories.flatMap(category => inherited[category].map(fragment => adjustmentKey(fragment))));
    errors.push(...validateAdjustments(adjustments, `inheritance.${source}`, {
      availableKeys, baselineAdjustments: baselinePrompt?.inheritance?.[source] ?? {}, layers: ['identity', 'variant'],
    }));
  }
  return errors;
}

// 删除共享词只报告已有下游调整，不改写下游；没有删除时不扫描页面文件。
export async function settingPromptRemovalDiagnostics(projectDirectory, { kind, id, before, after }) {
  const removedByModel = new Map(), variants = new Set();
  for (const [modelId, old] of promptModelEntries(before)) {
    if (modelId !== 'anima') continue;
    const next = inputModel(after, modelId), removed = new Map();
    for (const [variantId, variant] of Object.entries(old?.variants ?? {})) {
      const keys = value => inheritanceCategories.flatMap(category => value[category].map(adjustmentKey));
      const beforeKeys = keys(variantPrompt(old.identity, variant));
      const afterKeys = new Set(next?.variants?.[variantId] ? keys(variantPrompt(next.identity, next.variants[variantId])) : []);
      const missing = beforeKeys.filter(key => !afterKeys.has(key));
      if (missing.length) removed.set(`${kind}:${id}:${variantId}`, new Set(missing));
      if (missing.some(key => Object.hasOwn(next?.variants?.[variantId]?.identity_overrides ?? {}, key))) variants.add(variantId);
    }
    if (removed.size) removedByModel.set(modelId, removed);
  }
  if (!removedByModel.size) return [];
  const affected = new Set(), index = await json(projectDirectory, 'pages/index.json', { pages: [] });
  for (const page of index.pages) {
    const document = await json(projectDirectory, `pages/${page.page_id}.prompt.json`);
    for (const [modelId, removed] of removedByModel) {
      const input = inputModel(document, modelId);
      if ([...removed].some(([source, keys]) => Object.keys(input?.inheritance?.[source] ?? {}).some(key => keys.has(key)))) affected.add(page.page_id);
    }
  }
  if (!affected.size && !variants.size) return [];
  return [{ code: 'removed_shared_prompt_entries', kind, id, affected_page_count: affected.size, affected_variant_count: variants.size,
    message: '共享词已删除；下游原有逐词覆盖保留为失效项，可在相关 Prompt 中明确清理。' }];
}
