import { CandidateStorageError } from "./candidate-storage.mjs";
import { ComfyRuntimeError } from "./comfy-runtime.mjs";
import { LoraResourceError } from "./lora-resources.mjs";
import { PageRenderError } from "./page-render-resolver.mjs";
import { ProjectContractError } from "./project-contracts.mjs";
import {
  ProjectOperationError,
  projectCredentialFromRequest,
} from "./project-operations.mjs";
import { RenderProfileCompilerError } from "./render-profile-compiler.mjs";
import { RenderProfileOverrideError } from "./render-profile-override.mjs";
import { FactError } from "./story-facts.mjs";
import { loraTrainingModule } from "./lora-training-module.mjs";
import { createLoraTrainingOperations } from "./lora-training-operations.mjs";
import { handleLoraTrainingRequest } from "./lora-training-http.mjs";
import { handleComparisonRequest } from "./comparison-http.mjs";
import { handleProjectRequest } from "./project-http.mjs";
import { handleRuntimeRequest } from "./runtime-http.mjs";
import { handleWorkbenchRequest } from "./workbench-http.mjs";
import { handleFinishedRequest } from "./finished-http.mjs";
import { handleAgentRequest } from "./agent-http.mjs";
import { configuredComfyUiUrls } from "./comfy-endpoint-selector.mjs";
import {
  ApiError,
  readJsonBody,
  readLoraAssetRequest,
  readOptionalJsonBody,
  requireProjectDirectory,
  sendJson,
  serveProductionAsset,
} from "./http-support.mjs";

function isPublicApiError(error) {
  return error instanceof ApiError
    || error instanceof ComfyRuntimeError
    || error instanceof ProjectContractError
    || error instanceof CandidateStorageError
    || error instanceof loraTrainingModule.errors.LoraTrainingError
    || error instanceof LoraResourceError
    || error instanceof ProjectOperationError
    || error instanceof RenderProfileOverrideError
    || error instanceof RenderProfileCompilerError
    || error instanceof PageRenderError
    || error instanceof FactError
    || (Number.isInteger(error?.status) && typeof error?.code === "string");
}

export function createHttpRequestHandler({
  shutdownToken,
  shutdown,
  projectRoot,
  config,
  serverInstanceId,
  serverStartedAt,
  projectOperations,
  pageMediaReader,
  mutateDerivedState,
  readHardwareStatus,
  comfyEndpointSelector,
  controlComfyRuntime,
  activeComparisonProcesses,
  comparisonAdapterFactory,
  generationScheduler,
  workbenchRenderLauncher,
  vite,
  distRoot,
}) {
  const trainingOperations = createLoraTrainingOperations(projectRoot);
  return async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && requestUrl.pathname === "/api/workbench/shutdown") {
        if (!shutdownToken || request.headers["x-workbench-token"] !== shutdownToken) throw new ApiError(403, "invalid_workbench_token");
        await shutdown();
        sendJson(response, 200, { stopped: true });
        return;
      }
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(requestUrl.pathname);
      } catch {
        throw new ApiError(400, "invalid_path_encoding");
      }
      const credential = projectCredentialFromRequest(request);
      const selectedComfyUrl = comfyEndpointSelector?.currentUrl?.() ?? "";
      const requestConfig = selectedComfyUrl
        ? { ...config, comfyui_urls: [selectedComfyUrl, ...configuredComfyUiUrls(config).filter((url) => url !== selectedComfyUrl)] }
        : config;
      const mutateFacts = (projectId, operation) => projectOperations.mutateFacts(projectId, credential, operation);
      const mutateTargetFacts = (projectId, operation) => projectOperations.mutateTargetFacts(projectId, operation);
      const deriveFromFacts = (projectId, operation) => projectOperations.deriveFromFacts(projectId, credential, operation);
      const mutateDerived = (projectId, operation) => projectOperations.mutateDerived(projectId, operation);
      const readFacts = (projectId, operation) => projectOperations.readFacts(projectId, operation);
      const copyProjectOperation = (projectId, operation) => projectOperations.copyProject(projectId, credential, operation);
      const renameProjectOperation = (projectId, operation) => projectOperations.renameProject(projectId, credential, operation);
      const sendOperation = (status, result, value = result.value) => {
        sendJson(response, status, value, { revision: result.revision ?? null });
      };
      const shared = {
        request,
        response,
        requestUrl,
        decodedPath,
        projectRoot,
        config: requestConfig,
        readFacts,
        trainingOperations,
        readProjectRevision: (projectId) => projectOperations.state(projectId, { cached: true }),
        mutateFacts,
        mutateTargetFacts,
        deriveFromFacts,
        mutateDerived,
        mutateDerivedState,
        copyProjectOperation,
        renameProjectOperation,
        sendOperation,
      };

      if (await handleAgentRequest(shared)) return;
      if (await handleRuntimeRequest({
        ...shared,
        serverInstanceId,
        serverStartedAt,
        readHardwareStatus,
        comfyEndpointSelector,
        controlComfyRuntime,
        generationScheduler,
      })) return;
      if (await handleComparisonRequest({
        ...shared,
        activeComparisonProcesses,
        comparisonAdapterFactory,
        generationScheduler,
      })) return;
      if (await handleFinishedRequest(shared)) return;
      if (await handleWorkbenchRequest({
        ...shared,
        pageMediaReader,
        workbenchRenderLauncher,
        generationScheduler,
      })) return;
      if (await handleLoraTrainingRequest({
        ...shared,
        trainingOperations,
        resolvedProjectRoot: projectRoot,
        requireProjectDirectory,
        readJsonBody,
        readOptionalJsonBody,
        readLoraAssetRequest,
      })) return;
      if (await handleProjectRequest(shared)) return;

      if (decodedPath.startsWith("/api/")) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (vite) {
        vite.middlewares(request, response, () => {
          if (!response.headersSent) sendJson(response, 404, { error: "not_found" });
        });
        return;
      }
      await serveProductionAsset(response, requestUrl, distRoot);
    } catch (error) {
      if (isPublicApiError(error) && !response.headersSent) {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message,
          details: error.details,
        });
        return;
      }
      console.error("[story-canvas] request failed", error);
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
      else response.end();
    }
  };
}
