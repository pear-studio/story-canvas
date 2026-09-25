import { ApiError, readJsonBody, sendJson } from "./http-support.mjs";
import { readFactDraft, saveFactDraft } from "./fact-drafts.mjs";
import { readStoryContext } from "./story-facts.mjs";
import { readProjectCreationTemplate, createProject } from "./project-creation.mjs";
import { readPromptEditContext } from "./prompt-edit-context.mjs";
import { readAgentDirectory } from './agent-directory.mjs';

export async function handleAgentRequest({ request, response, decodedPath, projectRoot, config = {}, readFacts, mutateTargetFacts, sendOperation }) {
  const match = /^\/api\/agent\/facts\/(story|character|scene|page)\/([a-z-]+)\/(read|save)$/.exec(decodedPath);
  const creation = /^\/api\/agent\/project-create\/(template|create)$/.exec(decodedPath);
  const contextRead = decodedPath === "/api/agent/story-context";
  const promptContextRead = decodedPath === "/api/agent/prompt-context";
  const directoryRead = decodedPath === '/api/agent/directory';
  if (request.method !== "POST" || (!match && !creation && !contextRead && !promptContextRead && !directoryRead)) return false;
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_edit_request");
  if (directoryRead) {
    sendOperation(200, await readFacts(body.project_id, ({ projectDirectory }) => readAgentDirectory(projectRoot, projectDirectory, body)));
    return true;
  }
  if (promptContextRead) {
    sendOperation(200, await readFacts(body.project_id, ({ projectDirectory }) => readPromptEditContext({
      projectRoot, projectDirectory, projectId: body.project_id, pageKey: body.page_key, config,
    })));
    return true;
  }
  if (contextRead) {
    sendOperation(200, await readFacts(body.project_id, () => readStoryContext(projectRoot, body.project_id, body.sequence_id)));
    return true;
  }
  if (creation) {
    const value = creation[1] === "template"
      ? await readProjectCreationTemplate(projectRoot, body.project_id)
      : await createProject(projectRoot, body);
    sendJson(response, 200, value);
    return true;
  }
  const [, domain, kind, action] = match;
  const target = { domain, kind, projectId: body.project_id, targetId: body.target_id };
  if (action === "read") {
    sendOperation(200, await readFacts(body.project_id, () => readFactDraft(projectRoot, target)));
    return true;
  }
  if (action === "save") {
    if (!body.document || typeof body.document !== "object" || Array.isArray(body.document)
      || !/^[a-f0-9]{64}$/.test(body.expected_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(body.expected_context_sha256 ?? "")) {
      throw new ApiError(400, "invalid_fact_draft");
    }
    sendOperation(200, await mutateTargetFacts(body.project_id, () => saveFactDraft(projectRoot, {
      ...target, document: body.document, expectedSha256: body.expected_sha256, expectedContextSha256: body.expected_context_sha256,
      conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict",
    })));
    return true;
  }
  return false;
}
