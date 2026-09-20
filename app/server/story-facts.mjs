import { readPageEntry, readStoryPagesIndex, writeStoryPagesIndex, pageRelativePath } from "./pages-store.mjs";
import { planCharacterSwitch, applySceneSwitch, requireImpactConfirmation, commitFactChanges, optionalFact, readInheritanceSources, checkPageInheritance } from './prompt-inheritance-facts.mjs';
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveProjectLocation } from "./project-operations.mjs";
import {
  diagnoseStoryPageFiles,
  preparePromptForPersistence,
  prepareStoryPageNarrativeForPersistence,
  promptCharacterIds,
  storyNarrativeSpeakerIds,
  storyPageIdPattern,
  validateStoryOutlineDocument,
  validateStoryPageNarrativeDocument,
  validateStoryPagePromptDocument,
  validateStoryPageTextSourcesDocument,
  validateStoryPagesIndexDocument,
} from "./story-files.mjs";
import { verifyWritingCorpusSentence } from "./writing-corpus.mjs";
import { createStoryPageKey } from "./page-key.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { storyContentWarnings } from "../shared/story-content-guidance.mjs";
import { capturePagePromptSnapshot } from "./page-render-resolver.mjs";
import { auditSavedPagePrompt, capturePromptAuditInput, preparePromptWriteAudit } from "./prompt-write-audit.mjs";

export const DELETED_STORY_PAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const storyLockOwnerTokenPattern = /^[a-f0-9]{32}$/;
export const STORY_LOCK_MALFORMED_GRACE_MS = 5_000;

export class FactError extends Error {
  constructor(code, details = []) {
    super(code);
    this.name = "FactError";
    this.code = code;
    this.status = code === "story_edit_target_busy" || code.endsWith("_conflict") ? 409 : 422;
    this.details = Array.isArray(details) ? details : [details];
  }
}

function fail(code, details) {
  throw new FactError(code, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function factLocksRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), "Saved", "state", "fact-locks");
}

function deletedPagesRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), "Saved", "state", "deleted-pages");
}

async function assertRealPathWithin(root, target, label) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isWithin(realRoot, realTarget)) fail("unsafe_story_edit_path", [`${label} 的真实路径越界：${target}`]);
  return { realRoot, realTarget };
}

async function assertProjectTargetBoundary(projectRoot, projectDirectory, target) {
  const repositoryRoot = path.resolve(projectRoot);
  const pagesRoot = path.join(projectDirectory, "pages");
  await assertRealPathWithin(repositoryRoot, projectDirectory, "project directory");
  await assertRealPathWithin(projectDirectory, pagesRoot, "pages");
  await assertRealPathWithin(pagesRoot, target, "story page target");
}

async function assertProjectFactBoundary(projectRoot, projectDirectory, target, label) {
  const repositoryRoot = path.resolve(projectRoot);
  await assertRealPathWithin(repositoryRoot, projectDirectory, "project directory");
  const targetInfo = await lstat(target);
  if (targetInfo.isSymbolicLink()) fail("unsafe_story_edit_path", [`${label} 不能是链接：${target}`]);
  await assertRealPathWithin(projectDirectory, target, label);
}

async function assertNoReparsePoints(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail("unsafe_story_edit_path", [`目录包含链接或 junction：${target}`]);
    if (info.isDirectory()) await assertNoReparsePoints(target);
  }
}

async function removeSafeRuntimeDirectory(projectRoot, runtimeRoot, directory, label) {
  const root = path.resolve(runtimeRoot);
  const absolute = path.resolve(directory);
  if (!isWithin(root, absolute) || absolute === root) fail("unsafe_story_edit_path", [absolute]);
  const info = await lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_story_edit_path", [absolute]);
  await assertRealPathWithin(path.resolve(projectRoot), root, `${label} root`);
  await assertRealPathWithin(root, absolute, label);
  await assertNoReparsePoints(absolute);
  await rm(absolute, { recursive: true, force: true });
}

function projectRelativePath(...segments) {
  return segments.join("/");
}

function targetRelativePath(kind, pageId) {
  return pageRelativePath(pageId, kind === "narrative" ? "content" : kind);
}

function targetPath(projectDirectory, relativePath) {
  return path.join(projectDirectory, ...relativePath.split("/"));
}

async function readPlainJson(target, label) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error?.code === "ENOENT") fail("story_edit_file_missing", [`${label} 不存在：${target}`]);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("unsafe_story_edit_file", [`${label} 不是普通文件：${target}`]);
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) fail("invalid_story_edit_json", [`${label} 不是有效 JSON：${target}`]);
    throw error;
  }
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readPageMembership(projectDirectory, pageId) {
  const entry = await readPageEntry(projectDirectory, pageId);
  if (!entry) fail("story_page_not_found", [pageId]);
  return { ...entry, sha256: hashCanonicalJson(entry) };
}

