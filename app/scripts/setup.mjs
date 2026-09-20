import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");

for (const directory of ["Config", "workspace", "Saved/logs", "Saved/state", "app/data.local/lora-training", "app/data.local/lora-resources"]) {
  await mkdir(path.join(projectRoot, directory), { recursive: true });
}

const localConfig = path.join(appRoot, "..", "Config", "local.json");
try {
  const current = JSON.parse(await readFile(localConfig, "utf8"));
  const defaults = JSON.parse(await readFile(path.join(appRoot, "config.local.example.json"), "utf8"));
  const migrated = {
    ...defaults,
    ...current,
    prompt_dictionary: {
      ...defaults.prompt_dictionary,
      ...current.prompt_dictionary,
    },
    lora_training: {
      ...defaults.lora_training,
      ...current.lora_training,
    },
  };
  delete migrated.comfyui_link;
  delete migrated.models_link;
  if (JSON.stringify(migrated) !== JSON.stringify(current)) {
    await writeFile(localConfig, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    console.log("已补齐本机配置默认键并清理旧版目录链接配置；请确认新增项。");
  }
} catch (error) {
  if (!error || error.code !== "ENOENT") throw error;
  await copyFile(path.join(appRoot, "config.local.example.json"), localConfig);
}

console.log("StoryCanvas 本地目录已就绪。");
console.log("下一步：在 Config/local.json 填写 comfy_cli、comfyui_root（comfy-cli workspace）与模型目录；网络受限设备可选填 comfy_install_source；需要时显式调用 comfy-cli 安装或更新，再启动工作台。");
console.log("图片超分模型为可选能力：由 Agent 按 library/lora-training/upscalers/real-esrgan-x4plus-anime-6b.json 提前检查和处理，setup 不自动下载。");
