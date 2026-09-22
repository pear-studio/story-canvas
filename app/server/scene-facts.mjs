import { cleanRemovedReferences } from './reference-materials.mjs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, readdir, stat } from 'node:fs/promises';
import { resolveProjectLocation } from './project-operations.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { factStorage as storage, commitFactChanges } from './story-facts.mjs';
import { ApiError } from './http-support.mjs';
import { assertNoActivePageRender } from './render-task-storage.mjs';
import { sceneSource } from './prompt-contract.mjs';
import { SCENE_INDEX_SCHEMA_ID, SCENE_PROMPT_SCHEMA_ID, sceneIdPattern, validateSceneIndexDocument, validateSceneProfileDocument, validateSceneVisualDocument, validateScenePromptDocument, defaultSceneFacts } from './scene-files.mjs';

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

export const DELETED_SCENE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const relative = (id, kind) => `scenes/${id}.${kind}.json`;
const fail = (code, details = []) => { throw new ApiError(422, code, details); };
function validId(id) { if (typeof id !== 'string' || !sceneIdPattern.test(id)) fail('invalid_scene_id', [String(id)]); }
function assertValid(errors) { if (errors.length) fail('invalid_scene_document', errors); }
const visualIdentity = visual => hashCanonicalJson(visual.variants.map(v => v.id).sort());
const validators = { profile: validateSceneProfileDocument, visual: validateSceneVisualDocument, prompt: validateScenePromptDocument };
async function sceneIndex(directory) {
  const index = await optionalFact(directory, 'scenes/index.json', { $schema: SCENE_INDEX_SCHEMA_ID, scenes: [] });
  assertValid(validateSceneIndexDocument(index));
  return index;
}
async function requireScene(directory, id) {
  validId(id);
  const index = await sceneIndex(directory);
  if (!index.scenes.includes(id)) fail('scene_not_found', [id]);
  return index;
}
async function sceneFact(directory, id, kind) {
  const value = await optionalFact(directory, relative(id, kind));
  if (!value) fail('scene_fact_missing', [id, kind]);
  assertValid(validators[kind](value));
  return value;
}
const emptyVariant = () => ({ text: '', reference_images: [] });
function normalizedPrompt(prompt, visual) {
  return { ...prompt, variants: Object.fromEntries(visual.variants.map(v => [v.id, prompt.variants[v.id] ?? emptyVariant()])) };
}
export async function readSceneFactDraft(root, projectId, sceneId, kind = 'profile') {
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  await requireScene(project.projectDirectory, sceneId);
  if (!validators[kind]) fail('invalid_scene_edit_kind', [kind]);
  const persisted = await sceneFact(project.projectDirectory, sceneId, kind);
  const visual = kind === 'prompt' ? await sceneFact(project.projectDirectory, sceneId, 'visual') : null;
  return { project, definition: { targetRelative: relative(sceneId, kind), persisted,
    ...(visual ? { editable: normalizedPrompt(persisted, visual), targetBaseline: persisted } : {}),
    identity: { scene_id: sceneId }, upstream: visual ? { visual: { identity_sha256: visualIdentity(visual) } } : {} } };
}
export async function commitSceneFact(root, context, readDocument, kind, { beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(root), context.project_id);
  const id = context.scene_id;
  await requireScene(project.projectDirectory, id);
  const baseline = await storage.assertTargetBaseline(project.projectDirectory, context);
  const next = structuredClone(await readDocument());
  if (!validators[kind]) fail('invalid_scene_edit_kind', [kind]);
  const writes = [];
  if (kind === 'prompt') {
    const visual = await sceneFact(project.projectDirectory, id, 'visual');
    if (visualIdentity(visual) !== context.upstream.visual.identity_sha256) throw new ApiError(409, 'scene_edit_upstream_conflict');
    if (next?.$schema !== SCENE_PROMPT_SCHEMA_ID || !next.variants || typeof next.variants !== 'object' || Array.isArray(next.variants)) fail('invalid_scene_document', ['场景 Prompt 结构无效']);
    const expected = visual.variants.map(v => v.id).sort();
    if (JSON.stringify(Object.keys(next.variants).sort()) !== JSON.stringify(expected)) fail('scene_prompt_visual_mismatch');
  } else if (kind === 'visual') {
    assertValid(validateSceneVisualDocument(next));
    // 子设定列表与 Prompt 同次提交，新增立即可用；删除须经过引用检查。
    const removed = baseline.variants.filter(v => !next.variants.some(n => n.id === v.id));
    for (const variant of removed) if ((await sceneReferences(project.projectDirectory, id)).some(ref => ref.variant_id === variant.id)) fail('scene_variant_still_in_use', [id, variant.id]);
    const before = await sceneFact(project.projectDirectory, id, 'prompt');
    const after = normalizedPrompt(before, next);
    writes.push({ relative: relative(id, 'prompt'), before, after });
  }
  assertValid(validators[kind](next));
  if (beforeCommit) await beforeCommit();
  await commitFactChanges(project.projectDirectory, [...writes, { relative: context.target.relative_path, before: baseline, after: next }]);
  return { value: next, sha256: hashCanonicalJson(next), downstream_diagnostics: [], target_file: path.join(project.projectDirectory, context.target.relative_path) };
}
export async function createScene(root, projectId, sceneId, { name, beforeCommit } = {}) {
  validId(sceneId);
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  const before = await sceneIndex(project.projectDirectory);
  if (before.scenes.includes(sceneId)) fail('scene_already_exists', [sceneId]);
  const facts = defaultSceneFacts(sceneId, name);
  const writes = [];
  for (const kind of ['profile', 'visual', 'prompt']) {
    if (await optionalFact(project.projectDirectory, relative(sceneId, kind))) fail('scene_fact_already_exists', [sceneId, kind]);
    writes.push({ relative: relative(sceneId, kind), before: null, after: facts[kind] });
  }
  if (beforeCommit) await beforeCommit();
  await commitFactChanges(project.projectDirectory, [...writes, { relative: 'scenes/index.json', before, after: { ...before, scenes: [...before.scenes, sceneId] } }]);
  return { scene_id: sceneId };
}
export async function moveScene(root, projectId, sceneId, { direction, beforeSceneId, beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  const before = await requireScene(project.projectDirectory, sceneId);
  const after = structuredClone(before), old = after.scenes.indexOf(sceneId);
  let target = beforeSceneId === undefined ? old + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0) : after.scenes.indexOf(beforeSceneId);
  if (beforeSceneId === null) target = after.scenes.length - 1;
  else if (beforeSceneId !== undefined && old < target) target -= 1;
  if (target < 0 || target >= after.scenes.length) fail('invalid_scene_move');
  after.scenes.splice(old, 1); after.scenes.splice(target, 0, sceneId);
  if (beforeCommit) await beforeCommit();
  await commitFactChanges(project.projectDirectory, [{ relative: 'scenes/index.json', before, after }]);
  return { scene_id: sceneId };
}
export async function sceneReferences(directory, id) {
  const index = await optionalFact(directory, 'pages/index.json', { pages: [] });
  const references = [];
  for (const page of index.pages) {
    if (page.owner_kind === 'scene' && page.scene_id === id) references.push({ ...page, reference_kind: 'owner' });
    const prompt = await optionalFact(directory, `pages/${page.page_id}.prompt.json`);
    if (prompt?.scene_id === id) references.push({ page_id: page.page_id, variant_id: prompt.scene_variant_id, reference_kind: 'scene' });
  }
  return references;
}
export async function deleteSceneVariant(root, projectId, sceneId, variantId, { beforeCommit } = {}) {
  validId(variantId);
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  await requireScene(project.projectDirectory, sceneId);
  const visual = await sceneFact(project.projectDirectory, sceneId, 'visual');
  const prompt = await sceneFact(project.projectDirectory, sceneId, 'prompt');
  if (!visual.variants.some(v => v.id === variantId)) fail('scene_variant_not_found');
  if (visual.variants.length <= 1) fail('scene_last_variant');
  if ((await sceneReferences(project.projectDirectory, sceneId)).some(ref => ref.variant_id === variantId)) fail('scene_variant_still_in_use', [sceneId, variantId]);
  const nextVisual = { ...visual, variants: visual.variants.filter(v => v.id !== variantId) };
  if (beforeCommit) await beforeCommit();
  await commitFactChanges(project.projectDirectory, [
    { relative: relative(sceneId, 'visual'), before: visual, after: nextVisual },
    { relative: relative(sceneId, 'prompt'), before: prompt, after: normalizedPrompt(prompt, nextVisual) },
  ]);
  await cleanRemovedReferences(project.projectDirectory, prompt);
  return { scene_id: sceneId, variant_id: variantId, downstream_diagnostics: [] };
}
export async function renameSceneVariant(root, projectId, sceneId, oldId, newId, { beforeCommit } = {}) {
  validId(oldId); validId(newId);
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  await requireScene(project.projectDirectory, sceneId);
  const visual = await sceneFact(project.projectDirectory, sceneId, 'visual'), prompt = await sceneFact(project.projectDirectory, sceneId, 'prompt');
  if (!visual.variants.some(v => v.id === oldId)) fail('scene_variant_not_found');
  if (visual.variants.some(v => v.id === newId)) fail('scene_variant_already_exists');
  const nextVisual = { ...visual, variants: visual.variants.map(v => v.id === oldId ? { ...v, id: newId } : v) };
  const nextPrompt = { ...prompt, variants: Object.fromEntries(Object.entries(prompt.variants).map(([id,v]) => [id === oldId ? newId : id, v])) };
  assertValid(validateSceneVisualDocument(nextVisual)); assertValid(validateScenePromptDocument(nextPrompt));
  const writes = [{ relative: relative(sceneId, 'visual'), before: visual, after: nextVisual }, { relative: relative(sceneId, 'prompt'), before: prompt, after: nextPrompt }];
  const index = await optionalFact(project.projectDirectory, 'pages/index.json', { pages: [] }), nextIndex = structuredClone(index);
  const ids = new Set();
  for (const page of nextIndex.pages) {
    if (page.owner_kind === 'scene' && page.scene_id === sceneId && page.variant_id === oldId) { page.variant_id = newId; ids.add(page.page_id); }
    const file = `pages/${page.page_id}.prompt.json`, before = await optionalFact(project.projectDirectory, file);
    if (before?.scene_id !== sceneId || before.scene_variant_id !== oldId) continue;
    const after = structuredClone(before); after.scene_variant_id = newId;
    for (const field of ['text_overrides', 'reference_overrides']) {
      if (Object.hasOwn(after[field] ?? {}, sceneSource(sceneId, oldId))) {
        after[field][sceneSource(sceneId, newId)] = after[field][sceneSource(sceneId, oldId)];
        delete after[field][sceneSource(sceneId, oldId)];
      }
    }
    writes.push({ relative: file, before, after }); ids.add(page.page_id);
  }
  if (hashCanonicalJson(index) !== hashCanonicalJson(nextIndex)) writes.push({ relative: 'pages/index.json', before: index, after: nextIndex });
  if (beforeCommit) await beforeCommit();
  await commitFactChanges(project.projectDirectory, writes);
  return { scene_id: sceneId, old_id: oldId, new_id: newId, visual: nextVisual, prompt: nextPrompt, updated_page_ids: [...ids], downstream_diagnostics: [] };
}
export async function deleteScene(root, projectId, sceneId, { beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(root), projectId);
  const index = await requireScene(project.projectDirectory, sceneId);
  const references = await sceneReferences(project.projectDirectory, sceneId);
  for (const ref of references) await assertNoActivePageRender(project.projectDirectory, { page_id: ref.page_id });
  const facts = await Promise.all(['profile', 'visual', 'prompt'].map(kind => sceneFact(project.projectDirectory, sceneId, kind)));
  const deletionId = `deleted-${randomBytes(6).toString('hex')}`;
  const archive = path.resolve(root, 'Saved/state/deleted-scenes', project.projectId, deletionId);
  await mkdir(archive, { recursive: true });
  await storage.assertRealPathWithin(path.resolve(root), archive, 'deleted scene archive');
  const moved = [];
  try {
    await storage.writeJsonAtomic(path.join(archive, 'deletion.json'), { version: 1, deletion_id: deletionId, project_id: project.projectId, scene_id: sceneId, deleted_at: new Date().toISOString(), ordinal: index.scenes.indexOf(sceneId) });
    for (const [i,kind] of ['profile', 'visual', 'prompt'].entries()) {
      const source = storage.targetPath(project.projectDirectory, relative(sceneId, kind)), destination = path.join(archive, `${sceneId}.${kind}.json`);
      await storage.assertProjectFactBoundary(root, project.projectDirectory, source, relative(sceneId, kind));
      await rename(source, destination); moved.push({ source, destination, value: facts[i] });
    }
    if (beforeCommit) await beforeCommit();
    await storage.writeJsonAtomic(path.join(project.projectDirectory, 'scenes/index.json'), { ...index, scenes: index.scenes.filter(id => id !== sceneId) });
  } catch (error) {
    for (const item of moved.reverse()) await rename(item.destination, item.source);
    await storage.removeSafeRuntimeDirectory(root, path.resolve(root, 'Saved/state/deleted-scenes'), archive, 'deleted scene archive');
    throw error;
  }
  for (const fact of facts) await cleanRemovedReferences(project.projectDirectory, fact);
  return { scene_id: sceneId, deletion_id: deletionId, archive_directory: archive,
    downstream_diagnostics: references.map(ref => ({ code: ref.reference_kind === 'owner' ? 'page_owner_missing' : 'page_scene_missing', page_id: ref.page_id, scene_id: sceneId, variant_id: ref.variant_id })) };
}
export async function cleanupDeletedScenes(root, { now = Date.now(), maxAgeMs = DELETED_SCENE_RETENTION_MS } = {}) {
  const parent = path.resolve(root, 'Saved/state/deleted-scenes'), removed = [];
  const projects = await readdir(parent, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const project of projects.filter(item => item.isDirectory() && !item.isSymbolicLink())) {
    for (const entry of await readdir(path.join(parent, project.name), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^deleted-[a-f0-9]{12}$/.test(entry.name)) continue;
      const directory = path.join(parent, project.name, entry.name);
      const manifest = await optionalFact(directory, 'deletion.json');
      const deletedAt = Date.parse(manifest?.deleted_at) || (await stat(directory)).mtimeMs;
      if (now - deletedAt < maxAgeMs) continue;
      await storage.removeSafeRuntimeDirectory(root, parent, directory, 'deleted scene archive'); removed.push(directory);
    }
  }
  return removed;
}
