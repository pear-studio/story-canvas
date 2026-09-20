import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { resolveComfyUiUrls } from "./comfy-endpoint-selector.mjs";
import { ensureMediaVariant } from "./media-variants.mjs";
import { ProjectContractError, requireProjectDirectoryName } from "./project-contracts.mjs";
import { PROJECT_REVISION_HEADER } from "./project-operations.mjs";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const mediaDirectories = new Set(["Outputs", "materials"]);
const imageTypes = new Map([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export class ApiError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(response, status, value, { revision = null } = {}) {
  if (revision) response.setHeader(PROJECT_REVISION_HEADER, revision);
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function sendBuffer(response, buffer, { contentType, etag = null, headers = {} } = {}) {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...(etag ? { etag } : {}),
    ...headers,
  });
  response.end(buffer);
}

export function sendFile(response, media, { headers = {} } = {}) {
  response.writeHead(200, {
    "content-type": media.contentType,
    "content-length": media.info.size,
    "cache-control": "no-store",
    ...headers,
  });
  createReadStream(media.target).pipe(response);
}

export function imageContentType(target) {
  return imageTypes.get(path.extname(target).toLowerCase()) ?? "application/octet-stream";
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function requireProjectId(value) {
  try {
    return requireProjectDirectoryName(value);
  } catch (error) {
    if (error instanceof ProjectContractError) {
      throw new ApiError(error.status, error.code, error.details);
    }
    throw error;
  }
}

export async function requireProjectDirectory(projectRoot, projectId) {
  const safeProjectId = requireProjectId(projectId);
  const projectDirectory = registeredProjectPath(projectRoot, safeProjectId);
  try {
    const info = await lstat(projectDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ApiError(404, "project_not_found");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.code === "ENOENT") throw new ApiError(404, "project_not_found");
    throw error;
  }
  return { safeProjectId, projectDirectory };
}

export async function readJsonFile(target, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonFile(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

export function configuredPath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

export async function loadLocalConfig(appRoot) {
  const defaults = { port: 3000, comfyui_urls: [], comfy_cli: "" };
  const sharedUrls = JSON.parse(await readFile(path.join(appRoot, "comfyui-endpoints.json"), "utf8"));
  try {
    const local = JSON.parse(await readFile(path.join(appRoot, "..", "Config", "local.json"), "utf8"));
    return {
      ...defaults,
      ...local,
      comfyui_urls: resolveComfyUiUrls({
        sharedUrls,
        localUrls: local.comfyui_urls,
        hostName: hostname(),
      }),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ...defaults, comfyui_urls: resolveComfyUiUrls({ sharedUrls, hostName: hostname() }) };
    }
    throw error;
  }
}

async function resolveProjectMedia(projectDirectory, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) {
    throw new ApiError(400, "invalid_media_path");
  }
  const parts = relativePath.replaceAll("\\", "/").split("/");
  const mediaDirectory = parts[0];
  if (!mediaDirectories.has(mediaDirectory) || parts.some((part) => !part)) {
    throw new ApiError(400, "invalid_media_path");
  }
  const mediaRoot = path.resolve(projectDirectory, mediaDirectory);
  const target = path.resolve(projectDirectory, ...parts);
  const extension = path.extname(target).toLowerCase();
  if (!isWithin(mediaRoot, target) || !imageTypes.has(extension)) {
    throw new ApiError(400, "invalid_media_path");
  }
  try {
    const [projectReal, rootInfo, resolvedRoot] = await Promise.all([
      realpath(projectDirectory),
      lstat(mediaRoot),
      realpath(mediaRoot),
    ]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !isWithin(projectReal, resolvedRoot)) {
      throw new ApiError(400, "invalid_media_path");
    }
    let cursor = path.resolve(projectDirectory);
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new ApiError(400, "invalid_media_path");
      if (index < parts.length - 1 && !info.isDirectory()) throw new ApiError(400, "invalid_media_path");
      if (index === parts.length - 1 && !info.isFile()) throw new ApiError(404, "media_not_found");
    }
    const resolvedTarget = await realpath(target);
    if (!isWithin(resolvedRoot, resolvedTarget)) throw new ApiError(400, "invalid_media_path");
    const info = await stat(resolvedTarget);
    return { target: resolvedTarget, info, contentType: imageTypes.get(extension) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.code === "ENOENT") throw new ApiError(404, "media_not_found");
    throw error;
  }
}

export async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(request, maxBytes = 2 * 1024 * 1024) {
  try {
    return JSON.parse((await readRequestBody(request, maxBytes)).toString("utf8"));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json");
  }
}

export async function readOptionalJsonBody(request, maxBytes = 2 * 1024 * 1024) {
  try {
    const body = (await readRequestBody(request, maxBytes)).toString("utf8").trim();
    return body ? JSON.parse(body) : {};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json");
  }
}

export async function readLoraAssetRequest(request) {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new ApiError(415, "unsupported_media_type");
  }
  const body = await readRequestBody(request, 512 * 1024 * 1024);
  let form;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ApiError(400, "invalid_multipart_form");
  }
  const files = [];
  const sharedSource = String(form.get("source") ?? "");
  const sharedAssetId = String(form.get("asset_id") ?? "");
  for (const entry of form.getAll("files")) {
    if (!entry || typeof entry === "string") continue;
    files.push({
      filename: entry.name,
      buffer: Buffer.from(await entry.arrayBuffer()),
      caption: String(form.get(`caption:${entry.name}`) ?? ""),
      source: String(form.get(`source:${entry.name}`) ?? sharedSource),
      asset_id: String(form.get(`asset_id:${entry.name}`) ?? sharedAssetId),
    });
  }
  return { group_id: String(form.get("group_id") ?? ""), asset_id: sharedAssetId, files };
}

export async function serveProjectMedia(response, projectRoot, projectId, relativePath, { variantWidth = null } = {}) {
  const { projectDirectory } = await requireProjectDirectory(projectRoot, projectId);
  let media = await resolveProjectMedia(projectDirectory, relativePath);
  if (variantWidth && /^Outputs\/(?:story|characters|finished|comparisons)\//.test(relativePath)) {
    try {
      media = await ensureMediaVariant(projectDirectory, media, relativePath, variantWidth);
    } catch {
      // 变体生成失败时回退原图
    }
  }
  sendFile(response, media, { headers: { "x-content-type-options": "nosniff", ...(/^Outputs\/(?:story|characters|finished|comparisons)\//.test(relativePath) ? { "cache-control": "private, max-age=31536000, immutable" } : {}) } });
}

export async function serveProductionAsset(response, requestUrl, distRoot) {
  const requestedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  let target = path.resolve(distRoot, relativePath);
  if (!isWithin(distRoot, target)) throw new ApiError(400, "invalid_path");
  let fallback = false;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error("not_file"), { code: "ENOENT" });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    target = path.join(distRoot, "index.html");
    fallback = true;
  }
  const info = await stat(target);
  // assets/ 是构建哈希文件名,fonts/ 是手动版本化的内置 webfont,都可长缓存;SPA 回退不缓存。
  const cacheControl = fallback ? null
    : relativePath.startsWith("assets/") ? "private, max-age=31536000, immutable"
    : relativePath.startsWith("fonts/") ? "private, max-age=2592000"
    : null;
  response.writeHead(200, {
    "content-type": contentTypes.get(path.extname(target).toLowerCase()) ?? "application/octet-stream",
    "content-length": info.size,
    ...(cacheControl ? { "cache-control": cacheControl } : {}),
  });
  createReadStream(target).pipe(response);
}
