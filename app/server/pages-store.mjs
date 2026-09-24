// 页面索引是归属和组内顺序的唯一事实；内容与媒体始终通过项目唯一 page_id 定位。
import path from 'node:path';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isPageId } from './page-key.mjs';
import { STORY_PAGES_INDEX_SCHEMA_ID } from './story-files.mjs';
export const PAGES_INDEX_SCHEMA_ID = 'https://storyvisualizer.local/schemas/pages-index.schema.json';
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function validatePagesIndexDocument(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['pages index 必须是对象'];
  if (value.$schema !== PAGES_INDEX_SCHEMA_ID) errors.push('pages index.$schema 不匹配');
  if (Object.keys(value).some(key => !['$schema','pages'].includes(key))) errors.push('pages index 包含未知字段');
  if (!Array.isArray(value.pages)) return [...errors,'pages index.pages 必须是数组'];
  const seen = new Set();
  for (const entry of value.pages) {
    if (!entry || typeof entry !== 'object') { errors.push('页面归属必须是对象'); continue; }
    if (!isPageId(entry.page_id) || seen.has(entry.page_id)) errors.push('页面 ID 无效或重复：' + entry.page_id);
    seen.add(entry.page_id);
    const fields = entry.owner_kind === 'story' ? ['sequence_id'] : entry.owner_kind === 'character' ? ['character_id','variant_id'] : entry.owner_kind === 'scene' ? ['scene_id','variant_id'] : null;
    if (!fields) { errors.push('页面归属类型无效'); continue; }
    for (const field of fields) if (!idPattern.test(entry[field] ?? '')) errors.push('页面归属字段无效：' + field);
    if (Object.keys(entry).some(key => !['page_id','owner_kind',...fields].includes(key))) errors.push('页面归属包含未知字段');
  }
  return errors;
}
export function pageRelativePath(pageId, kind) {
  if (!isPageId(pageId)) throw new TypeError('无效页面 ID');
  const normalized = kind === 'narrative' || kind === 'goal' ? 'content' : kind;
  if (!['content','prompt','rewrite','text-sources'].includes(normalized)) throw new TypeError('无效页面事实类型');
  return `pages/${pageId}.${normalized}.json`;
}
export async function readPageIndex(directory) {
  const value = JSON.parse(await readFile(path.join(directory,'pages','index.json'),'utf8'));
  const errors = validatePagesIndexDocument(value);
  if (errors.length) throw new TypeError(errors.join('；'));
  return value;
}
export async function writePageIndex(directory,value) {
  const errors = validatePagesIndexDocument(value);
  if (errors.length) throw new TypeError(errors.join('；'));
  const target = path.join(directory,'pages','index.json');
  await mkdir(path.dirname(target),{recursive:true});
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n');
  await rename(temporary,target);
}
export async function readPageEntry(directory,id) { return (await readPageIndex(directory)).pages.find(page=>page.page_id===id) ?? null; }
export async function readPageContent(directory,id) { return JSON.parse(await readFile(path.join(directory,pageRelativePath(id,'content')),'utf8')); }
export async function readPagePrompt(directory,id) { return JSON.parse(await readFile(path.join(directory,pageRelativePath(id,'prompt')),'utf8')); }
export function storyPagesIndexProjection(index) {
  const by_sequence = {};
  for(const page of index.pages) if(page.owner_kind==='story') (by_sequence[page.sequence_id] ??= []).push(page.page_id);
  return {$schema:STORY_PAGES_INDEX_SCHEMA_ID,by_sequence};
}
export async function readStoryPagesIndex(directory) {return storyPagesIndexProjection(await readPageIndex(directory));}
export function mergeStoryPagesIndex(current,index) {
  return {$schema:PAGES_INDEX_SCHEMA_ID,pages:[...current.pages.filter(page=>page.owner_kind!=='story'),...Object.entries(index.by_sequence).flatMap(([sequence_id,ids])=>ids.map(page_id=>({page_id,owner_kind:'story',sequence_id})))]};
}
export async function writeStoryPagesIndex(directory,index) {return writePageIndex(directory,mergeStoryPagesIndex(await readPageIndex(directory),index));}
