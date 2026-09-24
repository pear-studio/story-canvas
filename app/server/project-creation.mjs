import { registerProject, readProjectRegistry } from "./project-registry.mjs";
import { PAGES_INDEX_SCHEMA_ID, validatePagesIndexDocument } from "./pages-store.mjs";
import { SCENE_INDEX_SCHEMA_ID } from "./scene-files.mjs";
import { projectGitignore, projectGitattributes } from "./project-storage-layout.mjs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
  characterIdPattern,
  validateCharacterIndexDocument,
  validateCharacterProfileDocument,
  validateCharacterPromptDocument,
  validateCharacterVisualDocument,
} from "./character-files.mjs";
import { defaultLetteringSettings, validateLetteringSettingsDocument } from "./lettering-settings.mjs";
import {
  ProjectContractError,
  emptyCreativeAgreement,
  emptyMaterialMetadata,
  requireProjectDirectoryName,
} from "./project-contracts.mjs";
import { STORY_PROJECT_FORMAT } from "./project-manifest.mjs";
import { defaultProfileAdapter } from './model-adapters.mjs';
import { emptySettingPrompt, makeModelPromptDocument } from './model-prompts.mjs';
import {
  STORY_OUTLINE_SCHEMA_ID,
  validateStoryOutlineDocument,
} from "./story-files.mjs";
import { factStorage as storage } from "./story-facts.mjs";


const projectSchemaId = "https://storyvisualizer.local/schemas/project.schema.json";
const renderProfileOverrideSchemaId = "https://storyvisualizer.local/schemas/render-profile-override.schema.json";
const canvasValues = new Set(["3:4", "2:3", "9:16", "4:3"]);
const renderProfileIdPattern = /^[a-z0-9][a-z0-9-]*$/;

