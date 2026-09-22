import { cleanRemovedReferences } from './reference-materials.mjs';
import { readPageIndex, validatePagesIndexDocument } from "./pages-store.mjs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { validateLetteringSettingsDocument } from "./lettering-settings.mjs";

import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
  characterIdPattern,
  characterVariantIdPattern,
  diagnoseCharacterCoreDependents,
  validateCharacterIndexDocument,
  validateCharacterProfileDocument,
  validateCharacterPromptDocument,
  validateCharacterVisualDocument,
} from "./character-files.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { assertNoActivePageRender } from "./render-task-storage.mjs";
import {
  commitFactChanges,
  FactError,
  factStorage as storage,
} from "./story-facts.mjs";
import {
  storyPageIdPattern,
  storyNarrativeSpeakerIds,
  validateStoryPageNarrativeDocument,
} from "./story-files.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { auditSavedCharacterPrompt, capturePromptAuditInput, preparePromptWriteAudit } from "./prompt-write-audit.mjs";

export const DELETED_CHARACTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function fail(code, details = []) {
  throw new FactError(code, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertDocument(errors) {
  if (errors.length) fail("invalid_character_edit_document", errors);
}

function characterRelativePath(characterId, suffix) {
  return storage.projectRelativePath("characters", `${characterId}.${suffix}.json`);
}

function characterTarget(projectDirectory, characterId, suffix) {
  return storage.targetPath(projectDirectory, characterRelativePath(characterId, suffix));
}

function visualIdentity(visual) {
  return hashCanonicalJson((Array.isArray(visual?.variants) ? visual.variants : [])
    .map((variant) => variant.id)
    .sort((left, right) => left.localeCompare(right, "en")));
}

function emptyVariant() {
  return { text: "", reference_images: [] };
}

function normalizePromptToVisual(promptDocument, visual) {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    prompt_name: promptDocument.prompt_name,
    variants: Object.fromEntries(variantIds(visual).map((variantId) => [
      variantId,
      structuredClone(promptDocument.variants[variantId] ?? emptyVariant()),
    ])),
  };
}

function variantIds(visual) {
  return (Array.isArray(visual?.variants) ? visual.variants : []).map((variant) => variant.id).sort((left, right) => left.localeCompare(right, "en"));
}

function promptVariantIds(promptDocument) {
  return Object.keys(isRecord(promptDocument?.variants) ? promptDocument.variants : {}).sort((left, right) => left.localeCompare(right, "en"));
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPromptMatchesVisual(promptDocument, visual) {
  const expected = variantIds(visual);
  const actual = promptVariantIds(promptDocument);
  if (!sameStrings(expected, actual)) {
    fail("character_prompt_visual_mismatch", [`visual variants=${expected.join(",")}；prompt variants=${actual.join(",")}`]);
  }
}

async function readCharacterIndex(projectDirectory) {
  const value = await storage.readJson(path.join(projectDirectory, "characters", "index.json"), "characters/index.json");
  assertDocument(validateCharacterIndexDocument(value));
  return value;
}

async function readCharacterProfile(projectDirectory, characterId) {
  const value = await storage.readJson(characterTarget(projectDirectory, characterId, "profile"), characterRelativePath(characterId, "profile"));
  assertDocument(validateCharacterProfileDocument(value));
  return value;
}

async function readCharacterVisual(projectDirectory, characterId) {
  const value = await storage.readJson(characterTarget(projectDirectory, characterId, "visual"), characterRelativePath(characterId, "visual"));
  assertDocument(validateCharacterVisualDocument(value));
  return value;
}

async function readCharacterPrompt(projectDirectory, characterId) {
  const value = await storage.readJson(characterTarget(projectDirectory, characterId, "prompt"), characterRelativePath(characterId, "prompt"));
  assertDocument(validateCharacterPromptDocument(value));
  return value;
}

async function requireCharacter(projectDirectory, characterId) {
  if (!characterIdPattern.test(characterId ?? "") || characterId === "npc") fail("invalid_character_id", [String(characterId)]);
  const index = await readCharacterIndex(projectDirectory);
  if (!index.characters.includes(characterId)) fail("character_not_found", [characterId]);
  return index;
}

async function listStoryNarratives(projectRoot, projectDirectory) {
  const pagesDirectory = path.join(projectDirectory, "pages");
  await storage.assertProjectFactBoundary(projectRoot, projectDirectory, pagesDirectory, "pages");
  const narratives = {};
  for (const entry of await readdir(pagesDirectory, { withFileTypes: true })) {
    const match = /^(page-(?:\d{3}|[a-f0-9]{12}))\.content\.json$/.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) fail("unsafe_character_edit_path", [entry.name]);
    const narrative = await storage.readJson(path.join(pagesDirectory, entry.name), `pages/${entry.name}`);
    assertDocument(validateStoryPageNarrativeDocument(narrative));
    narratives[match[1]] = narrative;
  }
  return narratives;
}

async function readCharacterPages(projectDirectory) {
  return (await readPageIndex(projectDirectory)).pages.filter(page => page.owner_kind === "character");
}

async function readCharacterStyles(projectDirectory) {
  const target = path.join(projectDirectory, "lettering", "settings.json");
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return { characters: {} };
  if (!info.isFile() || info.isSymbolicLink()) fail("unsafe_character_edit_path", [target]);
  const value = await storage.readJson(target, "lettering/settings.json");
  const errors = validateLetteringSettingsDocument(value);
  if (errors.length) fail("invalid_lettering_settings", errors);
  return {
    characters: Object.fromEntries(Object.entries(value.character_colors)
      .map(([characterId, displayColor]) => [characterId, { display_color: displayColor }])),
  };
}

function referencesForCharacter(narratives, characterId, characterPages = [], { includeDialogueSpeakers = false } = {}) {
  const references = [];
  for (const [pageId, narrative] of Object.entries(narratives)) {
    for (const reference of narrative.characters) {
      if (reference.character_id === characterId) references.push({ owner_kind: "story", page_id: pageId, variant_id: reference.variant_id });
    }
    if (includeDialogueSpeakers && storyNarrativeSpeakerIds(narrative).includes(characterId)) {
      references.push({ owner_kind: "story", page_id: pageId, dialogue_speaker: true });
    }
  }
  for (const page of characterPages) {
    if (page?.character_id === characterId) references.push({ owner_kind: "character", page_id: page.page_id, variant_id: page.variant_id });
  }
  return references;
}

async function currentCharacterDiagnostics(projectRoot, projectDirectory, characterId, { exists, visual, prompt }) {
  const [storyNarrativesByPage, characterPages, characterStyles] = await Promise.all([
    listStoryNarratives(projectRoot, projectDirectory),
    readCharacterPages(projectDirectory),
    readCharacterStyles(projectDirectory),
  ]);
  return {
    storyNarrativesByPage,
    characterPages,
    diagnostics: diagnoseCharacterCoreDependents({
      characterId,
      exists,
      visual,
      prompt,
      characterPages,
      characterStyles,
      storyNarrativesByPage,
    }),
  };
}

export async function readCharacterFactDraft(projectRoot, projectId, characterId, kind) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  await requireCharacter(project.projectDirectory, characterId);
  const visual = await readCharacterVisual(project.projectDirectory, characterId);
  let persisted;
  let editable;
  if (kind === "profile") persisted = await readCharacterProfile(project.projectDirectory, characterId);
  else if (kind === "visual") persisted = visual;
  else {
    persisted = await readCharacterPrompt(project.projectDirectory, characterId);
    editable = normalizePromptToVisual(persisted, visual);
  }
  const targetRelative = characterRelativePath(characterId, kind);
  await storage.assertProjectFactBoundary(projectRoot, project.projectDirectory, storage.targetPath(project.projectDirectory, targetRelative), targetRelative);
  return {
    project, definition: {
      targetRelative,
      persisted,
      ...(editable === undefined ? {} : { editable, targetBaseline: persisted }),
      identity: { character_id: characterId },
      upstream: kind === "prompt"
        ? { visual: { relative_path: characterRelativePath(characterId, "visual"), identity_sha256: visualIdentity(visual) } }
        : {},
    }
  };
}

