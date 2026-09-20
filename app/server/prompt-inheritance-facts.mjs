import { encodePromptFragment } from './current-page-prompt.mjs';
import path from 'node:path';
import { readFile, lstat, unlink } from 'node:fs/promises';
import { factStorage as storage } from './story-facts.mjs';
import { ApiError } from './http-support.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { adjustmentKey, promptChanges, updateAdjustments, variantPrompt, promptWord, promptText, characterSource, sceneSource, applyInheritedPrompt, duplicatePromptWords, inheritanceCategories } from '../shared/prompt-inheritance.mjs';

export async function optionalFact(directory, relative, fallback = null) {
  const target = storage.targetPath(directory, relative);
  const info = await lstat(target).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!info) return structuredClone(fallback);
  await storage.assertProjectFactBoundary(directory, directory, target, relative);
  return JSON.parse(await readFile(target, 'utf8'));
}

export async function readScenes(directory) {
  const index = await optionalFact(directory, 'scenes/index.json', { scenes: [] });
  const scenes = await Promise.all(index.scenes.map(async id => {
    const [profile, visual, prompt] = await Promise.all(['profile', 'visual', 'prompt'].map(kind => optionalFact(directory, `scenes/${id}.${kind}.json`)));
    if (!profile || !visual || !prompt) throw new ApiError(422, 'scene_fact_missing', [id]);
    return { id, name: profile.name, description: profile.description, profile_sha256: hashCanonicalJson(profile), visual,
      visual_sha256: hashCanonicalJson(visual), prompt, prompt_sha256: hashCanonicalJson(prompt), pages: [] };
  }));
  return { scenes };
}

export async function readInheritanceSources(directory, references, sceneId, sceneVariantId, { allowMissing = false } = {}) {
  const sources = [];
  for (const ref of references) {
    const doc = await optionalFact(directory, `characters/${ref.character_id}.prompt.json`);
    const variant = doc?.variants?.[ref.variant_id];
    if (!variant) { if (allowMissing) { sources.push({ id: characterSource(ref.character_id, ref.variant_id), scope: ref.character_id, label: `${ref.character_id} · ${ref.variant_id}`, missing: true, prompt: {} }); continue; } throw new ApiError(422, 'inheritance_source_missing', [ref.character_id, ref.variant_id]); }
    sources.push({ id: characterSource(ref.character_id, ref.variant_id), scope: ref.character_id, label: `${ref.character_id} · ${ref.variant_id}`, prompt: variantPrompt(doc.identity, variant) });
  }
  if (sceneId) {
    const scene = (await readScenes(directory)).scenes.find(s => s.id === sceneId);
    const variant = scene?.prompt?.variants?.[sceneVariantId];
    if (!variant) { if (!allowMissing) throw new ApiError(422, 'inheritance_source_missing', [`场景子设定不存在：${sceneId} · ${sceneVariantId}`]); sources.push({ id: sceneSource(sceneId, sceneVariantId), scope: 'environment', label: `场景 · ${sceneId} · ${sceneVariantId}`, missing: true, prompt: {} }); }
    else sources.push({ id: sceneSource(sceneId, sceneVariantId), scope: 'environment', label: `场景 · ${scene.name} · ${sceneVariantId}`, prompt: variantPrompt(scene.prompt.identity, variant) });
  }
  return sources;
}

export function checkPageInheritanceReferences(prompt, sources) {
  const errors = [];
  const byId = new Map(sources.map(s => [s.id, s]));
  for (const [id, adjustments] of Object.entries(prompt.inheritance ?? {})) {
    const source = byId.get(id);
    if (!source) { errors.push(`继承来源已切换，请清除旧调整：${id}`); continue; }
    if (source.missing) continue;
    const words = new Set(inheritanceCategories.flatMap(c => (source.prompt[c] ?? []).map(f => adjustmentKey(f, c))));
    for (const word of Object.keys(adjustments)) if (!words.has(word)) errors.push(`继承词已不存在：${source.label} / ${word}`);
  }
  return errors;
}

export function checkPageInheritance(prompt, sources) {
  return [...checkPageInheritanceReferences(prompt, sources), ...duplicatePromptWords([
    ...sources.map(s => ({ ...s, prompt: applyInheritedPrompt(s.prompt, prompt.inheritance?.[s.id]) })),
    { prompt, scope: 'environment', label: '本页' },
  ])];
}

async function pageFacts(directory) {
  const index = await optionalFact(directory, 'pages/index.json', { pages: [] });
  const pages = [];
  for (const entry of index.pages) {
    const content = await optionalFact(directory, `pages/${entry.page_id}.content.json`);
    const before = await optionalFact(directory, `pages/${entry.page_id}.prompt.json`);
    if (content && before) pages.push({ relative: `pages/${entry.page_id}.prompt.json`, label: `${content.title}（${entry.page_id}）`, references: content.characters ?? [], before });
  }
  return pages;
}

