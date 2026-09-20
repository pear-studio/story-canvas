import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveExistingProjectMedia } from "./render-media.mjs";
import { listFinishedJobs, finishedTaskSummary } from "./finished-jobs.mjs";

import { listComparisonExperimentViews, readComparisonExperimentView, readComparisonExperimentStorage } from "./comparison-experiment-storage.mjs";
import { encodePageKey } from "./page-key.mjs";
import { requireProjectDirectoryName } from "./project-contracts.mjs";
import { readGenerationQueue } from "./generation-queue.mjs";
import { renderTaskIdPattern } from "./render-task-id.mjs";
import {
  isActiveRenderTaskState,
  listProjectRenderTaskStates,
  listRenderHistoryTaskIds,
  readRenderTaskState,
  readRenderTask,
  renderTaskProgressFile,
} from "./render-task-storage.mjs";

const activeStatuses = new Set(["launching", "queued", "running"]);
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

async function readJsonOptional(target) {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function listComparisonRuntimeStatuses(projectDirectory) {
  const root = path.join(projectDirectory, "Saved", "comparisons");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const statuses = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const value = await readJsonOptional(path.join(root, entry.name, "status.json"));
    if (!value || value.id !== entry.name || typeof value.status !== "string") continue;
    statuses.push(value);
  }
  return statuses;
}