async function prepareCharacterPersistence(kind, baseline, edited, currentVisual) {
  if (kind === "profile") {
    assertDocument(validateCharacterProfileDocument(edited));
    return { persisted: edited };
  }
  if (kind === "visual") {
    delete edited.description; delete edited.base_description;
    for (const variant of edited.variants ?? []) delete variant.description;
    assertDocument(validateCharacterVisualDocument(edited));
    return {
      persisted: edited,
    };
  }
  const persisted = structuredClone(edited);
  const unknownVariants = promptVariantIds(persisted).filter(id => !variantIds(currentVisual).includes(id));
  if (unknownVariants.length) fail("character_prompt_visual_mismatch", unknownVariants);
  assertDocument(validateCharacterPromptDocument(persisted));
  return {
    persisted,
  };
}

export async function commitCharacterFact(projectRoot, context, readDocument, kind, { beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), context.project_id);
  const characterId = context.character_id;
  const auditPrepared = kind === "prompt" ? await preparePromptWriteAudit(projectRoot) : null;
  await requireCharacter(project.projectDirectory, characterId);
  const target = storage.targetPath(project.projectDirectory, context.target.relative_path);
  await storage.assertProjectFactBoundary(projectRoot, project.projectDirectory, target, context.target.relative_path);
  const baseline = await storage.assertTargetBaseline(project.projectDirectory, context);
  const edited = await readDocument();
  const visual = kind === "prompt" ? await readCharacterVisual(project.projectDirectory, characterId) : null;
  if (visual && visualIdentity(visual) !== context.upstream.visual.identity_sha256) fail("character_edit_upstream_conflict", [characterId]);
  const prepared = await prepareCharacterPersistence(kind, baseline, edited, visual);
  const downstreamDiagnostics = kind === "visual" || kind === "prompt"
    ? (await currentCharacterDiagnostics(projectRoot, project.projectDirectory, characterId, {
      exists: true,
      visual: kind === "visual" ? prepared.persisted : visual,
      prompt: kind === "prompt" ? prepared.persisted : await readCharacterPrompt(project.projectDirectory, characterId),
    })).diagnostics : [];
  if (beforeCommit !== undefined) {
    if (typeof beforeCommit !== "function") fail("invalid_character_edit_option", ["beforeCommit 必须是函数"]);
    await beforeCommit();
  }
  await commitFactChanges(project.projectDirectory, [{ relative: context.target.relative_path, before: baseline, after: prepared.persisted }]);
  const result = {
    target_file: path.resolve(target), value: prepared.persisted, downstream_diagnostics: downstreamDiagnostics,
  };
  if (kind === "prompt") {
    const captured = auditPrepared.value ? await capturePromptAuditInput(() => ({ characterId, prompt: structuredClone(prepared.persisted) })) : undefined;
    result.audit = await auditSavedCharacterPrompt(auditPrepared, captured);
  }
  return result;
}

