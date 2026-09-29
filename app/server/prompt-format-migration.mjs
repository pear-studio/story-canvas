import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {commitFactChanges} from './story-facts.mjs';
import {validateStoryPagePromptDocument} from './story-files.mjs';
import {validateCharacterPromptDocument} from './character-files.mjs';
import {validateScenePromptDocument} from './scene-files.mjs';
import {compilePagePromptSnapshot} from './page-render-resolver.mjs';

// 一次性旧格式转换，独立于当前继承解析器；不作为产品兼容入口。
const categories = ['population', 'person', 'setting', 'camera', 'avoid'];
const word = value => String(value).toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
const text = fragment => fragment.tag ?? fragment.description ?? fragment.prompt_text ?? '';
const oldKey = (fragment, category) => (category === 'avoid' ? 'negative:' : '') + word(text(fragment));
const rows = (prompt, scope) => categories.flatMap(category => (prompt?.[category] ?? []).map(fragment => ({fragment, category, key:oldKey(fragment, category), reference:`${scope}:${fragment.id}`})));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function migrateAnimaSettingPrompt(input) {
  const result = structuredClone(input);
  const base = rows(input.identity?.prompt, 'identity');
  for (const [variantId, variant] of Object.entries(input.variants ?? {})) {
    const adjustments = {};
    for (const disabled of variant.identity_disabled ?? []) {
      const matches = base.filter(row => word(text(row.fragment)) === word(disabled));
      if (!matches.length) throw new Error(`子设定旧停用词无法匹配：${variantId}`);
      for (const row of matches) adjustments[row.reference] = {enabled:false};
    }
    for (const [key, value] of Object.entries(variant.identity_overrides ?? {})) {
      const matches = base.filter(row => row.key === key);
      if (!matches.length) throw new Error(`子设定旧覆盖词无法匹配：${variantId}`);
      for (const row of matches) adjustments[row.reference] = {...adjustments[row.reference], ...value};
    }
    delete result.variants[variantId].identity_disabled;
    delete result.variants[variantId].identity_overrides;
    if (Object.keys(adjustments).length) result.variants[variantId].identity_overrides = adjustments;
  }
  return result;
}

export function migrateAnimaPagePrompt(input, settings) {
  const result = structuredClone(input), removed = [];
  for (const category of categories) for (const fragment of result[category] ?? []) delete fragment.id;
  if (input.inheritance) {
    result.inheritance = {};
    for (const [source, adjustments] of Object.entries(input.inheritance)) {
      const [kind, id, variantId] = source.split(':');
      const setting = settings.get(`${kind}:${id}`), variant = setting?.variants?.[variantId];
      if (!variant) throw new Error(`页面继承来源不存在：${source}`);
      const available = [...rows(setting.identity?.prompt, 'identity'), ...rows(variant.prompt, 'variant')];
      const converted = {};
      for (const [key, value] of Object.entries(adjustments)) {
        const matches = available.filter(row => row.key === key);
        if (!matches.length) { removed.push({source, old_key:key, adjustment:structuredClone(value)}); continue; }
        for (const row of matches) converted[row.reference] = structuredClone(value);
      }
      if (Object.keys(converted).length) result.inheritance[source] = converted;
    }
    if (!Object.keys(result.inheritance).length) delete result.inheritance;
  }
  return {prompt:result, removed};
}

export function planPromptFormatMigration(files) {
  const settings = new Map(), changes = [], removed = [];
  for (const file of files) {
    const match = /^(characters|scenes)\/([^/]+)\.prompt\.json$/.exec(file.relative);
    if (match && file.document.models?.anima) settings.set(`${match[1] === 'characters' ? 'character' : 'scene'}:${match[2]}`, file.document.models.anima);
  }
  for (const file of files) {
    const input = file.document.models?.anima;
    if (!input) continue;
    const after = structuredClone(file.document);
    if (file.relative.startsWith('pages/')) {
      const converted = migrateAnimaPagePrompt(input, settings);
      after.models.anima = converted.prompt;
      removed.push(...converted.removed.map(item => ({file:file.relative, ...item})));
    } else after.models.anima = migrateAnimaSettingPrompt(input);
    if (!same(file.document, after)) changes.push({relative:file.relative, before:file.document, after, sha256:file.sha256});
  }
  return {changes, removed};
}