const describe = f => f ? `${promptText(f)} ×${f.weight ?? 1} · ${f.enabled === false ? '关闭' : '开启'}` : '（删除）';
// 对比实际输出，不把停用词、默认值写法或存储元数据变化当作 Prompt 变化。
function effectiveFragment(fragment) {
  if (!fragment || fragment.enabled === false) return '';
  const text = encodePromptFragment({ prompt_type: fragment.tag ? 'danbooru' : 'custom_description', prompt_text: promptText(fragment), weight: fragment.weight });
  return JSON.stringify([fragment.category, fragment.character_id ?? fragment.role, text]);
}
const describeChanges = (label, changes) => changes.filter(c => effectiveFragment(c.before) !== effectiveFragment(c.after)).map(c => `${label}：${c.before ? describe(c.before) : '（新增）'} → ${describe(c.after)}`);

// 只改下游的显式调整；继承内容仍由源文件提供，不复制词条。
export async function planPromptPropagation(directory, { characterId, sceneId, baseline, next }) {
  const changesBySource = new Map(), impacts = [], writes = [], dependencies = [];
  {
    const identityChanges = promptChanges(baseline.identity.prompt, next.identity.prompt);
    for (const [id, variant] of Object.entries(next.variants)) {
      const old = baseline.variants[id];
      if (!old) continue;
      if (identityChanges.length) {
        const adjustments = { ...variant.identity_overrides };
        for (const word of variant.identity_disabled ?? []) for (const category of inheritanceCategories) {
          for (const fragment of baseline.identity.prompt[category] ?? []) if (promptWord(promptText(fragment)) === promptWord(word)) {
            const key = adjustmentKey(fragment, category);
            adjustments[key] = { ...adjustments[key], enabled: false };
          }
        }
        variant.identity_overrides = updateAdjustments(adjustments, identityChanges);
        variant.identity_disabled = [];
        if (!Object.keys(variant.identity_overrides).length) delete variant.identity_overrides;
        const effective = promptChanges(variantPrompt(baseline.identity, old), variantPrompt(next.identity, variant));
        impacts.push(...describeChanges(`子设定 ${sceneId ?? characterId} · ${id}`, effective));
      }
      // 使用基础变化和有效变化的并集：上游改权重/开关必须重置被子设定覆盖的页面调整。
      const effective = promptChanges(variantPrompt(baseline.identity, old), variantPrompt(next.identity, variant));
      for (const change of identityChanges) {
        if (!change.before || !change.after) continue;
        const resetWeight = (change.before.weight ?? 1) !== (change.after.weight ?? 1);
        const resetEnabled = (change.before.enabled !== false) !== (change.after.enabled !== false);
        if (!resetWeight && !resetEnabled) continue;
        let entry = effective.find(c => c.before && adjustmentKey(c.before) === adjustmentKey(change.before));
        if (!entry) {
          const beforePrompt = variantPrompt(baseline.identity, old), afterPrompt = variantPrompt(next.identity, variant);
          const before = inheritanceCategories.flatMap(c => beforePrompt[c].map(f => ({ ...f, category: c }))).find(f => adjustmentKey(f) === adjustmentKey(change.before));
          const after = inheritanceCategories.flatMap(c => afterPrompt[c].map(f => ({ ...f, category: c }))).find(f => adjustmentKey(f) === adjustmentKey(change.after));
          if (before && after) { entry = { before, after }; effective.push(entry); }
        }
        if (entry) Object.assign(entry, { resetWeight, resetEnabled });
      }
      if (effective.length) changesBySource.set(sceneId ? sceneSource(sceneId, id) : characterSource(characterId, id), { changes: effective });
    }
  }
  if (!changesBySource.size && !impacts.length) return { writes, impacts, dependencies };
  for (const page of await pageFacts(directory)) {
    const sourceIds = page.references.map(r => characterSource(r.character_id, r.variant_id));
    if (page.before.scene_id) sourceIds.push(sceneSource(page.before.scene_id, page.before.scene_variant_id));
    const applicable = sourceIds.filter(id => changesBySource.has(id));
    if (!applicable.length) continue;
    dependencies.push({ relative: page.relative, hash: hashCanonicalJson(page.before), references: page.references });
    const after = structuredClone(page.before);
    for (const id of applicable) {
      const { changes, removed } = changesBySource.get(id);
      const adjustments = after.inheritance?.[id] ?? {};
      const updated = updateAdjustments(adjustments, changes);
      const effectiveChanges = changes.flatMap(c => {
        const before = c.before ? { ...c.before, ...adjustments[adjustmentKey(c.before)] } : null;
        const next = c.after ? { ...c.after, ...updated[adjustmentKey(c.after)] } : null;
        return JSON.stringify(before) === JSON.stringify(next) ? [] : [{ before, after: next }];
      });
      impacts.push(...describeChanges(`${page.label} / ${id}`, effectiveChanges));
      if (after.inheritance?.[id]) {
        if (Object.keys(updated).length) after.inheritance[id] = updated;
        else delete after.inheritance[id];
      }

    }
    if (hashCanonicalJson(after) !== hashCanonicalJson(page.before)) writes.push({ relative: page.relative, before: page.before, after });
  }
  return { writes, impacts, dependencies };
}

