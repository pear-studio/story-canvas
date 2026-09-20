import path from "node:path";
import { fileURLToPath } from "node:url";

import { configuredComfyUiUrls } from "../server/comfy-endpoint-selector.mjs";
import { createComfyRuntimeController, resolveLocalComfyTarget } from "../server/comfy-runtime.mjs";
import { loadLocalConfig } from "../server/http-support.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");

const config = await loadLocalConfig(appRoot);
const localUrl = configuredComfyUiUrls(config).find((url) => resolveLocalComfyTarget(url, config.comfyui_root).target);
if (!localUrl) throw new Error("当前设备没有配置本机 ComfyUI 地址");

const command = process.argv[2];
if (command === "target") {
  const { target } = resolveLocalComfyTarget(localUrl, config.comfyui_root);
  process.stdout.write(`tcp://127.0.0.1:${target.port}\n`);
} else if (command === "start") {
  const result = await createComfyRuntimeController({
    projectRoot,
    config: { ...config, comfyui_urls: [localUrl] },
  }).start();
  console.log(result.already_running ? `ComfyUI already running: ${localUrl}` : `ComfyUI started: ${localUrl}`);
} else {
  throw new Error("只支持 start 或 target");
}
