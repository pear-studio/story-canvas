import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ApiError } from './http-support.mjs';
import { saveMaterial, openMaterialFile } from './project-materials.mjs';
import { deleteMaterial } from './project-materials.mjs';
import { promptModelEntries } from './model-prompts.mjs';
import {readCandidateResult} from './candidate-storage.mjs';
import {resolveExistingProjectMedia} from './render-media.mjs';
export async function promptDocuments(directory) {
  const result = [];
  for (const folder of ['pages', 'characters', 'scenes']) {
    for (const file of await readdir(path.join(directory, folder)).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
      if (!file.endsWith('.prompt.json')) continue;
      result.push({ file: `${folder}/${file}`, document: JSON.parse(await readFile(path.join(directory, folder, file), 'utf8')) });
    }
  }
  return result;
}
export async function removeUnusedFile(directory, file) {
  if (!file || !/^reference-[a-f0-9-]+\.png$/.test(file)) return;
  const documents = await promptDocuments(directory);
  if (documents.some(({ document }) => JSON.stringify(document).includes(JSON.stringify(file)))) return;
  await deleteMaterial(directory, file, { allowMissing: true });
}


export async function cleanRemovedReferences(directory, document) {
  if (document === null) return;
  const entries = promptModelEntries(document).flatMap(([,input]) => [...(input?.reference_images ?? []), ...Object.values(input?.variants ?? {}).flatMap(v => v.reference_images ?? [])]);
  for (const file of new Set(entries.map(e => e.file))) await removeUnusedFile(directory, file);
}

export async function checkRemovedSettingReferences(directory, writes) {
  const removals = [];
  for (const write of writes) {
    const match = /^(characters|scenes)\/([a-z0-9-]+)\.prompt\.json$/.exec(write.relative);
    if (!match || write.before === null) continue;
    const afterModels = new Map(write.after === null ? [] : promptModelEntries(write.after));
    for (const [modelId, input] of promptModelEntries(write.before)) for (const [variantId, variant] of Object.entries(input?.variants ?? {})) {
      const nextIds = new Set((afterModels.get(modelId)?.variants?.[variantId]?.reference_images ?? []).map(entry => entry.id));
      const removed = (variant.reference_images ?? []).filter(entry => !nextIds.has(entry.id));
      if (removed.length) removals.push({ modelId, source: `${match[1] === 'characters' ? 'character' : 'scene'}:${match[2]}:${variantId}`, ids: new Set(removed.map(entry => entry.id)) });
    }
  }
  if (!removals.length) return;
  const used = (await promptDocuments(directory)).filter(record => {
    const document = writes.find(write => write.relative === record.file)?.after ?? record.document;
    return promptModelEntries(document).some(([modelId,input]) => removals.some(removal => removal.modelId === modelId && input?.reference_overrides?.[removal.source]?.some(id => removal.ids.has(id))));
  }).map(record => record.file);
  if (used.length) throw new ApiError(409, 'reference_image_in_use', ['这些页面手动引用了该图，请先取消引用或恢复默认', ...used]);
}

// 整页草稿仅在提交时落地；任一图片或事实提交失败时，调用方清理本轮文件。
export async function savePageReferenceInputs(directory, projectId, prompt, inputs, created) {
  if (!Array.isArray(inputs) || new Set(inputs.map(input => input?.id)).size !== inputs.length) throw new ApiError(400, 'invalid_reference_inputs');
  for (const input of inputs) {
    const entry = prompt.reference_images?.find(entry => entry.id === input.id);
    if (!entry || Object.keys(input).some(key => !['id', 'content', 'material_file','candidate_id','page_key'].includes(key)) || [input.content,input.material_file,input.candidate_id].filter(Boolean).length !== 1 || Boolean(input.candidate_id)!==Boolean(input.page_key)) throw new ApiError(400, 'invalid_reference_inputs');
    // 目标路径已由 Prompt 契约校验；草稿新图片不可覆盖已有素材。
    const exists = await stat(path.join(directory, 'materials', entry.file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw new ApiError(409, 'reference_file_conflict');
    let bytes;
    if(input.candidate_id) {
      const result=await readCandidateResult(directory,input.page_key,input.candidate_id);
      const media=result&&await resolveExistingProjectMedia(directory,result.file);
      if(!media)throw new ApiError(404,'candidate_image_missing');
      bytes=await readFile(media.target);
    } else bytes = input.content ? Buffer.from(input.content, 'base64') : await readFile((await openMaterialFile(directory, input.material_file)).target);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new ApiError(422, 'invalid_reference_image');
    const metadata = await sharp(bytes).metadata();
    if (!['png','jpeg','webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new ApiError(422, 'invalid_reference_image');
    const content = await sharp(bytes).rotate().png().toBuffer();
    created.push(entry.file);
    await saveMaterial(directory, projectId, { file: entry.file, title: entry.title, encoding: 'base64', content: content.toString('base64') });
  }
}
