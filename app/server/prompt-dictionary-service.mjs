import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { dictionaryStatus } from "./global-resources.mjs";
import { buildPromptDictionary } from "./prompt-dictionary.mjs";

// 词典是全 server 共享的只读参考数据：按源文件指纹（路径+mtime+size）缓存构建结果，
// 每次调用只做 stat 重验证，未命中时单航班重建，所有消费方（渲染审计、检查、搜索）共享。
const slots = new Map();

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileIdentity(target, { label = null } = {}) {
  try {
    const info = await stat(target);
    return `${target}:${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (label) throw new Error(`Prompt 审计词库缺失：${label}（${target}）`);
      return `${target}:missing`;
    }
    throw error;
  }
}

async function cachedBuild(variant, identity, build) {
  const key = identity.join("|");
  const slot = slots.get(variant);
  if (slot && slot.key === key) return slot.promise;
  const promise = build();
  slots.set(variant, { key, promise });
  try {
    return await promise;
  } catch (error) {
    if (slots.get(variant)?.promise === promise) slots.delete(variant);
    throw error;
  }
}

function renderDictionaryFiles(localConfig, root) {
  const configured = localConfig?.prompt_dictionary ?? {};
  const resolveConfigured = (value) => typeof value === "string" && value.trim()
    ? (path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value))
    : null;
  const bundledRoot = path.join(root, "library", "prompt-dictionaries");
  const configuredTagsFile = resolveConfigured(configured.tags_file);
  const configuredTranslationsFile = resolveConfigured(configured.translations_file);
  return {
    tagsFile: configuredTagsFile ?? path.join(bundledRoot, "danbooru.csv"),
    tagsLabel: configuredTagsFile ? "Config/local.json 的 prompt_dictionary.tags_file" : "library/prompt-dictionaries/danbooru.csv",
    translationsFile: configuredTranslationsFile ?? path.join(bundledRoot, "zh.csv"),
    translationsLabel: configuredTranslationsFile ? "Config/local.json 的 prompt_dictionary.translations_file" : "library/prompt-dictionaries/zh.csv",
  };
}

export async function getRenderPromptDictionary(localConfig, root) {
  const files = renderDictionaryFiles(localConfig, root);
  const identity = await Promise.all([
    fileIdentity(files.tagsFile, { label: files.tagsLabel }),
    fileIdentity(files.translationsFile, { label: files.translationsLabel }),
  ]);
  return cachedBuild("render", identity, async () => {
    const [tags, translations] = await Promise.all([
      readFile(files.tagsFile, "utf8"),
      readFile(files.translationsFile, "utf8"),
    ]);
    const entries = buildPromptDictionary(tags, translations);
    if (!entries.length) throw new Error("Prompt 审计词库为空");
    return {
      entries,
      identity: {
        version: 1,
        tags_sha256: sha256Text(tags),
        translations_sha256: sha256Text(translations),
      },
    };
  });
}

export async function getSearchPromptDictionary(projectRoot, config) {
  const status = await dictionaryStatus(projectRoot, config);
  if (!status.available) return { status, entries: [] };
  const bundledRoot = path.join(projectRoot, "library", "prompt-dictionaries");
  const overlayFile = status.source === "bundled_snapshot" ? path.join(bundledRoot, "overlay.json") : null;
  const wikiFile = status.source === "bundled_snapshot" ? path.join(bundledRoot, "wiki.json") : null;
  const identity = await Promise.all([
    fileIdentity(status.tags_file),
    status.translations_file ? fileIdentity(status.translations_file) : "no-translations",
    overlayFile ? fileIdentity(overlayFile) : "no-overlay",
    wikiFile ? fileIdentity(wikiFile) : "no-wiki",
  ]);
  const entries = await cachedBuild("full", identity, async () => {
    const [tags, translations, overlay, wiki] = await Promise.all([
      readFile(status.tags_file, "utf8"),
      status.translations_file ? readFile(status.translations_file, "utf8").catch((error) => { if (error?.code !== "ENOENT") throw error; return ""; }) : "",
      overlayFile ? readFile(overlayFile, "utf8").catch((error) => { if (error?.code !== "ENOENT") throw error; return ""; }) : "",
      wikiFile ? readFile(wikiFile, "utf8").catch((error) => { if (error?.code !== "ENOENT") throw error; return ""; }) : "",
    ]);
    return buildPromptDictionary(tags, translations, overlay, wiki);
  });
  return { status, entries };
}
