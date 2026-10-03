import {resolvedSettingEntries, promptText, promptWord, promptDuplicateKey, inheritanceCategories} from './prompt-inheritance.mjs';

export function qwenSourceSelection(setting, pagePrompt, source) {
  return {text:pagePrompt.text_overrides?.[source] ?? setting.text ?? '',
    reference_images:setting.reference_images ?? [],
    selected_image_ids:pagePrompt.reference_overrides?.[source] ?? (setting.reference_images ?? []).slice(0,1).map(entry=>entry.id)};
}

export function promptSourceView(source, value, prompt = {}, {baseOnly = false} = {}) {
  const {identity,variant,...metadata} = value;
  if (!identity || !variant) return {source,...metadata,...(variant ? qwenSourceSelection(variant,prompt,source) : {})};
  const adjustments = baseOnly ? prompt.identity_overrides : prompt.inheritance?.[source];
  // 子设定编辑展示基础本身，不再应用该子设定自己的基础调整两次。
  const rows = resolvedSettingEntries(identity,baseOnly ? {prompt:{}} : variant,adjustments,value.kind);
  return {source,...metadata,entries:rows.map(({fragment,category,key,enabled,consumed})=>({
    key,category,text:promptText(fragment),weight:fragment.weight ?? 1,enabled,consumed,
    ...(adjustments?.[key] ? {override:adjustments[key]} : {}),
  })),loras:{identity:identity.lora ?? null,local:variant.loras ?? [],overrides:variant.lora_overrides ?? {}}};
}

// 检查结果描述事实，不决定删词；生成编译仍保留自己的顺序和抑制政策。
export function promptPageDiagnostics(prompt, references, sources, modelId) {
  const issues = [];
  const ids = new Set(references.map(ref=>ref.character_id));
  const sourceMap = new Map(sources.map(source=>[source.source,source]));
  for (const source of sources) {
    if (source.missing) issues.push({code:'source_missing',severity:'error',source:source.source,reason:source.missing});
    if (modelId === 'anima' && !source.missing && !(source.entries ?? []).some(entry=>entry.consumed))
      issues.push({code:'source_has_no_consumed_words',severity:'info',source:source.source});
  }
  for (const field of ['inheritance','text_overrides','reference_overrides']) for (const [source,adjustments] of Object.entries(prompt[field] ?? {})) {
    const current = sourceMap.get(source);
    if (!current) issues.push({code:'unused_source_override',severity:'warning',field,source});
    else if (field === 'inheritance') for (const key of Object.keys(adjustments))
      if (!(current.entries ?? []).some(entry=>entry.key===key)) issues.push({code:'missing_inherited_key',severity:'warning',source,key});
  }
  if (modelId !== 'anima') {
    for (const source of sources) for (const id of source.selected_image_ids ?? [])
      if (!source.reference_images?.some(image=>image.id===id)) issues.push({code:'selected_image_missing',severity:'error',source:source.source,id});
    return issues;
  }
  const words=[];
  for (const source of sources.filter(value=>!value.missing)) for (const entry of source.entries ?? []) if (entry.enabled)
    words.push({...entry,owner:['setting','camera'].includes(entry.category)?'environment':source.kind==='character'?source.id:'environment',location:{source:source.source,key:entry.key}});
  for (const category of inheritanceCategories) (prompt[category] ?? []).forEach((entry,index)=>{
    const location={category,index};
    if (entry.character_id && !ids.has(entry.character_id)) issues.push({code:'unreferenced_character_binding',severity:'error',...location,character_id:entry.character_id});
    if (category==='person' && !entry.character_id) issues.push({code:'unbound_person_word',severity:'info',...location});
    if (entry.enabled !== false) words.push({category,text:promptText(entry),weight:entry.weight ?? 1,owner:['setting','camera'].includes(category)?'environment':entry.character_id ?? 'environment',unbound:!entry.character_id,location});
  });
  const seen=new Map();
  for (const word of words) {
    const text=promptWord(word.text);if (!text) continue;
    const key=promptDuplicateKey(word.category,word.owner,text);
    const previous=seen.get(key);
    if (previous) issues.push({code:'same_owner_repeated_text',severity:'warning',policy:'inherited_validation',locations:[previous.location,word.location],weights:[previous.weight,word.weight],same_weight:previous.weight===word.weight,consumed:[previous.consumed!==false,word.consumed!==false]});
    else seen.set(key,word);
    if (word.unbound && word.category==='person') {
      const matches=words.filter(item=>item.location.source?.startsWith('character:') && item.category!=='avoid' && promptWord(item.text)===text);
      if (matches.length) issues.push({code:'unbound_matches_inherited',severity:'info',...word.location,matches:matches.map(item=>({ ...item.location,weight:item.weight})),weight:word.weight});
    }
  }
  for (const id of Object.keys(prompt.trigger_sources?.characters ?? {})) if (!ids.has(id))
    issues.push({code:'unused_trigger_source',severity:'warning',character_id:id});
  return issues;
}
