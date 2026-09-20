import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isSafeLoraFilename,
  validateLoraDefinition,
  validateStyleLoras,
} from "./lora-config.mjs";
import { resolveLocalComfyTarget } from "./comfy-runtime.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serverRoot, "..", "..");
const defaultStateRoot = path.join(repositoryRoot, "Saved", "state");
const modelHashCache = new Map();
const hashCacheDiskEntries = new Map();
let hashCacheLoadPromise = null;
let hashCacheWriteChain = Promise.resolve();

function configuredPath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function modelHashCacheFile() {
  return process.env.STORYVISUALIZER_HASH_CACHE_FILE ?? path.join(defaultStateRoot, "model-hash-cache.json");
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

function loadModelHashCache() {
  if (hashCacheLoadPromise) return hashCacheLoadPromise;
  hashCacheLoadPromise = (async () => {
    let value = null;
    try {
      value = JSON.parse(await readFile(modelHashCacheFile(), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      return;
    }
    if (value?.version !== 1 || !value.entries || typeof value.entries !== "object") return;
    for (const [target, entry] of Object.entries(value.entries)) {
      if (!entry || typeof entry.sha256 !== "string" || !Number.isInteger(entry.size) || !Number.isInteger(entry.mtime_ms) || !Number.isInteger(entry.ctime_ms)) continue;
      hashCacheDiskEntries.set(target, { size: entry.size, mtime_ms: entry.mtime_ms, ctime_ms: entry.ctime_ms, sha256: entry.sha256 });
      const key = `${target}:${entry.size}:${entry.mtime_ms}:${entry.ctime_ms}`;
      if (!modelHashCache.has(key)) modelHashCache.set(key, Promise.resolve(entry.sha256));
    }
  })().catch((error) => {
    hashCacheLoadPromise = null;
    throw error;
  });
  return hashCacheLoadPromise;
}

function scheduleModelHashCacheWrite() {
  hashCacheWriteChain = hashCacheWriteChain
    .then(() => writeJsonAtomic(modelHashCacheFile(), { version: 1, entries: Object.fromEntries(hashCacheDiskEntries) }))
    .catch(() => undefined);
  return hashCacheWriteChain;
}

async function sha256File(target, info) {
  const mtimeMs = Math.round(info.mtimeMs);
  const ctimeMs = Math.round(info.ctimeMs);
  const cacheKey = modelHashCacheKey(target, info);
  if (modelHashCache.has(cacheKey)) return modelHashCache.get(cacheKey);
  await loadModelHashCache();
  if (modelHashCache.has(cacheKey)) return modelHashCache.get(cacheKey);
  const promise = new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
  modelHashCache.set(cacheKey, promise);
  try {
    const sha256 = await promise;
    hashCacheDiskEntries.set(target, { size: info.size, mtime_ms: mtimeMs, ctime_ms: ctimeMs, sha256 });
    await scheduleModelHashCacheWrite();
    return sha256;
  } catch (error) {
    modelHashCache.delete(cacheKey);
    throw error;
  }
}

function modelHashCacheKey(target, info) {
  return `${target}:${info.size}:${Math.round(info.mtimeMs)}:${Math.round(info.ctimeMs)}`;
}

async function cachedSha256File(target, info) {
  const cacheKey = modelHashCacheKey(target, info);
  if (modelHashCache.has(cacheKey)) return modelHashCache.get(cacheKey);
  await loadModelHashCache();
  return modelHashCache.has(cacheKey) ? modelHashCache.get(cacheKey) : null;
}

export async function diagnoseModelFile({ projectRoot, config, relativePath, sha256, shaPolicy = "strict" }) {
  const remoteComfy = resolveLocalComfyTarget(primaryComfyUiUrl(config), null).reason === "remote_instance";
  const modelsRoot = remoteComfy ? null : configuredPath(projectRoot, config.models_root);
  if (remoteComfy) {
    return {
      modelsRoot: null,
      status: "available",
      reason: "remote_unverified",
      actualSha256: null,
      integrityStatus: "unverified",
    };
  }
  const target = modelsRoot && typeof relativePath === "string"
    ? path.resolve(modelsRoot, ...relativePath.split("/"))
    : null;
  let status = "missing";
  let actualSha256 = null;
  let integrityStatus = "unavailable";
  let reason = modelsRoot ? "file_missing" : "models_root_not_configured";
  if (target && isWithin(modelsRoot, target)) {
    try {
      const info = await stat(target);
      if (info.isFile()) {
        actualSha256 = shaPolicy === "advisory" ? await cachedSha256File(target, info) : await sha256File(target, info);
        if (actualSha256 === null) {
          integrityStatus = "unverified";
          status = "available";
          reason = null;
        } else {
          integrityStatus = actualSha256 === sha256 ? "verified" : "mismatch";
          status = actualSha256 === sha256 || shaPolicy === "advisory" ? "available" : "hash_mismatch";
          reason = actualSha256 === sha256 ? null : "sha256_mismatch";
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { modelsRoot, status, reason, actualSha256, integrityStatus };
}

async function diagnoseLoraDefinition(lora, projectRoot, config, metadata = {}) {
  const validation = validateLoraDefinition(lora, metadata.path ?? "lora");
  const relativePath = isSafeLoraFilename(lora?.filename) ? `loras/${lora.filename}` : null;
  if (validation.length || !relativePath) {
    return {
      ...metadata,
      filename: typeof lora?.filename === "string" ? lora.filename : "",
      relative_path: relativePath,
      sha256: typeof lora?.sha256 === "string" ? lora.sha256 : "",
      weight: typeof lora?.weight === "number" ? lora.weight : null,
      trigger: typeof lora?.trigger === "string" ? lora.trigger : null,
      status: "invalid",
      reason: "invalid_config",
      actual_sha256: null,
      errors: validation,
    };
  }
  const diagnosis = await diagnoseModelFile({ projectRoot, config, relativePath, sha256: lora.sha256 });
  return {
    ...metadata,
    filename: lora.filename,
    relative_path: relativePath,
    sha256: lora.sha256,
    weight: lora.weight,
    trigger: lora.trigger ?? null,
    status: diagnosis.status,
    reason: diagnosis.reason,
    actual_sha256: diagnosis.actualSha256,
    errors: [],
  };
}

export async function diagnoseResolvedLoras(loras, projectRoot, config) {
  return Promise.all((loras ?? []).map((lora, index) => diagnoseLoraDefinition({
    filename: lora.filename,
    sha256: lora.sha256,
    weight: lora.weight,
    ...(lora.trigger ? { trigger: lora.trigger } : {}),
  }, projectRoot, config, {
    kind: lora.kind,
    owner: lora.owner,
    path: `loras[${index}]`,
  })));
}

function renderProfilePreview(profile, resourceCatalog) {
  const primaryModel = profile.models?.dit ?? null;
  if (!primaryModel) return null;
  const resource = (resourceCatalog?.models ?? []).find((model) => model.relative_path === primaryModel.relative_path && model.sha256 === primaryModel.sha256);
  return resource?.preview ?? null;
}

function routeCapabilities(profile) {
  const routes = [];
  for (const [operation, operationValue] of Object.entries(profile.operations ?? {})) {
    for (const [inputSource, route] of Object.entries(operationValue.routes ?? {})) {
      routes.push({ operation, input_source: inputSource, workflow_id: route.workflow, recipe_source_id: route.recipe_source_id });
    }
  }
  return {
    operations: [...new Set(routes.map((route) => route.operation))],
    routes,
  };
}

export async function diagnoseRenderProfile(profile, projectRoot, config, resourceCatalog = null, { modelShaPolicy = "strict" } = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)
    || !profile.models || Array.isArray(profile.models)
    || !profile.style_loras || Array.isArray(profile.style_loras)
    || !profile.operations || Array.isArray(profile.operations)) {
    throw new Error("render profile diagnosis 只接受 compiler resolved_profile");
  }
  const remoteComfy = resolveLocalComfyTarget(primaryComfyUiUrl(config), null).reason === "remote_instance";
  const modelsRoot = remoteComfy ? null : configuredPath(projectRoot, config.models_root);
  const models = {};
  for (const [role, model] of Object.entries(profile.models)) {
    const diagnosis = await diagnoseModelFile({ projectRoot, config, relativePath: model.relative_path, sha256: model.sha256, shaPolicy: modelShaPolicy });
    models[role] = {
      id: role,
      role,
      kind: role,
      filename: model.filename,
      relative_path: model.relative_path,
      sha256: model.sha256,
      source: model.source ?? null,
      status: diagnosis.status,
      reason: diagnosis.reason,
      actual_sha256: diagnosis.actualSha256,
      integrity_status: diagnosis.integrityStatus,
    };
  }
  const styleLoras = Object.fromEntries(await Promise.all(Object.entries(profile.style_loras).map(async ([id, lora]) => [id, await diagnoseLoraDefinition(lora, projectRoot, config, {
    id,
    kind: "style",
    owner: profile.id,
    path: `${profile.id}.style_loras.${id}`,
  })])));
  const loraErrors = validateStyleLoras(profile);
  const routeCapabilitiesProjection = routeCapabilities(profile);
  return {
    id: profile.id,
    diagnosis_loaded: true,
    name: profile.name,
    description: profile.description ?? "",
    tags: Array.isArray(profile.tags) ? profile.tags : [],
    preview: renderProfilePreview(profile, resourceCatalog),
    architecture_family: profile.architecture_family,
    route_capabilities: routeCapabilitiesProjection,
    prompt_family: profile.prompt?.family ?? null,
    available: Object.values(models).every((model) => model.status === "available")
      && Object.values(styleLoras).every((lora) => lora.status === "available")
      && loraErrors.length === 0,
    models_root: modelsRoot,
    models,
    style_loras: styleLoras,
    errors: loraErrors,
  };
}
