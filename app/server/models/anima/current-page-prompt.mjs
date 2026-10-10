import {cameraPromptEntries} from '../../../shared/camera-prompt.mjs';
import { effectivePromptEntries, resolvedSettingEntries, characterSource, sceneSource, duplicatePromptWords } from '../../../shared/prompt-inheritance.mjs';
import { explicitPageLoras, resolvePageLoras } from "../../lora-config.mjs";
import { validatePageKey } from "../../page-key.mjs";
import { auditPromptContext } from "./prompt-audit.mjs";
import {
  PAGE_POSITIVE_PROMPT_CATEGORIES,
  isPromptPopulationControl,
  promptFragmentRecord,
  promptFragmentWeight,
} from "./prompt-contract.mjs";
import { storyPromptCategories } from "./story-files.mjs";
import { inlinePromptWeights } from "../../../shared/inline-prompt-weight.mjs";
import { resolvePromptTagMarkers } from "../../../shared/prompt-tags.mjs";
import { lookupPromptDictionaryEntry } from "../../prompt-dictionary.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStableIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentFragment(fragment) {
  const textKey = ["tag", "description"].find((key) => Object.hasOwn(fragment, key));
  const promptType = textKey === "tag" ? "danbooru" : "custom_description";
  const text = fragment[textKey];
  return {
    ...(fragment.id === undefined ? {} : { id: fragment.id }),
    prompt_type: promptType,
    prompt_text: text,
    ...(fragment.character_id ? { role: fragment.character_id } : {}),
    ...(fragment.weight === undefined ? {} : { weight: fragment.weight }),
    ...(fragment.enabled === undefined ? {} : { enabled: fragment.enabled }),
  };
}

