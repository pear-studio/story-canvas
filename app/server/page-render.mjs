import { assertDepthDependencies } from "./two-step-runtime.mjs";
import { randomInt } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { candidateFilePath, createCandidateStorageIdentity } from "./candidate-storage.mjs";
import { encodePageKey } from "./page-key.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { generationReference } from "./generation-queue.mjs";
import { submitGenerationTask } from "./generation-lifecycle.mjs";
import { createRenderTaskId } from "./render-task-id.mjs";
import { candidateSeedSequence } from "./render-task-helpers.mjs";
import { freezeRenderRoutes } from "./render-plan-route.mjs";
import { runPersistedRenderTask } from "./render-project-runtime.mjs";
import { loadPromptDictionaryForRender } from "./prompt-dictionary-loader.mjs";
import { compileFrozenExecutionUnits, createTaskSnapshot, validateFrozenRenderTask } from "./render-task-contract.mjs";
import { createRenderTask, readRenderTask } from "./render-task-storage.mjs";
import { compilePageRenderTarget, PageRenderError, resolveExactPageIdentity, resolvePageIdentity } from "./page-render-resolver.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";

function fail(code, details = [], status = 422) {
  throw new PageRenderError(code, details, status);
}

function normalizeCount(value) {
  const count = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 3) {
    fail("candidate_count_out_of_range", ["count 必须是 1 到 3"], 400);
  }
  return count;
}

function normalizeSeed(value, count) {
  if (value === undefined || value === null) return null;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed + count - 1 > 2 ** 31 - 1) {
    fail("candidate_seed_out_of_range", ["seed 必须让全部候选落在 0 到 2147483647"], 400);
  }
  return seed;
}

