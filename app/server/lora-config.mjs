import {mergeInheritedLoras} from '../shared/lora-inheritance.mjs';
const sha256Pattern = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStableIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSafeLoraFilename(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) return false;
  if (value.includes("\\") || value.includes("\0") || value.includes(":")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function validateLoraDefinition(value, prefix) {
  const errors = [];
  if (!isRecord(value)) return [`${prefix} 必须是对象`];
  const allowed = new Set(["filename", "sha256", "weight", "trigger"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${prefix} 包含未知字段：${key}`);
  }
  if (!isSafeLoraFilename(value.filename)) errors.push(`${prefix}.filename 必须是 loras 目录下的安全相对路径`);
  if (typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256)) {
    errors.push(`${prefix}.sha256 必须是 64 位小写十六进制字符串`);
  }
  if (typeof value.weight !== "number" || !Number.isFinite(value.weight) || value.weight < -2 || value.weight > 2) {
    errors.push(`${prefix}.weight 必须是 -2 到 2 之间的有限数值`);
  }
  if (value.trigger !== undefined && (typeof value.trigger !== "string" || !value.trigger.trim())) {
    errors.push(`${prefix}.trigger 必须是非空字符串`);
  }
  return errors;
}

export function validateStyleLoras(profile) {
  if (!isRecord(profile?.style_loras)) return [`${profile?.id ?? "当前生成配置"}.style_loras 必须是对象`];
  return Object.keys(profile.style_loras).sort(compareStableIds)
    .flatMap((id) => validateLoraDefinition(profile.style_loras[id], `${profile.id ?? "当前生成配置"}.style_loras.${id}`));
}

function normalizedLora(lora, kind, owner) {
  return {
    kind,
    owner,
    filename: lora.filename,
    sha256: lora.sha256,
    weight: lora.weight,
  };
}

export function resolveParticipantLoras(profile, participantIds, characters = [], pageId = "当前页面", scenes = []) {
  const errors = [...validateStyleLoras(profile)];
  const resolved = [];
  const byFilename = new Map();

  function append(lora, kind, owner, prefix) {
    const validation = validateLoraDefinition(lora, prefix);
    errors.push(...validation);
    if (validation.length) return;
    const next = normalizedLora(lora, kind, owner);
    const current = byFilename.get(next.filename);
    if (current) {
      if (current.sha256 !== next.sha256 || current.weight !== next.weight) {
        errors.push(`${pageId} 的 LoRA ${next.filename} 在 ${current.kind}:${current.owner} 与 ${kind}:${owner} 之间配置冲突`);
      }
      return;
    }
    byFilename.set(next.filename, next);
    resolved.push(next);
  }

  for (const id of Object.keys(profile.style_loras ?? {}).sort(compareStableIds)) {
    append(profile.style_loras[id], "style", profile.id, `${profile.id}.style_loras.${id}`);
  }

  const characterById = new Map(characters.map((character) => [character.id, character]));
  const sources = [
    ...(participantIds ?? []).map(id => ({ kind: "character", owner: id, value: characterById.get(id) })),
    ...scenes.map(scene => ({ kind: "scene", owner: scene.id, value: scene })),
  ];
  for (const { kind, owner, value } of sources) {
    for (const [index, lora] of (Array.isArray(value?.loras) ? value.loras : []).entries()) {
      append(lora, kind, owner, `${kind}s.${owner}.loras[${index}]`);
    }
  }

  return { loras: resolved, errors: [...new Set(errors)] };
}

export function styleLoraTriggers(profile) {
  return [...new Set(Object.keys(profile?.style_loras ?? {}).sort(compareStableIds)
    .map((id) => profile.style_loras[id])
    .map((lora) => typeof lora?.trigger === "string" ? lora.trigger.trim() : "")
    .filter(Boolean))];
}

function inheritedSources(profile, characters = [], scenes = []) {
  return [...Object.keys(profile?.style_loras ?? {}).sort(compareStableIds).map(id=>({lora:profile.style_loras[id],kind:'style',owner:profile.id})),
    ...characters.flatMap(value=>(value.loras??[]).map(lora=>({lora,kind:'character',owner:value.id}))),
    ...scenes.flatMap(value=>(value.loras??[]).map(lora=>({lora,kind:'scene',owner:value.id})))];
}
export function pageLoraDefinitions(profile, prompt, characters = [], scenes = []) {
  return mergeInheritedLoras(inheritedSources(profile,characters,scenes).map(value=>value.lora),prompt.loras,prompt.lora_overrides);
}
export function explicitPageLoras(prompt, pageId, profile, characters = [], scenes = []) {
  const errors = profile ? validateStyleLoras(profile) : [];
  const loras=[], local=new Map(), inherited=new Map();
  for(const lora of prompt.loras??[]) {
    if(local.has(lora.filename))errors.push('LoRA 重复：'+lora.filename);
    local.set(lora.filename,lora);
  }
  for(const source of inheritedSources(profile,characters,scenes)) {
    const previous=inherited.get(source.lora.filename);
    if(previous && !local.has(source.lora.filename) && prompt.lora_overrides?.[source.lora.filename]?.enabled!==false &&
      (previous.lora.sha256!==source.lora.sha256 || previous.lora.weight!==source.lora.weight && prompt.lora_overrides?.[source.lora.filename]?.weight===undefined))errors.push(pageId+' 的继承 LoRA 配置冲突：'+source.lora.filename);
    inherited.set(source.lora.filename,source);
  }
  for(const [index,item] of pageLoraDefinitions(profile,prompt,characters,scenes).entries()) {
    const {enabled,...definition}=item; errors.push(...validateLoraDefinition(definition,pageId+'.loras['+index+']'));
    const source=inherited.get(definition.filename);
    if(enabled!==false)loras.push({...definition,kind:local.has(definition.filename)?'page':source?.kind??'page',owner:local.has(definition.filename)?pageId:source?.owner??pageId});
  }
  return {loras,errors};
}
// 触发词与实际启用的 LoRA 共用继承结果，并保留旧迁移页面的来源位置。
export function pageLoraTriggers(prompt, kind, owner, fallback = [], profile = null, characters = [], scenes = []) {
  const active=[...new Set(pageLoraDefinitions(profile,prompt,characters,scenes).filter(lora=>lora.enabled!==false).map(lora=>lora.trigger?.trim()).filter(Boolean))];
  const sources=prompt.trigger_sources;
  const inherited=inheritedSources(profile,characters,scenes);
  const roleTriggers=inherited.filter(value=>value.kind!=='style').map(value=>value.lora.trigger).filter(Boolean);
  const legacy=[...Object.values(sources?.characters??{}).flat(),...Object.values(sources?.scenes??{}).flat()];
  if(kind==='style')return active.filter(trigger=>!roleTriggers.includes(trigger)&&!legacy.includes(trigger));
  const original=[...fallback,...(sources?.[kind]?.[owner]??[])];
  return [...new Set(original.filter(trigger=>active.includes(trigger)))];
}
