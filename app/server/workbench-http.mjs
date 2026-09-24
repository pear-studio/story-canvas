import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { readReferenceLibrary, mutateReferenceLibrary } from "./reference-library.mjs";
import { savePage } from "./page-facts.mjs";
import {reimportAnimaPrompt} from './page-render-settings.mjs';
import { SCENE_PROFILE_SCHEMA_ID, SCENE_VISUAL_SCHEMA_ID, SCENE_PROMPT_SCHEMA_ID } from "./scene-files.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { readFactDraft, saveFactDraft } from './fact-drafts.mjs';
import { inspectStoryCandidates, executeStoryCandidateRefresh } from "./story-candidate-refresh.mjs";
import { deletePageCandidateById, deletePageCandidates } from "./candidate-delete.mjs";
import { ApiError, configuredPath, readJsonBody, sendJson } from "./http-support.mjs";
import { readWritingCorpusContext } from "./writing-corpus.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";
import { compileAndPersistWorkbenchRenderTask, runCompiledPageRenderTask } from "./page-render.mjs";
import { generationReference } from "./generation-queue.mjs";
import { submitGenerationTask } from "./generation-lifecycle.mjs";
import { inspectPageRender } from "./page-render-inspection.mjs";
import { readPageRewriteState, rewriteSource, savePageRewriteResult } from "./page-rewrite.mjs";
import { PromptRewriteRunnerError, runPromptRewrite } from "./prompt-rewrite-runner.mjs";
import { readPageRewriteProgress, trackPageRewrite } from './page-rewrite-runtime.mjs';
import {
  readPageCandidateDetail,
  readProjectWorkbenchView,
  deletePageTextSource,
  saveCharacterProfile,
  saveCharacterPrompt,
  saveCharacterVisual,
  saveLetteringSettings,
  savePageContent,
  savePageLettering,
  savePagePrompt,
  saveStorySummary,
} from "./project-workbench.mjs";
import {
  createWorkbenchPage, duplicateWorkbenchPage, deleteWorkbenchPage, moveWorkbenchPage,
  createWorkbenchScene, deleteWorkbenchScene, moveWorkbenchScene, createWorkbenchSceneVariant,
  deleteWorkbenchSceneVariant, moveWorkbenchSceneVariant, renameWorkbenchSceneVariant,
  createWorkbenchChapter,
  createWorkbenchCharacter,
  createWorkbenchCharacterPage,
  createWorkbenchCharacterVariant,
  createWorkbenchSequence,
  createWorkbenchStoryPage,
  createWorkbenchStoryPageFromTemplate,
  deleteWorkbenchChapter,
  deleteWorkbenchCharacter,
  deleteWorkbenchCharacterPage,
  deleteWorkbenchCharacterVariant,
  deleteWorkbenchSequence,
  deleteWorkbenchStoryPage,
  duplicateWorkbenchCharacterPage,
  duplicateWorkbenchStoryPage,
  moveWorkbenchChapter,
  moveWorkbenchCharacterPage,
  moveWorkbenchCharacterVariant,
  moveWorkbenchSequence,
  moveWorkbenchStoryPage,
  renameWorkbenchChapter,
  renameWorkbenchCharacterVariant,
  renameWorkbenchSequence,
} from "./workbench-navigation.mjs";

