#!/usr/bin/env node

// 从 Civitai 拉取模型资源的安全级示例图，写入 app/public/resource-previews/。
// 规范见 library/resources/README.md。

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "..", "..");
const catalogFile = path.join(repoRoot, "library", "resources", "catalog.json");
const previewsDir = path.join(repoRoot, "app", "public", "resource-previews");
const apiBase = "https://civitai.com/api/v1";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log(`用法：
  node scripts/fetch-resource-preview.mjs --resource <id> --civitai-model <id> [选项]
  node scripts/fetch-resource-preview.mjs --check [--prune]

拉取选项：
  --version <vid>     Civitai 模型版本 ID；缺省使用该模型的最新版本
  --count <n>         下载张数，默认 3（只取 nsfw=None 的安全级图）
  --width <px>        预览图宽度，默认 768（由 Civitai CDN 缩放，无需本地依赖）
  --write-catalog     把 preview.images 写回 library/resources/catalog.json；
                      缺省只下载图片并打印可粘贴的 preview 块
  --proxy <url>       通过 HTTP 代理访问 Civitai，例如 http://127.0.0.1:10808
                      （依赖 Node.js 的 NODE_USE_ENV_PROXY，需要 Node >= 24.5）

检查选项：
  --check             校验资源目录引用的预览图存在、命名合规，并列出孤儿图
  --prune             配合 --check 使用，删除孤儿图

API key 从 Config/local.json 的 civitai_api_key 读取，不会回显。`);
}

// 通过子进程重入，让全局 fetch 走 NODE_USE_ENV_PROXY 代理。
function reexecWithProxy(proxy) {
  const child = spawn(process.execPath, [scriptFile, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      SV_PREVIEW_REEXEC: "1",
    },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

async function readConfigKey() {
  try {
    const config = JSON.parse(await readFile(path.join(repoRoot, "Config", "local.json"), "utf8"));
    return config.civitai_api_key || null;
  } catch {
    return null;
  }
}

async function civitaiGet(url, apiKey) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Civitai 请求失败 ${response.status}：${url}`);
  return response.json();
}

async function resolveVersionId(modelId, versionArg, apiKey) {
  if (versionArg) return { id: versionArg, name: null };
  const model = await civitaiGet(`${apiBase}/models/${modelId}`, apiKey);
  const latest = model.modelVersions?.[0];
  if (!latest) throw new Error(`模型 ${modelId} 没有可用版本`);
  return { id: String(latest.id), name: latest.name };
}

async function fetchImages({ resourceId, modelId, versionId, count, width, apiKey }) {
  const query = `${apiBase}/images?modelVersionId=${versionId}&nsfw=None&sort=Most%20Reactions&limit=${count * 4}`;
  const data = await civitaiGet(query, apiKey);
  const items = (data.items ?? []).slice(0, count);
  if (!items.length) throw new Error(`版本 ${versionId} 没有安全级（nsfw=None）示例图`);
  await mkdir(previewsDir, { recursive: true });
  const images = [];
  for (const [index, item] of items.entries()) {
    const n = index + 1;
    const filename = `${resourceId}-${n}.jpg`;
    const downloadUrl = item.url.replace("original=true", `width=${width}`);
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(downloadUrl, { headers, redirect: "follow" });
    if (!response.ok) throw new Error(`下载失败 ${response.status}：图片 ${item.id}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) throw new Error(`图片 ${item.id} 内容异常（${buffer.length} 字节）`);
    await writeFile(path.join(previewsDir, filename), buffer);
    console.log(`已下载 ${filename}（${Math.round(buffer.length / 1024)} KB，来源图片 ${item.id}）`);
    images.push({
      src: `/resource-previews/${filename}`,
      alt: null, // 由调用方补名称
      source: `https://civitai.com/images/${item.id}`,
      _n: n,
    });
  }
  return images;
}

async function readCatalog() {
  return JSON.parse(await readFile(catalogFile, "utf8"));
}

