import { inspectionGenerationSignature } from "./generation-signature.mjs";
import { deletePageCandidates } from "./candidate-delete.mjs";
import { readPageMedia } from "./page-media.mjs";
import { validatePageKey } from "./page-key.mjs";
import { compilePageRenderInspectionContext, resolveExactPageIdentity, PageRenderError } from "./page-render-resolver.mjs";

function requireStoryKey(key) {
  if (validatePageKey(key).length) {
    throw new PageRenderError("invalid_story_refresh_request", [], 400);
  }
}

// 每次只扫描一小批页面；不读取 generation.json、历史任务或整项目工作台。
export async function inspectStoryCandidates({ projectRoot, projectDirectory, projectId, config, pageKeys }) {
  if (!Array.isArray(pageKeys) || !pageKeys.length || pageKeys.length > 8) {
    throw new PageRenderError("invalid_story_refresh_request", [], 400);
  }
  pageKeys.forEach(requireStoryKey);
  for (const key of pageKeys) {
    const identity = await resolveExactPageIdentity(projectDirectory, key);
    if (identity.kind !== "story") throw new PageRenderError("invalid_story_refresh_request", [], 400);
  }
  const results = new Array(pageKeys.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, pageKeys.length) }, async () => {
    while (cursor < pageKeys.length) {
      const index = cursor++;
      const pageKey = pageKeys[index];
      const result = { page_key: pageKey, status: "unavailable", signature: null, matched: 0, candidate_ids: [], all_candidate_ids: [] };
      results[index] = result;
      const { media } = await readPageMedia(projectRoot, projectId, { page_key: pageKey });
      result.all_candidate_ids = media.candidates.map((item) => item.candidate_id);
      const context = await compilePageRenderInspectionContext({ repositoryRoot: projectRoot, projectDirectory, pageKey }).catch(() => null);
      if (!context?.compiled_page || context.blockers.length) continue;
      result.signature = inspectionGenerationSignature(context);
      if (!result.signature) continue;
      result.status = "ready";
      result.matched = media.candidates.filter((item) => item.generation_signature === result.signature).length;
      result.candidate_ids = media.candidates.filter((item) => item.generation_signature !== result.signature).map((item) => item.candidate_id);
    }
  }));
  return results;
}

// 在项目 mutateDerived 边界内重新判定，且删除范围只能缩小，不能扩大到确认后新增的图片。
export async function executeStoryCandidateRefresh(context, value, startRender) {
  requireStoryKey(value?.page_key);
  const all = value.scope === "all";
  if (!["clean", "generate"].includes(value.action)
    || !(value.action === "clean" ? ["mismatch", "all"] : ["missing", "all"]).includes(value.scope)
    || (!(value.action === "clean" && all) && typeof value.expected_signature !== "string")
    || (value.action === "generate" && (!Number.isInteger(value.count) || value.count < 1 || value.count > 3))
    || (value.action === "clean" && (!Array.isArray(value.candidate_ids)
      || value.candidate_ids.some((id) => typeof id !== "string")))) {
    throw new PageRenderError("invalid_story_refresh_request", [], 400);
  }
  const [current] = await inspectStoryCandidates({ ...context, pageKeys: [value.page_key] });
  if (current.status !== "ready" && !(value.action === "clean" && all)) return { status: "skipped" };
  if (!(value.action === "clean" && all) && current.signature !== value.expected_signature) {
    throw new PageRenderError("candidate_generation_signature_stale", ["当前生成条件已变化，请重新扫描后确认"], 409);
  }
  if (value.action === "generate") {
    if (!all && current.matched) return { status: "skipped" };
    return { status: "queued", task: await startRender({ page_key: value.page_key, operation: "candidates", count: value.count }) };
  }
  const requested = new Set(value.candidate_ids);
  const ids = (all ? current.all_candidate_ids : current.candidate_ids).filter((id) => requested.has(id));
  if (!ids.length) return { status: "skipped" };
  const deleted = await deletePageCandidates(context.projectRoot, context.projectId, { page_key: value.page_key, candidate_ids: ids });
  return { status: deleted.failed_candidates?.length ? 'incomplete' : 'deleted', count: deleted.deleted_candidate_ids.length,
    ...(deleted.failed_candidates?.length ? { deleted_candidate_ids: deleted.deleted_candidate_ids, failed_candidates: deleted.failed_candidates, recovery: deleted.recovery } : {}) };
}