function mediaUrl(projectId, relativePath) {
  return `/api/projects/${encodeURIComponent(projectId)}/media/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function itemCounts(items) {
  return {
    total: items.length,
    available: items.filter((item) => item.status === "available").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    discarded: items.filter((item) => item.status === "discarded").length,
    running: items.filter((item) => item.status === "running").length,
    queued: items.filter((item) => item.status === "queued").length,
    failed: items.filter((item) => item.status === "failed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
  };
}

async function publicRenderTaskState(projectDirectory, projectId, state, { detail = false } = {}) {
  let progress = null;
  if (isActiveRenderTaskState(state)) {
    try {
      const current = await readJsonOptional(renderTaskProgressFile(projectDirectory, state.id));
      const value = Number(current?.sampling?.value ?? current?.value);
      const max = Number(current?.sampling?.max ?? current?.max);
      if (Number.isFinite(value) && value >= 0 && Number.isFinite(max) && max > 0) progress = { value: Math.min(value, max), max };
    } catch { /* 临时进度损坏不影响持久任务状态。 */ }
  }
  const items = state.items.map((item) => ({
    ...structuredClone(item),
    task: state.id,
    url: item.file && item.status === "available" ? mediaUrl(projectId, item.file) : null,
    render_profile: state.render_profile,
    candidate_storage_migration_required: false,
  }));
  const currentItem = items.find((item) => item.status === "running")
    ?? items.find((item) => item.status === "queued")
    ?? items.find((item) => item.status === "failed");
  const pages = state.pages.map((page) => {
    const canonical = encodePageKey(page.page_key);
    const pageItems = items.filter((item) => encodePageKey(item.page_key) === canonical);
    return {
      ...structuredClone(page),
      item_counts: itemCounts(pageItems),
    };
  });
  const currentPage = currentItem
    ? pages.find((page) => encodePageKey(page.page_key) === encodePageKey(currentItem.page_key)) ?? null
    : pages[0] ?? null;
  return {
    id: state.id,
    purpose: state.purpose,
    status: state.status === "launching" ? "queued" : state.status,
    created_at: state.created_at,
    started_at: state.started_at,
    completed_at: state.completed_at,
    failed_at: state.failed_at,
    ...(detail ? { error: state.error } : {}),
    current_page_key: currentItem?.page_key ?? currentPage?.page_key ?? null,
    item_counts: itemCounts(items),
    progress,
    ...(detail ? { items } : {}),
    render_profile: state.render_profile,
    project_id: projectId,
    project_title: state.project_title,
    page_count: pages.length,
    current_page_order: Number.isInteger(currentPage?.order) ? currentPage.order : null,
    current_page_title: typeof currentPage?.title === "string" ? currentPage.title : null,
    current_owner_kind: currentPage?.owner_kind ?? null,
    current_owner_label: currentPage?.owner_label ?? null,
    pages,
  };
}

function comparisonCellItemStatus(status) {
  if (status === "completed") return "available";
  if (status === "failed" || status === "incomplete") return "failed";
  if (status === "cancelled") return "cancelled";
  return status === "running" ? "running" : "queued";
}

function renderTaskHistoryCreatedAt(taskId) {
  const match = /^render-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-|$)/.exec(taskId);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

/** Convert comparison's independent cell storage into the same task summary used by the root status bar. */
function publicComparisonTask(_projectId, record, _projectTitle, { detail = false } = {}) {
  const items = record.status.cells.map(cell => ({ ...cell, status: comparisonCellItemStatus(cell.status), page_key: null,
    url: cell.status === "completed" ? `/api/comparison-experiments/${record.id}/results/${cell.id}.png` : null }));
  return { id: record.id, purpose: "comparison", status: record.status.status === "incomplete" ? "failed" : record.status.status,
    created_at: record.manifest.created_at, started_at: record.status.started_at ?? null, completed_at: record.status.completed_at ?? null,
    failed_at: record.status.incomplete_at ?? null, item_counts: itemCounts(items), progress: null,
    project_id: null, project_title: "对比实验", page_count: record.manifest.axes.find(axis => axis.type === "input")?.values.length ?? 0,
    pages: [], current_page_key: null, current_page_title: record.id,
    ...(detail ? { items, error: record.status.cells.find(cell => cell.error)?.error?.message ?? null } : {}) };
}

// 详情只在点击时读取冻结任务和逐单元提交记录，不扫描候选或连接 ComfyUI。
export async function readWorkspaceTaskDetail(projectRoot, projectId, taskId, purpose = "candidate") {
  if (purpose !== "comparison") requireProjectDirectoryName(projectId);
  const projectDirectory = purpose === "comparison" ? projectRoot : registeredProjectPath(projectRoot, projectId);
  if (purpose === "finished") {
    const job = (await listFinishedJobs(projectDirectory)).find(job => job.id === taskId);
    if (!job) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const project = await readJsonOptional(path.join(projectDirectory, "project.json"));
    return finishedTaskSummary(job, projectId, project?.title ?? projectId);
  }
  if (purpose === "comparison") {
    const record = await readComparisonExperimentStorage(projectDirectory, taskId);
    const units = await Promise.all((record.execution?.cells ?? []).map(async cell => ({
      id: cell.id, item_ids: [cell.id],
      submission: await readJsonOptional(path.join(projectDirectory, "Saved", "comparisons", taskId, "submissions", `${cell.id}.json`)),
    })));
    return { ...publicComparisonTask(null, record, "对比实验", { detail: true }), execution_units: units, snapshot: record.execution };
  }
  if (!renderTaskIdPattern.test(taskId)) throw Object.assign(new Error("任务 ID 无效"), { status: 400, code: "invalid_task_id" });
  const stored = await readRenderTask(projectDirectory, taskId);
  if (!stored) throw Object.assign(new Error("任务不存在"), { status: 404, code: "task_not_found" });
  const units = await Promise.all((stored.task.snapshot.execution_units ?? []).map(async unit => ({
    id: unit.id, item_ids: unit.item_ids,
    ...(unit.two_step ? { two_step: unit.two_step, intermediates: await Promise.all((unit.intermediate_outputs ?? []).map(async output => ({ kind: output.kind, url: await resolveExistingProjectMedia(projectDirectory, output.file) ? mediaUrl(projectId, output.file) : null }))) } : {}),
    submission: await readJsonOptional(path.join(projectDirectory, "Saved", "render", "submissions", taskId, `${unit.id}.json`)),
  })));
  return { ...await publicRenderTaskState(projectDirectory, projectId, stored.state, { detail: true }), execution_units: units, snapshot: stored.task.snapshot };
}

// 卡片按需读取已发布图片；候选只读轻量 state，不扫描其他任务的候选。
export async function readWorkspaceTaskResults(projectRoot, projectId, taskId, purpose = "candidate") {
  if (purpose !== "comparison") requireProjectDirectoryName(projectId);
  const projectDirectory = purpose === "comparison" ? projectRoot : registeredProjectPath(projectRoot, projectId);
  let items;
  if (purpose === "finished") {
    const job = (await listFinishedJobs(projectDirectory)).find(job => job.id === taskId);
    if (!job) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const record = job.status === "completed" ? await readJsonOptional(path.join(projectDirectory, "finished", `${job.page_id}.json`)) : null;
    items = record ? [{ id: job.id, file: record.outputs.lettered, url: mediaUrl(projectId, record.outputs.lettered) }] : [];
  } else if (purpose === "comparison") {
    const record = await readComparisonExperimentView(projectDirectory, taskId);
    items = record.status.cells.filter(cell => cell.status === "completed").map(cell => ({
      id: cell.id,
      file: `Saved/comparison-results/${record.id}/results/${cell.id}/image.png`,
      url: `/api/comparison-experiments/${record.id}/results/${cell.id}.png`,
    }));
  } else {
    if (!renderTaskIdPattern.test(taskId)) throw Object.assign(new Error("任务 ID 无效"), { status: 400, code: "invalid_task_id" });
    const state = await readRenderTaskState(projectDirectory, taskId);
    if (!state) throw Object.assign(new Error("任务不存在"), { status: 404, code: "task_not_found" });
    items = state.items.filter(item => item.status === "available" && item.file).map(item => ({
      id: item.id, file: item.file, url: mediaUrl(projectId, item.file),
    }));
  }
  const images = await Promise.all(items.map(async item => (
    await resolveExistingProjectMedia(projectDirectory, item.file) ? { id: item.id, url: item.url } : null
  )));
  return images.filter(Boolean);
}

export async function listWorkspaceRenderTasks(projectRoot, {
  trackedByProject = new Map(),
  strict = false,
} = {}) {
  const entries = listRegisteredProjects(projectRoot, "story").filter(entry => entry.available);
  const tasks = [];
  const history = [];
  const tracked = [];
  const missingTrackedTaskIds = [];
  const visitedProjects = new Set();
  for (const entry of entries) {
    const projectDirectory = entry.path;
    const projectId = entry.id;
    const projectFacts = await readJsonOptional(path.join(projectDirectory, "project.json"));
    const projectTitle = typeof projectFacts?.title === "string" && projectFacts.title.trim() ? projectFacts.title : projectId;
    visitedProjects.add(projectId);
    const finishedJobs = await listFinishedJobs(projectDirectory);
    for (const job of finishedJobs) {
      const summary = finishedTaskSummary(job, projectId, projectTitle);
      (activeStatuses.has(summary.status) ? tasks : history).push(summary);
    }
    const states = await listProjectRenderTaskStates(projectDirectory, { scope: "active", strict });
    const statesById = new Map(states.map((state) => [state.id, state]));
    for (const taskId of trackedByProject.get(projectId) ?? []) {
      const finished = finishedJobs.find(job => job.id === taskId);
      if (finished) {
        const summary = finishedTaskSummary(finished, projectId, projectTitle);
        tracked.push({ id: summary.id, status: summary.status });
        continue;
      }
      const state = statesById.get(taskId) ?? (renderTaskIdPattern.test(taskId) ? await readRenderTaskState(projectDirectory, taskId) : null);
      if (state) tracked.push({ id: state.id, status: state.status === "launching" ? "queued" : state.status });
      else missingTrackedTaskIds.push(taskId);
    }
    for (const state of states) {
      if (activeStatuses.has(state.status)) tasks.push(await publicRenderTaskState(projectDirectory, projectId, state));
      else if (terminalStatuses.has(state.status)) history.push(await publicRenderTaskState(projectDirectory, projectId, state));
    }
  }
  for (const status of await listComparisonRuntimeStatuses(projectRoot)) {
    if (!activeStatuses.has(status.status) || !status.started_at) continue;
    tasks.push(publicComparisonTask(null, await readComparisonExperimentView(projectRoot, status.id)));
  }
  const queue = await readGenerationQueue(projectRoot);
  for (const task of tasks) {
    task.pending_control = queue.items.find(item => item.project_id === task.project_id
      && item.purpose === task.purpose && item.task_id === task.id)?.pending_control ?? null;
  }
  const order = new Map(queue.items.map((item, index) => [`${item.project_id}\0${item.purpose}\0${item.task_id}`, index]));
  tasks.sort((left, right) => {
    const leftOrder = order.get(`${left.project_id}\0${left.purpose}\0${left.id}`);
    const rightOrder = order.get(`${right.project_id}\0${right.purpose}\0${right.id}`);
    if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    return String(left.created_at ?? left.id).localeCompare(String(right.created_at ?? right.id), "en");
  });
  history.sort((left, right) => String(right.completed_at ?? right.failed_at ?? right.created_at ?? right.id).localeCompare(String(left.completed_at ?? left.failed_at ?? left.created_at ?? left.id), "en"));
  for (const [projectId, taskIds] of trackedByProject) {
    if (!visitedProjects.has(projectId)) missingTrackedTaskIds.push(...taskIds);
  }
  return {
    tasks,
    history,
    tracked: [...new Map(tracked.map((state) => [state.id, state])).values()],
    missing_tracked_task_ids: [...new Set(missingTrackedTaskIds)],
    ...(queue.items.length ? { queue_revision: queue.revision } : {}),
  };
}

// 历史按提交顺序翻页。只枚举目录名，再读取本页 state；不加载整段历史或 manifest。
export async function listWorkspaceRenderHistory(projectRoot, { before = null, limit = 30 } = {}) {
  const entries = listRegisteredProjects(projectRoot, "story").filter(entry => entry.available);
  const references = [];
  const comparisonSummaries = new Map();
  for (const entry of entries) {
    for (const taskId of await listRenderHistoryTaskIds(entry.path)) {
      // The render task ID already contains the submission timestamp.  Use it
      // as the stable history key so pagination only reads the selected page,
      // rather than opening every candidate state on every request.
      const cursor = `${renderTaskHistoryCreatedAt(taskId) ?? taskId}/candidate/${taskId}/${entry.id}`;
      if (!before || cursor < before) references.push({ projectId: entry.id, taskId, cursor });
    }
    const projectFacts = await readJsonOptional(path.join(entry.path, "project.json"));
    const projectTitle = typeof projectFacts?.title === "string" && projectFacts.title.trim() ? projectFacts.title : entry.id;
    for (const job of await listFinishedJobs(entry.path)) {
      if (!terminalStatuses.has(job.status)) continue;
      const cursor = `${job.created_at}/finished/${job.id}/${entry.id}`;
      comparisonSummaries.set(`${entry.id}\0${job.id}`, finishedTaskSummary(job, entry.id, projectTitle));
      if (!before || cursor < before) references.push({ projectId: entry.id, taskId: job.id, cursor, kind: "finished" });
    }
  }
  for (const record of await listComparisonExperimentViews(projectRoot)) {
    if (!terminalStatuses.has(record.status.status) && record.status.status !== "incomplete") continue;
    const cursor = `${record.manifest.created_at}/comparison/${record.id}`;
    comparisonSummaries.set(`null\0${record.id}`, publicComparisonTask(null, record));
    if (!before || cursor < before) references.push({ projectId: null, taskId: record.id, cursor, kind: "comparison" });
  }
  references.sort((left, right) => left.cursor < right.cursor ? 1 : left.cursor > right.cursor ? -1 : 0);
  const selected = references.slice(0, limit);
  const history = [];
  for (const { projectId, taskId, kind } of selected) {
    if (kind === "comparison" || kind === "finished") {
      const summary = comparisonSummaries.get(`${projectId}\0${taskId}`);
      if (summary) history.push(summary);
      continue;
    }
    const projectDirectory = registeredProjectPath(projectRoot, projectId);
    const state = await readRenderTaskState(projectDirectory, taskId).catch(() => null);
    if (state && terminalStatuses.has(state.status)) history.push(await publicRenderTaskState(projectDirectory, projectId, state));
  }
  return { history, next_cursor: references.length > selected.length ? selected.at(-1).cursor : null };
}
