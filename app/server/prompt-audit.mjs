import {
  DANBOORU_ALLOWED_CATEGORIES,
  PROMPT_AUDIT_CODES,
  PROMPT_TYPES,
  isPromptPopulationControl,
  normalizePromptText,
  promptFragmentRecord,
  promptFragmentWeight,
  promptPopulationTag,
} from "./prompt-contract.mjs";
import {
  lookupPromptDictionaryEntry,
  promptDictionaryCategory,
} from "./prompt-dictionary.mjs";
import { inlinePromptWeights } from "../shared/inline-prompt-weight.mjs";
import { promptTagMarkerErrors } from "../shared/prompt-tags.mjs";

const inlineWeightPattern = /<lora:[^>]+>|\([^()]+:\s*\d+(?:\.\d+)?\)|^\s*\([^()]+\)\s*$|^\s*\({2,}.*\){2,}\s*$|^\s*\[[^\]]+\]\s*$/i;
const toggleablePromptSourceKinds = new Set(["page", "character"]);

function asRecord(value, polarity) {
  if (value && typeof value === "object" && value.fragment !== undefined) {
    return promptFragmentRecord(value.fragment, {
      ...value,
      polarity: polarity ?? value.polarity ?? (value.category === "avoid" ? "negative" : "positive"),
    });
  }
  return promptFragmentRecord(value, { polarity });
}

function issue(record, code, message, extra = {}) {
  return {
    code,
    message,
    prompt_text: typeof record?.fragment?.prompt_text === "string" ? record.fragment.prompt_text.trim() : undefined,
    path: record?.path ?? "",
    token_id: typeof record?.fragment?.id === "string" ? record.fragment.id : null,
    category: record?.category || null,
    scope: record?.scope || null,
    ...extra,
  };
}

function related(record) {
  return {
    prompt_text: record.fragment?.prompt_text ?? "",
    path: record.path,
    token_id: record.fragment?.id ?? null,
  };
}

export function hasInlinePromptWeight(value) {
  return inlineWeightPattern.test(String(value ?? ""));
}

// LoRA 触发词使用独立的字符约束；自由描述不使用此限制。
export function isAsciiPromptText(value) {
  return /^[\x20-\x7e]+$/.test(String(value ?? ""));
}

function addCount(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function isWeighted(record) {
  return promptFragmentWeight(record.fragment) !== 1 || inlinePromptWeights(record.fragment?.prompt_text ?? "").weights.some(weight => weight !== 1);
}

function statsFor(records) {
  const stats = {
    total: records.length,
    positive: 0,
    negative: 0,
    weighted: 0,
    custom_description: 0,
    by_source_kind: {},
    by_category: {},
  };
  for (const record of records) {
    if (record.polarity === "negative") stats.negative += 1;
    else stats.positive += 1;
    if (isWeighted(record)) stats.weighted += 1;
    if (record.fragment?.prompt_type === "custom_description") stats.custom_description += 1;
    addCount(stats.by_source_kind, record.source_kind || "unknown");
    if (record.category) addCount(stats.by_category, record.category);
  }
  return stats;
}

function auditFragment(record, dictionaryEntries) {
  const errors = [];
  const fragment = record?.fragment;
  if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) {
    errors.push(issue(record, PROMPT_AUDIT_CODES.INVALID_FRAGMENT, "Prompt 片段必须是对象"));
    return errors;
  }
  if (!PROMPT_TYPES.includes(fragment.prompt_type)) {
    errors.push(issue(record, PROMPT_AUDIT_CODES.INVALID_TYPE, "Prompt 片段类型无效"));
  }
  const text = typeof fragment.prompt_text === "string" ? fragment.prompt_text.trim() : "";
  for (const message of promptTagMarkerErrors(text, Array.isArray(dictionaryEntries) ? tag => Boolean(lookupPromptDictionaryEntry(dictionaryEntries, tag)) : undefined)) {
    errors.push(issue(record, "prompt.fragment.tag_marker_invalid", message));
  }
  if (!text) errors.push(issue(record, PROMPT_AUDIT_CODES.EMPTY_TEXT, "Prompt 文本不能为空"));
  const weight = promptFragmentWeight(fragment);
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0.2 || weight > 10) {
    errors.push(issue(record, PROMPT_AUDIT_CODES.INVALID_WEIGHT, "Prompt 权重必须在 0.2 到 10 之间"));
  }
  const inline = inlinePromptWeights(text);
  if (text && (fragment.prompt_type === "custom_description" ? !inline.valid : hasInlinePromptWeight(text))) {
    errors.push(issue(record, PROMPT_AUDIT_CODES.INLINE_WEIGHT, "描述中的括号必须配对，显式权重必须是有效正数，不支持 LoRA 语法；标签不支持内嵌权重"));
  }

  if (text && isPromptPopulationControl(text)) {
    const expectedCategory = record.polarity === "negative" ? "avoid" : "subject";
    if (fragment.prompt_type !== "danbooru") {
      errors.push(issue(record, PROMPT_AUDIT_CODES.POPULATION_TAG_TYPE_INVALID, "人数与 solo 控制标签必须使用 Danbooru 类型"));
    }
    if (record.source_kind !== "page" || record.category !== expectedCategory) {
      errors.push(issue(record, PROMPT_AUDIT_CODES.POPULATION_TAG_PLACEMENT_INVALID, `人数与 solo 控制标签只能位于页面 ${expectedCategory} 分类`));
    } else if (record.role) {
      errors.push(issue(record, PROMPT_AUDIT_CODES.POPULATION_TAG_ROLE_INVALID, "人数与 solo 控制标签不能绑定角色"));
    }
  }

  const dictionaryEntry = Array.isArray(dictionaryEntries) && text
    ? lookupPromptDictionaryEntry(dictionaryEntries, text)
    : null;
  if (dictionaryEntry) {
    const category = promptDictionaryCategory(dictionaryEntry);
    if (category === "artist") {
      errors.push(issue(record, PROMPT_AUDIT_CODES.DANBOORU_ARTIST_FORBIDDEN, "Artist 类 Danbooru 标签禁止使用"));
    } else if (!(DANBOORU_ALLOWED_CATEGORIES[record.source_kind] ?? []).includes(category)) {
      errors.push(issue(record, PROMPT_AUDIT_CODES.DANBOORU_CATEGORY_NOT_ALLOWED, `当前 ${record.source_kind || "unknown"} 范围不允许使用 ${category} 类 Danbooru 标签`, {
        danbooru_category: category,
      }));
    }
  }

  if (fragment.prompt_type === "danbooru" && Array.isArray(dictionaryEntries) && text && !dictionaryEntry) {
    errors.push(issue(record, PROMPT_AUDIT_CODES.DANBOORU_NOT_FOUND, "Danbooru 标签不在固定词库中"));
  }
  return errors;
}

