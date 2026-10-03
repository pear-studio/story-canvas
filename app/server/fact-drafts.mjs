import * as scene from "./scene-facts.mjs";
import * as story from "./story-facts.mjs";
import * as character from "./character-facts.mjs";
import * as page from "./character-page-facts.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { ApiError } from "./http-support.mjs";
import { readPageRenderDraft, commitPageRender } from './page-render-settings.mjs';

export function fingerprintErrors(body, fields) {
  return fields.filter(field=>typeof body[field] !== 'string' || !/^[a-f0-9]{64}$/.test(body[field])).map(field=>({
    field, message:`${field} 必须原样使用读取回执中的64位小写十六进制指纹；不能填占位符或自行计算`,
    ...(typeof body[field]==='string'?{received_length:body[field].length}:{}),
  }));
}

function draftOperation(domain, kind) {
  if (domain === "scene" && ["profile", "visual", "prompt"].includes(kind)) return { read: scene.readSceneFactDraft, commit: scene.commitSceneFact, kind };
  if (domain === "page") {
    if (kind === 'render') return { read: readPageRenderDraft, commit: commitPageRender, kind };
    if (["content", "prompt"].includes(kind)) return { read: story.readStoryFactDraft, commit: story.commitStoryFact, kind: kind === "content" ? "narrative" : kind };
    if (kind === "text-sources") return { read: story.readTextSourcesDraft, commit: story.commitTextSources, kind };
  }
  if (domain === "story" && ["outline", "index"].includes(kind)) {
    return { read: story.readStoryStructureDraft, commit: story.commitStoryStructure, kind };
  }
  if (domain === "story" && ["synopsis", "chapter", "sequence"].includes(kind)) {
    return { read: story.readStoryOutlineTargetDraft, commit: story.commitStoryOutlineTarget, kind };
  }
  if (domain === "story" && ["narrative", "prompt"].includes(kind)) {
    return { read: story.readStoryFactDraft, commit: story.commitStoryFact, kind };
  }
  if (domain === "story" && kind === "text-sources") {
    return { read: story.readTextSourcesDraft, commit: story.commitTextSources, kind };
  }
  if (domain === "character" && ["profile", "visual", "prompt"].includes(kind)) {
    return { read: character.readCharacterFactDraft, commit: character.commitCharacterFact, kind };
  }
  if (domain === "character" && ["page-goal", "page-prompt"].includes(kind)) {
    return { read: page.readCharacterPageFactDraft, commit: page.commitCharacterPageFact, kind: kind.slice(5) };
  }
  if (domain === "character" && kind === "page-index") {
    return { read: page.readCharacterPagesIndexDraft, commit: page.commitCharacterPagesIndex, kind };
  }
  throw new ApiError(400, "fact_draft_not_supported", [domain, kind]);
}

async function currentDraft(root, domain, kind, projectId, targetId) {
  const operation = draftOperation(domain, kind);
  const { project, definition } = await operation.read(root, projectId, targetId, operation.kind);
  return { operation, document: definition.editable ?? definition.persisted,
    context: { project_id: project.projectId, ...definition.identity,
      target: { relative_path: definition.targetRelative, sha256: hashCanonicalJson(definition.targetBaseline ?? definition.persisted) },
      upstream: definition.upstream } };
}

// read 的返回值就是 save 的请求体；只修改 document，保留读取时的指纹。
export async function readFactDraft(root, { domain, kind, projectId, targetId }) {
  const { context, document } = await currentDraft(root, domain, kind, projectId, targetId);
  return { project_id: context.project_id, target_id: targetId ?? null, document: structuredClone(document),
    ...(["content","narrative"].includes(kind) && context.upstream.prompt_sha256 ? {expected_reference_sha256:context.upstream.prompt_sha256,
      expected_edit_context_sha256:hashCanonicalJson(Object.fromEntries(Object.entries(context.upstream).filter(([key])=>key!=='prompt_sha256')))} : {}),
    expected_sha256: context.target.sha256, expected_context_sha256: hashCanonicalJson(context.upstream) };
}

// HTTP 与 CLI 直接调用同一提交逻辑，不托管草稿文件。
export async function saveFactDraft(root, {
  domain, kind, projectId, targetId, document, expectedSha256, conflictCode,
  beforeCommit, sourceVersions, expectedContextSha256, contextConflictCode = "page_prompt_upstream_conflict",
}) {
  const submitted = structuredClone(document);
  const { operation, context } = await currentDraft(root, domain, kind, projectId, targetId);
  if (context.target.sha256 !== expectedSha256) throw new ApiError(409, conflictCode, [targetId]);
  if (expectedContextSha256 !== undefined && hashCanonicalJson(context.upstream) !== expectedContextSha256) throw new ApiError(409, contextConflictCode, [targetId]);
  return operation.commit(root, context, () => structuredClone(submitted), operation.kind, { beforeCommit, sourceVersions });
}

export async function pagePromptContextSha256(projectDirectory, kind, pageId) {
  return hashCanonicalJson(await story.readStoryPromptUpstream(projectDirectory, pageId));
}