function profilePromptRules(profile) {
  const prompt = isRecord(profile?.prompt) ? profile.prompt : {};
  const order = Array.isArray(prompt.category_order) ? prompt.category_order : [];
  const expected = new Set(PAGE_POSITIVE_PROMPT_CATEGORIES);
  const unknown = order.filter((category) => !expected.has(category));
  const duplicates = order.filter((category, index) => order.indexOf(category) !== index);
  const missing = PAGE_POSITIVE_PROMPT_CATEGORIES.filter((category) => !order.includes(category));
  const categoryOrderErrors = [];
  if (unknown.length) categoryOrderErrors.push(`prompt.category_order 包含未知分类：${[...new Set(unknown)].join("、")}`);
  if (duplicates.length) categoryOrderErrors.push(`prompt.category_order 包含重复分类：${[...new Set(duplicates)].join("、")}`);
  if (missing.length) categoryOrderErrors.push(`prompt.category_order 缺少分类：${missing.join("、")}`);
  if (order.length !== PAGE_POSITIVE_PROMPT_CATEGORIES.length && !missing.length && !unknown.length && !duplicates.length) {
    categoryOrderErrors.push(`prompt.category_order 必须恰好包含 ${PAGE_POSITIVE_PROMPT_CATEGORIES.length} 个正向页面分类`);
  }
  const polarityRank = new Map([["positive", 0], ["negative", 1]]);
  const placementRank = new Map([["prefix", 0], ["suffix", 1]]);
  const fragments = Object.entries(isRecord(prompt.fragments) ? prompt.fragments : {})
    .map(([id, fragment]) => ({ id, fragment }))
    .sort((left, right) => (polarityRank.get(left.fragment?.polarity) ?? 99) - (polarityRank.get(right.fragment?.polarity) ?? 99)
      || (placementRank.get(left.fragment?.placement) ?? 99) - (placementRank.get(right.fragment?.placement) ?? 99)
      || Number(left.fragment?.order ?? 0) - Number(right.fragment?.order ?? 0)
      || compareStableIds(left.id, right.id));
  const seen = new Set();
  const uniqueFragments = fragments.filter(({ fragment }) => {
    const key = `${fragment?.polarity}:${String(fragment?.prompt_text ?? "").trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    categoryOrder: categoryOrderErrors.length ? [...PAGE_POSITIVE_PROMPT_CATEGORIES] : [...order],
    categoryOrderErrors,
    separator: typeof prompt.separator === "string" ? prompt.separator : ", ",
    family: String(prompt.family ?? ""),
    positivePrefix: uniqueFragments.filter(({ fragment }) => fragment?.polarity === "positive" && fragment?.placement === "prefix"),
    positiveSuffix: uniqueFragments.filter(({ fragment }) => fragment?.polarity === "positive" && fragment?.placement === "suffix"),
    negativeFragments: uniqueFragments.filter(({ fragment }) => fragment?.polarity === "negative"),
    avoidanceStrategy: String(prompt.avoidance_strategy ?? ""),
  };
}

function encodedWeight(weight) {
  return Number(weight.toFixed(3)).toString();
}

export function encodePromptFragment(fragment) {
  const original = String(fragment?.prompt_text ?? "").trim();
  const raw = resolvePromptTagMarkers(original);
  const text = fragment?.prompt_type === "custom_description" ? inlinePromptWeights(raw).encoded : raw;
  const weight = promptFragmentWeight(fragment);
  return weight === 1 ? text : `(${text}:${encodedWeight(weight)})`;
}

function tracePart(fragment, metadata) {
  const record = promptFragmentRecord(fragment, metadata);
  return {
    category: record.category || null,
    role: record.role ?? null,
    prompt_type: fragment?.prompt_type ?? null,
    prompt_text: String(fragment?.prompt_text ?? "").trim(),
    weight: promptFragmentWeight(fragment),
    origin: metadata.origin ?? record.source_kind,
    origin_id: (metadata.origin_id ?? record.source_id) || null,
    origin_detail: metadata.origin_detail ? structuredClone(metadata.origin_detail) : null,
    audit_source_kind: record.source_kind,
    audit_source_id: record.source_id,
    scope: record.scope,
    polarity: record.polarity,
    path: record.path,
    text: encodePromptFragment(fragment),
    audit_record: record,
  };
}

function profileFragmentPart(profile, entry, polarity, profilePromptFragmentSources) {
  const source = isRecord(profilePromptFragmentSources?.[entry.id]) ? profilePromptFragmentSources[entry.id] : null;
  const sourceKind = typeof source?.source_kind === "string" ? source.source_kind : "render_profile";
  const sourceId = typeof source?.source_id === "string" ? source.source_id : profile?.id;
  return tracePart(entry.fragment, {
    path: sourceKind === "prompt_policy"
      ? `prompt_policy.${sourceId}.fragments.${entry.id}`
      : `render_profile.${sourceId}.prompt.fragments.${entry.id}`,
    source_kind: "render_profile",
    source_id: profile?.id,
    scope: `render_profile:${profile?.id}`,
    category: `${polarity}_${entry.fragment.placement}`,
    polarity,
    origin: sourceKind,
    origin_id: sourceId,
  });
}

function loraTriggerPart(text, owner, kind = "character") {
  return tracePart({ prompt_type: "custom_description", prompt_text: text }, {
    source_kind: "lora_trigger",
    source_id: owner,
    scope: "lora_trigger",
    category: "trigger",
    polarity: "positive",
    origin_detail: { kind, owner },
  });
}

function deduplicateCompiledParts(parts, suppressed = []) {
  const seen = new Map();
  return parts.filter((part) => {
    const normalized = part.prompt_text.toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ").trim();
    if (!normalized) return true;
    const key = part.origin === "lora_trigger"
      ? `trigger:${normalized}`
      : `${part.polarity}:${part.scope}:${normalized}`;
    if (seen.has(key)) {
      suppressed.push({reason:'same_scope_text',path:part.path,origin:part.origin,origin_id:part.origin_id,prompt_text:part.prompt_text,weight:part.weight,
        retained:{path:seen.get(key).path,origin:seen.get(key).origin,origin_id:seen.get(key).origin_id,weight:seen.get(key).weight}});
      return false;
    }
    seen.set(key,part);
    return true;
  });
}

export function applyPromptAvoidance(positive, negative, profile) {
  return profile.prompt.avoidance_strategy === "positive_avoid"
    ? { positive_prompt: positive + (negative.trim() ? `\n\nAVOID: ${negative}` : ""), negative_prompt: "" }
    : { positive_prompt: positive, negative_prompt: negative };
}

export function formatPromptParagraphs(parts, separator, profileId) {
  const paragraphs = [];
  let previousGroup;
  for (const part of parts) {
    const owner = part.role ?? (part.origin === "lora_trigger" && part.origin_id !== profileId ? part.origin_id : null);
    const group = owner ? `${part.origin_detail?.kind ?? "character"}:${owner}`
      : part.origin === "page" || part.origin === "scene" ? (part.category === "population" && isPromptPopulationControl(part.prompt_text) ? "population" : `page:${part.category}`)
      : part.category === "positive_suffix" ? "suffix" : "prefix";
    if (group !== previousGroup) paragraphs.push([]);
    paragraphs.at(-1).push(part.text);
    previousGroup = group;
  }
  return paragraphs.map(parts => parts.join(separator)).join(`${separator.trimEnd()}\n`);
}

function pageFactPath(pageKey, pageId, category, index) {
  return `pages/${pageId}.prompt.json.${category}[${index}]`;
}

// 保留原始位置，所有层的调整完成后才过滤；校重和编译共享这些有效词条。
function resolveSettingPrompt(character, adjustments = {}, kind = "character") {
  const configurationPath = character.configuration_path
    ?? `variants.${character.configuration_id}`;
  const documentRoot = `${kind}s/${character.id}.prompt.json`;
  const root = `${documentRoot}.${configurationPath}.prompt`;
  const resolved = resolvedSettingEntries(character.identity, character, adjustments, kind);
  const prompt = {};
  const entries = {};
  const missing = [];
  if (!character.identity?.prompt) missing.push(`${documentRoot}.identity.prompt`);
  for (const category of storyPromptCategories) {
    const effective = resolved.filter(entry => entry.category === category && entry.enabled);
    prompt[category] = effective.map(({ fragment }) => fragment);
    const identityCount = character.identity?.prompt?.[category]?.length ?? 0;
    entries[category] = effective.map(({ fragment, index }) => ({
      fragment,
      path: index < identityCount
        ? `${documentRoot}.identity.prompt.${category}[${index}]`
        : `${root}.${category}[${index - identityCount}]`,
    }));
    if (!character.identity?.prompt || !Array.isArray(character.prompt?.[category])) {
      entries[category] = null;
    }
  }
  return { prompt, entries, missing, root };
}

function characterPromptParts(character, resolved = resolveSettingPrompt(character), kind = "character", pageId = null) {
  const parts = [];
  const missing = [...resolved.missing];
  for (const category of kind === "scene" ? ["setting", "avoid"] : storyPromptCategories) {
    if (resolved.entries[category] === null) {
      missing.push(`${resolved.root}.${category}`);
      continue;
    }
    for (const { fragment: persisted, path } of resolved.entries[category]) {
      const fragment = currentFragment(persisted);
      if (!String(fragment.prompt_text ?? "").trim()) missing.push(`${path}.prompt_text`);
      parts.push(tracePart(fragment, {
        path, source_kind: kind === "scene" ? "page" : "character", source_id: kind === "scene" ? pageId : character.id,
        scope: kind === "scene" ? `page:${pageId}` : `character:${character.id}`,
        ...(kind === "scene" ? { origin: "scene", origin_id: character.id } : { role: character.id }),
        category, polarity: category === "avoid" ? "negative" : "positive",
      }));
    }
  }
  return { parts, missing };
}

export function auditCharacterPromptConfiguration(character, dictionaryEntries) {
  const { parts, missing } = characterPromptParts(character);
  if (missing.length) throw new Error(`角色 Prompt 不完整：${missing.join("；")}`);
  const records = deduplicateCompiledParts(parts).map((part) => part.audit_record);
  return auditPromptContext({
    positive: records.filter((record) => record.polarity === "positive"),
    negative: records.filter((record) => record.polarity === "negative"),
  }, { dictionaryEntries });
}

export function compileCurrentPagePrompt({
  pageId,
  pageKey,
  pagePrompt,
  profile,
  characters = [],
  scenes = [],
  participantIds = [],
  dictionaryEntries = null,
  profilePromptFragmentSources = null,
}) {
  const pageKeyErrors = validatePageKey(pageKey);
  if (pageKeyErrors.length) throw new TypeError(pageKeyErrors.join("；"));
  const rules = profilePromptRules(profile);
  const missing = [];
  const errors = rules.categoryOrderErrors.map((error) => `${profile?.id ?? "当前生成配置"}.${error}`);
  const characterPrompts = new Map(characters.map(character => [character, resolveSettingPrompt(character,
    pagePrompt.inheritance?.[characterSource(character.id, character.configuration_id)])]));
  const scenePrompts = new Map(scenes.map(scene => [scene, resolveSettingPrompt(scene,
    pagePrompt.inheritance?.[sceneSource(scene.id, scene.configuration_id)], "scene")]));
  const pageLoras = resolvePageLoras(pagePrompt, pageId, profile, characters, scenes);
  errors.push(...duplicatePromptWords([
    ...characters.filter(c => c.identity?.prompt).map(character => ({ scope: character.id, label: character.name ?? character.id, prompt: characterPrompts.get(character).prompt })),
    ...scenes.map(scene => ({ scope: 'environment', label: '场景 · ' + scene.name, prompt: scenePrompts.get(scene).prompt })),
    { scope: 'environment', label: '本页', prompt: pagePrompt },
  ]));
  const categoryPrompts = {};
  const categoryParts = {};
  const positiveBodyParts = [];
  const characterNegativeParts = [];
  const characterById = new Map(characters.map((character) => [character.id, character]));

  for (const category of storyPromptCategories) {
    const prompts = [];
    const parts = [];
    for (const { index, fragment: persistedFragment } of effectivePromptEntries(pagePrompt, category)) {
      const fragment = currentFragment(persistedFragment);
      const promptText = String(fragment.prompt_text ?? "").trim();
      if (!promptText) missing.push(`${pageFactPath(pageKey, pageId, category, index)}.prompt_text`);
      const role = typeof persistedFragment.character_id === "string" ? persistedFragment.character_id : null;
      const part = tracePart(fragment, {
        path: pageFactPath(pageKey, pageId, category, index),
        source_kind: "page",
        source_id: pageId,
        scope: role ? `character:${role}` : `page:${pageId}`,
        category,
        role,
        polarity: category === "avoid" ? "negative" : "positive",
        origin_detail: { kind: "project_fact", page_key: structuredClone(pageKey), category, index },
      });
      part.text = encodePromptFragment(fragment);
      if (promptText) prompts.push(part.text);
      parts.push(part);
    }
    categoryPrompts[category] = prompts;
    categoryParts[category] = parts;
  }

  for(const {field,fragment:input} of cameraPromptEntries(pagePrompt.camera_settings)) {
    const fragment=currentFragment(input);
    const part=tracePart(fragment,{path:'pages/'+pageId+'.prompt.json.camera_settings.'+field,source_kind:'page',source_id:pageId,scope:'page:'+pageId,category:'camera',role:null,polarity:'positive',origin_detail:{kind:'project_fact',page_key:structuredClone(pageKey),field:'camera_settings.'+field}});
    part.text=encodePromptFragment(fragment);categoryParts.camera.push(part);categoryPrompts.camera.push(part.text);
  }
  for (const characterId of participantIds) {
    const character = characterById.get(characterId);
    if (!character) {
      errors.push(`${pageId} 引用了未知角色：${characterId}`);
      continue;
    }
    for (const trigger of pageLoras.triggers.characters.get(characterId) ?? []) {
      positiveBodyParts.push(loraTriggerPart(trigger, characterId));
    }
    const characterParts = characterPromptParts(character, characterPrompts.get(character));
    missing.push(...characterParts.missing);
    positiveBodyParts.push(...characterParts.parts.filter((part) => part.polarity === "positive"));
    characterNegativeParts.push(...characterParts.parts.filter((part) => part.polarity === "negative"));
    for (const category of rules.categoryOrder) {
      positiveBodyParts.push(...(categoryParts[category] ?? []).filter((part) => part.role === characterId));
    }
  }

  const sceneSettingParts = [];
  for (const scene of scenes) {
    sceneSettingParts.push(...pageLoras.triggers.scenes.get(scene.id).map(trigger => loraTriggerPart(trigger, scene.id, "scene")));
    const sceneParts = characterPromptParts(scene, scenePrompts.get(scene), "scene", pageId);
    missing.push(...sceneParts.missing);
    sceneSettingParts.push(...sceneParts.parts.filter(part => part.polarity === "positive"));
    characterNegativeParts.push(...sceneParts.parts.filter(part => part.polarity === "negative"));
  }
  // 正式页面只传参与者；直接调用传入额外角色时，保留原有的执行列表筛选。
  const resolvedLoras = characters.every(c => participantIds.includes(c.id)) ? pageLoras
    : explicitPageLoras(pagePrompt, pageId, profile, characters.filter(c => participantIds.includes(c.id)), scenes);
  errors.push(...resolvedLoras.errors);
  if ((categoryPrompts.avoid.length || characterNegativeParts.length) && !["negative_prompt", "positive_avoid"].includes(rules.avoidanceStrategy)) {
    errors.push(`${profile?.id ?? "当前生成配置"} 不支持 avoid token`);
  }
  if (!["anima", "qwen-image-2-1"].includes(rules.family)) errors.push(`${profile?.id ?? "当前生成配置"} 使用了未知 Prompt 家族：${rules.family}`);

  const populationParts = (categoryParts.population ?? [])
    .filter((part) => part.role === null && isPromptPopulationControl(part.prompt_text));
  positiveBodyParts.push(...rules.categoryOrder.flatMap((category) => [
    ...(category === "setting" ? sceneSettingParts : []),
    ...(categoryParts[category] ?? []).filter((part) => part.role === null && !(category === "population" && isPromptPopulationControl(part.prompt_text))),
  ]));
  const positiveAuditParts = [
    ...rules.positivePrefix.map((entry) => profileFragmentPart(profile, entry, "positive", profilePromptFragmentSources)),
    ...pageLoras.triggers.style.map((text) => loraTriggerPart(text, profile?.id, "style")),
    ...populationParts,
    ...positiveBodyParts,
    ...rules.positiveSuffix.map((entry) => profileFragmentPart(profile, entry, "positive", profilePromptFragmentSources)),
  ];
  const negativeAuditParts = [
    ...rules.negativeFragments.map((entry) => profileFragmentPart(profile, entry, "negative", profilePromptFragmentSources)),
    ...(["negative_prompt", "positive_avoid"].includes(rules.avoidanceStrategy) ? [...characterNegativeParts, ...(categoryParts.avoid ?? [])] : []),
  ];
  for (const part of [...positiveAuditParts, ...negativeAuditParts]) {
    part.text = encodePromptFragment(part);
  }
  const suppressed=[];
  const positiveTraceParts = deduplicateCompiledParts(positiveAuditParts,suppressed);
  const negativeTraceParts = deduplicateCompiledParts(negativeAuditParts,suppressed);
  const positiveParts = positiveTraceParts.filter((part) => part.prompt_text);
  const negativeParts = negativeTraceParts.filter((part) => part.prompt_text);
  const revalidationPositive = positiveTraceParts.filter((part) => part.audit_record.source_kind !== "lora_trigger");
  const revalidationNegative = negativeTraceParts.filter((part) => part.audit_record.source_kind !== "lora_trigger");
  const audit = auditPromptContext({
    positive: revalidationPositive.map((part) => part.audit_record),
    negative: revalidationNegative.map((part) => part.audit_record),
  }, { dictionaryEntries });

  return {
    page_key: structuredClone(pageKey),
    prompt_family: rules.family,
    ready: missing.length === 0 && errors.length === 0 && audit.valid && positiveParts.length > 0,
    missing,
    errors: [...new Set(errors)],
    ...applyPromptAvoidance(formatPromptParagraphs(positiveParts, rules.separator, profile.id), formatPromptParagraphs(negativeParts, rules.separator, profile.id), profile),
    prompt_parts: {
      suppressed,
      separator: rules.separator,
      positive: positiveParts.map(({ audit_record: _record, ...part }) => part),
      negative: negativeParts.map(({ audit_record: _record, ...part }) => part),
    },
    audit_records: {
      positive: revalidationPositive.map((part) => structuredClone(part.audit_record)),
      negative: revalidationNegative.map((part) => structuredClone(part.audit_record)),
    },
    audit,
    categories: categoryPrompts,
    loras: resolvedLoras.loras,
  };
}
