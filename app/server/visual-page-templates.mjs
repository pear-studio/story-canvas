import { readFile } from "node:fs/promises";
import path from "node:path";

import { PAGE_PROMPT_CATEGORIES, PROMPT_TYPES } from "./prompt-contract.mjs";

export const VISUAL_PAGE_TEMPLATES_SCHEMA_ID = "https://storyvisualizer.local/schemas/visual-page-templates.schema.json";

const appliesTo = new Set(["story", "character", "scene"]);
const templatePageKeys = new Set(["title", "visual_goal", "visual"]);
const visualCategories = new Set(PAGE_PROMPT_CATEGORIES);
const fragmentKeys = new Set(["prompt_type", "prompt_text", "role_slot", "weight"]);
const roleSlots = new Set(["subject"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFragment(fragment, pathName, errors) {
  if (!isRecord(fragment)) {
    errors.push(`${pathName} 必须是对象`);
    return;
  }
  for (const key of Object.keys(fragment)) if (!fragmentKeys.has(key)) errors.push(`${pathName} 包含未知字段：${key}`);
  if (!PROMPT_TYPES.includes(fragment.prompt_type)) errors.push(`${pathName}.prompt_type 无效`);
  if (typeof fragment.prompt_text !== "string" || !fragment.prompt_text.trim()) errors.push(`${pathName}.prompt_text 必须是非空字符串`);
  if (fragment.role_slot !== undefined && !roleSlots.has(fragment.role_slot)) errors.push(`${pathName}.role_slot 只能是 subject`);
  if (fragment.weight !== undefined && (typeof fragment.weight !== "number" || !Number.isFinite(fragment.weight) || fragment.weight < 0.2 || fragment.weight > 10)) errors.push(`${pathName}.weight 必须是 0.2 至 10 的有限数字`);
}

function validateTemplate(template, index, declaredCategoryIds = new Set()) {
  const errors = [];
  const prefix = `templates[${index}]`;
  if (!isRecord(template)) return [`${prefix} 必须是对象`];
  const allowed = new Set(["id", "name", "description", "category", "applies_to", "page"]);
  for (const key of Object.keys(template)) if (!allowed.has(key)) errors.push(`${prefix} 包含未知字段：${key}`);
  if (typeof template.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(template.id)) errors.push(`${prefix}.id 格式无效`);
  if (typeof template.name !== "string" || !template.name.trim()) errors.push(`${prefix}.name 必须是非空字符串`);
  if (template.description !== undefined && typeof template.description !== "string") errors.push(`${prefix}.description 必须是字符串`);
  if (!declaredCategoryIds.has(template.category)) errors.push(`${prefix}.category 未在 categories 中声明`);
  if (!Array.isArray(template.applies_to) || template.applies_to.length < 1 || template.applies_to.some((item) => !appliesTo.has(item))) errors.push(`${prefix}.applies_to 必须是 story、character 或 scene 的非空数组`);
  else if (new Set(template.applies_to).size !== template.applies_to.length) errors.push(`${prefix}.applies_to 不能重复`);
  if (!isRecord(template.page)) {
    errors.push(`${prefix}.page 必须是对象`);
    return errors;
  }
  for (const key of Object.keys(template.page)) if (!templatePageKeys.has(key)) errors.push(`${prefix}.page 包含未知字段：${key}`);
  if (typeof template.page.title !== "string" || !template.page.title.trim()) errors.push(`${prefix}.page.title 必须是非空字符串`);
  const goal = template.page.visual_goal;
  if (!isRecord(goal)) errors.push(`${prefix}.page.visual_goal 必须是对象`);
  else {
    for (const key of Object.keys(goal)) if (!["content", "intent", "criteria"].includes(key)) errors.push(`${prefix}.page.visual_goal 包含未知字段：${key}`);
    if (typeof goal.content !== "string" || !goal.content.trim()) errors.push(`${prefix}.page.visual_goal.content 必须是非空字符串`);
    if (goal.intent !== "detail") errors.push(`${prefix}.page.visual_goal.intent 必须是 detail`);
    if (!Array.isArray(goal.criteria) || goal.criteria.length < 1 || goal.criteria.length > 5) errors.push(`${prefix}.page.visual_goal.criteria 必须是 1 至 5 项数组`);
    else goal.criteria.forEach((criterion, criterionIndex) => {
      if (!isRecord(criterion) || typeof criterion.text !== "string" || !criterion.text.trim()) errors.push(`${prefix}.page.visual_goal.criteria[${criterionIndex}] 必须包含非空 text`);
      else if (Object.keys(criterion).some((key) => key !== "text")) errors.push(`${prefix}.page.visual_goal.criteria[${criterionIndex}] 只能包含 text`);
    });
  }
  if (!isRecord(template.page.visual)) errors.push(`${prefix}.page.visual 必须是对象`);
  else {
    for (const key of Object.keys(template.page.visual)) if (!visualCategories.has(key)) errors.push(`${prefix}.page.visual.${key} 不是页面 Prompt 分类`);
    for (const category of PAGE_PROMPT_CATEGORIES) {
      const fragments = template.page.visual[category];
      if (!Array.isArray(fragments)) errors.push(`${prefix}.page.visual.${category} 必须是数组`);
      else fragments.forEach((fragment, fragmentIndex) => validateFragment(fragment, `${prefix}.page.visual.${category}[${fragmentIndex}]`, errors));
    }
  }
  return errors;
}

function validateCatalog(value) {
  const errors = [];
  if (!isRecord(value)) return ["模板清单必须是 JSON 对象"];
  for (const key of Object.keys(value)) if (!["$schema", "version", "categories", "templates"].includes(key)) errors.push(`模板清单包含未知字段：${key}`);
  if (value.version !== 1) errors.push("模板清单 version 必须为 1");
  if (value.$schema !== undefined && value.$schema !== VISUAL_PAGE_TEMPLATES_SCHEMA_ID) errors.push("模板清单 $schema 不匹配");
  if (!Array.isArray(value.categories)) errors.push("模板清单 categories 必须是数组");
  else {
    const declaredCategoryIds = new Set();
    value.categories.forEach((category, index) => {
      const prefix = `categories[${index}]`;
      if (!isRecord(category)) { errors.push(`${prefix} 必须是对象`); return; }
      for (const key of Object.keys(category)) if (!["id", "name"].includes(key)) errors.push(`${prefix} 包含未知字段：${key}`);
      if (typeof category.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(category.id)) errors.push(`${prefix}.id 格式无效`);
      else if (declaredCategoryIds.has(category.id)) errors.push(`${prefix}.id 重复：${category.id}`);
      else declaredCategoryIds.add(category.id);
      if (typeof category.name !== "string" || !category.name.trim()) errors.push(`${prefix}.name 必须是非空字符串`);
    });
    if (!Array.isArray(value.templates)) errors.push("模板清单 templates 必须是数组");
    else {
      const ids = new Set();
      value.templates.forEach((template, index) => {
        const templateErrors = validateTemplate(template, index, declaredCategoryIds);
        errors.push(...templateErrors);
        if (isRecord(template) && typeof template.id === "string") {
          if (ids.has(template.id)) errors.push(`templates[${index}].id 重复：${template.id}`);
          ids.add(template.id);
        }
      });
    }
  }
  return errors;
}

/**
 * 读取全局视觉页模板。模板属于仓库资源，任何一个损坏清单都只影响模板入口，
 * 不应阻止工作台读取项目或新建空白页面。
 */
export async function readVisualPageTemplates(projectRoot) {
  const target = path.join(projectRoot, "library", "visual-page-templates", "catalog.json");
  let value;
  try {
    value = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, categories: [], templates: [], errors: [] };
    return { version: 1, categories: [], templates: [], errors: [`无法读取视觉页面模板：${error?.message ?? "JSON 无效"}`] };
  }
  const errors = validateCatalog(value);
  if (errors.length) return { version: 1, categories: [], templates: [], errors };
  return { version: 1, categories: structuredClone(value.categories), templates: structuredClone(value.templates), errors: [] };
}

export function materializeVisualPageTemplate(template, characterId) {
  return {
    title: template.page.title,
    visual_goal: [template.page.visual_goal.content, ...template.page.visual_goal.criteria.map((criterion) => criterion.text)].join("\n"),
    prompt: Object.fromEntries(PAGE_PROMPT_CATEGORIES.map((category) => [
      category,
      template.page.visual[category].map((fragment) => ({
        ...(fragment.prompt_type === "danbooru" ? { tag: fragment.prompt_text }
          : { description: fragment.prompt_text }),
        ...(fragment.role_slot === "subject" && characterId ? { character_id: characterId } : {}),
        ...(fragment.weight === undefined ? {} : { weight: fragment.weight }),
      })),
    ])),
  };
}

export function validateVisualPageTemplateCatalog(value) {
  return validateCatalog(value);
}