export async function handleWorkbenchRequest({
  request,
  response,
  decodedPath,
  requestUrl,
  projectRoot,
  config,
  readFacts,
  pageMediaReader,
  mutateFacts,
  mutateTargetFacts,
  mutateDerived,
  mutateDerivedState,
  sendOperation,
  workbenchRenderLauncher,
  generationScheduler = null,
}) {
  async function startRender(projectDirectory, safeProjectId, value) {
    if (workbenchRenderLauncher) return workbenchRenderLauncher({
      repositoryRoot: projectRoot,
      projectDirectory,
      projectId: safeProjectId,
      value,
      config,
    });
    const compiled = await compileAndPersistWorkbenchRenderTask(projectRoot, safeProjectId, value, {
      localConfig: config,
      repositoryRoot: projectRoot,
    });
    const reference = generationReference(safeProjectId, compiled.task.id, "candidate", compiled.task.created_at);
    if (generationScheduler) await submitGenerationTask(projectRoot, reference);
    const worker = generationScheduler
      ? generationScheduler.startReference(reference)
      : runCompiledPageRenderTask(compiled, {
        repositoryRoot: projectRoot,
        apiUrl: primaryComfyUiUrl(config),
      });
    void worker.catch(error => console.error("生成任务执行失败", error));
    return {
      task_id: compiled.task.id,
      task_directory: compiled.task_directory,
      candidate_paths: compiled.candidate_paths,
      status: "queued",
      operation: value.operation ?? "candidates",
      page_key: structuredClone(compiled.page_key),
      count: compiled.task.items.length,
    };
  }

  const sceneFactMatch = /^\/api\/projects\/([^/]+)\/workbench\/scene-(profile|visual|prompt)\/?$/.exec(decodedPath);
  if (sceneFactMatch && request.method === "PUT") {
    const [, projectId, kind] = sceneFactMatch;
    const value = await readJsonBody(request);
    if (!value || typeof value.scene_id !== "string" || !value[kind] || typeof value[kind] !== "object" || Array.isArray(value[kind])) throw new ApiError(400, "invalid_scene_update");
    const schemas = { profile: SCENE_PROFILE_SCHEMA_ID, visual: SCENE_VISUAL_SCHEMA_ID, prompt: SCENE_PROMPT_SCHEMA_ID };
    const result = await mutateTargetFacts(projectId, async () => {
      if (kind === "prompt") {
        const visual = await readFactDraft(projectRoot, { domain: "scene", kind: "visual", projectId, targetId: value.scene_id });
        if (!value.expected_visual_sha256 || visual.expected_sha256 !== value.expected_visual_sha256) throw new ApiError(409, "scene_prompt_visual_conflict");
      }
      const saved = await saveFactDraft(projectRoot, { domain: "scene", kind, projectId, targetId: value.scene_id,
        document: { ...value[kind], $schema: schemas[kind] }, expectedSha256: value.expected_sha256,
        expectedContextSha256: value.expected_context_sha256, conflictCode: "scene_target_conflict", contextConflictCode: "scene_upstream_conflict" });
      const document = structuredClone(saved.value); delete document.$schema;
      return { scene_id: value.scene_id, [kind]: document, [`${kind}_sha256`]: hashCanonicalJson(saved.value), downstream_diagnostics: saved.downstream_diagnostics };
    });
    sendOperation(200, result);
    return true;
  }
  const pageSaveMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-save\/?$/.exec(decodedPath);
  if (pageSaveMatch && request.method === "PUT") {
    const value = await readJsonBody(request, 440 * 1024 * 1024);
    const result = await mutateTargetFacts(pageSaveMatch[1], ({ projectId }) => savePage(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }
  const referenceMatch = /^\/api\/projects\/([^/]+)\/workbench\/reference-library$/.exec(decodedPath);
  if (referenceMatch && request.method === "POST") {
    const value = await readJsonBody(request, 44 * 1024 * 1024);
    const result = value.action === "read"
      ? await readFacts(referenceMatch[1], ({ projectId }) => readReferenceLibrary(projectRoot, projectId, value.target))
      : await mutateTargetFacts(referenceMatch[1], ({ projectDirectory, projectId }) => mutateReferenceLibrary(projectRoot, projectDirectory, projectId, value));
    sendOperation(200, result); return true;
  }
  const workbenchMatch = /^\/api\/projects\/([^/]+)\/workbench\/?$/.exec(decodedPath);
  if (request.method === "GET" && workbenchMatch) {
    const result = await readFacts(workbenchMatch[1], ({ projectId }) => readProjectWorkbenchView(projectRoot, projectId));
    sendOperation(200, result);
    return true;
  }

  const letteringSettingsMatch = /^\/api\/projects\/([^/]+)\/workbench\/lettering-settings\/?$/.exec(decodedPath);
  if (request.method === "PUT" && letteringSettingsMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(letteringSettingsMatch[1], ({ projectId }) => saveLetteringSettings(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const pageMediaMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-media\/?$/.exec(decodedPath);
  if (request.method === "POST" && pageMediaMatch) {
    const value = await readJsonBody(request);
    // 媒体是本机派生投影，不扫描/推进项目事实 revision，也不获取候选写锁。
    const knownRevision = request.headers["x-story-canvas-media-revision"];
    const result = await pageMediaReader.read(pageMediaMatch[1], value, { fresh: request.headers["x-story-canvas-media-fresh"] === "1" });
    sendJson(response, 200, knownRevision === result.revision ? { unchanged: true, revision: result.revision } : result);
    return true;
  }

  const candidateCountsMatch = /^\/api\/projects\/([^/]+)\/workbench\/candidate-counts\/?$/.exec(decodedPath);
  if (request.method === "GET" && candidateCountsMatch) {
    const result = await pageMediaReader.counts(candidateCountsMatch[1]);
    sendJson(response, 200, request.headers["x-story-canvas-media-revision"] === result.revision
      ? { unchanged: true, revision: result.revision } : result);
    return true;
  }

  const navigationActionMatch = /^\/api\/projects\/([^/]+)\/workbench\/navigation\/([a-z-]+)\/?$/.exec(decodedPath);
  if (request.method === "POST" && navigationActionMatch) {
    const [projectId, action] = navigationActionMatch.slice(1);
    const value = await readJsonBody(request);
    const operations = {
      "create-page": () => createWorkbenchPage(projectRoot, projectId, value?.owner, { templateId: value?.template_id, pageKind: value?.page_kind, afterPageId: value?.after_page_id, characterId: value?.character_id, variantId: value?.variant_id }),
      "move-page": () => moveWorkbenchPage(projectRoot, projectId, value?.page_id, value?.owner, { beforePageId: value?.before_page_id }),
      "duplicate-page": () => duplicateWorkbenchPage(projectRoot, projectId, value?.page_id),
      "delete-page": () => deleteWorkbenchPage(projectRoot, projectId, value?.page_id),
      "create-scene": () => createWorkbenchScene(projectRoot, projectId, value?.id, value?.name),
      "delete-scene": () => deleteWorkbenchScene(projectRoot, projectId, value?.scene_id),
      "move-scene": () => moveWorkbenchScene(projectRoot, projectId, value?.scene_id, { beforeSceneId: value?.before_scene_id, direction: value?.direction }),
      "create-scene-variant": () => createWorkbenchSceneVariant(projectRoot, projectId, value?.scene_id, value?.id, value?.name, value?.after_variant_id ?? null),
      "move-scene-variant": () => moveWorkbenchSceneVariant(projectRoot, projectId, value?.scene_id, value?.variant_id, value?.before_variant_id ?? null),
      "delete-scene-variant": () => deleteWorkbenchSceneVariant(projectRoot, projectId, value?.scene_id, value?.variant_id),
      "rename-scene-variant": () => renameWorkbenchSceneVariant(projectRoot, projectId, value?.scene_id, value?.old_id, value?.new_id),
      "create-chapter": () => createWorkbenchChapter(projectRoot, projectId, value?.title, value?.after_chapter_id ?? null),
      "rename-chapter": () => renameWorkbenchChapter(projectRoot, projectId, value?.chapter_id, value?.title),
      "move-chapter": () => moveWorkbenchChapter(projectRoot, projectId, value?.chapter_id, value?.before_chapter_id ?? null),
      "delete-chapter": () => deleteWorkbenchChapter(projectRoot, projectId, value?.chapter_id),
      "create-sequence": () => createWorkbenchSequence(projectRoot, projectId, value?.chapter_id, value?.title, value?.after_sequence_id ?? null),
      "rename-sequence": () => renameWorkbenchSequence(projectRoot, projectId, value?.sequence_id, value?.title),
      "move-sequence": () => moveWorkbenchSequence(projectRoot, projectId, value?.sequence_id, value?.chapter_id, value?.before_sequence_id ?? null),
      "delete-sequence": () => deleteWorkbenchSequence(projectRoot, projectId, value?.sequence_id),
      "create-story-page": () => createWorkbenchStoryPage(projectRoot, projectId, value?.sequence_id, value?.page_kind ?? null, value?.after_page_id ?? null),
      "create-story-page-from-template": () => createWorkbenchStoryPageFromTemplate(projectRoot, projectId, value?.sequence_id, value?.template_id, value?.character_id, value?.variant_id, value?.after_page_id ?? null),
      "move-story-page": () => moveWorkbenchStoryPage(projectRoot, projectId, value?.page_id, value?.sequence_id, value?.before_page_id ?? null),
      "duplicate-story-page": () => duplicateWorkbenchStoryPage(projectRoot, projectId, value?.page_id),
      "delete-story-page": () => deleteWorkbenchStoryPage(projectRoot, projectId, value?.page_id),
      "create-character": () => createWorkbenchCharacter(projectRoot, projectId, value?.id, value?.name),
      "delete-character": () => deleteWorkbenchCharacter(projectRoot, projectId, value?.character_id),
      "create-character-variant": () => createWorkbenchCharacterVariant(projectRoot, projectId, value?.character_id, value?.id, value?.name, value?.after_variant_id ?? null),
      "move-character-variant": () => moveWorkbenchCharacterVariant(projectRoot, projectId, value?.character_id, value?.variant_id, value?.before_variant_id ?? null),
      "delete-character-variant": () => deleteWorkbenchCharacterVariant(projectRoot, projectId, value?.character_id, value?.variant_id),
      "create-character-page": () => createWorkbenchCharacterPage(projectRoot, projectId, value?.character_id, value?.variant_id, value?.template_id ?? null, value?.after_page_id ?? null),
      "move-character-page": () => moveWorkbenchCharacterPage(projectRoot, projectId, value?.page_id, value?.variant_id, value?.before_page_id ?? null),
      "duplicate-character-page": () => duplicateWorkbenchCharacterPage(projectRoot, projectId, value?.page_id),
      "delete-character-page": () => deleteWorkbenchCharacterPage(projectRoot, projectId, value?.page_id),
    };
    if (!operations[action]) throw new ApiError(404, "navigation_action_not_found");
    const result = await mutateFacts(projectId, operations[action]);
    sendOperation(200, result);
    return true;
  }

  const sceneVariantRenameMatch = /^\/api\/projects\/([^/]+)\/workbench\/scene-variant-rename\/?$/.exec(decodedPath);
  if (request.method === "POST" && sceneVariantRenameMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(sceneVariantRenameMatch[1], async ({ projectId }) => {
      const visual = await readFactDraft(projectRoot, { domain: "scene", kind: "visual", projectId, targetId: value?.scene_id });
      const prompt = await readFactDraft(projectRoot, { domain: "scene", kind: "prompt", projectId, targetId: value?.scene_id });
      if (visual.expected_sha256 !== value?.expected_sha256 || prompt.expected_sha256 !== value?.expected_prompt_sha256) throw new ApiError(409, "scene_variant_rename_conflict");
      return renameWorkbenchSceneVariant(projectRoot, projectId, value.scene_id, value.old_id, value.new_id);
    });
    sendOperation(200, result);
    return true;
  }

  const characterVariantRenameMatch = /^\/api\/projects\/([^/]+)\/workbench\/character-variant-rename\/?$/.exec(decodedPath);
  if (request.method === "POST" && characterVariantRenameMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(characterVariantRenameMatch[1], ({ projectId }) => (
      renameWorkbenchCharacterVariant(projectRoot, projectId, value?.character_id, value?.old_id, value?.new_id)
    ));
    sendOperation(200, result);
    return true;
  }

  const summaryMatch = /^\/api\/projects\/([^/]+)\/workbench\/story-summary\/?$/.exec(decodedPath);
  if (request.method === "PUT" && summaryMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(summaryMatch[1], ({ projectId }) => saveStorySummary(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const qwenImportMatch = /^\/api\/projects\/([^/]+)\/workbench\/qwen-import$/.exec(decodedPath);
  if(request.method==='POST'&&qwenImportMatch) {
    const value=await readJsonBody(request);
    sendOperation(200,await mutateTargetFacts(qwenImportMatch[1],({projectId})=>reimportAnimaPrompt(projectRoot,projectId,value)));return true;
  }
  const pagePromptMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-prompt\/?$/.exec(decodedPath);
  if (request.method === "PUT" && pagePromptMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(pagePromptMatch[1], ({ projectId }) => savePagePrompt(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const characterPromptMatch = /^\/api\/projects\/([^/]+)\/workbench\/character-prompt\/?$/.exec(decodedPath);
  if (request.method === "PUT" && characterPromptMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(characterPromptMatch[1], ({ projectId }) => saveCharacterPrompt(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const characterProfileMatch = /^\/api\/projects\/([^/]+)\/workbench\/character-profile\/?$/.exec(decodedPath);
  if (request.method === "PUT" && characterProfileMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(characterProfileMatch[1], ({ projectId }) => saveCharacterProfile(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const characterVisualMatch = /^\/api\/projects\/([^/]+)\/workbench\/character-visual\/?$/.exec(decodedPath);
  if (request.method === "PUT" && characterVisualMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(characterVisualMatch[1], ({ projectId }) => saveCharacterVisual(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const pageContentMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-content\/?$/.exec(decodedPath);
  if (request.method === "PUT" && pageContentMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(pageContentMatch[1], ({ projectId }) => savePageContent(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const pageLetteringMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-lettering\/?$/.exec(decodedPath);
  if (request.method === "PUT" && pageLetteringMatch) {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(pageLetteringMatch[1], ({ projectId }) => savePageLettering(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }

  const pageTextSourcesMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-text-sources\/(page-(?:\d{3}|[a-f0-9]{12}))\/?$/.exec(decodedPath);
  if (pageTextSourcesMatch && request.method === "GET") {
    const result = await readFacts(pageTextSourcesMatch[1], ({ projectId }) => (
      readFactDraft(projectRoot, { domain: "page", kind: "text-sources", projectId, targetId: pageTextSourcesMatch[2] })
    ));
    sendOperation(200, result);
    return true;
  }
  if (pageTextSourcesMatch && request.method === "DELETE") {
    const value = await readJsonBody(request);
    const result = await mutateTargetFacts(pageTextSourcesMatch[1], ({ projectId }) => (
      deletePageTextSource(projectRoot, projectId, { ...value, page_id: pageTextSourcesMatch[2] })
    ));
    sendOperation(200, result);
    return true;
  }

  const textSourceContextMatch = /^\/api\/projects\/([^/]+)\/workbench\/text-source-context\/?$/.exec(decodedPath);
  if (textSourceContextMatch && request.method === "GET") {
    const sourceFile = requestUrl.searchParams.get("source_file");
    const rawOffset = requestUrl.searchParams.get("offset");
    const offset = rawOffset === null ? NaN : Number(rawOffset);
    const result = await readFacts(textSourceContextMatch[1], () => readWritingCorpusContext(projectRoot, sourceFile, offset));
    sendOperation(200, result);
    return true;
  }

  const pageRenderInspectionMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-render-inspection\/?$/.exec(decodedPath);
  if (request.method === "POST" && pageRenderInspectionMatch) {
    const value = await readJsonBody(request);
    const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !value.page_key || keys.some((key) => !new Set(["page_key", "prompt", "prompt_source"]).has(key))) {
      throw new ApiError(400, "invalid_page_render_inspection_request");
    }
    const result = await readFacts(pageRenderInspectionMatch[1], ({ projectDirectory }) => inspectPageRender({
      repositoryRoot: projectRoot,
      projectDirectory,
      pageKey: value.page_key,
      ...(Object.hasOwn(value, "prompt") ? { pagePromptDraft: value.prompt } : {}),
      promptSource: value.prompt_source ?? "original",
      config,
    }));
    sendOperation(200, result, { inspection: result.value });
    return true;
  }

  const pageRewriteMatch = /^\/api\/projects\/([^/]+)\/workbench\/page-rewrite\/?$/.exec(decodedPath);
  if (pageRewriteMatch && request.method === "GET") {
    let pageKey;
    try { pageKey = JSON.parse(requestUrl.searchParams.get("page_key") ?? ""); }
    catch { throw new ApiError(400, "invalid_page_rewrite_request"); }
    if (requestUrl.searchParams.get('progress') === '1') {
      const result = await readFacts(pageRewriteMatch[1], () => ({
        progress: readPageRewriteProgress(projectRoot, pageRewriteMatch[1], pageKey),
      }));
      sendOperation(200, result);
      return true;
    }
    const result = await readFacts(pageRewriteMatch[1], async ({ projectDirectory }) => ({
      ...await readPageRewriteState({ repositoryRoot: projectRoot, projectDirectory, pageKey }),
      progress: readPageRewriteProgress(projectRoot, pageRewriteMatch[1], pageKey),
    }));
    sendOperation(200, result);
    return true;
  }
  if (pageRewriteMatch && request.method === "POST") {
    const value = await readJsonBody(request);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => key !== "page_key") || !value.page_key) {
      throw new ApiError(400, "invalid_page_rewrite_request");
    }
    const settings = config.prompt_rewrite ?? {};
    const systemPromptPath = configuredPath(projectRoot, settings.system_prompt);
    if (!config.comfyui_url || !settings.model || !systemPromptPath) throw new ApiError(422, "prompt_rewrite_not_configured");
    const result = await trackPageRewrite(projectRoot, pageRewriteMatch[1], value.page_key, async onProgress => {
      const before = await readFacts(pageRewriteMatch[1], ({ projectDirectory }) => rewriteSource({
        repositoryRoot: projectRoot, projectDirectory, pageKey: value.page_key,
      }));
      const taskDirectory = path.join(projectRoot, "Saved", "Agent", "page-rewrite", randomUUID());
      await mkdir(taskDirectory, { recursive: true });
      let rewritten;
      try {
        rewritten = await runPromptRewrite({
          positivePrompt: before.value.original_prompt,
          comfyUrl: config.comfyui_url, modelName: settings.model,
          systemPromptPath, taskDirectory, onProgress,
        });
      } catch (error) {
        if (error instanceof PromptRewriteRunnerError) {
          throw new ApiError(502, error.code, [error.code === 'TIMEOUT'
            ? '等待优化超过 3 分钟；ComfyUI 可能仍在执行，请先检查运行状态再重试。'
            : `ComfyUI 优化失败：${error.code}`]);
        }
        throw error;
      }
      onProgress({ phase: 'saving' });
      return mutateTargetFacts(pageRewriteMatch[1], ({ projectDirectory }) => savePageRewriteResult({
        repositoryRoot: projectRoot, projectDirectory, source: before.value, result: rewritten,
      }));
    });
    sendOperation(200, result);
    return true;
  }

  const storyRefreshMatch = /^\/api\/projects\/([^/]+)\/workbench\/story-candidate-refresh\/?$/.exec(decodedPath);
  if (request.method === "POST" && storyRefreshMatch) {
    const value = await readJsonBody(request);
    const projectId = storyRefreshMatch[1];
    const operation = value?.action === "inspect" ? readFacts : mutateDerived;
    const result = await operation(projectId, async ({ projectDirectory, projectId: safeProjectId }) => {
      const context = { projectRoot, projectDirectory, projectId: safeProjectId, config };
      return value?.action === "inspect"
        ? { pages: await inspectStoryCandidates({ ...context, pageKeys: value.page_keys }) }
        : executeStoryCandidateRefresh(context, value, (input) => startRender(projectDirectory, safeProjectId, input));
    });
    sendOperation(200, result, result.value);
    return true;
  }

  const workbenchRenderMatch = /^\/api\/projects\/([^/]+)\/workbench\/render\/?$/.exec(decodedPath);
  if (request.method === "POST" && workbenchRenderMatch) {
    const projectId = workbenchRenderMatch[1];
    const value = await readJsonBody(request);
    if (!value || (value.operation ?? "candidates") !== "candidates") throw new ApiError(400, "invalid_workbench_render_request");
    const result = await mutateDerived(projectId, async ({ projectDirectory, projectId: safeProjectId }) => {
      return startRender(projectDirectory, safeProjectId, value);
    });
    sendOperation(202, result, { task: result.value });
    return true;
  }

  const candidateDetailMatch = /^\/api\/projects\/([^/]+)\/workbench\/candidate-detail\/?$/.exec(decodedPath);
  if (request.method === "POST" && candidateDetailMatch) {
    const value = await readJsonBody(request);
    const result = await mutateDerived(candidateDetailMatch[1], ({ projectId }) => readPageCandidateDetail(projectRoot, projectId, value));
    sendOperation(200, result, { detail: result.value });
    return true;
  }

  const candidateDeleteMatch = /^\/api\/projects\/([^/]+)\/workbench\/candidates\/([^/]+)\/?$/.exec(decodedPath);
  const candidateDeleteCollectionMatch = /^\/api\/projects\/([^/]+)\/workbench\/candidates\/?$/.exec(decodedPath);
  if (request.method === "DELETE" && candidateDeleteCollectionMatch) {
    const value = await readJsonBody(request);
    const result = await mutateDerived(candidateDeleteCollectionMatch[1], ({ projectId }) => deletePageCandidates(projectRoot, projectId, value));
    sendOperation(200, result);
    return true;
  }
  if (request.method === "DELETE" && candidateDeleteMatch) {
    const value = await readJsonBody(request);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !value.page_key) {
      throw new ApiError(400, "invalid_candidate_delete_request");
    }
    const result = await mutateDerived(candidateDeleteMatch[1], ({ projectId }) => deletePageCandidateById(
      projectRoot,
      projectId,
      value.page_key,
      candidateDeleteMatch[2],
    ));
    sendOperation(200, result);
    return true;
  }

  return false;
}
