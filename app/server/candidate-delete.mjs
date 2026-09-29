import { inspectionGenerationSignature } from "./generation-signature.mjs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { candidateFilePath, readGenerationCandidateRecords } from "./candidate-storage.mjs";
import { withCandidateMutationLock } from "./candidate-mutation-lock.mjs";
import { encodePageKey } from "./page-key.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { PageRenderError, compilePageRenderInspectionContext, resolveExactPageIdentity, resolvePageIdentity } from "./page-render-resolver.mjs";
import { updateRenderTask } from "./render-task-storage.mjs";
import { factStorage as storage } from "./story-facts.mjs";
import {replaceFileWithRetry} from './file-replace.mjs';

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
      const mediaLock = `candidate-media-${createHash("sha256").update(requested).digest("hex")}`;
      return storage.withResourceLock(projectRoot, projectId, mediaLock, record.candidate_id, async () => {
        await assertCandidateFile(project.projectDirectory, requested);
        const currentRecords = await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
        const current = currentRecords.find((candidate) => candidate.task_id === record.task_id
          && candidate.candidate_id === record.candidate_id && encodePageKey(candidate.page_key) === canonical);
        if (!current || current.status !== "available") fail("candidate_delete_conflict", [record.candidate_id], 409);
        const staged = path.join(project.projectDirectory, "Saved", "staging", "deleted-" + randomUUID());
        await mkdir(path.dirname(staged), { recursive: true });
        // 先持久化删除状态，再移走目录；标记失败时不删除，防止执行器重新发布。
        let previousItem;
        await updateRenderTask(project.projectDirectory, current.task_id, (task) => {
          const item = task.items.find(entry => entry.candidate_id === current.candidate_id);
          if (item) { previousItem = structuredClone(item); item.status = 'discarded'; item.discarded_at = new Date().toISOString(); }
        }).catch(error => { if (error.code !== 'ENOENT') throw error; });
        try{await replaceFileWithRetry(path.dirname(requested),staged);}
        catch(error){
          if (previousItem) await updateRenderTask(project.projectDirectory, current.task_id, task => {
            const item = task.items.find(entry => entry.candidate_id === current.candidate_id);
            if (item) { item.status = previousItem.status; if (previousItem.discarded_at) item.discarded_at = previousItem.discarded_at; else delete item.discarded_at; }
          });
          if(['EPERM','EACCES','EBUSY'].includes(error.code))fail('candidate_file_busy',[
          {candidate_id:record.candidate_id,filesystem_code:error.code,phase:'stage_delete'},
          '移动候选目录失败，已完成短时重试；可能是文件占用或权限问题。停止空等，可继续其他编辑或生成。',
        ],409);throw error;}
        // 候选已移出发布目录；暂存垃圾回收失败不把已完成删除报成失败。
        await rm(staged, { recursive: true, force: true }).catch(() => undefined);
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
  const generationMismatch = value.generation_mismatch === true;
  const allowed = hasIds ? new Set(["page_key", "candidate_ids"]) : new Set(["page_key", "generation_mismatch", "expected_signature"]);
  if (hasIds === generationMismatch || Object.keys(value).some((key) => !allowed.has(key))) fail("invalid_candidate_delete_request", [], 400);
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
    const currentSignature = inspectionGenerationSignature(context);
    if (!currentSignature) fail("current_prompt_unavailable", ["无法取得完整生成条件"]);
    if (value.expected_signature !== undefined && value.expected_signature !== currentSignature) {
      fail("candidate_generation_signature_stale", [], 409);
    }
    requestedIds = available.filter((record) => record.generation_signature !== currentSignature).map((record) => record.candidate_id);
  }
  const byId = new Map(available.map((record) => [record.candidate_id, record]));
  const missing = requestedIds.filter((candidateId) => !byId.has(candidateId));
  if (missing.length) fail("candidate_not_found", missing, 404);
  const deleted = [];
  const failed = [];
  for (const candidateId of requestedIds) {
    try { deleted.push(await deletePageCandidateById(projectRoot, projectId, identity.page_key, candidateId)); }
    catch (error) { failed.push({ candidate_id: candidateId, code: error.code ?? 'candidate_delete_failed', details: error.details ?? [], message: error.message }); }
  }
  return {
    page_key: structuredClone(identity.page_key),
    deleted_candidate_ids: deleted.map((item) => item.deleted_candidate_id),
    ...(failed.length ? { status: 'incomplete', failed_candidates: failed, recovery: '已尝试全部指定候选。不要重放成功项或等待生成结束；可继续其他工作，排查失败原因后仅处理失败 ID。' } : {}),
  };
}
