import { storyPageNumbers } from '../shared/story-page-numbers.mjs';
// Agent 只读目录：在 readFacts 边界内读取索引，不装载工作台全文、Prompt 或媒体。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './http-support.mjs';
import { readPageIndex, readPageContent } from './pages-store.mjs';
import { readVisualPageTemplates } from './visual-page-templates.mjs';

const filters = {
  chapter: [], sequence: ['chapter_id'], character: [], scene: [],
  'character.variant': ['character_id'], 'scene.variant': ['scene_id'],
  page: ['page_number', 'owner_kind', 'sequence_id', 'character_id', 'scene_id', 'variant_id'], template: ['owner_kind'],
};
const json = async (directory, relative) => JSON.parse(await readFile(path.join(directory, relative), 'utf8'));
export async function readAgentDirectory(projectRoot, projectDirectory, input) {
  const { kind, offset = 0, limit = 20 } = input;
  if (!Object.hasOwn(filters, kind)) throw new ApiError(400, 'unknown_directory_kind');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, 'invalid_directory_pagination');
  for (const [key, value] of Object.entries(input)) {
    if (!['project_id', 'kind', 'offset', 'limit', ...filters[kind]].includes(key)) throw new ApiError(400, 'unknown_directory_filter', [key]);
    if (key === 'page_number') { if (!Number.isInteger(value) || value < 1) throw new ApiError(400, 'invalid_page_number'); continue; }
    if (filters[kind].includes(key) && (typeof value !== 'string' || !value)) throw new ApiError(400, 'invalid_directory_filter', [key]);
  }
  if (input.owner_kind && !['story', 'character', 'scene'].includes(input.owner_kind)) throw new ApiError(400, 'invalid_directory_owner');
  let items;
  if (kind === 'chapter' || kind === 'sequence') {
    const outline = await json(projectDirectory, 'story/outline.json');
    items = kind === 'chapter' ? outline.chapters.map(({ id, title, sequences }) => ({ id, title, sequence_count: sequences.length }))
      : outline.chapters.filter(c => !input.chapter_id || c.id === input.chapter_id)
        .flatMap(c => c.sequences.map(({ id, title }) => ({ id, title, chapter_id: c.id })));
  } else if (kind === 'page') {
    const pages = (await readPageIndex(projectDirectory)).pages;
    const outline = await json(projectDirectory, 'story/outline.json');
    const numbers = storyPageNumbers(outline.chapters.map(c=>({...c,sequences:c.sequences.map(s=>({...s,pages:pages.filter(p=>p.owner_kind==='story'&&p.sequence_id===s.id)}))})));
    const selected = pages.map(p=>({...p,page_number:numbers.get(p.page_id)??null})).filter(item=>filters.page.every(key=>input[key]===undefined||item[key]===input[key]));
    const items=await Promise.all(selected.slice(offset,offset+limit).map(async item=>({...item,title:(await readPageContent(projectDirectory,item.page_id)).title??'',page_key:{page_id:item.page_id}})));
    return {total:selected.length,offset,items,next_offset:offset+limit<selected.length?offset+limit:null};
  } else if (kind === 'template') {
    const catalog = await readVisualPageTemplates(projectRoot);
    if (catalog.errors.length) throw new ApiError(422, 'invalid_visual_page_templates', catalog.errors);
    items = catalog.templates
      .filter(item => !input.owner_kind || item.applies_to.includes(input.owner_kind))
      .map(({ id, name, category, applies_to }) => ({ id, name, category, applies_to }));
  } else {
    const entity = kind.split('.')[0], folder = entity === 'character' ? 'characters' : 'scenes';
    const ids = (await json(projectDirectory, `${folder}/index.json`))[folder];
    if (kind.endsWith('.variant')) {
      const id = input[`${entity}_id`];
      if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !ids.includes(id)) throw new ApiError(404, `${entity}_not_found`, [id]);
      items = (await json(projectDirectory, `${folder}/${id}.visual.json`)).variants.map(({ id: variant_id, name }) => ({ id: variant_id, name, [`${entity}_id`]: id }));
    } else {
      // 先分页再读取显示名，不为一页目录加载所有角色／场景正文。
      const selected = await Promise.all(ids.slice(offset, offset + limit).map(async id => {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new ApiError(422, 'invalid_directory_id');
        const profile = await json(projectDirectory, `${folder}/${id}.profile.json`);
        return { id, name: profile.name };
      }));
      return { total: ids.length, offset, items: selected, next_offset: offset + limit < ids.length ? offset + limit : null };
    }
  }
  return { total: items.length, offset, items: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null };
}
