import { inheritanceCategories, characterSource } from './prompt-inheritance.mjs';
import {settingLoras} from './lora-inheritance.mjs';

// 浏览器当前模型草稿与服务端各模型事实使用同一变换。不猜测自由词或显式 LoRA 的归属。
export function cleanPageCharacterInput(input, beforeCharacters = [], afterCharacters = [], loraScope) {
  const next = structuredClone(input);
  const retained = new Set(afterCharacters.map(ref => ref.character_id));
  const removed = new Set(beforeCharacters.map(ref => ref.character_id).filter(id => !retained.has(id)));
  const keep = new Set(afterCharacters.map(ref => characterSource(ref.character_id, ref.variant_id)));
  for (const field of ['text_overrides','reference_overrides','inheritance'])
    for (const source of Object.keys(next[field] ?? {}))
      if (source.startsWith('character:') && !keep.has(source)) delete next[field][source];
  for (const category of inheritanceCategories)
    if (Array.isArray(next[category])) next[category] = next[category].filter(fragment => !removed.has(fragment.character_id));
  for (const id of Object.keys(next.trigger_sources?.characters ?? {}))
    if (!retained.has(id) || beforeCharacters.some(ref=>ref.character_id===id&&!keep.has(characterSource(id,ref.variant_id)))) delete next.trigger_sources.characters[id];
  if (loraScope) {
    const {beforeSources,afterSources,styleLoras}=loraScope;
    const removedSources=Object.entries(beforeSources).filter(([key])=>!Object.hasOwn(afterSources,key));
    const complete=styleLoras!==undefined && [...Object.values(beforeSources),...Object.values(afterSources)].every(source=>!source.missing&&source.identity&&source.variant);
    if (complete) {
      const affected=new Set(removedSources.flatMap(([,source])=>settingLoras(source.identity,source.variant).map(lora=>lora.filename)));
      const retainedFiles=new Set([...styleLoras,...(input.loras ?? []),...Object.values(afterSources).flatMap(source=>settingLoras(source.identity,source.variant))].map(lora=>lora.filename));
      for (const filename of Object.keys(next.lora_overrides ?? {})) if(affected.has(filename)&&!retainedFiles.has(filename)) delete next.lora_overrides[filename];
    }
  }
  return next;
}
