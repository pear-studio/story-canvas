import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The queue is deliberately only a runtime projection.  It contains stable
 * task references and the one current owner; task manifests remain the source
 * of truth for progress and results.
 */
export const GENERATION_QUEUE_VERSION = 1;
export const GENERATION_STATUSES = Object.freeze(["queued", "running", "completed", "failed", "cancelled"]);

const queueLocks = new Map();
const queueDrainGates = new Map();
const taskIdPattern = /^.{1,200}$/;

function clone(value) { return structuredClone(value); }

function queuePath(repositoryRoot) {
  return path.resolve(repositoryRoot, "Saved", "comfyui-queue.json");
}

function queueLockPath(repositoryRoot) {
  return `${queuePath(repositoryRoot)}.lock`;
}

function refKey(ref) {
  return `${ref.project_id}\0${ref.purpose}\0${ref.task_id}`;
}

function assertRef(ref) {
  const inferredPurpose = ref?.purpose ?? (typeof ref?.task_id === "string" && ref.task_id.startsWith("render-") ? "candidate" : "comparison");
  if (!ref || typeof ref !== "object" || Array.isArray(ref)
    || (inferredPurpose === "candidate" ? typeof ref.project_id !== "string" || !ref.project_id : ref.project_id !== null)
    || typeof ref.task_id !== "string" || !taskIdPattern.test(ref.task_id)
    || !["candidate", "comparison"].includes(inferredPurpose)) {
    throw new Error("统一生成队列任务引用无效");
  }
  return {
    project_id: ref.project_id,
    task_id: ref.task_id,
    purpose: inferredPurpose,
    created_at: typeof ref.created_at === "string" ? ref.created_at : null,
  };
}

function storedRef(ref) {
  return ref;
}

function emptyQueue() {
  return { version: GENERATION_QUEUE_VERSION, revision: 0, updated_at: new Date().toISOString(), user_ordered: false, draining: false, items: [], active: null };
}

function normalizeQueue(value) {
  if (!value || typeof value !== "object" || value.version !== GENERATION_QUEUE_VERSION || !Array.isArray(value.items)) {
    throw new Error("统一生成队列文件无效");
  }
  const seen = new Set();
  const items = value.items.map((item) => {
    const ref = assertRef(item);
    const key = refKey(ref);
    if (seen.has(key)) throw new Error(`统一生成队列包含重复任务：${ref.task_id}`);
    seen.add(key);
    return {
      ...storedRef(ref),
      status: "queued",
      pending_control: item.pending_control === "cancel" ? item.pending_control : null,
    };
  });
  let active = null;
  if (value.active !== null && value.active !== undefined) {
    const ref = assertRef(value.active);
    if (!seen.has(refKey(ref))) throw new Error("统一生成队列 active 引用了不存在的任务");
    const unitId = typeof value.active.unit_id === "string" && value.active.unit_id ? value.active.unit_id : null;
    if (!unitId) throw new Error("统一生成队列 active 缺少 unit_id");
    active = {
      ...storedRef(ref),
      unit_id: unitId,
      // A pre-token queue lease is deliberately treated as foreign. Generic
      // cleanup must never be able to clear it by omission.
      lease_token: typeof value.active.lease_token === "string" && value.active.lease_token ? value.active.lease_token : "legacy",
      owner_pid: Number.isInteger(value.active.owner_pid) ? value.active.owner_pid : null,
      claimed_at: typeof value.active.claimed_at === "string" ? value.active.claimed_at : null,
    };
  }
  return {
    version: GENERATION_QUEUE_VERSION,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    updated_at: value.updated_at ?? null,
    user_ordered: value.user_ordered === true,
    draining: value.draining === true,
    items,
    active,
  };
}

async function readQueueFile(repositoryRoot, { create = false } = {}) {
  const target = queuePath(repositoryRoot);
  try {
    return normalizeQueue(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!create) return emptyQueue();
    const initial = emptyQueue();
    await mkdir(path.dirname(target), { recursive: true });
    await writeQueueFile(repositoryRoot, initial);
    initial.revision = 1;
    return initial;
  }
}