function defaultCharacterFacts(characterId, name) {
  const displayName = typeof name === "string" && name.trim() ? name.trim() : characterId;
  return {
    profile: {
      $schema: CHARACTER_PROFILE_SCHEMA_ID,
      name: displayName,
      description: "待补充角色设定。",
    },
    visual: {
      $schema: CHARACTER_VISUAL_SCHEMA_ID,
      variants: [{ id: "default", name: "默认" }],
    },
    prompt: {
      $schema: CHARACTER_PROMPT_SCHEMA_ID,
      prompt_name: displayName,
      variants: { default: emptyVariant() },
    },
  };
}

export async function createCharacter(projectRoot, projectId, characterId, { name, beforeCommit } = {}) {
  if (!characterIdPattern.test(characterId ?? "") || characterId === "npc") fail("invalid_character_id", [String(characterId)]);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);

  const index = await readCharacterIndex(project.projectDirectory);
  if (index.characters.includes(characterId)) fail("character_already_exists", [characterId]);
  const facts = defaultCharacterFacts(characterId, name);
  assertDocument(validateCharacterProfileDocument(facts.profile));
  assertDocument(validateCharacterVisualDocument(facts.visual));
  assertDocument(validateCharacterPromptDocument(facts.prompt));
  const targets = ["profile", "visual", "prompt"].map((suffix) => ({ suffix, target: characterTarget(project.projectDirectory, characterId, suffix) }));
  for (const item of targets) {
    const exists = await lstat(item.target).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
    if (exists) fail("character_fact_already_exists", [item.target]);
  }
  const nextIndex = { ...structuredClone(index), characters: [...index.characters, characterId] };
  assertDocument(validateCharacterIndexDocument(nextIndex));
  const written = [];
  try {
    for (const item of targets) {
      await storage.writeJsonAtomic(item.target, facts[item.suffix]);
      written.unshift(item.target);
    }
    if (beforeCommit !== undefined) {
      if (typeof beforeCommit !== "function") fail("invalid_character_edit_option", ["beforeCommit 必须是函数"]);
      await beforeCommit();
    }
    await storage.writeJsonAtomic(path.join(project.projectDirectory, "characters", "index.json"), nextIndex);
  } catch (error) {
    await storage.rollbackCreatedFactFiles(written, error, "character_create_rollback_failed");
    throw error;
  }
  return {
    character_id: characterId,
    profile_file: path.resolve(targets[0].target),
    visual_file: path.resolve(targets[1].target),
    prompt_file: path.resolve(targets[2].target),
    index_file: path.resolve(project.projectDirectory, "characters", "index.json"),
  };
}

function deletedCharactersRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), "Saved", "state", "deleted-characters");
}

async function createDeletedCharacterDirectory(projectRoot, projectId) {
  const root = deletedCharactersRoot(projectRoot);
  await mkdir(root, { recursive: true });
  await storage.assertRealPathWithin(path.resolve(projectRoot), root, "deleted-characters root");
  const parent = path.join(root, projectId);
  await mkdir(parent, { recursive: true });
  await storage.assertRealPathWithin(root, parent, "deleted-characters project directory");
  for (;;) {
    const deletionId = `deleted-${randomBytes(6).toString("hex")}`;
    const directory = path.join(parent, deletionId);
    try {
      await mkdir(directory);
      await storage.assertRealPathWithin(parent, directory, "deleted character archive");
      return { deletionId, directory };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function preflightCharacterFacts(projectRoot, projectDirectory, characterId) {
  const sources = [];
  for (const suffix of ["profile", "visual", "prompt"]) {
    const relativePath = characterRelativePath(characterId, suffix);
    const source = storage.targetPath(projectDirectory, relativePath);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) fail("unsafe_character_edit_path", [relativePath]);
    await storage.assertRealPathWithin(projectDirectory, source, relativePath);
    sources.push({ relative_path: relativePath, source });
  }
  return sources;
}

async function moveCharacterFacts(archiveDirectory, sources, moved) {
  for (const source of sources) {
    const destination = storage.targetPath(archiveDirectory, source.relative_path);
    await mkdir(path.dirname(destination), { recursive: true });
    await storage.assertRealPathWithin(archiveDirectory, path.dirname(destination), "deleted character archive destination");
    await rename(source.source, destination);
    moved.push({ ...source, destination });
  }
}

async function rollbackCharacterFacts(moved) {
  const results = [];
  for (const item of [...moved].reverse()) {
    try {
      await rename(item.destination, item.source);
      results.push({ source: item.source, destination: item.destination, restored: true });
    } catch (error) {
      results.push({
        source: item.source,
        destination: item.destination,
        restored: false,
        error: { code: error?.code, message: error?.message ?? String(error) },
      });
    }
  }
  return results;
}

function rollbackFailure(originalError, archiveDirectory, results, cleanupError) {
  const describe = (error) => `${error?.code ? `[${error.code}] ` : ""}${error?.message ?? String(error)}`;
  const failure = new FactError("character_delete_rollback_failed", [
    `原始错误：${describe(originalError)}`,
    `归档目录：${archiveDirectory}`,
    ...results.map((result) => result.restored
      ? `已恢复：${result.source}`
      : `未恢复：${result.source}（仍在 ${result.destination}；${describe(result.error)}）`),
    ...(cleanupError ? [`归档清理失败：${describe(cleanupError)}`] : []),
  ]);
  failure.cause = originalError;
  failure.rollback_results = results;
  if (cleanupError) failure.cleanup_error = { code: cleanupError?.code, message: cleanupError?.message ?? String(cleanupError) };
  return failure;
}

export async function deleteCharacterVariant(projectRoot, projectId, characterId, variantId, { beforeCommit } = {}) {
  if (!characterIdPattern.test(characterId ?? "") || characterId === "npc") fail("invalid_character_id", [String(characterId)]);
  if (!characterVariantIdPattern.test(variantId ?? "") || variantId === "main") fail("invalid_character_variant_id", [String(variantId)]);
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    fail("invalid_character_edit_option", ["beforeCommit 必须是函数"]);
  }
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);

  await requireCharacter(project.projectDirectory, characterId);
  const [visual, prompt, narratives, characterPages] = await Promise.all([
    readCharacterVisual(project.projectDirectory, characterId),
    readCharacterPrompt(project.projectDirectory, characterId),
    listStoryNarratives(projectRoot, project.projectDirectory),
    readCharacterPages(project.projectDirectory),
  ]);
  const references = referencesForCharacter(narratives, characterId, characterPages)
    .filter((reference) => reference.variant_id === variantId);
  if (references.length) fail("character_variant_still_in_use", [characterId, variantId]);
  const ordinal = visual.variants.findIndex((variant) => variant.id === variantId);
  if (ordinal < 0) fail("character_variant_not_found", [characterId, variantId]);
  if (visual.variants.length <= 1) fail("character_last_variant", [characterId, variantId]);

  const nextVisual = structuredClone(visual);
  nextVisual.variants.splice(ordinal, 1);
  const nextPrompt = structuredClone(prompt);
  const promptCleaned = Object.hasOwn(nextPrompt.variants, variantId);
  delete nextPrompt.variants[variantId];
  assertDocument(validateCharacterVisualDocument(nextVisual));
  assertDocument(validateCharacterPromptDocument(nextPrompt));

  const visualTarget = characterTarget(project.projectDirectory, characterId, "visual");
  const promptTarget = characterTarget(project.projectDirectory, characterId, "prompt");
  await Promise.all([
    storage.assertProjectFactBoundary(projectRoot, project.projectDirectory, visualTarget, characterRelativePath(characterId, "visual")),
    storage.assertProjectFactBoundary(projectRoot, project.projectDirectory, promptTarget, characterRelativePath(characterId, "prompt")),
  ]);
  let promptWritten = false;
  try {
    if (promptCleaned) {
      await storage.writeJsonAtomic(promptTarget, nextPrompt);
      promptWritten = true;
    }
    if (beforeCommit) await beforeCommit();
    await storage.writeJsonAtomic(visualTarget, nextVisual);
  } catch (error) {
    if (promptWritten) {
      try {
        await storage.writeJsonAtomic(promptTarget, prompt);
      } catch (rollbackError) {
        const failure = new FactError("character_variant_delete_rollback_failed", [
          characterId,
          variantId,
          rollbackError?.message ?? String(rollbackError),
        ]);
        failure.cause = error;
        throw failure;
      }
    }
    throw error;
  }
  await cleanRemovedReferences(project.projectDirectory, prompt);
  return {
    character_id: characterId,
    variant_id: variantId,
    prompt_cleaned: promptCleaned,
    visual_file: path.resolve(visualTarget),
    prompt_file: path.resolve(promptTarget),
    downstream_diagnostics: [],
  };
}