async function taskDisplay(resolved, projectDirectory) {
  const optionalDocument = async relative => {
    const source = resolved.sources.find(source => source.relative_path === relative);
    if (source) return source.value;
    try { return JSON.parse(await readFile(path.join(projectDirectory, relative), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const index = await optionalDocument("pages/index.json");
  const membership = index.pages.find(page => page.page_id === resolved.page_id);
  let order = null, ownerLabel = null;
  if (membership.owner_kind === "story") {
    const outline = await optionalDocument("story/outline.json");
    let cursor = 0;
    for (const chapter of outline?.chapters ?? []) for (const sequence of chapter.sequences ?? []) {
      for (const page of index.pages.filter(page => page.owner_kind === "story" && page.sequence_id === sequence.id)) {
        cursor += 1;
        if (page.page_id === resolved.page_id) order = cursor;
      }
      if (sequence.id === membership.sequence_id) ownerLabel = sequence.title;
    }
  } else {
    const kind = membership.owner_kind;
    const ownerId = membership[`${kind}_id`];
    const pages = index.pages.filter(page => page.owner_kind === kind && page[`${kind}_id`] === ownerId);
    order = pages.findIndex(page => page.page_id === resolved.page_id) + 1;
    const profile = await optionalDocument(`${kind === "character" ? "characters" : "scenes"}/${ownerId}.profile.json`);
    ownerLabel = profile?.name ?? null;
  }
  return {
    project_title: String(resolved.project.title ?? resolved.project.id ?? "未命名项目"),
    pages: [{ page_key: structuredClone(resolved.page_key), page_id: resolved.page_id,
      owner_kind: membership.owner_kind, order, title: resolved.title, owner_label: ownerLabel }],
  };
}

function compileTask({ resolved, projectDirectory, projectId, taskId, count, seed, promptDictionary }) {
  const compiled = resolved.compiled_page;
  const pageLoras = resolved.page_loras;
  const seeds = candidateSeedSequence(count, seed);
  const itemPrefix = `${encodePageKey(resolved.page_key).replaceAll("/", ".")}`;
  const items = Array.from({ length: count }, (_, index) => {
    const storageIdentity = createCandidateStorageIdentity(resolved.page_key);
    return {
      id: `${itemPrefix}.candidate-${String(index + 1).padStart(3, "0")}`,
      ...storageIdentity,
      absolute_file: path.resolve(candidateFilePath(projectDirectory, resolved.page_key, storageIdentity.candidate_id)),
      task: taskId,
      page_key: structuredClone(resolved.page_key),
      seed: seeds[index],
      ...(resolved.reference_image ? { reference_image: structuredClone(resolved.reference_image) } : {}),
      ...(compiled.two_step ? { two_step: { ...structuredClone(compiled.two_step), seed: randomInt(2147483647) } } : {}),
      positive_prompt: compiled.positive_prompt,
      negative_prompt: compiled.negative_prompt,
      prompt_parts: structuredClone(compiled.prompt_parts),
      loras: structuredClone(pageLoras),
      status: "queued",
    };
  });
  const profileBundle = resolved.compiled_profile;
  const profile = profileBundle.effective_profile;
  const routedItems = freezeRenderRoutes(items, { purpose: "candidate", resolvedProfile: profile });
  const pageKey = encodePageKey(resolved.page_key);
  const snapshot = createTaskSnapshot({
    purpose: "candidate",
    canvas: resolved.project.canvas,
    profile,
    effectiveProfileSha256: profileBundle.effective_profile_sha256,
    sourceIdentity: profileBundle.source_identity,
    workflowDefinitions: profileBundle.workflow_definitions,
    items: routedItems,
    promptAudit: { valid: compiled.audit.valid, pages: { [pageKey]: structuredClone(compiled.audit) } },
    promptDictionary: promptDictionary.identity,
    execution: { candidate_batch: false, queue_all: false },
    promptRevalidation: {
      version: 1,
      pages: {
        [pageKey]: {
          records: structuredClone(compiled.audit_records),
          positive_prompt: compiled.positive_prompt,
          negative_prompt: compiled.negative_prompt,
          prompt_parts: structuredClone(compiled.prompt_parts),
          lora_trigger_parts: structuredClone(compiled.prompt_parts.positive.filter((part) => part.origin === "lora_trigger")),
        },
      },
    },
  });
  snapshot.execution_units = compileFrozenExecutionUnits({
    items: routedItems,
    purpose: "candidate",
    snapshot,
    profile,
    canvas: resolved.project.canvas,
    candidateBatch: false,
    taskId,
  });
  snapshot.execution_units_sha256 = hashCanonicalJson(snapshot.execution_units);
  const task = {
    version: 2,
    id: taskId,
    render_profile: profile.id,
    purpose: "candidate",
    status: "queued",
    created_at: new Date().toISOString(),
    snapshot,
    items: routedItems,
    project: projectId,
  };
  validateFrozenRenderTask(task, {
    dictionaryEntries: promptDictionary.entries,
    dictionaryIdentity: promptDictionary.identity,
  });
  return task;
}

async function compileAndPersistExactPageRenderTask(
  projectRoot, projectId, pageKey,
  { count: requestedCount = 1, seed: requestedSeed = null, taskId = createRenderTaskId(), localConfig = {}, repositoryRoot = path.resolve(projectRoot) } = {},
) {
  const count = normalizeCount(requestedCount);
  const seed = normalizeSeed(requestedSeed, count);
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const promptDictionary = await loadPromptDictionaryForRender(localConfig, repositoryRoot);
  const identity = await resolveExactPageIdentity(project.projectDirectory, pageKey);
  const resolved = await compilePageRenderTarget({
    repositoryRoot,
    projectDirectory: project.projectDirectory,
    pageKey: identity.page_key,
    dictionaryEntries: promptDictionary.entries,
  });
  if (resolved.compiled_page.two_step) await assertDepthDependencies(resolved.compiled_page.two_step, repositoryRoot, localConfig);

  const task = compileTask({
    resolved,
    projectDirectory: project.projectDirectory,
    projectId,
    taskId,
    count,
    seed,
    promptDictionary,
  });
  let persisted;
  try { persisted = await createRenderTask(project.projectDirectory, task, await taskDisplay(resolved, project.projectDirectory), { referenceImage: resolved.reference_image_bytes }); }
  catch (error) {
    if (error?.code === "render_task_exists") fail("render_task_exists", [taskId], 409);
    throw error;
  }
  return {
    task,
    task_directory: persisted.task_directory,
    project_directory: project.projectDirectory,
    candidate_paths: task.items.map((item) => item.absolute_file),
    page_key: structuredClone(resolved.page_key),
  };
}

export async function compileAndPersistPageRenderTask(
  projectRoot,
  projectId,
  pageId,
  options = {},
) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const identity = await resolvePageIdentity(project.projectDirectory, pageId);
  return compileAndPersistExactPageRenderTask(projectRoot, projectId, identity.page_key, options);
}

export async function compileAndPersistWorkbenchRenderTask(
  projectRoot,
  projectId,
  value,
  options = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_workbench_render_request", [], 400);
  const allowed = new Set(["page_key", "operation", "count", "seed"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !value.page_key) fail("invalid_workbench_render_request", [], 400);
  const operation = value.operation ?? "candidates";
  if (operation !== "candidates") fail("invalid_workbench_render_request", [], 400);
  return compileAndPersistExactPageRenderTask(projectRoot, projectId, value.page_key, {
    ...options,
    count: value.count ?? 1,
    seed: value.seed ?? null,
  });
}

export async function runCompiledPageRenderTask(compiled, options = {}, { runTask = runPersistedRenderTask } = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? path.dirname(path.dirname(compiled.project_directory)));
  await submitGenerationTask(repositoryRoot, generationReference(
    compiled.task.project,
    compiled.task.id,
    "candidate",
    compiled.task.created_at,
  ));
  const projectDirectory = compiled.project_directory;
  await runTask({
    projectRoot: projectDirectory,
    repositoryRoot,
    taskId: compiled.task.id,
    apiUrl: options.apiUrl ?? null,
    generationQueue: {
      repositoryRoot,
      reference: generationReference(compiled.task.project, compiled.task.id, "candidate", compiled.task.created_at),
    },
  });
  const persisted = await readRenderTask(compiled.project_directory, compiled.task.id);
  if (!persisted) throw new Error(`渲染任务在执行后消失：${compiled.task.id}`);
  return persisted;
}

export async function renderPage(
  projectRoot,
  projectId,
  pageId,
  options = {},
  { runTask = runPersistedRenderTask } = {},
) {
  const compiled = await compileAndPersistPageRenderTask(projectRoot, projectId, pageId, options);
  const completed = await runCompiledPageRenderTask(compiled, { ...options, repositoryRoot: projectRoot }, { runTask });
  const completedTask = completed.task;
  return {
    task_id: completedTask.id,
    task_directory: completed.task_directory,
    status: completedTask.status,
    page_key: compiled.page_key,
    candidate_paths: completedTask.items
      .filter((item) => item.status !== "discarded")
      .map((item) => item.absolute_file),
  };
}
