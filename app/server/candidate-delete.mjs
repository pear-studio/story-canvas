import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { candidateFilePath, readGenerationCandidateRecords } from "./candidate-storage.mjs";
import { withCandidateMutationLock } from "./candidate-mutation-lock.mjs";
import { encodePageKey } from "./page-key.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { PageRenderError, compilePageRenderInspectionContext, resolveExactPageIdentity, resolvePageIdentity } from "./page-render-resolver.mjs";
import { listActiveProjectTaskIds, promptSignature, updateRenderTask } from "./render-task-storage.mjs";
import { factStorage as storage } from "./story-facts.mjs";

function fail(code, details = [], status = 422) {
  throw new PageRenderError(code, details, status);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertCandidateFile(projectDirectory, target) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error?.code === "ENOENT") fail("candidate_not_found", [target], 404);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("candidate_path_invalid", [target]);
  const [projectReal, targetReal] = await Promise.all([realpath(projectDirectory), realpath(target)]);
  if (!isWithin(projectReal, targetReal)) fail("candidate_path_invalid", [target]);
}

export async function deletePageCandidate(projectRoot, projectId, pageId, absoluteCandidatePath, { exactPageKey = null } = {}) {
  if (typeof absoluteCandidatePath !== "string" || !path.isAbsolute(absoluteCandidatePath)) {
    fail("candidate_path_must_be_absolute", [String(absoluteCandidatePath)], 400);
  }
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  return withCandidateMutationLock(projectRoot, projectId, async () => {
    const readIdentity = () => exactPageKey
      ? resolveExactPageIdentity(project.projectDirectory, exactPageKey)
      : resolvePageIdentity(project.projectDirectory, pageId);
    const initialIdentity = await readIdentity();
    return storage.withPageLocks(projectRoot, projectId, [pageId], async () => {
      const identity = await readIdentity();
      if (encodePageKey(identity.page_key) !== encodePageKey(initialIdentity.page_key)) {
        fail("candidate_page_identity_conflict", [pageId], 409);
      }
      const requested = path.resolve(absoluteCandidatePath);
      const records = await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
      const canonical = encodePageKey(identity.page_key);
      const matches = records.filter((record) => encodePageKey(record.page_key) === canonical
        && path.resolve(candidateFilePath(project.projectDirectory, record.page_key, record.candidate_id)) === requested);
      if (matches.length !== 1) fail(matches.length ? "candidate_record_ambiguous" : "candidate_not_found", [requested], matches.length ? 409 : 404);
      const record = matches[0];
      if (record.status !== "available") fail("candidate_not_available", [record.candidate_id], 409);
      if ((await listActiveProjectTaskIds(project.projectDirectory)).includes(record.task_id)) fail("candidate_task_active", [record.task_id], 409);
      const mediaLock = `candidate-media-${createHash("sha256").update(requested).digest("hex")}`;
      return storage.withResourceLock(projectRoot, projectId, mediaLock, record.candidate_id, async () => {
        await assertCandidateFile(project.projectDirectory, requested);
        const currentRecords = await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
        const current = currentRecords.find((candidate) => candidate.task_id === record.task_id
          && candidate.candidate_id === record.candidate_id && encodePageKey(candidate.page_key) === canonical);
        if (!current || current.status !== "available") fail("candidate_delete_conflict", [record.candidate_id], 409);
        if ((await listActiveProjectTaskIds(project.projectDirectory)).includes(record.task_id)) fail("candidate_task_active", [record.task_id], 409);
        const staged = path.join(project.projectDirectory, "Saved", "staging", "deleted-" + randomUUID());
        await mkdir(path.dirname(staged), { recursive: true });
        await rename(path.dirname(requested), staged);
        // 成果删除已经生效；历史标记失败不能复活它。
        await updateRenderTask(project.projectDirectory, current.task_id, (task) => {
          const item = task.items.find(entry => entry.candidate_id === current.candidate_id);
          if (item) { item.status = "discarded"; item.discarded_at = new Date().toISOString(); }
        }).catch(() => undefined);
        await rm(staged, { recursive: true, force: true });
        return {
          deleted_candidate_id: current.candidate_id,
          deleted_path: requested,
          task_id: current.task_id,
          page_key: structuredClone(identity.page_key),
        };
      });
    });
  });
}

