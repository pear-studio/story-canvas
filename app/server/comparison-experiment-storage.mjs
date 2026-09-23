import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertComparisonExperimentManifest } from "./comparison-experiment.mjs";
import { assertComparisonPreflightPlan } from "./comparison-preflight.mjs";
import { assertComparisonExecutionPlan } from "./comparison-execution-contract.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { replaceFileWithRetry } from "./file-replace.mjs";
import { isCompletePng } from "./render-media.mjs";
import { persistReferenceImage } from "./reference-image.mjs";

const STORAGE_DIRECTORY = "comparisons";
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const CELL_PATTERN = /^cell-[a-f0-9]{64}$/;
// `incomplete` remains a historical domain result; task APIs project it to
// `failed`. Queue controls use the shared cancelled status.
const STATUS_VALUES = new Set(["queued", "running", "completed", "incomplete", "failed", "cancelled"]);

export const COMPARISON_STORAGE_VERSION = 1;

export class ComparisonExperimentStorageError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ComparisonExperimentStorageError";
    this.code = code;
    this.status = 422;
    this.details = details;
  }
}

const locks = new Map();

// 创建、启动和删除共用服务内串行入口，防止删除与新 worker 竞争。
export function withComparisonOperation(repositoryRoot, operation) {
  return withLock(`operations:${path.resolve(repositoryRoot)}`, operation);
}

export async function deleteComparisonExperiment(repositoryRoot, id) {
  return withExperimentLock(repositoryRoot, id, async directory => {
    const record = await readComparisonExperimentView(repositoryRoot, id);
    if (record.status.status === "running" || (record.status.status === "queued" && record.status.started_at)) {
      throw Object.assign(new Error("请先停止实验，等待执行结束后再删除"), { code: "comparison_running", status: 409 });
    }
    const reviews = path.join(repositoryRoot, "Saved", "comparison-reviews");
    const relatedReviews = [];
    for (const entry of await readdir(reviews, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const index = JSON.parse(await readFile(path.join(reviews, entry.name, "index.json"), "utf8"));
      if (index.experiments?.some(experiment => experiment.id === id)) relatedReviews.push(path.join(reviews, entry.name));
    }
    // 先读完关联索引，避免索引损坏时已删除实验却返回失败。
    // id 已严格校验；目标都只位于本仓库实验目录下。
    await rm(directory, { recursive: true, force: true });
    await rm(path.join(repositoryRoot, "Saved", "comparisons", assertId(id)), { recursive: true, force: true });
    for (const review of relatedReviews) await rm(review, { recursive: true, force: true });
    return id;
  });
}

function clone(value) {
  return structuredClone(value);
}

function fail(code, message, details = []) {
  throw new ComparisonExperimentStorageError(code, message, details);
}

function assertId(value, label = "比较实验 id") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail("invalid_comparison_id", `${label} 不合法`);
  return value;
}

function assertCellId(value) {
  if (typeof value !== "string" || !CELL_PATTERN.test(value)) fail("invalid_comparison_cell", "cell id 不合法");
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") fail(code, `文件不存在：${file}`);
    if (error instanceof SyntaxError) fail("invalid_comparison_json", `JSON 无效：${file}`);
    throw error;
  }
}

async function writeJson(file, value, { createOnly = false } = {}) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, jsonText(value), { encoding: "utf8", flag: "wx" });
    await replaceFileWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (createOnly && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
      fail("comparison_experiment_exists", "比较实验 id 已存在");
    }
    throw error;
  }
}

function storageRoot(projectRoot) {
  return path.resolve(projectRoot, "Saved", "comparison-results");
}

function experimentDirectory(projectRoot, id) {
  return path.join(storageRoot(projectRoot), assertId(id));
}

async function withLock(key, task) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tail = current.catch(() => undefined);
  locks.set(key, tail);
  await tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return current;
}

async function withExperimentLock(projectRoot, id, task) {
  const directory = experimentDirectory(projectRoot, id);
  return withLock(directory, () => task(directory));
}