function auditPopulationSemantics(records, errors, warnings) {
  const pages = new Map();
  for (const record of records) {
    if (record.source_kind !== "page" || record.category !== "subject" || record.polarity === "negative") continue;
    if (!isPromptPopulationControl(record.fragment?.prompt_text)) continue;
    const group = pages.get(record.source_id) ?? [];
    group.push(record);
    pages.set(record.source_id, group);
  }
  for (const group of pages.values()) {
    const selectedByKind = new Map();
    const solo = group.find((record) => normalizePromptText(record.fragment?.prompt_text) === "solo") ?? null;
    for (const record of group) {
      const tag = promptPopulationTag(record.fragment?.prompt_text);
      if (!tag) continue;
      const previous = selectedByKind.get(tag.kind);
      if (previous) {
        if (normalizePromptText(previous.record.fragment?.prompt_text) !== normalizePromptText(record.fragment?.prompt_text)) {
          errors.push(issue(record, PROMPT_AUDIT_CODES.POPULATION_TAG_CONFLICT, "同一页面不能同时声明两种同类人数标签", {
            conflicts_with: previous.record.path,
            related: [related(previous.record)],
          }));
        }
        continue;
      }
      selectedByKind.set(tag.kind, { record, tag });
    }
    if (!solo) continue;
    const selected = [...selectedByKind.values()];
    if (selected.length === 0) {
      warnings.push(issue(solo, PROMPT_AUDIT_CODES.SOLO_COUNT_WARNING, "solo 建议同时声明 1girl、1boy 或 1other"));
    } else if (selected.length > 1 || selected.some(({ tag }) => tag.minimum > 1)) {
      errors.push(issue(solo, PROMPT_AUDIT_CODES.SOLO_CONFLICT, "solo 不能与多人声明同时使用", {
        related: selected.map(({ record }) => related(record)),
      }));
    }
  }
}

function auditDuplicates(records, errors) {
  const seenByScope = new Map();
  const positives = new Map();
  const negatives = new Map();
  for (const record of records) {
    const normalized = normalizePromptText(record.fragment?.prompt_text);
    if (!normalized) continue;
    const scopedKey = `${record.polarity}\n${record.scope}\n${normalized}`;
    if (seenByScope.has(scopedKey)) {
      errors.push(issue(record, PROMPT_AUDIT_CODES.DUPLICATE_IN_SCOPE, "同一作用域内存在重复 Prompt 片段", {
        conflicts_with: seenByScope.get(scopedKey).path,
        related: [related(seenByScope.get(scopedKey))],
      }));
    } else seenByScope.set(scopedKey, record);
    const polarityIndex = record.polarity === "negative" ? negatives : positives;
    if (!polarityIndex.has(normalized)) polarityIndex.set(normalized, record);
  }
  for (const [normalized, negative] of negatives) {
    const positive = positives.get(normalized);
    if (!positive) continue;
    errors.push(issue(negative, PROMPT_AUDIT_CODES.POSITIVE_AVOID_CONFLICT, "同一内容同时出现在正向 Prompt 与 avoid 中", {
      conflicts_with: positive.path,
      related: [related(positive)],
    }));
  }
}

export function auditPromptFragments(values, { dictionaryEntries = null } = {}) {
  const records = (values ?? []).map((value) => asRecord(value)).filter((record) => {
    if (record.fragment?.enabled !== false) return true;
    return !toggleablePromptSourceKinds.has(record.source_kind);
  });
  const errors = [];
  const warnings = [];
  for (const record of records) {
    errors.push(...auditFragment(record, dictionaryEntries));
  }
  auditPopulationSemantics(records, errors, warnings);
  auditDuplicates(records, errors);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: statsFor(records),
  };
}

export function auditPromptContext({ positive = [], negative = [] } = {}, options = {}) {
  return auditPromptFragments([
    ...positive.map((value) => asRecord(value, "positive")),
    ...negative.map((value) => asRecord(value, "negative")),
  ], options);
}