export async function deletePageCandidateById(projectRoot, projectId, pageKey, candidateId) {
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const identity = await resolveExactPageIdentity(project.projectDirectory, pageKey);
  const canonical = encodePageKey(identity.page_key);
  const records = await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
  const matches = records.filter((record) => record.candidate_id === candidateId && encodePageKey(record.page_key) === canonical);
  if (matches.length !== 1) fail(matches.length ? "candidate_record_ambiguous" : "candidate_not_found", [String(candidateId)], matches.length ? 409 : 404);
  const absoluteCandidatePath = path.resolve(candidateFilePath(project.projectDirectory, matches[0].page_key, matches[0].candidate_id));
  return deletePageCandidate(projectRoot, projectId, identity.page_id, absoluteCandidatePath, { exactPageKey: identity.page_key });
}

export async function deletePageCandidates(projectRoot, projectId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.page_key) fail("invalid_candidate_delete_request", [], 400);
  const hasIds = Array.isArray(value.candidate_ids);
  const promptMismatch = value.prompt_mismatch === true;
  const allowed = hasIds ? new Set(["page_key", "candidate_ids"]) : new Set(["page_key", "prompt_mismatch", "expected_signature"]);
  if (hasIds === promptMismatch || Object.keys(value).some((key) => !allowed.has(key))) fail("invalid_candidate_delete_request", [], 400);
  if (!hasIds && value.expected_signature !== undefined && typeof value.expected_signature !== "string") fail("invalid_candidate_delete_request", [], 400);
  if (hasIds && (!value.candidate_ids.length || new Set(value.candidate_ids).size !== value.candidate_ids.length
    || value.candidate_ids.some((candidateId) => typeof candidateId !== "string"))) {
    fail("invalid_candidate_delete_request", [], 400);
  }
  const project = await resolveProjectLocation(path.resolve(projectRoot), projectId);
  const identity = await resolveExactPageIdentity(project.projectDirectory, value.page_key);
  const canonical = encodePageKey(identity.page_key);
  const records = await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
  const available = records.filter((record) => encodePageKey(record.page_key) === canonical && record.status === "available");
  let requestedIds;
  if (hasIds) {
    requestedIds = value.candidate_ids;
  } else {
    const context = await compilePageRenderInspectionContext({
      repositoryRoot: projectRoot,
      projectDirectory: project.projectDirectory,
      pageKey: identity.page_key,
    });
    const compiled = context.compiled_page;
    if (!compiled) fail("current_prompt_unavailable", context.blockers.map((blocker) => blocker.message));
    const currentSignature = promptSignature({ positive_prompt: compiled.positive_prompt ?? "", negative_prompt: compiled.negative_prompt ?? "" });
    if (value.expected_signature !== undefined && value.expected_signature !== currentSignature) {
      fail("candidate_prompt_signature_stale", [], 409);
    }
    requestedIds = available.filter((record) => record.prompt_signature !== currentSignature).map((record) => record.candidate_id);
  }
  const byId = new Map(available.map((record) => [record.candidate_id, record]));
  const missing = requestedIds.filter((candidateId) => !byId.has(candidateId));
  if (missing.length) fail("candidate_not_found", missing, 404);
  const activeIds = new Set(await listActiveProjectTaskIds(project.projectDirectory));
  const active = requestedIds.map((candidateId) => byId.get(candidateId)).filter((record) => activeIds.has(record.task_id));
  if (active.length) fail("candidate_task_active", [...new Set(active.map((record) => record.task_id))], 409);
  const deleted = [];
  for (const candidateId of requestedIds) {
    deleted.push(await deletePageCandidateById(projectRoot, projectId, identity.page_key, candidateId));
  }
  return {
    page_key: structuredClone(identity.page_key),
    deleted_candidate_ids: deleted.map((item) => item.deleted_candidate_id),
  };
}
