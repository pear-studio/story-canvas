import { createHash } from "node:crypto";
import { watch } from "node:fs";
import path from "node:path";

import { candidateFilePath, readGenerationCandidateRecords } from "./candidate-storage.mjs";
import { encodePageKey, validatePageKey } from "./page-key.mjs";
import { resolveProjectLocation } from "./project-operations.mjs";
import { resolveExistingProjectMedia } from "./render-media.mjs";
import { PageRenderError, resolveExactPageIdentity } from "./page-render-resolver.mjs";

function fail(code, details = [], status = 422) {
  throw new PageRenderError(code, details, status);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mediaUrl(projectId, relativePath) {
  return `/api/projects/${encodeURIComponent(projectId)}/media/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function projectCandidate(record, projectDirectory, projectId) {
  const expectedFile = candidateFilePath(projectDirectory, record.page_key, record.candidate_id);
  const resolved = await resolveExistingProjectMedia(projectDirectory, record.file).catch(() => null);
  if (!resolved || path.resolve(resolved.target) !== path.resolve(expectedFile)) return null;
  return {
    candidate_id: record.candidate_id,
    file: record.file,
    absolute_file: expectedFile,
    url: mediaUrl(projectId, record.file),
    ...(record.media_kind==='video' ? {media_kind:'video',video:record.video,video_file:record.video_file,video_url:mediaUrl(projectId,record.video_file),review_file:record.review_file,review_url:mediaUrl(projectId,record.review_file),absolute_video:path.resolve(projectDirectory,record.video_file),absolute_review:path.resolve(projectDirectory,record.review_file)} : {}),
    task_id: record.task_id,
    seed: Number.isSafeInteger(record.seed) ? record.seed : null,
    generated_at: record.generated_at ?? null,
    generation_signature: record.generation_signature ?? null,
  };
}

async function projectPageMedia(projectDirectory, projectId, records) {
  const available = records.filter((record) => record.status === "available");
  const projected = new Array(available.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, available.length) }, async () => {
    while (cursor < available.length) {
      const index = cursor++;
      projected[index] = await projectCandidate(available[index], projectDirectory, projectId);
    }
  }));
  const candidates = projected
    .filter(Boolean)
    .sort((left, right) => String(right.generated_at ?? "").localeCompare(String(left.generated_at ?? ""), "en"));
  return { candidates };
}

export async function readPageMedia(projectRoot, projectId, value, recordsOverride) {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.page_key)) {
    fail("invalid_page_media_request", [], 400);
  }
  const repositoryRoot = path.resolve(projectRoot);
  const project = await resolveProjectLocation(repositoryRoot, projectId);
  // 展示读取不参与候选写锁。各状态原子替换，跨文件短暂不一致由下一次刷新收敛。
  const identity = await resolveExactPageIdentity(project.projectDirectory, value.page_key);
  const records = recordsOverride ?? await readGenerationCandidateRecords(project.projectDirectory, { pageKey: identity.page_key });
  return {
    version: 1,
    page_key: structuredClone(identity.page_key),
    media: await projectPageMedia(project.projectDirectory, project.projectId, records),
  };
}

export function isPageMediaChange(filename) {
  if (!filename) return true;
  const relative = String(filename).replaceAll("\\", "/");
  return ["Outputs/pages"].some((target) =>
    relative === target || relative.startsWith(`${target}/`) || target.startsWith(`${relative}/`));
}

function versioned(snapshot) {
  return { ...snapshot, revision: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

// 文件通知只标记受影响页面；无法定位的通知与周期校验才重建整个索引。
function changedPage(filename) {
  const parts = String(filename ?? "").replaceAll("\\", "/").split("/");
  if (parts[0] !== "Outputs" || parts[1] !== "pages") return null;
  const key = { page_id: parts[2] };
  return validatePageKey(key).length ? null : key;
}

export function createPageMediaReader({ projectRoot, watchDirectory = watch, now = Date.now, recheckMs = 60_000, readCandidateRecords = readGenerationCandidateRecords }) {
  const projects = new Map();
  async function index(projectId, freshPage = null) {
    const { projectDirectory } = await resolveProjectLocation(projectRoot, projectId);
    let state = projects.get(projectDirectory);
    if (!state) {
      state = { generation: 0, fullGeneration: 0, checkedFullGeneration: -1, checkedAt: -Infinity,
        dirty: new Map(), media: new Map(), views: new Map(), counts: null, watcher: null, retryWatchAt: -Infinity, pending: null };
      projects.set(projectDirectory, state);
    }
    if (!state.watcher && now() >= state.retryWatchAt) {
      const failed = (error) => {
        state.retryWatchAt = now() + 5_000;
        console.warn(`[page-media] ${projectId} 文件监听失败，将重试订阅：${error.code ?? error.message}`);
      };
      try {
        const watcher = watchDirectory(projectDirectory, { recursive: true, persistent: false }, (_event, filename) => {
          if (!isPageMediaChange(filename)) return;
          const key = changedPage(filename);
          const generation = ++state.generation;
          if (key) state.dirty.set(encodePageKey(key), { key, generation });
          else state.fullGeneration = generation;
        });
        state.watcher = watcher;
        // 重新订阅后补齐中断窗口内的变更；正常读取仍只扫描通知标记的页面。
        state.fullGeneration = ++state.generation;
        watcher.on("error", error => {
          if (state.watcher !== watcher) return;
          state.watcher = null;
          state.fullGeneration = ++state.generation;
          watcher.close();
          failed(error);
        });
      } catch (error) { failed(error); }
    }
    if (freshPage) state.dirty.set(encodePageKey(freshPage), { key: freshPage, generation: ++state.generation });
    while (state.pending) await state.pending;
    const full = state.checkedFullGeneration !== state.fullGeneration || now() - state.checkedAt >= recheckMs;
    if (full || state.dirty.size) {
      const generation = state.generation;
      const fullGeneration = state.fullGeneration;
      const dirty = new Map(state.dirty);
      const operation = (async () => {
        const groups = new Map();
        if (full) {
          for (const record of await readCandidateRecords(projectDirectory)) {
            const canonical = encodePageKey(record.page_key);
            if (!groups.has(canonical)) groups.set(canonical, []);
            groups.get(canonical).push(record);
          }
        } else {
          for (const [canonical, { key }] of dirty) {
            groups.set(canonical, await readCandidateRecords(projectDirectory, { pageKey: key }));
          }
        }
        const media = full ? new Map() : new Map(state.media);
        for (const [canonical, records] of groups) media.set(canonical, await projectPageMedia(projectDirectory, projectId, records));
        // 所有投影准备好后统一发布；读取途中到达的通知保留到下一轮。
        state.media = media;
        if (full) {
          state.views.clear();
          state.checkedFullGeneration = fullGeneration;
          state.checkedAt = now();
        } else for (const canonical of groups.keys()) state.views.delete(canonical);
        for (const [canonical, entry] of state.dirty) if (entry.generation <= generation) state.dirty.delete(canonical);
        state.counts = versioned({ counts: Object.fromEntries([...media]
          .filter(([, value]) => value.candidates.length)
          .map(([canonical, value]) => [canonical, value.candidates.length])
          .sort(([a], [b]) => a.localeCompare(b, "en"))) });
      })();
      state.pending = operation;
      try { await operation; } finally { if (state.pending === operation) state.pending = null; }
    }
    return { state, projectDirectory };
  }
  return {
    async read(projectId, value, { fresh = false } = {}) {
      if (!isRecord(value) || Object.keys(value).length !== 1 || validatePageKey(value.page_key).length) fail("invalid_page_media_request", [], 400);
      const { state, projectDirectory } = await index(projectId, fresh ? value.page_key : null);
      const canonical = encodePageKey(value.page_key);
      if (state.views.has(canonical)) return state.views.get(canonical);
      const identity = await resolveExactPageIdentity(projectDirectory, value.page_key);
      const result = versioned({ version: 1, page_key: structuredClone(identity.page_key), media: state.media.get(canonical) ?? { candidates: [] } });
      state.views.set(canonical, result);
      return result;
    },
    async counts(projectId) {
      return (await index(projectId)).state.counts;
    },
    close() { for (const state of projects.values()) state.watcher?.close(); projects.clear(); },
  };
}