function assertStoredIdentity(manifest, preflight, id) {
  if (manifest.id !== id
    || preflight.manifest_id !== id
    || preflight.manifest_sha256 !== manifest.canonical_sha256
    || hashCanonicalJson(preflight.manifest) !== hashCanonicalJson(manifest)) {
    fail("comparison_storage_identity_mismatch", "manifest 与 preflight 的实验身份不一致");
  }
  if (manifest.status !== "queued" || manifest.cells.some((cell) => cell.status !== "queued")) {
    fail("invalid_comparison_manifest", "比较实验 manifest 必须保持 queued 状态");
  }
}

function assertStatus(status, manifest, preflight = null) {
  if (!status || typeof status !== "object" || Array.isArray(status)) fail("invalid_comparison_status", "status 必须是对象");
  if (status.version !== COMPARISON_STORAGE_VERSION || status.kind !== "comparison_experiment_status") {
    fail("invalid_comparison_status", "status 版本或类型无效");
  }
  if (status.id !== manifest.id
    || status.manifest_sha256 !== manifest.canonical_sha256
    || (preflight && status.preflight_sha256 !== preflight.canonical_sha256)) {
    fail("invalid_comparison_status", "status 与实验身份不一致");
  }
  if (!STATUS_VALUES.has(status.status) || !Array.isArray(status.cells) || status.cells.length !== manifest.cells.length) {
    fail("invalid_comparison_status", "status 状态或 cell 数量无效");
  }
  for (const [index, cell] of status.cells.entries()) {
    const source = manifest.cells[index];
    if (!cell || cell.id !== source.id || cell.ordinal !== index || !STATUS_VALUES.has(cell.status)) {
      fail("invalid_comparison_status", `status.cells[${index}] 无效`);
    }
  }
  return status;
}

function initialStatus(manifest, preflight, now) {
  return {
    version: COMPARISON_STORAGE_VERSION,
    kind: "comparison_experiment_status",
    id: manifest.id,
    manifest_sha256: manifest.canonical_sha256,
    preflight_sha256: preflight.canonical_sha256,
    status: "queued",
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    incomplete_at: null,
    cells: manifest.cells.map((cell) => ({
      id: cell.id,
      ordinal: cell.ordinal,
      status: "queued",
      started_at: null,
      completed_at: null,
      result: null,
      error: null,
    })),
  };
}

function view(record) {
  return clone({ ...record, status: record.status, execution: record.execution ?? null });
}

async function readRecord(projectRoot, id, { readExecution = true } = {}) {
  const directory = experimentDirectory(projectRoot, id);
  const manifest = assertComparisonExperimentManifest(await readJson(path.join(directory, "manifest.json"), "invalid_comparison_manifest_file"));
  const preflight = assertComparisonPreflightPlan(await readJson(path.join(directory, "preflight.json"), "invalid_comparison_preflight_file"));
  assertStoredIdentity(manifest, preflight, id);
  const resultStatus = await readJson(path.join(directory, "result.json"), "invalid_comparison_status_file");
  let live = null;
  try { live = await readJson(path.join(projectRoot, "Saved", "comparisons", id, "status.json"), "missing_runtime"); }
  catch (error) { if (error.code !== "missing_runtime") throw error; }
  const status = assertStatus(["completed", "incomplete", "failed", "cancelled"].includes(resultStatus.status) ? resultStatus : live ?? reconcileComparisonExperimentStatus({ ...resultStatus, status: "running" }), manifest, preflight);
  for (const cell of status.cells) {
    try {
      const result = await readJson(path.join(directory, "results", cell.id, "result.json"), "missing_cell");
      Object.assign(cell, { status: "completed", completed_at: result.completed_at, result, error: null });
    } catch (error) { if (error.code !== "missing_cell") throw error; }
  }
  if (status.cells.every(cell => cell.status === "completed")) {
    status.status = "completed"; status.completed_at ??= status.cells.at(-1)?.completed_at; status.incomplete_at = null;
  }
  let execution = null;
  try {
    if (readExecution) execution = assertComparisonExecutionPlan(await readJson(path.join(directory, "execution.json"), "invalid_comparison_execution_file"), { manifest, preflight });
  } catch (error) {
    if (error?.code !== "invalid_comparison_execution_file") throw error;
  }
  return { id, directory, manifest: clone(manifest), preflight: clone(preflight), status: clone(status), execution: execution ? clone(execution) : null };
}

