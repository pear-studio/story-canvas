import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createComfyRuntimeController, queryComfySystemStats, resolveLocalComfyTarget } from "./comfy-runtime.mjs";
import { configuredComfyUiUrls, createComfyEndpointSelector, primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";
import { createHardwareStatusReader } from "./hardware-status.mjs";
import { createHttpRequestHandler } from "./http-app.mjs";
import { configuredPath, loadLocalConfig } from "./http-support.mjs";
import { loraTrainingModule } from "./lora-training-module.mjs";
import { createProjectOperations } from "./project-operations.mjs";
import { createPageMediaReader } from "./page-media.mjs";
import { recoverGenerationTasks } from "./generation-lifecycle.mjs";
import { createGenerationScheduler } from "./generation-scheduler.mjs";
import { getRenderPromptDictionary, getSearchPromptDictionary } from "./prompt-dictionary-service.mjs";
import { claimInstance, instanceAlive, readInstance } from "./workbench-instance.mjs";

const serverFile = fileURLToPath(import.meta.url);
const defaultAppRoot = path.resolve(path.dirname(serverFile), "..");
const defaultProjectRoot = path.resolve(defaultAppRoot, "..");

export async function createStoryCanvasServer({
  projectRoot = defaultProjectRoot,
  appRoot,
  production = false,
  localConfig,
  hardwareStatusReader,
  comfyRuntimeController,
  comfyEndpointSelector,
  comparisonAdapterFactory,
  workbenchRenderLauncher,
  generationQueueDrainOptions = {},
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedAppRoot = path.resolve(appRoot ?? path.join(resolvedProjectRoot, "app"));
  const launcher = await readInstance(resolvedProjectRoot, "launcher");
  if (await instanceAlive(launcher) && process.env.STORYVIS_LAUNCHER_TOKEN !== launcher.token) {
    throw new Error("本仓库已有工作台启动进程，请通过启动脚本替换。");
  }
  const config = localConfig ?? await loadLocalConfig(resolvedAppRoot);
  const instance = await claimInstance(resolvedProjectRoot, "server", { port: Number(process.env.STORYVIS_PORT ?? config.port ?? 3000) });
  try {
    const serverInstanceId = randomUUID();
    const activeComparisonProcesses = new Map();
    const pageMediaReader = createPageMediaReader({ projectRoot: resolvedProjectRoot });
    const projectOperations = createProjectOperations({
      projectRoot: resolvedProjectRoot,
      instanceId: serverInstanceId,
      onExternalChange: ({ projectDirectory }) => {
        console.warn(`[story-canvas] 检测到绕过 Node 写入的项目事实：${projectDirectory}`);
      },
    });
    const mutateDerivedState = (projectId, operation) => projectOperations.mutateDerived(projectId, operation);
    const serverStartedAt = new Date().toISOString();
    const comfyUrls = configuredComfyUiUrls(config);
    const comfyuiRoot = configuredPath(resolvedProjectRoot, config.comfyui_root);
    const comfyCli = configuredPath(resolvedProjectRoot, config.comfy_cli);
    const managedComfyUiUrl = comfyuiRoot && comfyCli
      ? comfyUrls.find((url) => Boolean(resolveLocalComfyTarget(url, comfyuiRoot).target)) ?? null
      : null;
    const selectComfyEndpoint = comfyEndpointSelector ?? createComfyEndpointSelector({
      urls: comfyUrls,
      probe: queryComfySystemStats,
    });
    await selectComfyEndpoint.refresh();
    const readHardwareStatus = hardwareStatusReader ?? createHardwareStatusReader({
      comfyEndpointSelector: selectComfyEndpoint,
      comfyuiRoot,
      managedComfyUiUrl,
    });
    const controlComfyRuntime = comfyRuntimeController
      ?? createComfyRuntimeController({
        projectRoot: resolvedProjectRoot,
        config: managedComfyUiUrl ? { ...config, comfyui_urls: [managedComfyUiUrl] } : config,
      });
    const generationScheduler = createGenerationScheduler({
      repositoryRoot: resolvedProjectRoot,
      config,
      comparisonAdapterFactory,
      getComfyUiUrl: () => selectComfyEndpoint.currentUrl(),
    });

    await loraTrainingModule.runtime.lifecycle.recover(resolvedProjectRoot);
    await recoverGenerationTasks(resolvedProjectRoot, {
      apiUrl: selectComfyEndpoint.currentUrl(),
      drainOptions: generationQueueDrainOptions,
    });
    await generationScheduler.startQueued();

    const distRoot = path.join(resolvedAppRoot, "dist");
    const vite = production
      ? null
      : await import("vite").then(({ createServer: createViteServer }) =>
        createViteServer({ root: resolvedAppRoot, server: { middlewareMode: true }, appType: "spa" }),
      );
    const server = createServer(createHttpRequestHandler({
      shutdownToken: instance.record.token,
      shutdown: async () => {
        generationScheduler.close();
        await loraTrainingModule.runtime.lifecycle.shutdown();
        setImmediate(() => server.close());
      },
      projectRoot: resolvedProjectRoot,
      config,
      serverInstanceId,
      serverStartedAt,
      projectOperations,
      pageMediaReader,
      mutateDerivedState,
      readHardwareStatus,
      comfyEndpointSelector: selectComfyEndpoint,
      controlComfyRuntime,
      activeComparisonProcesses,
      comparisonAdapterFactory,
      generationScheduler,
      workbenchRenderLauncher,
      vite,
      distRoot,
    }));
    server.once("close", () => {
      generationScheduler.close();
      projectOperations.close();
      pageMediaReader.close();
      void loraTrainingModule.runtime.lifecycle.shutdown();
      void instance.release();
    });
    if (vite) server.once("close", () => void vite.close());
    return server;
  } catch (error) {
    await instance.release();
    throw error;
  }
}

async function start() {
  const production = process.argv.includes("--production");
  const config = await loadLocalConfig(defaultAppRoot);
  const port = Number(process.env.STORYVIS_PORT ?? config.port ?? 3000);
  const server = await createStoryCanvasServer({
    projectRoot: defaultProjectRoot,
    production,
    localConfig: config,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close((error) => {
      if (error) console.error("StoryCanvas 关闭失败", error);
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.listen(port, "127.0.0.1", () => {
    console.log(`StoryCanvas ${production ? "production" : "development"} server`);
    console.log(`Local: http://127.0.0.1:${port}/`);
  });
  // 后台预热共享词典缓存，避免首个检查/搜索请求承担构建开销；失败由首个请求重建。
  void (async () => {
    await getRenderPromptDictionary(config, defaultProjectRoot).catch(() => undefined);
    await getSearchPromptDictionary(defaultProjectRoot, config).catch(() => undefined);
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === serverFile) await start();