async function readCharacterReferences(projectDirectory, references, { includePrompt, allowMissing = false }) {
  const index = await readPlainJson(path.join(projectDirectory, "characters", "index.json"), "characters/index.json");
  const knownCharacters = new Set(Array.isArray(index?.characters) ? index.characters : []);
  const result = [];
  for (const reference of references) {
    const characterId = reference?.character_id;
    if (!knownCharacters.has(characterId)) {
      if (!allowMissing) fail("invalid_story_edit_context", [`角色不存在：${characterId}`]);
      result.push({ character_id: characterId, variant_id: reference.variant_id, missing: "character" });
      continue;
    }
    const visualRelative = projectRelativePath("characters", `${characterId}.visual.json`);
    const visual = await readPlainJson(targetPath(projectDirectory, visualRelative), visualRelative);
    const visualVariant = (Array.isArray(visual?.variants) ? visual.variants : []).find((variant) => variant?.id === reference.variant_id) ?? null;
    if (!visualVariant) {
      if (!allowMissing) fail("invalid_story_edit_context", [`角色 ${characterId} 不存在 variant：${reference.variant_id}`]);
      result.push({ character_id: characterId, variant_id: reference.variant_id, missing: "variant" });
      continue;
    }
    const entry = { character_id: characterId, variant_id: reference.variant_id };
    if (includePrompt) {
      const promptRelative = projectRelativePath("characters", `${characterId}.prompt.json`);
      const prompt = await readPlainJson(targetPath(projectDirectory, promptRelative), promptRelative);
      const configuration = prompt?.variants?.[reference.variant_id];
      if (!isRecord(configuration)) {
        if (!allowMissing) fail("invalid_story_edit_context", [`角色 ${characterId} 缺少当前设定的完整 Prompt：${reference.variant_id}`]);
        result.push({ character_id: characterId, variant_id: reference.variant_id, missing: "prompt" });
        continue;
      }
      // 角色身份层与所选造型说明是该引用实际生效内容的一部分,必须进入上游指纹。
      entry.visual_sha256 = hashCanonicalJson({ variant: { id: visualVariant.id, name: visualVariant.name } });
      entry.prompt_sha256 = hashCanonicalJson({ identity: prompt?.identity ?? null, configuration });
    }
    result.push(entry);
  }
  result.sort((left, right) => `${left.character_id}\0${left.variant_id ?? ""}`.localeCompare(`${right.character_id}\0${right.variant_id ?? ""}`, "en"));
  return { references: structuredClone(references), sha256: hashCanonicalJson(result) };
}

async function readDialogueSpeakerIdentities(projectDirectory, speakerIds, { requireAll = false } = {}) {
  const index = await readPlainJson(path.join(projectDirectory, "characters", "index.json"), "characters/index.json");
  const knownCharacters = new Set(Array.isArray(index?.characters) ? index.characters : []);
  const ids = [...new Set(speakerIds)].sort((left, right) => left.localeCompare(right, "en"));
  const identities = ids.map((characterId) => ({ character_id: characterId, exists: knownCharacters.has(characterId) }));
  if (requireAll) {
    const missing = identities.filter((identity) => !identity.exists).map((identity) => identity.character_id);
    if (missing.length) fail("invalid_story_edit_document", missing.map((characterId) => `对白 speaker 不是项目角色：${characterId}`));
  }
  return { ids, sha256: hashCanonicalJson(identities) };
}

function assertDocument(errors) {
  if (errors.length) fail("invalid_story_edit_document", errors);
}

export async function readStoryFactDraft(projectRoot, projectId, pageId, kind) {
  if (!storyPageIdPattern.test(pageId ?? "")) fail("invalid_story_page_id", [String(pageId)]);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const relativeTarget = targetRelativePath(kind, pageId);
  const persistedTarget = targetPath(project.projectDirectory, relativeTarget);
  const targetInfo = await lstat(persistedTarget).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!targetInfo) fail("story_page_not_found", [pageId]);
  await assertProjectTargetBoundary(projectRoot, project.projectDirectory, persistedTarget);
  const persisted = await readPlainJson(persistedTarget, relativeTarget);
  if (kind === "narrative") assertDocument(validateStoryPageNarrativeDocument(persisted));
  else assertDocument(validateStoryPagePromptDocument(persisted));

  let upstream;
  if (kind === "narrative") {
    upstream = {
      membership: await readPageMembership(project.projectDirectory, pageId),
      characters: await readCharacterReferences(project.projectDirectory, persisted.characters, { includePrompt: false, allowMissing: true }),
      speakers: await readDialogueSpeakerIdentities(project.projectDirectory, storyNarrativeSpeakerIds(persisted)),
    };
  } else {
    upstream = await readStoryPromptUpstream(project.projectDirectory, pageId);
  }

  return { project, definition: {
    kind,
    targetRelative: relativeTarget,
    persisted,
    identity: { page_id: pageId },
    upstream,
  } };
}