export async function createComparisonExperimentStorage({ projectRoot, manifest, preflight, referenceImages = [], now = new Date().toISOString() } = {}) {
  const verifiedManifest = clone(assertComparisonExperimentManifest(manifest));
  const verifiedPreflight = clone(assertComparisonPreflightPlan(preflight));
  assertStoredIdentity(verifiedManifest, verifiedPreflight, verifiedManifest.id);
  const status = initialStatus(verifiedManifest, verifiedPreflight, now);
  assertStatus(status, verifiedManifest, verifiedPreflight);

  const root = storageRoot(projectRoot);
  await mkdir(root, { recursive: true });
  const directory = experimentDirectory(projectRoot, verifiedManifest.id);
  const temporary = path.join(root, `.${verifiedManifest.id}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(temporary);
  try {
    await writeFile(path.join(temporary, "manifest.json"), jsonText(verifiedManifest), "utf8");
    await writeFile(path.join(temporary, "preflight.json"), jsonText(verifiedPreflight), "utf8");
    await writeFile(path.join(temporary, "result.json"), jsonText(status), "utf8");
    await persistReferenceImage(temporary, verifiedPreflight.inputs, referenceImages);
    await mkdir(path.join(temporary, "results"));
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) fail("comparison_experiment_exists", "比较实验 id 已存在");
    throw error;
  }
  const runtime = path.join(projectRoot, "Saved", "comparisons", verifiedManifest.id);
  await mkdir(runtime, { recursive: true });
  await writeJson(path.join(runtime, "status.json"), status);
  return view({ id: verifiedManifest.id, directory, manifest: verifiedManifest, preflight: verifiedPreflight, status, execution: null });
}

export async function readComparisonExperimentStorage(projectRoot, experimentId) {
  return view(await readRecord(projectRoot, experimentId));
}

export async function listComparisonExperimentStorage(projectRoot) {
  const root = storageRoot(projectRoot);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    records.push(await readRecord(projectRoot, entry.name));
  }
  records.sort((left, right) => left.manifest.created_at.localeCompare(right.manifest.created_at) || left.id.localeCompare(right.id));
  return records.map(view);
}

async function readViewRecord(projectRoot, id) {
  const directory = experimentDirectory(projectRoot, id);
  const manifest = assertComparisonExperimentManifest(await readJson(path.join(directory, "manifest.json"), "invalid_comparison_manifest_file"));
  const resultStatus = await readJson(path.join(directory, "result.json"), "invalid_comparison_status_file");
  let live = null;
  try { live = await readJson(path.join(projectRoot, "Saved", "comparisons", id, "status.json"), "missing_runtime"); }
  catch (error) { if (error.code !== "missing_runtime") throw error; }
  const source = ["completed", "incomplete", "failed", "cancelled"].includes(resultStatus.status)
    ? resultStatus
    : live ?? reconcileComparisonExperimentStatus({ ...resultStatus, status: "running" });
  // 浏览器投影只读取 manifest 和轻量状态；执行入口仍通过 readRecord
  // 完整校验 preflight 与 execution 身份。
  const status = assertStatus(source, manifest);
  return clone({ id, manifest, status });
}

export async function readComparisonExperimentView(projectRoot, experimentId) {
  return readViewRecord(projectRoot, assertId(experimentId));
}

export async function listComparisonExperimentViews(projectRoot) {
  const root = storageRoot(projectRoot);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const records = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => readViewRecord(projectRoot, entry.name)));
  records.sort((left, right) => left.manifest.created_at.localeCompare(right.manifest.created_at) || left.id.localeCompare(right.id));
  return records;
}

export async function createComparisonExperimentExecution(projectRoot, experimentId, execution) {
  return withExperimentLock(projectRoot, experimentId, async (directory) => {
    const current = await readRecord(projectRoot, experimentId);
    if (current.status.status !== "queued") fail("comparison_execution_order", "只有 queued 比较实验可以冻结 execution plan");
    if (current.execution) fail("comparison_execution_exists", "比较实验已经存在 execution plan");
    const verified = clone(assertComparisonExecutionPlan(execution, { manifest: current.manifest, preflight: current.preflight }));
    await writeJson(path.join(directory, "execution.json"), verified, { createOnly: true });
    return view({ ...current, execution: verified });
  });
}

async function updateStatus(projectRoot, experimentId, update, directory = null, options = {}) {
  const targetDirectory = directory ?? experimentDirectory(projectRoot, experimentId);
  const current = await readRecord(projectRoot, experimentId, options);
  const next = update(clone(current));
  assertStatus(next.status, next.manifest, next.preflight);
  // 成功 cell 和终态先归档，再更新可清理的运行状态。
  if (options.archive || ["completed", "incomplete", "failed", "cancelled"].includes(next.status.status) || next.status.cells.some(cell => cell.status === "completed")) {
    await writeJson(path.join(targetDirectory, "result.json"), next.status);
  }
  const runtime = path.join(projectRoot, "Saved", "comparisons", experimentId);
  await mkdir(runtime, { recursive: true });
  await writeJson(path.join(runtime, "status.json"), next.status);
  return view(next);
}

export async function markComparisonExperimentRunning(projectRoot, experimentId, now = new Date().toISOString()) {
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    if (current.status.status === "queued") {
      current.status.status = "running";
      current.status.started_at = now;
      current.status.updated_at = now;
      return current;
    }
    if (current.status.status === "running") fail("comparison_experiment_already_running", "比较实验已经在运行");
    fail("comparison_experiment_terminal", "终态比较实验不能再次运行");
  }, directory));
}

/** Mark a frozen experiment as intentionally started without claiming a ComfyUI unit. */
export async function markComparisonExperimentStarted(projectRoot, experimentId, now = new Date().toISOString()) {
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    if (!current.execution) fail("comparison_execution_order", "比较实验尚未冻结 execution plan");
    if (!["queued"].includes(current.status.status)) fail("comparison_experiment_terminal", "比较实验已经启动或已结束");
    current.status.started_at ??= now;
    current.status.updated_at = now;
    return current;
  }, directory));
}

export async function requeueComparisonExperiment(projectRoot, experimentId, now = new Date().toISOString()) {
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    if (current.status.status !== "running") return current;
    current.status.status = "queued";
    current.status.updated_at = now;
    for (const cell of current.status.cells) if (cell.status === "running") {
      cell.status = "queued";
      cell.started_at = null;
    }
    return current;
  }, directory));
}

/** 用户明确补跑失败实验：保留冻结计划、已发布成果和上一次错误。 */
export async function retryComparisonExperiment(projectRoot, experimentId, now = new Date().toISOString(), { recoverInterrupted = false } = {}) {
  return withExperimentLock(projectRoot, experimentId, async (directory) => {
    const current = await readRecord(projectRoot, experimentId);
    const interrupted = recoverInterrupted && ["running", "queued"].includes(current.status.status) && current.status.started_at;
    if (!["incomplete", "failed", "completed"].includes(current.status.status) && !interrupted) fail("comparison_retry_unavailable", "只有失败或已中断的实验可以补跑");
    if (!current.execution) fail("comparison_execution_order", "实验没有冻结执行计划，不能补跑");
    // 状态写入可能落后于成果发布。先核验已完成成果，避免覆盖或默默跳过损坏成果。
    for (const cell of current.status.cells.filter(cell => cell.status === "completed")) {
      const target = path.join(directory, "results", cell.id);
      const result = await readJson(path.join(target, "result.json"), "comparison_result_not_ready");
      let bytes, generation;
      try {
        bytes = await readFile(path.join(target, "image.png"));
        generation = await readFile(path.join(target, "generation.json"));
      } catch (error) {
        if (error?.code === "ENOENT") fail("comparison_result_invalid", `已完成成果文件缺失，不能补跑：${cell.id}`);
        throw error;
      }
      if (result.image?.relative_path !== `results/${cell.id}/image.png`
        || !isCompletePng(bytes) || result.image.byte_length !== bytes.length
        || result.image.sha256 !== createHash("sha256").update(bytes).digest("hex")
        || result.generation_sha256 !== createHash("sha256").update(generation).digest("hex")) {
        fail("comparison_result_invalid", `已完成成果损坏，不能补跑：${cell.id}`);
      }
    }
    // 最后一格已发布但终态写入失败时，仅补写终态，不再提交生成。
    if (current.status.status === "completed") {
      return updateStatus(projectRoot, experimentId, record => record, directory, { archive: true });
    }
    return updateStatus(projectRoot, experimentId, (record) => {
      record.status.failures ??= [];
      record.status.failures.push({ status: record.status.status, started_at: record.status.started_at, at: record.status.incomplete_at,
        retried_at: now, ...(interrupted ? { reason: "executor_missing" } : {}),
        cells: record.status.cells.filter(cell => cell.error).map(cell => ({ id: cell.id, error: clone(cell.error) })) });
      for (const cell of record.status.cells) {
        if (cell.status === "completed") continue;
        Object.assign(cell, { status: "queued", started_at: null, completed_at: null, result: null, error: null });
      }
      // 用户已明确授权补跑；保留启动意图，使入队前中断仍可恢复。
      Object.assign(record.status, { status: "queued", started_at: now, completed_at: null, incomplete_at: null, updated_at: now });
      return record;
    }, directory, { archive: true });
  });
}

export async function cancelComparisonExperiment(projectRoot, experimentId, now = new Date().toISOString()) {
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    if (["completed", "failed", "incomplete", "cancelled"].includes(current.status.status)) return current;
    if (!["queued", "running"].includes(current.status.status)) fail("comparison_experiment_control", "终态比较实验不能取消");
    current.status.status = "cancelled";
    current.status.incomplete_at = now;
    current.status.updated_at = now;
    for (const cell of current.status.cells) {
      if (cell.status === "completed") continue;
      cell.status = "cancelled";
      cell.error = null;
    }
    return current;
  }, directory));
}

export async function claimNextComparisonCell(projectRoot, experimentId, now = new Date().toISOString()) {
  const record = await withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    if (current.status.status === "queued") {
      current.status.status = "running";
      current.status.started_at = now;
    }
    if (current.status.status !== "running") fail("comparison_experiment_terminal", "终态比较实验不能领取 cell");
    if (current.status.cells.some((cell) => cell.status === "running")) fail("comparison_cell_in_progress", "已有 cell 正在运行");
    const next = current.status.cells.find((cell) => cell.status === "queued");
    if (!next) {
      if (current.status.cells.every((cell) => cell.status === "completed")) {
        current.status.status = "completed";
        current.status.completed_at = now;
      }
      current.status.updated_at = now;
      return current;
    }
    if (current.status.cells.some((cell) => cell.ordinal < next.ordinal && cell.status !== "completed")) {
      fail("comparison_cell_order_violation", "只能按 ordinal 顺序领取 cell");
    }
    next.status = "running";
    next.started_at = now;
    next.error = null;
    current.status.updated_at = now;
    return current;
  }, directory));
  return record.status.cells.find((cell) => cell.status === "running") ?? null;
}

export async function completeComparisonCell(projectRoot, experimentId, cellId, result, now = new Date().toISOString()) {
  assertCellId(cellId);
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    const cell = current.status.cells.find((entry) => entry.id === cellId);
    if (!cell) fail("comparison_cell_not_found", "找不到比较实验 cell");
    if (cell.status === "completed") return current;
    if (cell.status !== "running") fail("comparison_cell_order_violation", "只有 running cell 可以完成");
    cell.status = "completed";
    cell.completed_at = now;
    cell.result = clone(result);
    cell.error = null;
    current.status.updated_at = now;
    if (current.status.cells.every((entry) => entry.status === "completed")) {
      current.status.status = "completed";
      current.status.completed_at = now;
    }
    return current;
  }, directory));
}

function failureValue(error, now) {
  return {
    code: typeof error?.code === "string" ? error.code : "comparison_execution_failed",
    message: typeof error?.message === "string" ? error.message : String(error ?? "比较实验执行失败"),
    at: now,
  };
}

export async function failComparisonExperiment(projectRoot, experimentId, error, now = new Date().toISOString()) {
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    if (["completed", "failed", "incomplete", "cancelled"].includes(current.status.status)) return current;
    const failure = failureValue(error, now);
    for (const cell of current.status.cells) {
      if (cell.status === "completed") continue;
      cell.status = "incomplete";
      cell.completed_at = null;
      cell.result = null;
      cell.error = failure;
    }
    current.status.status = "incomplete";
    current.status.incomplete_at = now;
    current.status.updated_at = now;
    return current;
  }, directory, { readExecution: false }));
}

export function reconcileComparisonExperimentStatus(status, now = new Date().toISOString()) {
  const next = clone(status);
  if (!["running", "queued"].includes(next.status)) return next;
  for (const cell of next.cells ?? []) {
    if (cell.status === "completed") continue;
    cell.status = "incomplete";
    cell.completed_at = null;
    cell.result = null;
    cell.error = { code: "process_restarted", message: "进程重启后未自动恢复比较实验", at: now };
  }
  next.status = "incomplete";
  next.incomplete_at = now;
  next.updated_at = now;
  return next;
}

export async function reconcileComparisonExperimentStorage(projectRoot, experimentId, now = new Date().toISOString()) {
  return withExperimentLock(projectRoot, experimentId, (directory) => updateStatus(projectRoot, experimentId, (current) => {
    current.status = reconcileComparisonExperimentStatus(current.status, now);
    return current;
  }, directory));
}

export async function resolveComparisonCellImagePath(projectRoot, experimentId, cellId, { mode = "read" } = {}) {
  assertCellId(cellId);
  if (mode !== "read" && mode !== "write") fail("invalid_comparison_result_mode", "图片 mode 必须是 read 或 write");
  const record = await readRecord(projectRoot, experimentId);
  const cell = record.status.cells.find((entry) => entry.id === cellId);
  if (!cell) fail("comparison_cell_not_found", "找不到比较实验 cell");
  if (mode === "read" && (cell.status !== "completed" || cell.result?.image?.relative_path !== `results/${cellId}/image.png`)) {
    fail("comparison_result_not_ready", "比较结果尚未完成");
  }
  if (mode === "write" && cell.status !== "running") fail("comparison_result_write_order", "只有 running cell 可以写入图片");
  return path.join(record.directory, "results", cellId, "image.png");
}

export async function resolvePublishedComparisonCellImagePath(projectRoot, experimentId, cellId) {
  const verifiedCellId = assertCellId(cellId);
  const directory = experimentDirectory(projectRoot, assertId(experimentId));
  const relativePath = `results/${verifiedCellId}/image.png`;
  const result = await readJson(path.join(directory, "results", verifiedCellId, "result.json"), "comparison_result_not_ready");
  if (result?.image?.relative_path !== relativePath) fail("comparison_result_not_ready", "比较结果尚未完成");
  return path.join(directory, relativePath);
}

export async function recordComparisonSubmission(projectRoot, experimentId, cellId, value) {
  const target = path.join(projectRoot, "Saved", "comparisons", assertId(experimentId), "submissions");
  await mkdir(target, { recursive: true });
  await writeJson(path.join(target, assertCellId(cellId) + ".json"), value);
}

export async function publishComparisonCell(projectRoot, experimentId, cellId, bytes, result, submission) {
  const imagePath = await resolveComparisonCellImagePath(projectRoot, experimentId, cellId, { mode: "write" });
  const generationText = jsonText(submission);
  const published = { ...result, generation_sha256: createHash("sha256").update(generationText).digest("hex") };
  const staging = path.join(projectRoot, "Saved", "staging", "comparison-" + randomUUID());
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(path.join(staging, "image.png"), bytes, { flag: "wx" });
    await writeFile(path.join(staging, "result.json"), jsonText(published), { flag: "wx" });
    await writeFile(path.join(staging, "generation.json"), generationText, { flag: "wx" });
    await mkdir(path.dirname(path.dirname(imagePath)), { recursive: true });
    await rename(staging, path.dirname(imagePath));
    return published;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
