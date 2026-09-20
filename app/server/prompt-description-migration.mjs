import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonFile } from "./http-support.mjs";
import { validateStoryPagePromptDocument } from "./story-files.mjs";
import { validateCharacterPromptDocument } from "./character-files.mjs";
import { requireIdleProject } from "./project-management.mjs";

/** 一次性字段迁移；只改变旧文本字段名和类型，不改正文及其他事实。 */
export function migratePromptDescriptionDocument(source) {
  let changed = false;
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const legacyKeys = ["term", "phrase"].filter(key => Object.hasOwn(value, key));
    if (legacyKeys.length && (legacyKeys.length !== 1 || Object.hasOwn(value, "tag") || Object.hasOwn(value, "description"))) {
      throw new Error("片段同时包含多个文本字段，未迁移");
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (legacyKeys.includes(key)) { changed = true; return ["description", item]; }
      if (key === "prompt_type" && ["custom_term", "custom_phrase"].includes(item)) {
        changed = true; return [key, "custom_description"];
      }
      return [key, visit(item)];
    }));
  }
  const document = visit(source);
  // 远端旧编辑器写入的空自定义占位不代表覆盖，按当前契约省略。
  if (document.mode === "structured" && document.free
    && document.free.base_sha256 === undefined
    && document.free.positive === "" && document.free.negative === ""
    && Array.isArray(document.free.loras) && document.free.loras.length === 0
    && Object.keys(document.free).every(key => ["positive", "negative", "loras"].includes(key))) {
    delete document.free;
    changed = true;
  }
  return { document, changed };
}

async function entries(directory) {
  return readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
}

export async function preparePromptDescriptionMigration(repositoryRoot) {
  const candidates = [];
  const projects = [];
  for (const entry of await entries(path.join(repositoryRoot, "workspace"))) {
    if (!entry.isDirectory()) continue;
    const project = path.join(repositoryRoot, "workspace", entry.name);
    projects.push(project);
    for (const folder of ["story/pages", "characters/pages", "characters"]) {
      for (const file of await entries(path.join(project, folder))) {
        if (file.isFile() && file.name.endsWith(".prompt.json")) candidates.push({
          file: path.join(project, folder, file.name),
          validate: folder === "characters" ? validateCharacterPromptDocument : validateStoryPagePromptDocument,
        });
      }
    }
    const override = path.join(project, "render-profile.override.json");
    if (await readFile(override).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error))) candidates.push({ file: override });
  }
  for (const folder of ["library/render-profiles", "library/prompt-policies"]) {
    for (const file of await entries(path.join(repositoryRoot, folder))) {
      if (file.isFile() && file.name.endsWith(".json")) candidates.push({ file: path.join(repositoryRoot, folder, file.name) });
    }
  }
  const files = [];
  for (const candidate of candidates) {
    const raw = await readFile(candidate.file, "utf8");
    const result = migratePromptDescriptionDocument(JSON.parse(raw));
    if (!result.changed) continue;
    const errors = candidate.validate?.(result.document) ?? [];
    if (errors.length) throw new Error(`${path.relative(repositoryRoot, candidate.file)}: ${errors.join("; ")}`);
    files.push({ file: candidate.file, raw, document: result.document });
  }
  return { files, projects };
}

export async function applyPromptDescriptionMigration(plan) {
  for (const project of plan.projects) await requireIdleProject(project);
  for (const item of plan.files) {
    if (await readFile(item.file, "utf8") !== item.raw) throw new Error(`迁移基线变化，请重新读取：${item.file}`);
  }
  for (const item of plan.files) await writeJsonFile(item.file, item.document);
  return { files: plan.files.map(item => item.file) };
}