async function readSceneReferenceIdentity(projectDirectory, pageId) {
  const prompt = await readPlainJson(targetPath(projectDirectory, targetRelativePath("prompt", pageId)), "page prompt");
  if (!prompt.scene_id) return hashCanonicalJson(null);
  const reference = { scene_id: prompt.scene_id, variant_id: prompt.scene_variant_id };
  const index = await optionalFact(projectDirectory, "scenes/index.json", { scenes: [] });
  if (!index.scenes.includes(prompt.scene_id)) return hashCanonicalJson({ ...reference, missing: "scene" });
  const [visual, scenePrompt] = await Promise.all([
    optionalFact(projectDirectory, `scenes/${prompt.scene_id}.visual.json`),
    optionalFact(projectDirectory, `scenes/${prompt.scene_id}.prompt.json`),
  ]);
  const variant = visual?.variants?.find(item => item.id === prompt.scene_variant_id);
  const configuration = scenePrompt?.variants?.[prompt.scene_variant_id];
  if (!variant || !configuration) return hashCanonicalJson({ ...reference, missing: "variant" });
  return hashCanonicalJson({ ...reference, visual: { id: variant.id, name: variant.name }, identity: scenePrompt.identity, configuration });
}

export async function readStoryPromptUpstream(projectDirectory, pageId) {
  const narrativeRelative = targetRelativePath("narrative", pageId);
  const narrative = await readPlainJson(targetPath(projectDirectory, narrativeRelative), narrativeRelative);
  assertDocument(validateStoryPageNarrativeDocument(narrative));
  return {
    narrative: { relative_path: narrativeRelative, sha256: hashCanonicalJson(narrative) },
    characters: await readCharacterReferences(projectDirectory, narrative.characters, { includePrompt: true, allowMissing: true }),
    scenes_sha256: await readSceneReferenceIdentity(projectDirectory, pageId),
  };
}

// text-sources 是可选文件；不存在时按空文档 {} 处理，baseline 即 hashCanonicalJson({})。
async function readOptionalTextSources(projectDirectory, pageId) {
  const relative = targetRelativePath("text-sources", pageId);
  const target = targetPath(projectDirectory, relative);
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return { exists: false, value: {} };
  const value = await readPlainJson(target, relative);
  assertDocument(validateStoryPageTextSourcesDocument(value));
  return { exists: true, value };
}

async function readTextSourcesUpstream(projectDirectory, pageId) {
  const narrativeRelative = targetRelativePath("narrative", pageId);
  const narrative = await readPlainJson(targetPath(projectDirectory, narrativeRelative), narrativeRelative);
  assertDocument(validateStoryPageNarrativeDocument(narrative));
  return { narrative: { relative_path: narrativeRelative, sha256: hashCanonicalJson(narrative) }, value: narrative };
}

export async function readTextSourcesDraft(projectRoot, projectId, pageId) {
  if (!storyPageIdPattern.test(pageId ?? "")) fail("invalid_story_page_id", [String(pageId)]);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const relativeTarget = targetRelativePath("text-sources", pageId);
  const { exists, value: persisted } = await readOptionalTextSources(project.projectDirectory, pageId);
  if (exists) await assertProjectTargetBoundary(projectRoot, project.projectDirectory, targetPath(project.projectDirectory, relativeTarget));
  const upstream = await readTextSourcesUpstream(project.projectDirectory, pageId);
  return { project, definition: {
    kind: "text-sources",
    targetRelative: relativeTarget,
    persisted,
    identity: { page_id: pageId },
    upstream: { narrative: upstream.narrative },
  } };
}

export async function commitTextSources(projectRoot, context, readDocument, kind, { beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), context.project_id);

  const relativeTarget = context.target.relative_path;
  const persistedTarget = targetPath(project.projectDirectory, relativeTarget);
  const baseline = await readOptionalTextSources(project.projectDirectory, context.page_id);
  if (baseline.exists) await assertProjectTargetBoundary(projectRoot, project.projectDirectory, persistedTarget);
  if (hashCanonicalJson(baseline.value) !== context.target.sha256) fail("story_edit_target_conflict", [relativeTarget]);
  const upstream = await readTextSourcesUpstream(project.projectDirectory, context.page_id);
  if (upstream.narrative.sha256 !== context.upstream.narrative.sha256) fail("story_edit_upstream_conflict", [relativeTarget]);
  const narrative = upstream.value;
  const edited = await readDocument();
  assertDocument(validateStoryPageTextSourcesDocument(edited));
  const dialogueModes = new Map(narrative.dialogue.map((dialogue) => [dialogue.id, dialogue.mode]));
  const referenceErrors = [];
  for (const dialogueId of Object.keys(edited)) {
    if (dialogueId === "$schema") continue;
    const mode = dialogueModes.get(dialogueId);
    if (mode === undefined) referenceErrors.push(`text-sources 指向不存在的对白：${dialogueId}`);
    else if (mode === "heart") referenceErrors.push(`爱心条目不记录原文参考：${dialogueId}`);
  }
  if (referenceErrors.length) fail("invalid_text_source_reference", referenceErrors);
  for (const [dialogueId, entry] of Object.entries(edited)) {
    if (dialogueId === "$schema") continue;
    await verifyWritingCorpusSentence(projectRoot, {
      sourceFile: entry.source_file,
      offset: entry.offset,
      sentence: entry.original_sentence,
      label: dialogueId,
    });
  }
  if (beforeCommit !== undefined) {
    if (typeof beforeCommit !== "function") fail("invalid_story_edit_option", ["beforeCommit 必须是函数"]);
    await beforeCommit();
  }
  await writeJsonAtomic(persistedTarget, edited);
  return { target_file: path.resolve(persistedTarget), value: edited };
}