export function validatePromptFormatMigration(plan) {
  for (const change of plan.changes) {
    const validate = change.relative.startsWith('pages/') ? validateStoryPagePromptDocument
      : change.relative.startsWith('characters/') ? validateCharacterPromptDocument : validateScenePromptDocument;
    const errors = validate(change.after);
    if (errors.length) throw new Error(`迁移格式检查失败：${change.relative}\n${errors.join('\n')}`);
  }
}

export function migratedPromptSnapshot(snapshot, plan) {
  const result = structuredClone(snapshot);
  if (result.model_id !== 'anima') return result;
  const documents = new Map(plan.changes.map(change => [change.relative, change.after]));
  const pageDocument = documents.get(`pages/${result.page_id}.prompt.json`);
  if (pageDocument) { result.page_prompt = pageDocument.models.anima; result.prompt_document = pageDocument; }
  for (const [field, folder] of [['characters', 'characters'], ['scenes', 'scenes']]) {
    result[field] = result[field].map(setting => {
      const document = documents.get(`${folder}/${setting.id}.prompt.json`)?.models?.anima;
      if (!document) return setting;
      const {identity_disabled:_disabled, identity_overrides:_overrides, ...current} = setting;
      const variant = structuredClone(document.variants[setting.configuration_id]);
      return {...current, ...variant, identity:structuredClone(document.identity), loras:current.loras, local_loras:variant.loras ?? []};
    });
  }
  return result;
}

export function promptMigrationComparable(compiled) {
  return {
    positive_prompt:compiled.positive_prompt, negative_prompt:compiled.negative_prompt,
    loras:compiled.loras ?? [], images:compiled.images ?? [],
  };
}

export function comparePromptFormatMigration(baseline, plan) {
  const failures = [], skipped = [], existingBlocked = [];
  for (const page of baseline.pages) {
    if (!page.compiled) { skipped.push({page_id:page.page_id, error:page.error}); continue; }
    if (!page.compiled.ready) existingBlocked.push({page_id:page.page_id, errors:page.compiled.errors?.length ?? 0, missing:page.compiled.missing?.length ?? 0});
    const actual = compilePagePromptSnapshot(migratedPromptSnapshot(page.snapshot, plan), page.profile);
    if (!same(promptMigrationComparable(page.compiled), promptMigrationComparable(actual)) || (page.compiled.ready && !actual.ready)) failures.push(page.page_id);
  }
  return {checked:baseline.pages.length - skipped.length, failures, skipped, existing_blocked:existingBlocked};
}

export async function backupPromptFormatMigration(projectDirectory, plan, backupDirectory) {
  const manifest = {project_directory:path.resolve(projectDirectory), created_at:new Date().toISOString(), files:[], removed:plan.removed};
  for (const change of plan.changes) {
    const bytes = await readFile(path.join(projectDirectory, change.relative));
    if (sha256(bytes) !== change.sha256) throw new Error(`迁移基线已变化：${change.relative}`);
    const target = path.join(backupDirectory, change.relative);
    await mkdir(path.dirname(target), {recursive:true});
    await writeFile(target, bytes, {flag:'wx'});
    if (sha256(await readFile(target)) !== change.sha256) throw new Error(`迁移备份校验失败：${change.relative}`);
    manifest.files.push({relative:change.relative, sha256:change.sha256});
  }
  await writeFile(path.join(backupDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
  return manifest;
}

// 调用方通过 ProjectOperations 持有项目写锁；项目事实只交既有领域事务提交。
export async function commitPromptFormatMigration(projectDirectory, plan) {
  validatePromptFormatMigration(plan);
  for (const change of plan.changes) {
    if (sha256(await readFile(path.join(projectDirectory, change.relative))) !== change.sha256) throw new Error(`迁移基线已变化：${change.relative}`);
  }
  await commitFactChanges(projectDirectory, plan.changes);
  try {
    for (const change of plan.changes) {
      if (!same(JSON.parse(await readFile(path.join(projectDirectory, change.relative), 'utf8')), change.after)) throw new Error(`迁移读回不一致：${change.relative}`);
    }
  } catch (error) {
    await restorePromptFormatMigration(projectDirectory, plan);
    throw error;
  }
  return {changed_files:plan.changes.length, removed_adjustments:plan.removed.length};
}

export async function restorePromptFormatMigration(projectDirectory, plan) {
  await commitFactChanges(projectDirectory, plan.changes.map(change => ({relative:change.relative, before:change.after, after:change.before})));
  for (const change of plan.changes) {
    if (!same(JSON.parse(await readFile(path.join(projectDirectory, change.relative), 'utf8')), change.before)) throw new Error(`迁移恢复读回不一致：${change.relative}`);
  }
}