export async function renameCharacterVariant(projectRoot, projectId, characterId, oldId, newId, { beforeCommit } = {}) {
  if (!characterIdPattern.test(characterId ?? "") || characterId === "npc") fail("invalid_character_id", [String(characterId)]);
  if (!characterVariantIdPattern.test(oldId ?? "") || oldId === "main") fail("invalid_character_variant_id", [String(oldId)]);
  if (!characterVariantIdPattern.test(newId ?? "") || newId === "main") fail("invalid_character_variant_id", [String(newId)]);
  if (oldId === newId) fail("invalid_character_variant_id", [`新旧 variant ID 相同：${newId}`]);
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    fail("invalid_character_edit_option", ["beforeCommit 必须是函数"]);
  }
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);

  await requireCharacter(project.projectDirectory, characterId);
  const [visual, prompt, narratives, characterPages] = await Promise.all([
    readCharacterVisual(project.projectDirectory, characterId),
    readCharacterPrompt(project.projectDirectory, characterId),
    listStoryNarratives(projectRoot, project.projectDirectory),
    readCharacterPages(project.projectDirectory),
  ]);
  const ordinal = visual.variants.findIndex((variant) => variant.id === oldId);
  if (ordinal < 0) fail("character_variant_not_found", [characterId, oldId]);
  if (visual.variants.some((variant) => variant.id === newId)) fail("character_variant_already_exists", [characterId, newId]);

  const updatedStoryPageIds = Object.entries(narratives)
    .filter(([, narrative]) => narrative.characters.some((reference) => reference.character_id === characterId && reference.variant_id === oldId))
    .map(([pageId]) => pageId)
    .sort((left, right) => left.localeCompare(right, "en"));
  const updatedCharacterPageIds = characterPages
    .filter((page) => page?.character_id === characterId && page?.variant_id === oldId)
    .map((page) => page.page_id)
    .sort((left, right) => left.localeCompare(right, "en"));
  const affectedPageIds = [...new Set([...updatedStoryPageIds, ...updatedCharacterPageIds])]
    .sort((left, right) => left.localeCompare(right, "en"));

  const nextVisual = structuredClone(visual);
  nextVisual.variants[ordinal] = { ...nextVisual.variants[ordinal], id: newId };
  const nextPrompt = structuredClone(prompt);
  nextPrompt.variants = Object.fromEntries(Object.entries(nextPrompt.variants)
    .map(([variantId, configuration]) => [variantId === oldId ? newId : variantId, configuration]));
  assertDocument(validateCharacterVisualDocument(nextVisual));
  assertDocument(validateCharacterPromptDocument(nextPrompt));

  const writes = [
    {
      relativePath: characterRelativePath(characterId, "visual"),
      next: nextVisual,
      previous: visual,
    },
    {
      relativePath: characterRelativePath(characterId, "prompt"),
      next: nextPrompt,
      previous: prompt,
    },
  ];
  if (updatedCharacterPageIds.length) {
    const pagesIndexRelative = storage.projectRelativePath("pages", "index.json");
    const pagesIndexValue = await storage.readJson(storage.targetPath(project.projectDirectory, pagesIndexRelative), pagesIndexRelative);
    const nextPagesIndex = structuredClone(pagesIndexValue);
    for (const page of nextPagesIndex.pages) {
      if (page?.owner_kind === "character" && page.character_id === characterId && page.variant_id === oldId) page.variant_id = newId;
    }
    assertDocument(validatePagesIndexDocument(nextPagesIndex));
    writes.push({ relativePath: pagesIndexRelative, next: nextPagesIndex, previous: pagesIndexValue });
  }
  for (const pageId of updatedStoryPageIds) {
    const narrative = narratives[pageId];
    const nextNarrative = structuredClone(narrative);
    for (const reference of nextNarrative.characters) {
      if (reference.character_id === characterId && reference.variant_id === oldId) reference.variant_id = newId;
    }
    assertDocument(validateStoryPageNarrativeDocument(nextNarrative));
    writes.push({
      relativePath: storage.projectRelativePath("pages", `${pageId}.content.json`),
      next: nextNarrative,
      previous: narrative,
    });
  }
  for (const pageId of affectedPageIds) {
      const relativePath = storage.projectRelativePath('pages', pageId + '.prompt.json');
      const previous = await storage.readJson(storage.targetPath(project.projectDirectory, relativePath), relativePath);
      const oldSource = 'character:' + characterId + ':' + oldId;
      if (!Object.hasOwn(previous.text_overrides ?? {}, oldSource) && !Object.hasOwn(previous.reference_overrides ?? {}, oldSource)) continue;
      const next = structuredClone(previous);
      for (const field of ['text_overrides', 'reference_overrides']) if (Object.hasOwn(next[field] ?? {}, oldSource)) {
        next[field]['character:' + characterId + ':' + newId] = next[field][oldSource];
        delete next[field][oldSource];
      }
      writes.push({ relativePath, next, previous });
  }
  await Promise.all(writes.map((write) => (
    storage.assertProjectFactBoundary(projectRoot, project.projectDirectory, storage.targetPath(project.projectDirectory, write.relativePath), write.relativePath)
  )));
  if (beforeCommit) await beforeCommit();
  const written = [];
  try {
    for (const write of writes) {
      await storage.writeJsonAtomic(storage.targetPath(project.projectDirectory, write.relativePath), write.next);
      written.push(write);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const write of written.reverse()) {
      try { await storage.writeJsonAtomic(storage.targetPath(project.projectDirectory, write.relativePath), write.previous); }
      catch (rollbackError) { rollbackErrors.push(`${write.relativePath}: ${rollbackError?.message ?? String(rollbackError)}`); }
    }
    if (rollbackErrors.length) {
      const failure = new FactError("character_variant_rename_rollback_failed", [characterId, oldId, newId, ...rollbackErrors]);
      failure.cause = error;
      throw failure;
    }
    throw error;
  }
  return {
    character_id: characterId,
    old_id: oldId,
    new_id: newId,
    updated_page_ids: affectedPageIds,
    visual: nextVisual,
    prompt: nextPrompt,
    visual_file: path.resolve(storage.targetPath(project.projectDirectory, characterRelativePath(characterId, "visual"))),
    prompt_file: path.resolve(storage.targetPath(project.projectDirectory, characterRelativePath(characterId, "prompt"))),
    downstream_diagnostics: [],
  };
}

