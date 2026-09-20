import { storyDialogueIdPattern, storyPageIdPattern } from "./story-files.mjs";

export const LETTERING_SCHEMA_ID = "https://storyvisualizer.local/schemas/lettering.schema.json";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateNormalizedNumber(value, valuePath, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${valuePath} 必须是 0 到 1 之间的有限数字`);
  }
}

function validateBox(box, valuePath, errors) {
  if (!isRecord(box)) {
    errors.push(`${valuePath} 必须是对象`);
    return;
  }
  for (const key of Object.keys(box)) if (!new Set(["x", "y", "w", "h"]).has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
  for (const key of ["x", "y", "w", "h"]) validateNormalizedNumber(box[key], `${valuePath}.${key}`, errors);
  if (typeof box.w === "number" && box.w < 0.08) errors.push(`${valuePath}.w 不能小于 0.08`);
  if (typeof box.h === "number" && box.h < 0.05) errors.push(`${valuePath}.h 不能小于 0.05`);
}

export function emptyLetteringDocument() {
  return { $schema: LETTERING_SCHEMA_ID, version: 2, pages: [] };
}

export function validatePageLettering(pageLayout, { pageId = null, dialogueIds = null, valuePath = "lettering" } = {}) {
  const errors = [];
  if (!isRecord(pageLayout)) return [`${valuePath} 必须是对象`];
  for (const key of Object.keys(pageLayout)) if (!new Set(["page", "items"]).has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
  if (!storyPageIdPattern.test(pageLayout.page ?? "")) errors.push(`${valuePath}.page 不是有效剧情页面 ID`);
  else if (pageId !== null && pageLayout.page !== pageId) errors.push(`${valuePath}.page 必须等于 ${pageId}`);
  if (!Array.isArray(pageLayout.items)) return [...errors, `${valuePath}.items 必须是数组`];
  const placed = new Set();
  const allowed = dialogueIds === null ? null : new Set(dialogueIds);
  for (const [index, item] of pageLayout.items.entries()) {
    const itemPath = `${valuePath}.items[${index}]`;
    if (!isRecord(item)) { errors.push(`${itemPath} 必须是对象`); continue; }
    for (const key of Object.keys(item)) if (!new Set(["dialogue_id", "box", "heart"]).has(key)) errors.push(`${itemPath} 包含未知字段：${key}`);
    if (item.heart !== undefined) {
      if (!isRecord(item.heart)) errors.push(`${itemPath}.heart 必须是对象`);
      else {
        for (const key of Object.keys(item.heart)) if (!["font_size", "rotation", "seed"].includes(key)) errors.push(`${itemPath}.heart 包含未知字段：${key}`);
        for (const [key, min, max] of [["font_size", 12, 192], ["rotation", -180, 180], ["seed", 0, 4294967295]]) {
          const n = item.heart[key];
          if (!Number.isInteger(n) || n < min || n > max) errors.push(`${itemPath}.heart.${key} 必须是 ${min} 到 ${max} 的整数`);
        }
      }
    }
    if (!storyDialogueIdPattern.test(item.dialogue_id ?? "")) errors.push(`${itemPath}.dialogue_id 不是有效对白 ID`);
    else if (placed.has(item.dialogue_id)) errors.push(`${valuePath} 重复放置对白：${item.dialogue_id}`);
    else {
      placed.add(item.dialogue_id);
      if (allowed && !allowed.has(item.dialogue_id)) errors.push(`${itemPath} 引用了本页不存在的对白：${item.dialogue_id}`);
    }
    validateBox(item.box, `${itemPath}.box`, errors);
  }
  return errors;
}

export function validateLetteringDocument(document) {
  const errors = [];
  if (!isRecord(document)) return ["文字布局必须是 JSON 对象"];
  for (const key of Object.keys(document)) if (!new Set(["$schema", "version", "pages"]).has(key)) errors.push(`文字布局包含未知字段：${key}`);
  if (document.$schema !== LETTERING_SCHEMA_ID) errors.push("文字布局的 $schema 不匹配");
  if (document.version !== 2) errors.push("文字布局 version 必须等于 2");
  if (!Array.isArray(document.pages)) return [...errors, "文字布局 pages 必须是数组"];
  const pages = new Set();
  for (const [index, page] of document.pages.entries()) {
    errors.push(...validatePageLettering(page, { valuePath: `pages[${index}]` }));
    if (typeof page?.page === "string") {
      if (pages.has(page.page)) errors.push(`文字布局页面重复：${page.page}`);
      pages.add(page.page);
    }
  }
  return errors;
}
