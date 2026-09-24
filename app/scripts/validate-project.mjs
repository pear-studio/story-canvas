#!/usr/bin/env node

import { validatePagesIndexDocument } from '../server/pages-store.mjs';
import { validatePageRewriteDocument } from '../server/page-rewrite.mjs';
import { validateSceneIndexDocument, validateSceneProfileDocument, validateSceneVisualDocument, validateScenePromptDocument } from '../server/scene-files.mjs';
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  diagnoseCharacterFiles,
  validateCharacterIndexDocument,
  validateCharacterProfileDocument,
  validateCharacterPromptDocument,
  validateCharacterVisualDocument,
} from "../server/character-files.mjs";
import { validateLetteringSettingsDocument } from "../server/lettering-settings.mjs";
import { requireProjectDirectoryName, validateCreativeAgreement, validateMaterialMetadata } from "../server/project-contracts.mjs";
import { validateProjectManifest } from "../server/project-manifest.mjs";
import { compileEffectiveRenderProfile, validateProjectRenderProfileOverride } from "../server/render-profile-compiler.mjs";
import { readRenderProfileOverrideDocument } from "../server/render-profile-override.mjs";
import {
  checkPagePromptOverrideReferences,
  validateStoryOutlineDocument,
  validateStoryPageNarrativeDocument,
  validateStoryPagePromptDocument,
} from "../server/story-files.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "..", "..");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readJson(projectRoot, relativePath, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`${relativePath} 不是合法 JSON`);
    throw new Error(`无法读取 ${relativePath}：${error.message}`);
  }
}

async function matchingFileIds(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name.slice(0, -suffix.length));
}

