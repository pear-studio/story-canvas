import path from "node:path";
import { diagnoseModelFile, diagnoseResolvedLoras } from "./render-profile-diagnostics.mjs";
import { configuredComfyUiUrls } from "./comfy-endpoint-selector.mjs";
import { checkDepthNodes } from "./two-step-generation.mjs";
import { randomUUID } from "node:crypto";
import { writeFile, rename, unlink } from "node:fs/promises";
import { isCompletePng, resolveProjectMediaTarget } from "./render-media.mjs";
import { resolveLocalComfyTarget } from "./comfy-runtime.mjs";

export function depthComfyUiUrls(localConfig) {
  return configuredComfyUiUrls(localConfig).filter(url => resolveLocalComfyTarget(url, null).reason !== "remote_instance");
}

export async function assertDepthDependencies(config, repositoryRoot, localConfig, apiUrl = depthComfyUiUrls(localConfig)[0]) {
  if (!apiUrl) throw new Error("两步生成需要已配置的本机 ComfyUI 地址");
  if (resolveLocalComfyTarget(apiUrl, null).reason === "remote_instance") throw new Error("两步生成实验目前仅支持本机 ComfyUI，需本机验证深度模型以避免生成时自动下载");
  localConfig = { ...localConfig, comfyui_urls: [apiUrl] };
  if (!localConfig.comfyui_root || !localConfig.models_root) throw new Error("两步生成需要配置本机 ComfyUI 与模型目录");
  const depthRoot = path.resolve(repositoryRoot, localConfig.comfyui_root, "custom_nodes/comfyui_controlnet_aux/ckpts");
  const [base, control, depth, loras] = await Promise.all([
    diagnoseModelFile({ projectRoot: repositoryRoot, config: localConfig, relativePath: config.base_model.relative_path, sha256: config.recipe.base_sha256 }),
    diagnoseModelFile({ projectRoot: repositoryRoot, config: localConfig, relativePath: `controlnet/${config.recipe.controlnet}`, sha256: config.recipe.controlnet_sha256 }),
    diagnoseModelFile({ projectRoot: repositoryRoot, config: { ...localConfig, models_root: depthRoot }, relativePath: `depth-anything/Depth-Anything-V2-Small/${config.recipe.preprocessor}`, sha256: config.recipe.preprocessor_sha256 }),
    diagnoseResolvedLoras(config.loras, repositoryRoot, localConfig),
  ]);
  const missing = [
    ...(base.status !== "available" ? [`Anima Base v1.0（${base.reason}）`] : []),
    ...(control.status !== "available" ? [`${config.recipe.controlnet}（${control.reason}）`] : []),
    ...(depth.status !== "available" ? [`${config.recipe.preprocessor}（${depth.reason}）`] : []),
    ...loras.filter(lora => lora.status !== "available").map(lora => `${lora.filename}（${lora.reason}）`),
  ];
  if (missing.length) throw new Error(`两步生成缺少依赖或权重不匹配：${missing.join("、")}`);
  if (!apiUrl) throw new Error("两步生成需要可用的 ComfyUI 地址");
  await checkDepthNodes(apiUrl, config);
}

export async function saveDepthIntermediates(projectDirectory, outputs, history, download) {
  // ComfyUI 将可执行的 SaveImage 优先执行；错误 history 也可能已有草稿/深度输出。
  for (const output of outputs ?? []) {
    const image = history?.outputs?.[output.node_id]?.images?.[output.image_index];
    if (!image) continue;
    const bytes = await download(image);
    if (!isCompletePng(bytes)) throw new Error(`中间结果 PNG 不完整：${output.kind}`);
    const { target } = await resolveProjectMediaTarget(projectDirectory, output.file, { createParent: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes); await rename(temporary, target); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}