function fail(status, code, details = []) {
  throw new ProjectContractError(status, code, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, allowed, valuePath, errors) {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
}

function checkText(value, valuePath, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${valuePath} 必须是非空字符串`);
}

function defaultOutline() {
  return {
    synopsis: "待补充故事梗概。",
    chapters: [{ id: "main", title: "故事", summary: "待补充章节梗概。", sequences: [] }],
  };
}

export function createEmptyProjectCreationDocument(projectId) {
  const safeProjectId = requireProjectDirectoryName(projectId);
  return {
    metadata: {
      title: safeProjectId,
      canvas: "2:3",
      default_render_profile: "anima-base-v1",
    },
    lettering_settings: defaultLetteringSettings(),
    outline: defaultOutline(),
    characters: [],
  };
}

function validateCreationCharacter(character, index, errors) {
  const valuePath = `characters[${index}]`;
  if (!isRecord(character)) {
    errors.push(`${valuePath} 必须是对象`);
    return;
  }
  checkExactKeys(character, ["id", "name", "description", "visual_description", "variants"], valuePath, errors);
  if (!characterIdPattern.test(character.id ?? "") || character.id === "npc") errors.push(`${valuePath}.id 不是有效角色 ID`);
  checkText(character.name, `${valuePath}.name`, errors);
  checkText(character.description, `${valuePath}.description`, errors);

  if (!Array.isArray(character.variants)) {
    errors.push(`${valuePath}.variants 必须是数组`);
    return;
  }
  if (character.variants.length === 0) {
    errors.push(`${valuePath}.variants 至少需要一个子设定`);
    return;
  }
  for (const [variantIndex, variant] of character.variants.entries()) {
    const variantPath = `${valuePath}.variants[${variantIndex}]`;
    if (!isRecord(variant)) {
      errors.push(`${variantPath} 必须是对象`);
      continue;
    }
    checkExactKeys(variant, ["id", "name", "description"], variantPath, errors);
    if (!characterIdPattern.test(variant.id ?? "") || variant.id === "main") errors.push(`${variantPath}.id 不是有效 variant ID`);
    checkText(variant.name, `${variantPath}.name`, errors);

  }
}

export function validateProjectCreationDocument(document) {
  const errors = [];
  if (!isRecord(document)) return ["creation document 必须是对象"];
  checkExactKeys(document, ["metadata", "lettering_settings", "outline", "characters"], "creation document", errors);
  if (!isRecord(document.metadata)) errors.push("metadata 必须是对象");
  else {
    checkExactKeys(document.metadata, ["title", "canvas", "default_render_profile"], "metadata", errors);
    checkText(document.metadata.title, "metadata.title", errors);
    if (!canvasValues.has(document.metadata.canvas)) errors.push("metadata.canvas 无效");
    if (!renderProfileIdPattern.test(document.metadata.default_render_profile ?? "")) errors.push("metadata.default_render_profile 不是有效 ID");
  }
  errors.push(...validateLetteringSettingsDocument(document.lettering_settings));
  if (!isRecord(document.outline)) errors.push("outline 必须是对象");
  else {
    checkExactKeys(document.outline, ["synopsis", "chapters"], "outline", errors);
    errors.push(...validateStoryOutlineDocument({ $schema: STORY_OUTLINE_SCHEMA_ID, ...document.outline }));
  }
  if (!Array.isArray(document.characters)) errors.push("characters 必须是数组");
  else {
    document.characters.forEach((character, index) => validateCreationCharacter(character, index, errors));
    const ids = document.characters.map((character) => character?.id).filter((id) => typeof id === "string");
    for (const [index, id] of ids.entries()) if (ids.indexOf(id) !== index) errors.push(`characters[${index}].id 重复：${id}`);
  }
  return errors;
}

function materializeCreation(document, now, modelId) {
  const outline = { $schema: STORY_OUTLINE_SCHEMA_ID, ...structuredClone(document.outline) };
  const characterIds = document.characters.map((character) => character.id);
  const characterIndex = { $schema: CHARACTER_INDEX_SCHEMA_ID, characters: characterIds };
  const letteringSettings = structuredClone(document.lettering_settings);
  const lettering = {
    $schema: "https://storyvisualizer.local/schemas/lettering.schema.json",
    version: 2,
    pages: [],
  };
  const characters = document.characters.map((character) => {
    const profile = {
      $schema: CHARACTER_PROFILE_SCHEMA_ID,
      name: character.name,
      description: character.description,
    };
    const visual = {
      $schema: CHARACTER_VISUAL_SCHEMA_ID,
      variants: structuredClone(character.variants),
    };
    const prompt = makeModelPromptDocument(CHARACTER_PROMPT_SCHEMA_ID, modelId, emptySettingPrompt(modelId, character.name, character.variants.map(variant => variant.id)));
    return { id: character.id, profile, visual, prompt };
  });

  const contractErrors = [
    ...validateStoryOutlineDocument(outline),
    ...validatePagesIndexDocument({ $schema: PAGES_INDEX_SCHEMA_ID, pages: [] }),
    ...validateCharacterIndexDocument(characterIndex),
    ...validateLetteringSettingsDocument(letteringSettings),
    ...characters.flatMap(({ id, profile, visual, prompt }) => [
      ...validateCharacterProfileDocument(profile).map((error) => `${id}.profile: ${error}`),
      ...validateCharacterVisualDocument(visual).map((error) => `${id}.visual: ${error}`),
      ...validateCharacterPromptDocument(prompt).map((error) => `${id}.prompt: ${error}`),
    ]),
  ];
  if (contractErrors.length) fail(422, "invalid_project_creation", contractErrors);

  return {
    project: { $schema: projectSchemaId, format: STORY_PROJECT_FORMAT, ...structuredClone(document.metadata), title: document.metadata.title.trim() },
    outline,
    characterIndex,
    letteringSettings,
    lettering,
    characters,
    materialMetadata: emptyMaterialMetadata(),
    creativeAgreement: emptyCreativeAgreement(),
    renderProfileOverride: { $schema: renderProfileOverrideSchemaId, version: 1, profiles: {} },
  };
}

async function pathExists(target) {
  return lstat(target).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
}

async function requirePlainDirectory(target, code) {
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) fail(404, code);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(409, "unsafe_project_directory", [target]);
  return target;
}

async function assertDestinationAvailable(projectRoot, projectId) {
  const workspaceRoot = path.join(path.resolve(projectRoot), "workspace");
  if (readProjectRegistry(projectRoot).some(entry => entry.id === projectId)) fail(409, "project_already_exists");
  const destination = path.join(workspaceRoot, projectId);
  if (path.dirname(destination) !== workspaceRoot || !storage.isWithin(workspaceRoot, destination)) fail(400, "invalid_project_id");
  if (await pathExists(destination)) fail(409, "project_already_exists", [projectId]);
  return { workspaceRoot, destination };
}

export async function readProjectCreationTemplate(projectRoot, projectId) {
  const id = requireProjectDirectoryName(projectId);
  await assertDestinationAvailable(projectRoot, id);
  return { project_id: id, document: createEmptyProjectCreationDocument(id) };
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function writeMaterializedProject(stagingDirectory, materialized) {
  const jsonFiles = [
    ["project.json", materialized.project],
    ["scenes/index.json", { $schema: SCENE_INDEX_SCHEMA_ID, scenes: [] }],
    ["render-profile.override.json", materialized.renderProfileOverride],
    ["materials/index.json", materialized.materialMetadata],
    ["creative-agreement.json", materialized.creativeAgreement],
    ["story/outline.json", materialized.outline],
    ["pages/index.json", { $schema: PAGES_INDEX_SCHEMA_ID, pages: [] }],
    ["characters/index.json", materialized.characterIndex],
    ["lettering/settings.json", materialized.letteringSettings],
    ["lettering/dialogue-layouts.json", materialized.lettering],
    ...materialized.characters.flatMap((character) => [
      [`characters/${character.id}.profile.json`, character.profile],
      [`characters/${character.id}.visual.json`, character.visual],
      [`characters/${character.id}.prompt.json`, character.prompt],
    ]),
  ];
  for (const [relativePath, value] of jsonFiles) await writeJson(storage.targetPath(stagingDirectory, relativePath), value);
  await writeFile(path.join(stagingDirectory, ".gitignore"), projectGitignore, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(stagingDirectory, ".gitattributes"), projectGitattributes, { encoding: "utf8", flag: "wx" });
}

async function cleanupStaging(workspaceRoot, stagingDirectory) {
  const absoluteRoot = path.resolve(workspaceRoot);
  const absolute = path.resolve(stagingDirectory);
  if (!storage.isWithin(absoluteRoot, absolute) || absolute === absoluteRoot || path.dirname(absolute) !== absoluteRoot || !path.basename(absolute).startsWith(".create-")) {
    fail(500, "unsafe_project_creation_staging", [absolute]);
  }
  const info = await lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) fail(500, "unsafe_project_creation_staging", [absolute]);
  await storage.assertNoReparsePoints(absolute);
  await rm(absolute, { recursive: true, force: false });
}

export async function createProject(projectRoot, { project_id: projectId, document }, { now = () => new Date().toISOString() } = {}) {
  requireProjectDirectoryName(projectId);
  const errors = validateProjectCreationDocument(document);
  if (errors.length) fail(422, "invalid_project_creation", errors);
  const materialized = materializeCreation(document, now(),(await defaultProfileAdapter(projectRoot,document.metadata.default_render_profile)).id);
  const { workspaceRoot, destination } = await assertDestinationAvailable(projectRoot, projectId);
  await mkdir(workspaceRoot, { recursive: true });
  await requirePlainDirectory(workspaceRoot, "workspace_not_found");
  await storage.assertRealPathWithin(path.resolve(projectRoot), workspaceRoot, "workspace root");
  const stagingDirectory = path.join(workspaceRoot, `.create-${randomUUID()}`);
  let stagingCreated = false;
  try {
    await mkdir(stagingDirectory, { recursive: false });
    stagingCreated = true;
    await storage.assertRealPathWithin(workspaceRoot, stagingDirectory, "project creation staging");
    await writeMaterializedProject(stagingDirectory, materialized);
    if (await pathExists(destination)) fail(409, "project_already_exists", [projectId]);
    try { await rename(stagingDirectory, destination); }
    catch (error) {
      if (new Set(["EEXIST", "ENOTEMPTY", "EPERM"]).has(error?.code) && await pathExists(destination)) {
        fail(409, "project_already_exists", [projectId]);
      }
      fail(500, "project_creation_publish_failed", [error?.message ?? String(error)]);
    }
  } catch (error) {
    if (stagingCreated) {
      await cleanupStaging(workspaceRoot, stagingDirectory).catch((cleanupError) => {
        throw new ProjectContractError(500, "project_creation_cleanup_failed", [error?.message ?? String(error), cleanupError?.message ?? String(cleanupError)]);
      });
    }
    throw error;
  }

  registerProject(projectRoot, { id: projectId, type: "story", path: path.resolve(destination), temporary: true });
  return {
    id: projectId,
    directory: `workspace/${projectId}`,
    absolute_directory: path.resolve(destination),
    title: materialized.project.title,
  };
}
