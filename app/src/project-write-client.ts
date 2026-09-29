export const PROJECT_REVISION_HEADER = "x-story-canvas-revision";

const revisions = new Map<string, string>();
const queues = new Map<string, Promise<void>>();
const writeEpochs = new Map<string, number>();
const writeGenerations = new Map<string, number>();
const refreshRequired = new Set<string>();

export const isProjectWritePending = (projectId: string) => queues.has(projectId);
export async function waitForProjectWrites(projectId: string) {
  while (queues.has(projectId)) await queues.get(projectId);
}
export const getProjectWriteGeneration = (projectId: string) => writeGenerations.get(projectId) ?? 0;
export const isProjectRefreshRequired = (projectId: string) => refreshRequired.has(projectId);

export function acceptProjectSnapshot(projectId: string, revision: string) {
  invalidateProjectWriteQueue(projectId);
  setProjectWriteRevision(projectId, revision);
  refreshRequired.delete(projectId);
}

type ProjectRequest = { projectId: string };

function projectRequest(url: URL): ProjectRequest | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "projects") return null;
  try {
    return { projectId: decodeURIComponent(parts[2]) };
  } catch {
    return null;
  }
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit) {
  return new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
}

function requestMethod(input: RequestInfo | URL, init: RequestInit) {
  return String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function isProjectStaticResource(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "projects") return false;
  if (parts[3] === "media" && parts.length >= 5) return true;
  if (parts.length === 5 && parts[3] === "materials" && parts[4] === "file") return true;
  return false;
}

export function setProjectWriteRevision(projectId: string, revision: string) {
  if (projectId && revision) revisions.set(projectId, revision);
}

export function getProjectWriteRevision(projectId: string) {
  return revisions.get(projectId) ?? null;
}

export function invalidateProjectWriteQueue(projectId: string) {
  writeEpochs.set(projectId, (writeEpochs.get(projectId) ?? 0) + 1);
}

export function clearProjectWriteRevision(projectId: string) {
  invalidateProjectWriteQueue(projectId);
  revisions.delete(projectId);
  queues.delete(projectId);
  refreshRequired.delete(projectId);
}

function staleResponse() {
  return new Response(JSON.stringify({ error: "project_revision_conflict" }), {
    status: 409,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-story-canvas-refresh-required": "true" },
  });
}

async function explicitProjectFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const project = projectRequest(url);
  if (!project) return globalThis.fetch(input, init);
  const headers = requestHeaders(input, init);
  return globalThis.fetch(input, { ...init, headers });
}

async function coordinatedProjectFetch(input: RequestInfo | URL, init: RequestInit, requireRevision = true, projectId?: string): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const project = projectId ? {projectId} : projectRequest(url);
  if (!project) return globalThis.fetch(input, init);

  const previous = queues.get(project.projectId) ?? Promise.resolve();
  writeGenerations.set(project.projectId, getProjectWriteGeneration(project.projectId) + 1);
  const requestEpoch = writeEpochs.get(project.projectId) ?? 0;
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(project.projectId, current);
  await previous.catch(() => undefined);
  try {
    if ((writeEpochs.get(project.projectId) ?? 0) !== requestEpoch) {
      return staleResponse();
    }

    const headers = requestHeaders(input, init);
    const revision = revisions.get(project.projectId);
    if (requireRevision && !revision) {
      throw new Error("项目版本尚未载入");
    }
    if (requireRevision && revision) headers.set("x-story-canvas-expected-revision", revision);
    const response = await globalThis.fetch(input, { ...init, headers });
    if ((writeEpochs.get(project.projectId) ?? 0) !== requestEpoch) {
      return staleResponse();
    }
    const responseRevision = response.headers.get("x-story-canvas-revision");
    if (response.ok && responseRevision) revisions.set(project.projectId, responseRevision);
    if (response.status === 409) {
      const payload = await response.clone().json().catch(() => null) as { error?: string } | null;
      if (payload?.error && [
        "project_revision_conflict", "prompt_target_conflict", "page_prompt_upstream_conflict", "story_edit_upstream_conflict", "story_edit_target_conflict", "character_page_upstream_conflict", "character_edit_upstream_conflict", "page_content_target_conflict",
        "page_lettering_target_conflict", "character_profile_target_conflict", "character_visual_target_conflict",
        "page_identity_conflict", "page_content_reference_conflict", "character_edit_dependency_conflict",
      ].includes(payload.error)) {
        refreshRequired.add(project.projectId);
        invalidateProjectWriteQueue(project.projectId);
        return staleResponse();
      }
    }
    return response;
  } finally {
    release();
    if (queues.get(project.projectId) === current) queues.delete(project.projectId);
  }
}

export function readFacts(input: RequestInfo | URL, init: RequestInit = {}) {
  return explicitProjectFetch(input, init);
}

export async function readProjectResource(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  if (!projectRequest(url) || requestMethod(input, init) !== "GET" || !isProjectStaticResource(url)) {
    throw new Error("项目资源读取必须使用受支持的 GET 资源路径");
  }
  return globalThis.fetch(input, init);
}

export function mutateFacts(input: RequestInfo | URL, init: RequestInit = {}) {
  return coordinatedProjectFetch(input, init);
}

export function mutateTargetFacts(input: RequestInfo | URL, init: RequestInit = {}, projectId?: string) {
  return coordinatedProjectFetch(input, init, false, projectId);
}

export function deriveFromFacts(input: RequestInfo | URL, init: RequestInit = {}) {
  return coordinatedProjectFetch(input, init);
}

export function mutateDerived(input: RequestInfo | URL, init: RequestInit = {}) {
  return explicitProjectFetch(input, init);
}

export function copyProject(input: RequestInfo | URL, init: RequestInit = {}) {
  return coordinatedProjectFetch(input, init);
}

export function renameProject(input: RequestInfo | URL, init: RequestInit = {}) {
  return coordinatedProjectFetch(input, init);
}

/**
 * 非项目请求可以继续使用这个薄入口；项目操作和项目资源都必须显式选择 Interface。
 */
export async function workbenchFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const project = projectRequest(url);
  if (!project) return globalThis.fetch(input, init);
  throw new Error("项目请求必须使用显式项目 Interface");
}
