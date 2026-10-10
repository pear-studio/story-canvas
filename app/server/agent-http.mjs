import {migrateProjectCamera} from './camera-migration.mjs';
import {migrateProjectPopulation} from './population-migration.mjs';
import { captureCandidateSheet, exportCandidateSheet } from './candidate-sheet.mjs';
import { ApiError, readJsonBody, sendJson } from "./http-support.mjs";
import { readFactDraft, saveFactDraft, fingerprintErrors } from "./fact-drafts.mjs";
import { readStoryContext } from "./story-facts.mjs";
import { readProjectCreationTemplate, createProject } from "./project-creation.mjs";
import { readPromptEditContext } from "./prompt-edit-context.mjs";
import { readPageEditContext, savePageEditChanges } from './page-edit-context.mjs';
import { readAgentDirectory } from './agent-directory.mjs';
import { readPageRenderEditor, setPageRenderEditor } from './page-render-editor.mjs';
import { readPromptScope, savePromptScope, readPromptScopeSources, promptEditorMigration } from './prompt-scope.mjs';
import {checkProjectPrompts} from './prompt-check.mjs';

export async function handleAgentRequest({ request, response, decodedPath, projectRoot, config = {}, readFacts, mutateTargetFacts, sendOperation }) {
  const match = /^\/api\/agent\/facts\/(story|character|scene|page)\/([a-z-]+)\/(read|save)$/.exec(decodedPath);
  const creation = /^\/api\/agent\/project-create\/(template|create)$/.exec(decodedPath);
  const contextRead = decodedPath === "/api/agent/story-context";
  const promptContextRead = decodedPath === "/api/agent/prompt-context";
  const pageEditorRead = decodedPath === '/api/agent/page-editor';
  const pageEditorSave = decodedPath === '/api/agent/page-editor/save';
  const pageRender = /^\/api\/agent\/page-render\/(read|set)$/.exec(decodedPath);
  const promptScope = /^\/api\/agent\/prompt\/(read|save|sources|check)$/.exec(decodedPath);
  const cameraMigration = decodedPath === '/api/agent/camera-migration';
  const populationMigration = decodedPath === '/api/agent/population-migration';
  const candidateSheet = decodedPath === '/api/agent/candidate-sheet';
  const directoryRead = decodedPath === '/api/agent/directory';
  if (request.method !== "POST" || (!cameraMigration && !promptScope && !populationMigration && !candidateSheet && !match && !creation && !contextRead && !promptContextRead && !directoryRead && !pageEditorRead && !pageEditorSave && !pageRender)) return false;
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_edit_request");
  if (promptScope) {
    const action = promptScope[1];
    if(action==='check') {
      sendJson(response,200,await checkProjectPrompts(projectRoot,body,readFacts));
      return true;
    }
    const options = {projectRoot,projectId:body.project_id,target:body.target,expectedSha256:body.expected_sha256,changes:body.changes,sourceVersions:body.source_versions,source:body.source};
    const run = action === 'save' ? savePromptScope : action === 'sources' ? readPromptScopeSources : readPromptScope;
    sendOperation(200,await (action === 'save' ? mutateTargetFacts : readFacts)(body.project_id,()=>run(options)));
    return true;
  }
  if(cameraMigration){sendOperation(200,await (body.apply?mutateTargetFacts:readFacts)(body.project_id,({projectDirectory})=>migrateProjectCamera(projectDirectory,body)));return true;}
  if (populationMigration) {
    sendOperation(200,await (body.apply?mutateTargetFacts:readFacts)(body.project_id,({projectDirectory})=>migrateProjectPopulation(projectDirectory,body)));
    return true;
  }
  if (candidateSheet) {
    let directory;
    const captured=await readFacts(body.project_id, async ({projectDirectory}) => {
      directory=projectDirectory; return captureCandidateSheet(projectDirectory,body);
    });
    sendOperation(200,{...captured,value:await exportCandidateSheet(projectRoot,directory,captured.value)});
    return true;
  }
  if (pageRender) {
    const options={projectRoot,projectId:body.project_id,pageKey:body.page_key,expectedSha256:body.expected_sha256,settings:body};
    const reading=pageRender[1]==='read';
    sendOperation(200,await (reading?readFacts:mutateTargetFacts)(body.project_id,()=>reading?readPageRenderEditor(options):setPageRenderEditor(options)));
    return true;
  }
  if (pageEditorSave) {
    if ((body.section ?? 'content') === 'prompt') throw promptEditorMigration('page','prompt',body.page_key?.page_id,body.project_id);
    sendOperation(200, await mutateTargetFacts(body.project_id, () => savePageEditChanges({
      projectRoot,projectId:body.project_id,pageKey:body.page_key,section:body.section ?? 'content',changes:body.changes,expectedSha256:body.expected_sha256,
      expectedReferenceSha256:body.expected_reference_sha256,
    })));
    return true;
  }
  if (pageEditorRead) {
    if ((body.section ?? 'content') === 'prompt') throw promptEditorMigration('page','prompt',body.page_key?.page_id,body.project_id);
    sendOperation(200, await readFacts(body.project_id, ({ projectDirectory }) => readPageEditContext({
      projectRoot, projectDirectory, projectId: body.project_id, pageKey: body.page_key, section: body.section ?? 'content', config,
    })));
    return true;
  }
  if (directoryRead) {
    sendOperation(200, await readFacts(body.project_id, ({ projectDirectory }) => readAgentDirectory(projectRoot, projectDirectory, body)));
    return true;
  }
  if (promptContextRead) {
    sendOperation(200, await readFacts(body.project_id, async ({ projectDirectory }) => {
      const {page_key,context} = await readPromptEditContext({projectRoot,projectDirectory,projectId:body.project_id,pageKey:body.page_key,config});
      return {page_key,context,edit:{operation:'prompt.read',args:{project_id:body.project_id,target:{kind:'page',id:page_key.page_id}}}};
    }));
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
  const migration = promptEditorMigration(domain,kind,body.target_id,body.project_id);
  if (migration) throw migration;
  const target = { domain, kind, projectId: body.project_id, targetId: body.target_id };
  if (action === "read") {
    sendOperation(200, await readFacts(body.project_id, () => readFactDraft(projectRoot, target)));
    return true;
  }
  if (action === "save") {
    const errors=fingerprintErrors(body,['expected_sha256','expected_context_sha256']);
    if (!body.document || typeof body.document !== "object" || Array.isArray(body.document))
      errors.push({field:'document',message:'document 必须是读取草稿中的完整对象；不要提交整个 {draft,save} 返回包'});
    if(errors.length)throw new ApiError(400, "invalid_fact_draft",errors);
    sendOperation(200, await mutateTargetFacts(body.project_id, () => saveFactDraft(projectRoot, {
      ...target, document: body.document, expectedSha256: body.expected_sha256, expectedContextSha256: body.expected_context_sha256,
      conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict",
    })));
    return true;
  }
  return false;
}