export function requireImpactConfirmation(plan, token, target) {
  if (!plan.impacts.length) return;
  const stable = JSON.parse(JSON.stringify({ target, ...plan }, (key, value) => key === 'id' && typeof value === 'string' && /^token-/.test(value) ? undefined : value));
  const confirmation = hashCanonicalJson(stable);
  if (token !== confirmation) throw new ApiError(422, 'inheritance_confirmation_required', [{ confirmation_sha256: confirmation, changes: plan.impacts }]);
}

// 引用切换只汇报被清理调整实际改变的输出；相同正文与权重不重复确认。
export async function sourceSwitchImpacts(directory, before, after, beforeReferences, afterReferences, removedSources) {
  if (!removedSources.some(id => Object.keys(before.inheritance?.[id] ?? {}).length)) return [];
  const oldSources = await readInheritanceSources(directory, beforeReferences, before.scene_id, before.scene_variant_id, { allowMissing: true });
  const newSources = await readInheritanceSources(directory, afterReferences, after.scene_id, after.scene_variant_id, { allowMissing: true });
  const fragments = (source, prompt) => inheritanceCategories.flatMap(category =>
    applyInheritedPrompt(source.prompt, prompt.inheritance?.[source.id])[category].map(fragment => ({ ...fragment, category })));
  const impacts = [];
  for (const id of removedSources) {
    const old = oldSources.find(source => source.id === id);
    if (!old) continue;
    const previous = fragments(old, before);
    const following = newSources.filter(source => source.scope === old.scope).flatMap(source => fragments(source, after));
    for (const key of Object.keys(before.inheritance?.[id] ?? {})) {
      const a = previous.find(fragment => adjustmentKey(fragment) === key) ?? null;
      const b = following.find(fragment => adjustmentKey(fragment) === key) ?? null;
      impacts.push(...describeChanges('切换 ' + old.label, [{ before: a, after: b }]));
    }
  }
  return impacts;
}

export async function planCharacterSwitch(directory, pageId, before, after) {
  const relative = `pages/${pageId}.prompt.json`;
  const prompt = await optionalFact(directory, relative);
  const plan = { impacts: [], writes: [], dependencies: [] };
  if (!prompt) return plan;
  const keep = new Set(after.characters.map(r => characterSource(r.character_id, r.variant_id)));
  const next = structuredClone(prompt);
  for (const [source, adjustments] of Object.entries(prompt.inheritance ?? {})) {
    if (!source.startsWith('character:') || keep.has(source)) continue;

    delete next.inheritance[source];
  }
  const removed = Object.keys(prompt.inheritance ?? {}).filter(id => id.startsWith('character:') && !keep.has(id));
  plan.impacts = await sourceSwitchImpacts(directory, prompt, next, before.characters, after.characters, removed);
  if (hashCanonicalJson(next) !== hashCanonicalJson(prompt)) plan.writes.push({ relative, before: prompt, after: next });
  return plan;
}

export async function applySceneSwitch(directory, baseline, next, references) {
  const plan = { impacts: [], writes: [] };
  if (baseline.scene_id === next.scene_id && baseline.scene_variant_id === next.scene_variant_id) return plan;
  for (const [source, adjustments] of Object.entries(baseline.inheritance ?? {})) {
    if (!source.startsWith('scene:')) continue;

    if (next.inheritance) delete next.inheritance[source];
  }
  plan.impacts = await sourceSwitchImpacts(directory, baseline, next, references, references, Object.keys(baseline.inheritance ?? {}).filter(id => id.startsWith('scene:')));
  return plan;
}

// 项目写锁由调用入口持有；失败时恢复已写文件，避免半套连带修改。
export async function commitFactChanges(directory, writes) {
  const done = [];
  try {
    for (const write of writes) {
      await storage.writeJsonAtomic(storage.targetPath(directory, write.relative), write.after);
      done.push(write);
    }
  } catch (error) {
    for (const write of done.reverse()) {
      const target = storage.targetPath(directory, write.relative);
      if (write.before === null) await unlink(target);
      else await storage.writeJsonAtomic(target, write.before);
    }
    throw error;
  }
}