function parsedStoryLockOwner(source) {
  try {
    const owner = JSON.parse(source);
    if (!Number.isInteger(owner?.pid) || owner.pid < 1
      || !storyLockOwnerTokenPattern.test(owner.token ?? "")
      || !Number.isFinite(Date.parse(owner.created_at))) return null;
    return owner;
  } catch {
    return null;
  }
}

async function readStoryLockSnapshot(lockPath) {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) return { info, source: null, owner: null };
    const source = await readFile(lockPath, "utf8");
    return { info, source, owner: parsedStoryLockOwner(source) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeMalformedStoryLock(lockPath, observed) {
  const current = await readStoryLockSnapshot(lockPath);
  if (!current || current.owner || current.source !== observed.source
    || current.info.size !== observed.info.size || current.info.mtimeMs !== observed.info.mtimeMs) return false;
  await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return true;
}

async function removeOwnedStoryLock(lockPath, ownerToken) {
  const current = await readStoryLockSnapshot(lockPath);
  if (!current || current.owner?.token !== ownerToken) return false;
  await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return true;
}

async function withStoryLock(projectRoot, projectId, lockName, detail, operation) {
  const lockBase = factLocksRoot(projectRoot);
  await mkdir(lockBase, { recursive: true });
  await assertRealPathWithin(path.resolve(projectRoot), lockBase, "fact locks root");
  const lockRoot = path.join(lockBase, projectId);
  await mkdir(lockRoot, { recursive: true });
  await assertRealPathWithin(lockBase, lockRoot, "story page lock directory");
  const lockPath = path.join(lockRoot, `${lockName}.lock`);
  const ownerToken = randomBytes(16).toString("hex");
  let handle;
  const deadline = Date.now() + 1000;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail("story_edit_target_busy", [detail]);
      await delay(Math.min(20 * 2 ** Math.min(attempt - 1, 4), remaining));
    }
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: ownerToken, created_at: new Date().toISOString() })}\n`);
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      const observed = await readStoryLockSnapshot(lockPath);
      if (!observed) continue;
      if (!observed.owner) {
        const ageMs = Date.now() - observed.info.mtimeMs;
        if (!Number.isFinite(ageMs) || ageMs < STORY_LOCK_MALFORMED_GRACE_MS) continue;
        await removeMalformedStoryLock(lockPath, observed);
        continue;
      }
      let active = true;
      try { process.kill(observed.owner.pid, 0); }
      catch (probeError) { active = probeError?.code !== "ESRCH"; }
      if (active) continue;
      await removeOwnedStoryLock(lockPath, observed.owner.token);
    }
  }
  if (!handle) fail("story_edit_target_busy", [detail]);
  await handle.close();
  try { return await operation(); }
  finally { await removeOwnedStoryLock(lockPath, ownerToken); }
}

function withPageLocks(projectRoot, projectId, pageIds, operation) {
  const ordered = [...new Set(pageIds)].sort((left, right) => left.localeCompare(right, "en"));
  const enter = (index) => {
    if (index === ordered.length) return operation();
    const pageId = ordered[index];
    const lockId = `page-${createHash("sha256").update(pageId).digest("hex")}`;
    return withStoryLock(projectRoot, projectId, lockId, pageId, () => enter(index + 1));
  };
  return enter(0);
}

// Identity/configuration writers and story-page writers share this lock. Any
// narrative entering or leaving a character reference takes the same lock.

async function assertTargetBaseline(projectDirectory, baselineContext) {
  let current;
  try { current = await readPlainJson(targetPath(projectDirectory, baselineContext.target.relative_path), baselineContext.target.relative_path); }
  catch (error) {
    if (error instanceof FactError) fail("story_edit_target_conflict", [baselineContext.target.relative_path]);
    throw error;
  }
  if (hashCanonicalJson(current) !== baselineContext.target.sha256) fail("story_edit_target_conflict", [baselineContext.target.relative_path]);
  return current;
}

async function assertNarrativeUpstream(projectDirectory, baselineContext) {
  try {
    const membership = await readPageMembership(projectDirectory, baselineContext.page_id);
    const characters = await readCharacterReferences(projectDirectory, baselineContext.upstream.characters.references, { includePrompt: false, allowMissing: true });
    const speakers = await readDialogueSpeakerIdentities(projectDirectory, baselineContext.upstream.speakers.ids);
    if (membership.sha256 !== baselineContext.upstream.membership.sha256
      || characters.sha256 !== baselineContext.upstream.characters.sha256
      || speakers.sha256 !== baselineContext.upstream.speakers.sha256) {
      fail("story_edit_upstream_conflict", [baselineContext.target.relative_path]);
    }
  } catch (error) {
    if (error instanceof FactError && error.code !== "story_edit_upstream_conflict") fail("story_edit_upstream_conflict", [baselineContext.target.relative_path]);
    throw error;
  }
}

async function assertPromptUpstream(projectDirectory, baselineContext) {
  try {
    const narrative = await readPlainJson(targetPath(projectDirectory, baselineContext.upstream.narrative.relative_path), baselineContext.upstream.narrative.relative_path);
    const characters = await readCharacterReferences(projectDirectory, baselineContext.upstream.characters.references, { includePrompt: true, allowMissing: true });
    if (hashCanonicalJson(narrative) !== baselineContext.upstream.narrative.sha256 || characters.sha256 !== baselineContext.upstream.characters.sha256 || (baselineContext.upstream.scenes_sha256 && await readSceneReferenceIdentity(projectDirectory, baselineContext.page_id) !== baselineContext.upstream.scenes_sha256)) {
      fail("story_edit_upstream_conflict", [baselineContext.target.relative_path]);
    }
    return narrative;
  } catch (error) {
    if (error instanceof FactError && error.code !== "story_edit_upstream_conflict") fail("story_edit_upstream_conflict", [baselineContext.target.relative_path]);
    throw error;
  }
}

function createDialogueId(occupiedIds) {
  const occupied = new Set(occupiedIds);
  for (;;) {
    const id = `dialogue-${randomBytes(6).toString("hex")}`;
    if (!occupied.has(id)) return id;
  }
}

export function createPromptFragmentId(occupiedIds) {
  const occupied = new Set(occupiedIds);
  for (;;) {
    const id = `token-${randomBytes(6).toString("hex")}`;
    if (!occupied.has(id)) return id;
  }
}

export async function commitStoryFact(projectRoot, context, readDocument, kind, { beforeCommit, confirmationSha256 } = {}) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), context.project_id);
  const auditPrepared = kind === "prompt" ? await preparePromptWriteAudit(projectRoot) : null;
  let auditCaptured;
  const persistedTarget = targetPath(project.projectDirectory, context.target.relative_path);
  try {
    await assertProjectTargetBoundary(projectRoot, project.projectDirectory, persistedTarget);
  } catch (error) {
    if (error?.code === "ENOENT") fail("story_edit_target_conflict", [context.target.relative_path]);
    throw error;
  }
  const baseline = await assertTargetBaseline(project.projectDirectory, context);
  const currentNarrative = kind === "narrative"
    ? null
    : await assertPromptUpstream(project.projectDirectory, context);
  if (kind === "narrative") await assertNarrativeUpstream(project.projectDirectory, context);
  const edited = await readDocument();
  let persisted;
  if (kind === "narrative") {
    try {
      persisted = prepareStoryPageNarrativeForPersistence(edited, { baselineNarrative: baseline, createDialogueId });
      if (persisted.page_kind !== baseline.page_kind) fail('page_kind_immutable');
    } catch (error) {
      if (error instanceof TypeError) fail("invalid_story_edit_document", [error.message]);
      throw error;
    }
    assertDocument(validateStoryPageNarrativeDocument(persisted));
    await assertPageLetteringAnchors(project.projectDirectory, context.page_id, baseline, persisted);
  } else {
    try {
      persisted = preparePromptForPersistence(edited, {
        baselinePrompt: baseline,
        createFragmentId: createPromptFragmentId,
      });
    } catch (error) {
      if (error instanceof TypeError) fail("invalid_story_edit_document", [error.message]);
      throw error;
    }
    assertDocument(validateStoryPagePromptDocument(persisted));
    const switchPlan = await applySceneSwitch(project.projectDirectory, baseline, persisted, currentNarrative.characters);
    requireImpactConfirmation(switchPlan, confirmationSha256, persisted);
    const inheritanceErrors = checkPageInheritance(persisted, await readInheritanceSources(project.projectDirectory, currentNarrative.characters, persisted.scene_id, persisted.scene_variant_id, { allowMissing: true }));
    if (inheritanceErrors.length) fail('invalid_story_edit_document', inheritanceErrors);
  }
  if (beforeCommit !== undefined) {
    if (typeof beforeCommit !== "function") fail("invalid_story_edit_option", ["beforeCommit 必须是函数"]);
    await beforeCommit();
  }
  const downstreamDiagnostics = kind === "narrative"
    ? await narrativeDownstreamDiagnostics(project.projectDirectory, context.page_id, persisted) : [];
  const switchPlan = kind === 'narrative' ? await planCharacterSwitch(project.projectDirectory, context.page_id, baseline, persisted) : { impacts: [], writes: [] };
  requireImpactConfirmation(switchPlan, confirmationSha256, kind === "narrative" ? edited : persisted);
  await commitFactChanges(project.projectDirectory, [...switchPlan.writes, { relative: context.target.relative_path, before: baseline, after: persisted }]);
  if (kind === "prompt" && auditPrepared.value) {
    auditCaptured = await capturePromptAuditInput(() => capturePagePromptSnapshot(project.projectDirectory, context.page_id, createStoryPageKey(context.page_id)));
  }

  const result = { target_file: path.resolve(persistedTarget), value: persisted, downstream_diagnostics: downstreamDiagnostics, ...(switchPlan.writes[0] ? { inherited_prompt: switchPlan.writes[0].after } : {}) };
  if (kind === "prompt") result.audit = await auditSavedPagePrompt(projectRoot, project.projectDirectory, auditPrepared, auditCaptured);
  if (kind === "narrative") result.warnings = storyContentWarnings(result.value);
  return result;
}

async function assertPageLetteringAnchors(projectDirectory, pageId, baseline, persisted) {
  const removed = new Set(baseline.dialogue.map((dialogue) => dialogue.id));
  for (const dialogue of persisted.dialogue) removed.delete(dialogue.id);
  if (!removed.size) return;
  const letteringRelative = projectRelativePath("lettering", "dialogue-layouts.json");
  let lettering;
  try {
    lettering = await readPlainJson(targetPath(projectDirectory, letteringRelative), letteringRelative);
  } catch (error) {
    if (error instanceof FactError && error.code === "story_edit_file_missing") return;
    throw error;
  }
  const referenced = new Set((Array.isArray(lettering?.pages) ? lettering.pages : [])
    .filter((page) => page?.page === pageId)
    .flatMap((page) => Array.isArray(page?.items) ? page.items : [])
    .map((item) => item?.dialogue_id));
  const blocked = [...removed].filter((id) => referenced.has(id)).sort((left, right) => left.localeCompare(right, "en"));
  if (blocked.length) fail("page_lettering_anchor_conflict", [`这些条目被排版引用，请先调整排版：${blocked.join("、")}`]);
}

export async function narrativeDownstreamDiagnostics(projectDirectory, pageId, narrative) {
  try {
    const prompt = await readPlainJson(path.join(projectDirectory, "pages", `${pageId}.prompt.json`), "page prompt");
    const layouts = await readPlainJson(path.join(projectDirectory, "lettering", "dialogue-layouts.json"), "lettering")
      .catch(error => error?.code === "ENOENT" || error instanceof FactError && error.code === "story_edit_file_missing" ? { pages: [] } : Promise.reject(error));
    const textSources = await readPlainJson(path.join(projectDirectory, "pages", `${pageId}.text-sources.json`), "page text-sources")
      .catch(error => error instanceof FactError && error.code === "story_edit_file_missing" ? {} : Promise.reject(error));
    const characters = new Set(narrative.characters.map(reference => reference.character_id));
    const dialogueIds = new Set(narrative.dialogue.map(dialogue => dialogue.id));
    const dialogueModes = new Map(narrative.dialogue.map(dialogue => [dialogue.id, dialogue.mode]));
    return [
      ...promptCharacterIds(prompt).filter(id => !characters.has(id)).map(id => ({ code: "dangling_prompt_character", page_id: pageId, character_id: id })),
      ...(layouts.pages.find(page => page.page === pageId)?.items ?? []).filter(item => !dialogueIds.has(item.dialogue_id))
        .map(item => ({ code: "dangling_lettering_dialogue", page_id: pageId, dialogue_id: item.dialogue_id })),
      ...Object.keys(isRecord(textSources) ? textSources : {}).filter(id => id !== "$schema").flatMap(id => {
        if (!dialogueIds.has(id)) return [{ code: "dangling_text_source", page_id: pageId, dialogue_id: id }];
        if (dialogueModes.get(id) === "heart") return [{ code: "heart_text_source", page_id: pageId, dialogue_id: id }];
        return [];
      }),
    ];
  } catch (error) {
    return [{ code: "downstream_diagnostics_unavailable", page_id: pageId, message: error.message }];
  }
}

function outlineSequenceIds(outline) {
  return (Array.isArray(outline?.chapters) ? outline.chapters : [])
    .flatMap((chapter) => Array.isArray(chapter?.sequences) ? chapter.sequences : [])
    .map((sequence) => sequence.id)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function outlineSequenceIdentity(outline) {
  return hashCanonicalJson(outlineSequenceIds(outline));
}

function pageIdsFromIndex(pagesIndex) {
  return Object.values(isRecord(pagesIndex?.by_sequence) ? pagesIndex.by_sequence : {}).flat();
}

async function readValidatedOutline(projectDirectory) {
  const target = path.join(projectDirectory, "story", "outline.json");
  const value = await readPlainJson(target, "story/outline.json");
  assertDocument(validateStoryOutlineDocument(value));
  return value;
}

async function readValidatedPagesIndex(projectDirectory) {
  const value = await readStoryPagesIndex(projectDirectory);
  assertDocument(validateStoryPagesIndexDocument(value));
  return value;
}

async function listStoryPageFiles(projectRoot, projectDirectory) {
  const pagesDirectory = path.join(projectDirectory, "pages");
  await assertProjectFactBoundary(projectRoot, projectDirectory, pagesDirectory, "pages");
  const indexed = new Set(pageIdsFromIndex(await readStoryPagesIndex(projectDirectory)));
  const narrativePageIds = [];
  const promptPageIds = [];
  for (const entry of await readdir(pagesDirectory, { withFileTypes: true })) {
    const match = /^(page-(?:\d{3}|[a-f0-9]{12}))\.(content|prompt)\.json$/.exec(entry.name);
    if (!match || !indexed.has(match[1])) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) fail("unsafe_story_edit_file", [`pages/${entry.name} 不是普通文件`]);
    if (match[2] === "content") narrativePageIds.push(match[1]);
    else promptPageIds.push(match[1]);
  }
  narrativePageIds.sort((left, right) => left.localeCompare(right, "en"));
  promptPageIds.sort((left, right) => left.localeCompare(right, "en"));
  return { narrativePageIds, promptPageIds };
}

async function storyPageDiagnostics(projectRoot, projectDirectory, outline, pagesIndex) {
  const files = await listStoryPageFiles(projectRoot, projectDirectory);
  return {
    ...files,
    diagnostics: diagnoseStoryPageFiles({ outline, pagesIndex, ...files }),
  };
}

function failForDiagnostics(diagnostics) {
  if (diagnostics.length) fail("invalid_story_pages_index", diagnostics.map((item) => JSON.stringify(item)));
}

export async function readStoryStructureDraft(projectRoot, projectId, targetId, kind) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const outline = await readValidatedOutline(project.projectDirectory);
  const targetRelative = kind === "outline" ? "story/outline.json" : "pages/index.json";
  const persistedTarget = targetPath(project.projectDirectory, targetRelative);
  await assertProjectFactBoundary(projectRoot, project.projectDirectory, persistedTarget, targetRelative);
  const persisted = kind === "outline" ? outline : await readValidatedPagesIndex(project.projectDirectory);
  return { project, definition: {
    kind,
    targetRelative,
    persisted,
    upstream: kind === "outline" ? {} : {
      outline: {
        relative_path: "story/outline.json",
        sequence_identity_sha256: outlineSequenceIdentity(outline),
      },
    },
  } };
}

export async function commitStoryStructure(projectRoot, context, readDocument, kind, { beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), context.project_id);
  const baseline = kind === "outline"
    ? await assertTargetBaseline(project.projectDirectory, context)
    : await readValidatedPagesIndex(project.projectDirectory);
  if (kind === "index" && hashCanonicalJson(baseline) !== context.target.sha256) fail("story_edit_target_conflict", [context.target.relative_path]);
  const edited = await readDocument();
  if (kind === "outline") assertDocument(validateStoryOutlineDocument(edited));
  else assertDocument(validateStoryPagesIndexDocument(edited));
  const index = kind === "outline" ? await readValidatedPagesIndex(project.projectDirectory) : baseline;
  const persistedTarget = targetPath(project.projectDirectory, context.target.relative_path);
  await assertProjectFactBoundary(projectRoot, project.projectDirectory, persistedTarget, context.target.relative_path);
  let downstreamDiagnostics = [];
  if (kind === "index") {
    const outline = await readValidatedOutline(project.projectDirectory);
    if (outlineSequenceIdentity(outline) !== context.upstream.outline.sequence_identity_sha256) fail("story_edit_upstream_conflict", [context.target.relative_path]);
    const state = await storyPageDiagnostics(projectRoot, project.projectDirectory, outline, edited);
    failForDiagnostics(state.diagnostics);
  } else {
    downstreamDiagnostics = (await storyPageDiagnostics(projectRoot, project.projectDirectory, edited, index)).diagnostics;
  }
  if (beforeCommit !== undefined) {
    if (typeof beforeCommit !== "function") fail("invalid_story_edit_option", ["beforeCommit 必须是函数"]);
    await beforeCommit();
  }
  if (kind === "index") await writeStoryPagesIndex(project.projectDirectory, edited);
  else await writeJsonAtomic(persistedTarget, edited);
  return { target_file: path.resolve(persistedTarget), value: edited, downstream_diagnostics: downstreamDiagnostics };
}

function outlineTarget(outline, kind, id) {
  if (kind === "synopsis") return { document: { synopsis: outline.synopsis }, upstream: {}, node: outline };
  const chapter = kind === "chapter" ? outline.chapters.find(item => item.id === id)
    : outline.chapters.find(item => item.sequences.some(sequence => sequence.id === id));
  const node = kind === "chapter" ? chapter : chapter?.sequences.find(item => item.id === id);
  if (!node) fail("story_outline_target_not_found", [kind, id]);
  return { document: { title: node.title, summary: node.summary },
    upstream: kind === "sequence" ? { chapter_id: chapter.id } : {}, node };
}

export async function readStoryOutlineTargetDraft(projectRoot, projectId, targetId, kind) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const outline = await readValidatedOutline(project.projectDirectory);
  const { document, upstream } = outlineTarget(outline, kind, targetId);
  return { project, definition: { targetRelative: "story/outline.json", persisted: document,
    identity: { target_id: targetId }, upstream } };
}

export async function commitStoryOutlineTarget(projectRoot, context, readDocument, kind, { beforeCommit } = {}) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), context.project_id);

  const outline = await readValidatedOutline(project.projectDirectory);
  const current = outlineTarget(outline, kind, context.target_id);
  if (hashCanonicalJson(current.document) !== context.target.sha256) fail("fact_target_conflict");
  if (hashCanonicalJson(current.upstream) !== hashCanonicalJson(context.upstream)) fail("fact_upstream_conflict");
  const document = await readDocument();
  const fields = kind === "synopsis" ? ["synopsis"] : ["title", "summary"];
  if (!isRecord(document) || Object.keys(document).length !== fields.length || fields.some(field => typeof document[field] !== "string")) {
    fail("invalid_story_outline_target", fields);
  }
  Object.assign(current.node, document);
  assertDocument(validateStoryOutlineDocument(outline));
  const target = targetPath(project.projectDirectory, "story/outline.json");
  await assertProjectFactBoundary(projectRoot, project.projectDirectory, target, "story/outline.json");
  if (beforeCommit) await beforeCommit();
  await writeJsonAtomic(target, outline);
  return { target_file: target, value: document };
}

export async function readStoryContext(projectRoot, projectId, sequenceId) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const outline = await readValidatedOutline(project.projectDirectory);
  const chapter = outline.chapters.find(item => item.sequences.some(sequence => sequence.id === sequenceId));
  if (!chapter) fail("story_outline_target_not_found", ["sequence", sequenceId]);
  return { synopsis: outline.synopsis, chapter: { id: chapter.id, title: chapter.title, summary: chapter.summary,
    sequences: chapter.sequences.map(({ id, title, summary }) => ({ id, title, summary })) }, current_sequence_id: sequenceId };
}

export async function createStoryPage(projectRoot, projectId, sequenceId, options = {}) {
  const { createPage } = await import("./page-facts.mjs");
  return createPage(projectRoot, projectId, { owner_kind: "story", sequence_id: sequenceId }, options);
}

export async function duplicateStoryPage(projectRoot, projectId, pageId) {
  const { duplicatePage } = await import("./page-facts.mjs");
  return duplicatePage(projectRoot, projectId, pageId);
}

export async function deleteStoryPage(projectRoot, projectId, pageId, options = {}) {
  const { deletePage } = await import("./page-facts.mjs");
  return deletePage(projectRoot, projectId, pageId, options);
}

export async function cleanupDeletedStoryPages(
  projectRoot,
  { now = Date.now(), maxAgeMs = DELETED_STORY_PAGE_RETENTION_MS } = {},
) {
  const root = deletedPagesRoot(projectRoot);
  const removed = [];
  const projects = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  if (projects.length) await assertRealPathWithin(path.resolve(projectRoot), root, "deleted-pages root");
  for (const projectEntry of projects) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
    const projectDirectory = path.join(root, projectEntry.name);
    for (const entry of await readdir(projectDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^deleted-[a-f0-9]{12}$/.test(entry.name)) continue;
      const archiveDirectory = path.join(projectDirectory, entry.name);
      let deletedAt = null;
      try {
        const manifest = await readPlainJson(path.join(archiveDirectory, "deletion.json"), "deleted page manifest");
        deletedAt = Date.parse(manifest.deleted_at);
      } catch (error) {
        if (!(error instanceof FactError)) throw error;
      }
      if (!Number.isFinite(deletedAt)) deletedAt = (await stat(archiveDirectory)).mtimeMs;
      if (now - deletedAt < maxAgeMs) continue;
      await removeSafeRuntimeDirectory(projectRoot, root, archiveDirectory, "deleted page archive");
      removed.push(path.resolve(archiveDirectory));
    }
  }
  return removed;
}

async function rollbackCreatedFactFiles(targets, originalError, failureCode) {
  const rollbackFailures = [];
  for (const target of targets) {
    try { await unlink(target); }
    catch (error) { if (error?.code !== "ENOENT") rollbackFailures.push({ target, error }); }
  }
  if (!rollbackFailures.length) return;
  const failure = new FactError(failureCode, [
    `原始错误：${originalError?.code ?? originalError?.message ?? String(originalError)}`,
    ...rollbackFailures.map(item => `未清理 ${item.target}：${item.error?.code ?? item.error?.message ?? String(item.error)}`),
  ]);
  failure.cause = originalError;
  throw failure;
}

// 事实领域共用原子写入、路径检查和归档清理；资源与页面锁只供候选媒体执行器使用。
export const factStorage = Object.freeze({
  assertNoReparsePoints,
  assertProjectFactBoundary,
  assertRealPathWithin,
  assertTargetBaseline,
  factLocksRoot,
  isWithin,
  projectRelativePath,
  readJson: readPlainJson,
  removeSafeRuntimeDirectory,
  rollbackCreatedFactFiles,
  targetPath,
  withPageLocks,
  withResourceLock: withStoryLock,
  writeJsonAtomic,
});