export async function deleteCharacter(projectRoot, projectId, characterId, { beforeCommit } = {}) {
  if (!characterIdPattern.test(characterId ?? "") || characterId === "npc") fail("invalid_character_id", [String(characterId)]);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);

  const index = await requireCharacter(project.projectDirectory, characterId);
  await Promise.all([
    readCharacterVisual(project.projectDirectory, characterId),
    readCharacterPrompt(project.projectDirectory, characterId),
  ]);

  const dependencyState = await currentCharacterDiagnostics(projectRoot, project.projectDirectory, characterId, {
    exists: false,
    visual: { variants: [] },
    prompt: { variants: {} },
  });
  const references = referencesForCharacter(
    dependencyState.storyNarrativesByPage,
    characterId,
    dependencyState.characterPages,
    { includeDialogueSpeakers: true },
  );
  for (const reference of references) {
    await assertNoActivePageRender(project.projectDirectory, { page_id: reference.page_id });
  }
  const ordinal = index.characters.indexOf(characterId);
  const nextIndex = structuredClone(index);
  nextIndex.characters.splice(ordinal, 1);
  const sources = await preflightCharacterFacts(projectRoot, project.projectDirectory, characterId);
  const archive = await createDeletedCharacterDirectory(projectRoot, project.projectId);
  const manifest = {
    version: 1,
    deletion_id: archive.deletionId,
    project_id: project.projectId,
    character_id: characterId,
    ordinal,
    previous_character_id: index.characters[ordinal - 1] ?? null,
    next_character_id: index.characters[ordinal + 1] ?? null,
    deleted_at: new Date().toISOString(),
    archived_paths: sources.map((source) => source.relative_path),
  };
  const removedReferences = await readCharacterPrompt(project.projectDirectory, characterId);
  const moved = [];
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    fail("invalid_character_edit_option", ["beforeCommit 必须是函数"]);
  }
  try {
    await storage.writeJsonAtomic(path.join(archive.directory, "deletion.json"), manifest);
    await moveCharacterFacts(archive.directory, sources, moved);
    if (beforeCommit) await beforeCommit({ moved: structuredClone(moved), archive_directory: archive.directory });
    await storage.writeJsonAtomic(path.join(project.projectDirectory, "characters", "index.json"), nextIndex);
  } catch (error) {
    const rollbackResults = await rollbackCharacterFacts(moved);
    if (rollbackResults.some((result) => !result.restored)) {
      throw rollbackFailure(error, archive.directory, rollbackResults);
    }
    try {
      await storage.removeSafeRuntimeDirectory(projectRoot, deletedCharactersRoot(projectRoot), archive.directory, "deleted character archive");
    } catch (cleanupError) {
      throw rollbackFailure(error, archive.directory, rollbackResults, cleanupError);
    }
    throw error;
  }
  await cleanRemovedReferences(project.projectDirectory, removedReferences);
  return {
    deletion_id: archive.deletionId,
    archive_directory: path.resolve(archive.directory),
    character_id: characterId,
    downstream_diagnostics: dependencyState.diagnostics,
  };
}