async function readAndValidateFiles(projectRoot, ids, suffix, validate, errors) {
  const documents = {};
  for (const id of ids) {
    const relative = `${suffix.directory}/${id}${suffix.extension}`;
    try {
      const document = await readJson(projectRoot, relative);
      documents[id] = document;
      errors.push(...validate(document).map((error) => `${relative}：${error}`));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return documents;
}

export async function validateProject(projectRoot) {
  const errors = [];
  const warnings = [];
  const [project, outline, pagesIndex, characterIndex, sceneIndex, letteringSettings, materialMetadata, creativeAgreement] = await Promise.all([
    readJson(projectRoot, "project.json"),
    readJson(projectRoot, "story/outline.json"),
    readJson(projectRoot, "pages/index.json"),
    readJson(projectRoot, "characters/index.json"),
    readJson(projectRoot, "scenes/index.json"),
    readJson(projectRoot, "lettering/settings.json"),
    readJson(projectRoot, "materials/index.json", { optional: true }),
    readJson(projectRoot, "creative-agreement.json", { optional: true }),
  ]);

  try { requireProjectDirectoryName(path.basename(projectRoot)); } catch { errors.push("项目目录名不是有效的项目 ID"); }
  errors.push(...validateProjectManifest(project));
  errors.push(...validateStoryOutlineDocument(outline).map((error) => `story/outline.json：${error}`));
  errors.push(...validatePagesIndexDocument(pagesIndex).map((error) => `pages/index.json：${error}`));
  errors.push(...validateCharacterIndexDocument(characterIndex).map((error) => `characters/index.json：${error}`));
  errors.push(...validateSceneIndexDocument(sceneIndex).map((error) => `scenes/index.json：${error}`));
  errors.push(...validateLetteringSettingsDocument(letteringSettings).map((error) => `lettering/settings.json：${error}`));
  errors.push(...validateMaterialMetadata(materialMetadata));
  errors.push(...validateCreativeAgreement(creativeAgreement));

  const pageDirectory = path.join(projectRoot, "pages");
  const narrativePageIds = await matchingFileIds(pageDirectory, ".content.json");
  const storyPromptPageIds = await matchingFileIds(pageDirectory, ".prompt.json");
  const rewritePageIds = await matchingFileIds(pageDirectory, ".rewrite.json");
  const storyNarratives = await readAndValidateFiles(projectRoot, narrativePageIds, { directory: "pages", extension: ".content.json" }, validateStoryPageNarrativeDocument, errors);
  await readAndValidateFiles(projectRoot, storyPromptPageIds, { directory: "pages", extension: ".prompt.json" }, validateStoryPagePromptDocument, errors);
  await readAndValidateFiles(projectRoot, rewritePageIds, { directory: "pages", extension: ".rewrite.json" }, validatePageRewriteDocument, errors);
  const indexedIds = new Set((pagesIndex.pages ?? []).map(entry => entry.page_id));
  for (const id of indexedIds) {
    if (!narrativePageIds.includes(id)) errors.push(`页面文件：missing_content_file（page_id=${id}）`);
    if (!storyPromptPageIds.includes(id)) errors.push(`页面文件：missing_prompt_file（page_id=${id}）`);
  }
  for (const id of new Set([...narrativePageIds, ...storyPromptPageIds, ...rewritePageIds])) if (!indexedIds.has(id)) errors.push(`页面文件：unindexed_page（page_id=${id}）`);
  const characterDirectory = path.join(projectRoot, "characters");
  const profileCharacterIds = await matchingFileIds(characterDirectory, ".profile.json");
  const visualCharacterIds = await matchingFileIds(characterDirectory, ".visual.json");
  const promptCharacterIds = await matchingFileIds(characterDirectory, ".prompt.json");
  await readAndValidateFiles(projectRoot, profileCharacterIds, { directory: "characters", extension: ".profile.json" }, validateCharacterProfileDocument, errors);
  const visualByCharacter = await readAndValidateFiles(projectRoot, visualCharacterIds, { directory: "characters", extension: ".visual.json" }, validateCharacterVisualDocument, errors);
  const promptByCharacter = await readAndValidateFiles(projectRoot, promptCharacterIds, { directory: "characters", extension: ".prompt.json" }, validateCharacterPromptDocument, errors);

  const knownCharacters = new Set(characterIndex.characters ?? []);
  for (const diagnostic of diagnoseCharacterFiles({ characterIndex, profileCharacterIds, visualByCharacter, promptByCharacter,
    storyNarrativesByPage: storyNarratives,
    characterStyles: { characters: Object.fromEntries(Object.entries(letteringSettings.character_colors ?? {}).map(([id, display_color]) => [id, { display_color }])) },
  })) {
    const message = `角色文件：${diagnostic.code}（${Object.entries(diagnostic).filter(([key]) => key !== 'code').map(([key, value]) => `${key}=${value}`).join('，')}）`;
    (diagnostic.code.startsWith('dangling_') ? warnings : errors).push(message);
  }
  const sceneIds = sceneIndex.scenes ?? [];
  await readAndValidateFiles(projectRoot, sceneIds, { directory: "scenes", extension: ".profile.json" }, validateSceneProfileDocument, errors);
  const sceneVisual = await readAndValidateFiles(projectRoot, sceneIds, { directory: "scenes", extension: ".visual.json" }, validateSceneVisualDocument, errors);
  const scenePrompts = await readAndValidateFiles(projectRoot, sceneIds, { directory: "scenes", extension: ".prompt.json" }, validateScenePromptDocument, errors);
  for (const id of sceneIds) for (const variant of sceneVisual[id]?.variants ?? []) if (!scenePrompts[id]?.variants?.[variant.id]) errors.push(`场景子设定 Prompt 缺失：${id}/${variant.id}`);
  const sequenceIds = new Set((outline.chapters ?? []).flatMap(chapter => (chapter.sequences ?? []).map(sequence => sequence.id)));
  for (const entry of pagesIndex.pages ?? []) {
    const ownerValid = entry.owner_kind === 'story' ? sequenceIds.has(entry.sequence_id)
      : entry.owner_kind === 'character' ? knownCharacters.has(entry.character_id) && visualByCharacter[entry.character_id]?.variants.some(v => v.id === entry.variant_id)
      : sceneIds.includes(entry.scene_id) && sceneVisual[entry.scene_id]?.variants.some(v => v.id === entry.variant_id);
    if (!ownerValid) warnings.push(`页面归属待整理：${entry.page_id}`);
    const content = storyNarratives[entry.page_id];
    for (const reference of content?.characters ?? []) if (!knownCharacters.has(reference.character_id) || !visualByCharacter[reference.character_id]?.variants.some(v => v.id === reference.variant_id)) warnings.push(`页面角色引用待修复：${entry.page_id}/${reference.character_id}/${reference.variant_id}`);
    try {
      const prompt = await readJson(projectRoot, `pages/${entry.page_id}.prompt.json`);
      errors.push(...checkPagePromptOverrideReferences(prompt, content?.characters ?? []).map(error => `pages/${entry.page_id}.prompt.json：${error}`));
    } catch (error) { warnings.push(`页面 Prompt 待修复：${entry.page_id}：${error.message}`); }
  }

  let overrideDocument = null;
  let overrideValid = false;
  try {
    overrideDocument = await readRenderProfileOverrideDocument(projectRoot);
    await validateProjectRenderProfileOverride({ repositoryRoot: repoRoot, projectRoot, overrideDocument });
    overrideValid = true;
  } catch (error) {
    errors.push(`项目生成配置调整无效：${error.message}`);
  }
  if (overrideValid && typeof project?.default_render_profile === "string") {
    try {
      const compiledProfile = await compileEffectiveRenderProfile({
        repositoryRoot: repoRoot,
        projectRoot,
        profileId: project.default_render_profile,
        overrideDocument,
      });
      if (compiledProfile.blocked) {
        const targets = compiledProfile.override_resolution.conflicts.map((conflict) => conflict.target);
        errors.push(`默认生成配置的项目调整存在冲突：${targets.join("、")}`);
      }
    } catch (error) {
      errors.push(`无法读取默认生成配置：${error.message}`);
    }
  }

  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    counts: {
      storyPages: (pagesIndex.pages ?? []).filter(entry => entry.owner_kind === "story").length,
      characterPages: (pagesIndex.pages ?? []).filter(entry => entry.owner_kind === "character").length,
      scenePages: (pagesIndex.pages ?? []).filter(entry => entry.owner_kind === "scene").length,
      characters: Array.isArray(characterIndex?.characters) ? characterIndex.characters.length : 0,
      promptIssues: 0,
    },
  };
}

async function main() {
  const projectArgument = argumentValue("--project");
  if (!projectArgument) throw new Error("缺少 --project，例如：--project workspace/ellen-jk-v3");
  const projectRoot = path.resolve(repoRoot, projectArgument);
  const result = await validateProject(projectRoot);
  console.log(`项目：${path.relative(repoRoot, projectRoot)}`);
  console.log(`统计：${result.counts.storyPages} 个剧情页面，${result.counts.characterPages} 个角色页面，${result.counts.characters} 个角色`);
  for (const warning of result.warnings) console.log(`警告：${warning}`);
  for (const error of result.errors) console.error(`错误：${error}`);
  if (result.errors.length) process.exitCode = 1;
  else console.log("项目事实校验通过");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
