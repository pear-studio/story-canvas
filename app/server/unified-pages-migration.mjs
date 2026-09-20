import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireIdleProject } from './project-management.mjs';
import { defaultSceneFacts, SCENE_INDEX_SCHEMA_ID, validateScenePromptDocument } from './scene-files.mjs';

import { validatePagesIndexDocument } from './pages-store.mjs';
import { validateStoryPageNarrativeDocument, validateStoryPagePromptDocument } from './story-files.mjs';

const exists = file => lstat(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
const read = async (file, fallback) => exists(file).then(async present => present ? JSON.parse(await readFile(file, 'utf8')) : fallback);
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };

// 一次性当前项目转换；默认只预演。备份保留原事实和媒体，不改写历史生成证据。
export async function migrateUnifiedPages(directory, { apply = false, backupDirectory } = {}) {
  directory = path.resolve(directory);
  const marker = path.join(directory, '.storage-migration.json');
  if (await exists(marker)) throw new Error(`迁移未完成，请先从 ${JSON.stringify(await read(marker))} 中指定的备份恢复，禁止直接重跑。`);
  if (await exists(path.join(directory, 'pages/index.json'))) return { migrated: false, reason: 'already_current' };
  await requireIdleProject(directory);
  const story = await read(path.join(directory, 'story/pages/index.json'), { by_sequence: {} });
  const characters = await read(path.join(directory, 'characters/pages/index.json'), { pages: [] });
  const scenes = await read(path.join(directory, 'scenes.json'), { scenes: [] });
  const used = new Set();
  const entries = [];
  const allocate = id => { let next = id; while (used.has(next)) next = 'page-' + randomBytes(6).toString('hex'); used.add(next); return next; };
  for (const [sequence_id, ids] of Object.entries(story.by_sequence)) for (const id of ids) entries.push({ oldId: id, oldDirectory: 'story/pages', entry: { page_id: allocate(id), owner_kind: 'story', sequence_id } });
  for (const page of characters.pages) entries.push({ oldId: page.page_id, oldDirectory: 'characters/pages', entry: { ...page, page_id: allocate(page.page_id), owner_kind: 'character' } });
  for (const item of entries) {
    const { entry, oldId, oldDirectory } = item;
    const oldBase = path.join(directory, oldDirectory, oldId);
    const content = entry.owner_kind === 'story'
      ? await read(oldBase + '.narrative.json')
      : await read(oldBase + '.goal.json').then(goal => ({ $schema: 'https://storyvisualizer.local/schemas/story-page-narrative.schema.json', title: goal.title, scene_description: goal.visual_goal ?? '', characters: [{ character_id: entry.character_id, variant_id: entry.variant_id }], dialogue: [] }));
    if (!content) throw new Error(`页面内容缺失：${oldBase}`);
    content.$schema = 'https://storyvisualizer.local/schemas/story-page-narrative.schema.json';
    const prompt = await read(oldBase + '.prompt.json');
    if (!prompt) throw new Error(`页面 Prompt 缺失：${oldBase}`);
    prompt.$schema = 'https://storyvisualizer.local/schemas/story-page-prompt.schema.json';
    if (prompt.scene_id) prompt.scene_variant_id = 'default';
    if (prompt.inheritance) prompt.inheritance = Object.fromEntries(Object.entries(prompt.inheritance).map(([key, value]) => [key.startsWith('scene:') ? key + ':default' : key, value]));
    const errors = [...validateStoryPageNarrativeDocument(content), ...validateStoryPagePromptDocument(prompt)];
    if (errors.length) throw new Error(`${oldBase} 转换校验失败：${errors.join('；')}`);
    item.content = content; item.prompt = prompt;
    item.sources = await read(oldBase + '.text-sources.json');
  }
  const nextIndex = { $schema: 'https://storyvisualizer.local/schemas/pages-index.schema.json', pages: entries.map(item => item.entry) };
  const indexErrors = validatePagesIndexDocument(nextIndex);
  if (indexErrors.length) throw new Error(indexErrors.join('；'));
  const sceneFacts = scenes.scenes.map(scene => {
    const facts = defaultSceneFacts(scene.id, scene.name); facts.prompt.identity.prompt = scene.prompt;
    const errors = validateScenePromptDocument(facts.prompt); if (errors.length) throw new Error(`${scene.id}：${errors.join('；')}`);
    return { id: scene.id, facts };
  });
  const report = { migrated: apply, pages: entries.length, scenes: scenes.scenes.length, renamed: entries.filter(p => p.oldId !== p.entry.page_id).map(p => ({ from: p.oldId, to: p.entry.page_id, owner: p.entry.character_id })) };
  if (!apply) return report;
  const backup = path.resolve(backupDirectory ?? path.join(path.dirname(directory), '.unified-pages-backups', `${path.basename(directory)}-${Date.now()}`));
  if (backup === directory || backup.startsWith(directory + path.sep)) throw new Error('备份必须位于项目目录之外');
  if (await exists(backup)) throw new Error('备份目录已存在');
  await cp(directory, backup, { recursive: true, dereference: false });
  report.backup = backup;
  await save(marker, { kind: 'unified-pages', backup });
  try {
    const mediaPaths = [];
    for (const item of entries) {
      const { entry, oldId, content, prompt, sources } = item;
      await save(path.join(directory, 'pages', entry.page_id + '.content.json'), content);
      await save(path.join(directory, 'pages', entry.page_id + '.prompt.json'), prompt);
      if (sources) await save(path.join(directory, 'pages', entry.page_id + '.text-sources.json'), sources);
      const oldMedia = entry.owner_kind === 'story' ? `Outputs/story/${oldId}` : `Outputs/characters/${entry.character_id}/${oldId}`;
      const newMedia = `Outputs/pages/${entry.page_id}`;
      mediaPaths.push([oldMedia, newMedia]);
      if (await exists(path.join(directory, oldMedia))) {
        await mkdir(path.join(directory, 'Outputs/pages'), { recursive: true });
        await rename(path.join(directory, oldMedia), path.join(directory, newMedia));
        for (const candidate of await readdir(path.join(directory, newMedia), { withFileTypes: true })) {
          if (!candidate.isDirectory()) continue;
          const resultPath = path.join(directory, newMedia, candidate.name, 'result.json');
          const result = await read(resultPath);
          if (result) { result.page_key = { page_id: entry.page_id }; result.file = `${newMedia}/${candidate.name}/image.png`; await save(resultPath, result); }
        }
      }
      if (entry.owner_kind === 'story') {
        const finishedPath = path.join(directory, 'finished', oldId + '.json');
        const finished = await read(finishedPath);
        if (finished) { finished.page_key = { page_id: entry.page_id }; await save(finishedPath, finished); }
      }
    }
    const currentKey = key => {
      const match = entries.find(item => item.oldId === key.page_id && item.entry.owner_kind === key.owner_kind && (key.owner_kind !== 'character' || item.entry.character_id === key.owner_id));
      return { page_id: match?.entry.page_id ?? key.page_id };
    };
    const updateState = value => {
      if (Array.isArray(value)) return value.map(updateState);
      if (!value || typeof value !== 'object') return value;
      const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, updateState(item)]));
      if (value.page_key?.page_id) { next.page_key = currentKey(value.page_key); if (Object.hasOwn(value, 'page_id')) next.page_id = next.page_key.page_id; }
      if (typeof value.file === 'string') for (const [oldMedia, newMedia] of mediaPaths) if (value.file.startsWith(oldMedia + '/')) next.file = newMedia + value.file.slice(oldMedia.length);
      return next;
    };
    // state 是当前任务列表定位；manifest 与 generation 是冻结证据，不改写。
    for (const scope of ['active', 'history']) {
      const root = path.join(directory, 'Saved/render', scope);
      for (const task of await readdir(root, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
        if (!task.isDirectory()) continue;
        const file = path.join(root, task.name, 'state.json'), state = await read(file);
        if (state) await save(file, updateState(state));
      }
    }
    for (const { id, facts } of sceneFacts) for (const [kind, document] of Object.entries(facts)) await save(path.join(directory, 'scenes', `${id}.${kind}.json`), document);
    await save(path.join(directory, 'scenes/index.json'), { $schema: SCENE_INDEX_SCHEMA_ID, scenes: scenes.scenes.map(scene => scene.id) });
    await save(path.join(directory, 'pages/index.json'), nextIndex);
    // 只删除已逐项备份且范围固定的旧事实文件；不递归清理目录。
    for (const item of entries) for (const suffix of ['.narrative.json', '.goal.json', '.prompt.json', '.text-sources.json']) await rm(path.join(directory, item.oldDirectory, item.oldId + suffix), { force: true });
    for (const file of ['story/pages/index.json', 'characters/pages/index.json', 'scenes.json']) await rm(path.join(directory, file), { force: true });
    await rm(marker);
    return report;
  } catch (error) { throw new Error(`迁移中断，请从备份 ${backup} 恢复原项目后再试：${error.message}`, { cause: error }); }
}