async function writeQueueFile(repositoryRoot, value, { bumpRevision = true } = {}) {
  const target = queuePath(repositoryRoot);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  const next = {
    ...value,
    revision: bumpRevision ? (Number.isSafeInteger(value.revision) ? value.revision : 0) + 1 : value.revision,
    updated_at: new Date().toISOString(),
  };
  value.revision = next.revision;
  value.updated_at = next.updated_at;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function withFileLock(repositoryRoot, operation, { isProcessAlive = processAlive, waitMs = 15, timeoutMs = 10_000 } = {}) {
  const key = path.resolve(repositoryRoot);
  const previous = queueLocks.get(key) ?? Promise.resolve();
  const current = previous.then(async () => {
    const lockFile = queueLockPath(repositoryRoot);
    await mkdir(path.dirname(lockFile), { recursive: true });
    const started = Date.now();
    while (true) {
      let handle;
      try {
        handle = await open(lockFile, "wx");
        await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid })}\n`, "utf8");
        try { return await operation(); }
        finally {
          await handle.close().catch(() => undefined);
          await unlink(lockFile).catch((error) => { if (error?.code !== "ENOENT") throw error; });
        }
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        if (error?.code !== "EEXIST") throw error;
        let owner = null;
        try { owner = JSON.parse(await readFile(lockFile, "utf8")); } catch { /* another process is writing its owner */ }
        const ownerPid = Number(owner?.pid);
        let stale = Number.isInteger(ownerPid) && ownerPid > 0 ? !isProcessAlive(ownerPid) : false;
        if (!owner && Date.now() - (await stat(lockFile).then((info) => info.mtimeMs).catch(() => Date.now())) > timeoutMs) stale = true;
        if (stale) {
          await unlink(lockFile).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
          continue;
        }
        if (Date.now() - started >= timeoutMs) throw Object.assign(new Error("统一生成队列正被其他进程更新"), { code: "generation_queue_busy" });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  });
  const tail = current.catch(() => undefined);
  queueLocks.set(key, tail);
  try { return await current; }
  finally { if (queueLocks.get(key) === tail) queueLocks.delete(key); }
}

// The public reader is intentionally read-only; missing runtime state is an empty queue.
export async function readGenerationQueue(repositoryRoot) {
  return clone(await readQueueFile(repositoryRoot));
}

export function generationQueueFile(repositoryRoot) { return queuePath(repositoryRoot); }

export async function ensureGenerationQueue(repositoryRoot, references = []) {
  return withFileLock(repositoryRoot, async () => {
    const queue = await readQueueFile(repositoryRoot, { create: true });
    const before = JSON.stringify({ items: queue.items, active: queue.active, user_ordered: queue.user_ordered, draining: queue.draining });
    const activeKeys = new Set(references.map((candidate) => refKey(assertRef(candidate))));
    // Domain state is authoritative for terminal tasks; remove stale queue
    // references left by a failed worker or an orderly completion.
    queue.items = queue.items.filter((item) => activeKeys.has(refKey(item))
      || (queue.active && refKey(queue.active) === refKey(item)));
    const existing = new Set(queue.items.map(refKey));
    for (const candidate of references) {
      const ref = assertRef(candidate);
      const key = refKey(ref);
      if (existing.has(key)) continue;
      queue.items.push({ ...storedRef(ref), status: "queued", pending_control: null });
      existing.add(key);
    }
    // Only a missing queue file is reconstructed by creation time. Once the
    // user has reordered items, subsequent observations must not overwrite it.
    if (!queue.user_ordered) {
      queue.items.sort((left, right) => String(left.created_at ?? left.task_id).localeCompare(String(right.created_at ?? right.task_id), "en"));
    }
    const changed = before !== JSON.stringify({ items: queue.items, active: queue.active, user_ordered: queue.user_ordered, draining: queue.draining });
    if (changed) await writeQueueFile(repositoryRoot, queue);
    return clone(queue);
  });
}

export async function enqueueGenerationTask(repositoryRoot, reference) {
  const ref = assertRef(reference);
  return withFileLock(repositoryRoot, async () => {
    const queue = await readQueueFile(repositoryRoot, { create: true });
    const key = refKey(ref);
    const existing = queue.items.find((item) => refKey(item) === key);
    const before = JSON.stringify(queue.items);
    if (!existing) queue.items.push({ ...storedRef(ref), status: "queued", pending_control: null });
    if (!queue.user_ordered) queue.items.sort((left, right) => String(left.created_at ?? left.task_id).localeCompare(String(right.created_at ?? right.task_id), "en"));
    const changed = before !== JSON.stringify(queue.items);
    if (changed) await writeQueueFile(repositoryRoot, queue);
    return clone(queue);
  });
}

function findItem(queue, ref) {
  const key = refKey(assertRef(ref));
  return queue.items.find((item) => refKey(item) === key) ?? null;
}

export async function reorderGenerationQueue(repositoryRoot, orderedReferences, { expectedRevision = null } = {}) {
  if (!Array.isArray(orderedReferences)) throw new Error("统一生成队列顺序必须是数组");
  return withFileLock(repositoryRoot, async () => {
    const queue = await readQueueFile(repositoryRoot, { create: true });
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || queue.revision !== expectedRevision)) {
      throw Object.assign(new Error("统一生成队列版本已变化，请刷新后重试"), { code: "generation_queue_revision_conflict", status: 409 });
    }
    const requested = orderedReferences.map(assertRef);
    const requestedKeys = new Set();
    const ordered = [];
    for (const ref of requested) {
      const key = refKey(ref);
      if (requestedKeys.has(key)) throw Object.assign(new Error("统一生成队列顺序包含重复任务"), { code: "generation_queue_identity_mismatch", status: 400 });
      const existing = findItem(queue, ref);
      if (!existing || existing.purpose !== ref.purpose || existing.project_id !== ref.project_id || existing.task_id !== ref.task_id
        || (ref.created_at !== null && ref.created_at !== existing.created_at)) {
        throw Object.assign(new Error("统一生成队列只能调整既有任务顺序"), { code: "generation_queue_identity_mismatch", status: 400 });
      }
      ordered.push(existing);
      requestedKeys.add(key);
    }
    if (requestedKeys.size !== queue.items.length) throw Object.assign(new Error("统一生成队列顺序必须包含全部既有任务"), { code: "generation_queue_identity_mismatch", status: 400 });
    if (JSON.stringify(queue.items) === JSON.stringify(ordered) && queue.user_ordered) return clone(queue);
    queue.items = ordered;
    queue.user_ordered = true;
    await writeQueueFile(repositoryRoot, queue);
    return clone(queue);
  });
}

export async function controlGenerationQueue(repositoryRoot, reference, action) {
  const ref = assertRef(reference);
  if (action !== "cancel") throw new Error("统一生成队列控制命令无效");
  return withFileLock(repositoryRoot, async () => {
    const queue = await readQueueFile(repositoryRoot, { create: true });
    const item = findItem(queue, ref);
    if (!item) throw Object.assign(new Error(`统一生成队列找不到任务：${ref.task_id}`), { code: "generation_task_not_queued" });
    if (action === "cancel") {
      if (queue.active && refKey(queue.active) === refKey(ref)) item.pending_control = "cancel";
      else queue.items = queue.items.filter((entry) => refKey(entry) !== refKey(ref));
    }
    await writeQueueFile(repositoryRoot, queue);
    return clone(queue);
  });
}

export async function completeGenerationTask(repositoryRoot, reference, { leaseToken = null } = {}) {
  const ref = assertRef(reference);
  return withFileLock(repositoryRoot, async () => {
    const queue = await readQueueFile(repositoryRoot, { create: true });
    const activeIsSameReference = queue.active && refKey(queue.active) === refKey(ref);
    if (activeIsSameReference && queue.active.lease_token !== leaseToken) return clone(queue);
    queue.items = queue.items.filter((item) => refKey(item) !== refKey(ref));
    if (activeIsSameReference) queue.active = null;
    await writeQueueFile(repositoryRoot, queue);
    return clone(queue);
  });
}

/**
 * Wait until this reference is the first queued item, then claim one ComfyUI
 * unit.  A claim is intentionally released at every unit boundary.
 */
export async function waitForGenerationUnitTurn(repositoryRoot, reference, unitId, {
  pollMs = 100,
  signal = null,
  ownerPid = process.pid,
  isProcessAlive = processAlive,
  drainApiUrl = null,
  drainOptions = {},
} = {}) {
  const ref = assertRef(reference);
  if (typeof unitId !== "string" || !unitId) throw new Error("统一生成队列 unit id 无效");
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error("统一生成队列等待已取消"), { code: "aborted" });
    const result = await withFileLock(repositoryRoot, async () => {
      const queue = await readQueueFile(repositoryRoot, { create: true });
      const item = findItem(queue, ref);
      if (!item) return { kind: "gone" };
      if (queue.draining) return { kind: "draining" };
      if (queue.active) {
        // A lease whose owner process died can never be released.  Reclaim it
        // like startup recovery does; the drain worker is kicked below, outside
        // this lock.
        if (!reclaimDeadOwner(queue, isProcessAlive)) return { kind: "wait" };
        await writeQueueFile(repositoryRoot, queue);
        return { kind: "reclaimed" };
      }
      const firstQueued = queue.items.find((entry) => entry.status === "queued");
      if (firstQueued !== item) return { kind: "wait" };
      const leaseToken = randomUUID();
      queue.active = { ...storedRef(ref), unit_id: unitId, lease_token: leaseToken, owner_pid: ownerPid, claimed_at: new Date().toISOString() };
      await writeQueueFile(repositoryRoot, queue);
      return { kind: "claimed", leaseToken };
    }, { isProcessAlive });
    if (result.kind === "claimed") {
      let released = false;
      return {
        token: result.leaseToken,
        async release({ completed = false, domainCompleted = false, draining = false, drainApiUrl = null } = {}) {
          if (released) return { action: null };
          const releaseResult = await withFileLock(repositoryRoot, async () => {
            const queue = await readQueueFile(repositoryRoot, { create: true });
            const item = findItem(queue, ref);
            const active = queue.active && refKey(queue.active) === refKey(ref) && queue.active.unit_id === unitId && queue.active.lease_token === result.leaseToken;
            if (!active) return { action: null };
            const action = domainCompleted ? null : item?.pending_control ?? null;
            queue.active = null;
            // A prompt that was accepted by ComfyUI but whose terminal state
            // is unknown must drain naturally before another prompt is sent.
            // Persist this under the same queue lock as lease release so a
            // second process cannot claim in the gap.
            if (draining) queue.draining = true;
            if (!item) { await writeQueueFile(repositoryRoot, queue); return { action }; }
            item.pending_control = null;
            // The domain is marked completed before the final lease is
            // released.  That terminal decision wins over a queued cancel, so there is no window where the queue says done while
            // the domain still says running.
            if (completed || domainCompleted) queue.items = queue.items.filter((entry) => refKey(entry) !== refKey(ref));
            else if (action === "cancel") queue.items = queue.items.filter((entry) => refKey(entry) !== refKey(ref));
            await writeQueueFile(repositoryRoot, queue);
            return { action };
          });
          // 持久化成功后才消费凭证；失败时调用方仍可用同一凭证重试。
          released = true;
          if (draining && drainApiUrl) {
            // Runtime uncertainty can begin after startup.  Start (or reuse)
            // the process-local idempotent drain worker immediately so the
            // persisted gate does not become permanent in this process.
            void startGenerationQueueDrain(repositoryRoot, drainApiUrl).catch(() => undefined);
          }
          return releaseResult;
        },
      };
    }
    if (result.kind === "reclaimed") {
      // The persisted drain bit now gates every claim.  Kick (or reuse) the
      // process-local drain worker outside the queue lock so the gate clears
      // once ComfyUI is empty; without it this loop would wait on draining
      // forever.
      if (drainApiUrl) void startGenerationQueueDrain(repositoryRoot, drainApiUrl, drainOptions).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (result.kind === "draining") {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (result.kind === "gone") throw Object.assign(new Error("统一生成队列任务已移除"), { code: "generation_task_removed" });
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// A lease whose owner process died can never be released.  Both startup
// recovery and the wait loop reclaim it and gate the next submission behind a
// ComfyUI drain, since the dead owner may already have submitted a prompt.
function reclaimDeadOwner(queue, isProcessAlive) {
  if (!queue.active) return false;
  if (Number.isInteger(queue.active.owner_pid) && isProcessAlive(queue.active.owner_pid)) return false;
  queue.active = null;
  queue.draining = true;
  return true;
}

/** On startup, dead owners no longer block the next task. */
export async function recoverGenerationQueue(repositoryRoot, { isProcessAlive = processAlive } = {}) {
  return withFileLock(repositoryRoot, async () => {
    const queue = await readQueueFile(repositoryRoot, { create: true });
    const before = JSON.stringify({ active: queue.active, draining: queue.draining });
    reclaimDeadOwner(queue, isProcessAlive);
    if (before !== JSON.stringify({ active: queue.active, draining: queue.draining })) await writeQueueFile(repositoryRoot, queue);
    return clone(queue);
  }, { isProcessAlive });
}

export function generationReference(projectId, taskId, purpose = null, createdAt = null) {
  return assertRef({ project_id: projectId, task_id: taskId, purpose, created_at: createdAt });
}

export async function waitForComfyQueueDrain(apiUrl, {
  fetchImpl = fetch,
  pollMs = 250,
  timeoutMs = 15 * 60_000,
  requestTimeoutMs = 10_000,
} = {}) {
  const base = String(apiUrl ?? "http://127.0.0.1:8188").replace(/\/$/, "");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/queue`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`ComfyUI 队列查询失败：${response.status}`);
    const value = await response.json();
    const running = value?.queue_running ?? value?.running ?? [];
    const pending = value?.queue_pending ?? value?.pending ?? [];
    if ((!Array.isArray(running) || running.length === 0) && (!Array.isArray(pending) || pending.length === 0)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("等待 ComfyUI 遗留队列清空超时");
}

export function startGenerationQueueDrain(repositoryRoot, apiUrl, options = {}) {
  const key = path.resolve(repositoryRoot);
  if (!queueDrainGates.has(key)) {
    const gate = (async () => {
      const queue = await readGenerationQueue(repositoryRoot);
      if (!queue.draining) return;
      // Keep retrying after a query error/timeout.  The persisted `draining`
      // bit remains the gate, so startup can listen while ComfyUI is down.
      while (true) {
        try {
          await waitForComfyQueueDrain(apiUrl, options);
          await withFileLock(repositoryRoot, async () => {
            const current = await readQueueFile(repositoryRoot, { create: true });
            if (!current.draining) return;
            current.draining = false;
            await writeQueueFile(repositoryRoot, current);
          });
          return;
        } catch (error) {
          const retryMs = Number.isFinite(options.retryMs) ? Math.max(1, Number(options.retryMs)) : 1_000;
          await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
      }
    })().finally(() => queueDrainGates.delete(key));
    queueDrainGates.set(key, gate);
  }
  return queueDrainGates.get(key);
}

export function waitForGenerationQueueDrain(repositoryRoot) {
  return queueDrainGates.get(path.resolve(repositoryRoot)) ?? Promise.resolve();
}