async function runFetch() {
  const resourceId = argumentValue("--resource");
  const modelId = argumentValue("--civitai-model");
  if (!resourceId || !modelId) {
    console.error("缺少 --resource 或 --civitai-model");
    printHelp();
    process.exit(1);
  }
  const count = Number(argumentValue("--count") ?? 3);
  const width = Number(argumentValue("--width") ?? 768);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    console.error("--count 必须是 1~10 的整数");
    process.exit(1);
  }
  const apiKey = await readConfigKey();
  if (!apiKey) console.warn("警告：未读到 civitai_api_key，受限内容可能无法访问");

  const version = await resolveVersionId(modelId, argumentValue("--version"), apiKey);
  console.log(`模型 ${modelId} 版本 ${version.id}${version.name ? `（${version.name}）` : ""}，取安全级示例图 ${count} 张`);

  const catalog = await readCatalog();
  const resource = catalog.models?.find((item) => item.id === resourceId);
  if (!resource) {
    console.error(`无法写入：资源目录中不存在 ${resourceId}`);
    process.exit(1);
  }
  const images = await fetchImages({ resourceId, modelId, versionId: version.id, count, width, apiKey });
  const preview = {
    images: images.map((image) => ({
      src: image.src,
      alt: `${resource.name} 示例图 ${image._n}`,
      source: image.source,
    })),
  };

  if (hasFlag("--write-catalog")) {
    resource.preview = preview;
    await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    console.log(`已写回资源 ${resourceId} 的 preview.images（${preview.images.length} 张）`);
  } else {
    console.log("\n未写回资源目录（缺 --write-catalog）。可粘贴的 preview 块：");
    console.log(JSON.stringify({ preview }, null, 2));
  }
}

function referencedPreviewFiles(resource) {
  const files = [];
  for (const image of resource?.preview?.images ?? []) {
    if (typeof image?.src === "string") files.push(image.src);
  }
  return files
    .map((src) => (/^\/resource-previews\/([a-z0-9-]+\.(jpg|jpeg|png|webp))$/.exec(src)?.[1] ?? null))
    .filter(Boolean);
}

async function runCheck() {
  const catalog = await readCatalog();
  const referenced = new Map();
  const errors = [];
  for (const resource of catalog.models ?? []) {
    const files = referencedPreviewFiles(resource);
    for (const filename of files) {
      if (!filename.startsWith(`${resource.id}-`) && filename !== `${resource.id}.jpg` && filename !== `${resource.id}.png`) {
        errors.push(`${resource.id} 的预览图 ${filename} 不符合 <resource-id>-<n> 命名规范`);
      }
      try {
        await readFile(path.join(previewsDir, filename));
        referenced.set(filename, resource.id);
      } catch {
        errors.push(`${resource.id} 引用的预览图缺失：${filename}`);
      }
    }
  }
  let orphans = [];
  try {
    const onDisk = await readdir(previewsDir);
    orphans = onDisk.filter((file) => !referenced.has(file));
  } catch {
    // 预览目录不存在时全部算缺失，上面已报告
  }
  for (const orphan of orphans) {
    console.log(`孤儿图：${orphan}`);
    if (hasFlag("--prune")) {
      await rm(path.join(previewsDir, orphan));
      console.log(`已删除 ${orphan}`);
    }
  }
  for (const error of errors) console.error(error);
  const ok = errors.length === 0 && (orphans.length === 0 || hasFlag("--prune"));
  console.log(ok ? "预览图检查通过" : "预览图检查未通过");
  process.exit(ok ? 0 : 1);
}

const proxy = argumentValue("--proxy");
if (proxy && process.env.SV_PREVIEW_REEXEC !== "1") {
  reexecWithProxy(proxy);
} else if (hasFlag("--help") || hasFlag("-h")) {
  printHelp();
} else if (hasFlag("--check")) {
  runCheck().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  runFetch().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
