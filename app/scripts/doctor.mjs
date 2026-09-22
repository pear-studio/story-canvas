import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLoraTrainingEnvironment, readUpscaleModelStatus } from "../server/lora-training.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");
const checks = [];

function add(name, ok, detail, required = false) {
  checks.push({ name, ok, detail, required });
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function isFile(target) {
  try { return (await stat(target)).isFile(); } catch { return false; }
}

function configuredPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

const [major, minor] = process.versions.node.split(".").map(Number);
add("Node.js", major > 22 || (major === 22 && minor >= 13), process.versions.node, true);
add("工作区", await exists(path.join(projectRoot, "workspace")), "workspace", true);
add("运行日志", await exists(path.join(projectRoot, "Saved", "logs")), "Saved/logs", true);
add("运行状态", await exists(path.join(projectRoot, "Saved", "state")), "Saved/state", true);

let config = null;
try {
  config = JSON.parse(await readFile(path.join(appRoot, "..", "Config", "local.json"), "utf8"));
  add("本地配置", true, `port ${config.port ?? 3000}`, true);
} catch (error) {
  add("本地配置", false, error?.code === "ENOENT" ? "请运行 npm --prefix app run setup" : "JSON 无效", true);
}

if (config) {
  for (const [name, key, required = false] of [["comfy-cli 可执行文件", "comfy_cli", true], ["ComfyUI workspace", "comfyui_root"], ["模型目录", "models_root"]]) {
    const target = configuredPath(config[key]);
    const available = Boolean(target && await exists(target) && (key !== "comfy_cli" || await isFile(target)));
    add(name, available, target ?? `${key} 未配置`, required);
  }
  const dictionaryConfig = config.prompt_dictionary ?? {};
  const bundledDictionaryRoot = path.join(projectRoot, "library", "prompt-dictionaries");
  const configuredDictionaryFile = configuredPath(dictionaryConfig.tags_file);
  const configuredTranslationsFile = configuredPath(dictionaryConfig.translations_file);
  const dictionaryFile = configuredDictionaryFile ?? path.join(bundledDictionaryRoot, "danbooru.csv");
  const translationsFile = configuredTranslationsFile ?? path.join(bundledDictionaryRoot, "zh.csv");
  const dictionaryFilesAvailable = await Promise.all([exists(dictionaryFile), exists(translationsFile)]);
  add(
    "Prompt 词库",
    dictionaryFilesAvailable.every(Boolean),
    `${configuredDictionaryFile ? "本机覆盖" : "仓库固定快照"}：${dictionaryFile}；${translationsFile}`,
  );
  try {
    const environment = await readLoraTrainingEnvironment(projectRoot, config);
    add("LoRA 训练环境", environment.available, environment.available ? `${environment.runtime.gpu}，DiffSynth ${environment.commit.slice(0, 8)}` : environment.checks.filter((check) => !check.ok).map((check) => check.message).join("；"));
    const upscaler = environment.optional_capabilities?.upscaler ?? await readUpscaleModelStatus(projectRoot, config);
    add("图片超分模型（可选）", upscaler.ready, upscaler.message);
  } catch (error) {
    add("LoRA 训练环境", false, error.message);
  }
}

const profileDirectory = path.join(projectRoot, "library", "render-profiles");
for (const entry of (await readdir(profileDirectory, { withFileTypes: true })).filter((item) => item.isFile() && item.name.endsWith(".json"))) {
  try {
    const profile = JSON.parse(await readFile(path.join(profileDirectory, entry.name), "utf8"));
    const models = Object.values(profile.models ?? {});
    const invalidModels = models.filter((model) => typeof model.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(model.sha256));
    add(`生成配置 ${profile.id ?? entry.name}`, Boolean(profile.id && profile.prompt && models.length && invalidModels.length === 0), invalidModels.length ? "存在缺少 SHA-256 的模型" : `${models.length} 个模型身份`, true);
  } catch {
    add(`生成配置 ${entry.name}`, false, "JSON 无效", true);
  }
}

if (config?.models_root) {
  const root = configuredPath(config.models_root);
  if (root && await exists(root)) {
    const info = await stat(root);
    add("模型目录类型", info.isDirectory(), root);
  }
}

for (const check of checks) console.log(`${check.ok ? "PASS" : check.required ? "FAIL" : "WARN"}  ${check.name}: ${check.detail}`);
if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