export async function cleanupDeletedCharacters(
  projectRoot,
  { now = Date.now(), maxAgeMs = DELETED_CHARACTER_RETENTION_MS } = {},
) {
  const root = deletedCharactersRoot(projectRoot);
  const removed = [];
  const projects = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  if (projects.length) await storage.assertRealPathWithin(path.resolve(projectRoot), root, "deleted-characters root");
  for (const projectEntry of projects) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
    const projectDirectory = path.join(root, projectEntry.name);
    for (const entry of await readdir(projectDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^deleted-[a-f0-9]{12}$/.test(entry.name)) continue;
      const archiveDirectory = path.join(projectDirectory, entry.name);
      let deletedAt = null;
      try {
        const manifest = await storage.readJson(path.join(archiveDirectory, "deletion.json"), "deleted character manifest");
        deletedAt = Date.parse(manifest.deleted_at);
      } catch (error) {
        if (!(error instanceof FactError)) throw error;
      }
      if (!Number.isFinite(deletedAt)) deletedAt = (await stat(archiveDirectory)).mtimeMs;
      if (now - deletedAt < maxAgeMs) continue;
      await storage.removeSafeRuntimeDirectory(projectRoot, root, archiveDirectory, "deleted character archive");
      removed.push(path.resolve(archiveDirectory));
    }
  }
  return removed;
}
