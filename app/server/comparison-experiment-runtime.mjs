import { executeGenerationTask } from "./generation-lifecycle.mjs";
import { recordComparisonSubmission, publishComparisonCell } from "./comparison-experiment-storage.mjs";
import { createTaskStageRecorder } from "./task-stage-recorder.mjs";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  cancelComparisonExperiment,
  claimNextComparisonCell,
  completeComparisonCell,
  markComparisonExperimentRunning,
  readComparisonExperimentStorage,
  resolvePublishedComparisonCellImagePath,
  resolveComparisonCellImagePath,
} from "./comparison-experiment-storage.mjs";
import { waitForGenerationQueueDrain, waitForGenerationUnitTurn } from "./generation-queue.mjs";
import { isCompletePng } from "./render-media.mjs";
import { resolveComfyLoraNames } from "./render-project-runtime.mjs";
import { diagnoseModelFile } from "./render-profile-diagnostics.mjs";
import { referenceImageFilename, uploadFrozenReferenceImage } from "./reference-image.mjs";

function clone(value) { return structuredClone(value); }

function apiUrlFrom(value) {
  return String(value ?? "http://127.0.0.1:8188").replace(/\/$/, "");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) throw new Error("比较实验输入路径无效");
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("比较实验输入路径无效");
  return normalized;
}

async function assertLorasExist(unit, modelsRoot) {
  for (const lora of unit.loras ?? []) {
    const relative = safeRelativePath(lora.relative_path ?? `loras/${lora.filename}`);
    await access(path.resolve(modelsRoot, relative));
  }
}

/**
 * 默认的轻量 ComfyUI 适配器。比较执行只需要提交一个 workflow、
 * 查询 history 和下载冻结输出；不维护第二套 ComfyUI 服务。
 */
export function createComparisonComfyAdapter({ apiUrl = "http://127.0.0.1:8188", fetchImpl = fetch } = {}) {
  const baseUrl = apiUrlFrom(apiUrl);
  const loraOptions = new Map();
  const requestJson = async (pathname, options = {}) => {
    const response = await fetchImpl(`${baseUrl}${pathname}`, options);
    const text = await response.text();
    if (!response.ok) throw new Error(`ComfyUI 请求失败：${response.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    async uploadReference(taskDirectory, identity) {
      return uploadFrozenReferenceImage(baseUrl, taskDirectory, identity);
    },
    async resolveWorkflow(workflow) {
      const classes = [...new Set(Object.values(workflow)
        .map((node) => node?.class_type)
        .filter((classType) => ["LoraLoader", "LoraLoaderModelOnly"].includes(classType)))];
      const options = {};
      for (const classType of classes) {
        if (!loraOptions.has(classType)) {
          loraOptions.set(classType, requestJson(`/object_info/${encodeURIComponent(classType)}`).then((value) => {
            const entries = value?.[classType]?.input?.required?.lora_name?.[0];
            if (!Array.isArray(entries)) throw new Error(`ComfyUI 未提供 ${classType}.lora_name 枚举`);
            return entries;
          }));
        }
        options[classType] = await loraOptions.get(classType);
      }
      return classes.length ? resolveComfyLoraNames(workflow, options) : clone(workflow);
    },
    async submit({ workflow, extraData, clientId }) {
      const result = await requestJson("/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, prompt: workflow, extra_data: extraData }),
      });
      if (!result.prompt_id) throw new Error(`ComfyUI 未接受比较 cell：${JSON.stringify(result.node_errors ?? result)}`);
      return result.prompt_id;
    },
    async wait(promptId, timeoutMs = 15 * 60_000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const result = await requestJson(`/history/${encodeURIComponent(promptId)}`);
        const history = result[promptId];
        if (history?.status?.status_str === "error") {
          const error = new Error(`ComfyUI 任务失败：${JSON.stringify(history.status.messages ?? [])}`);
          error.comfyTerminal = true;
          throw error;
        }
        if (history?.outputs && Object.keys(history.outputs).length) return history;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`等待 ComfyUI 任务超时：${promptId}`);
    },
    async download(image) {
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
      const response = await fetchImpl(`${baseUrl}/view?${query}`);
      if (!response.ok) throw new Error(`下载比较结果失败：${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

function outputImage(history, output) {
  return history?.outputs?.[output.node_id]?.images?.[output.image_index] ?? null;
}

export async function resolveComparisonReferenceWorkflow(workflow, references, adapter, taskDirectory) {
  for (const reference of references ?? []) {
    if (!adapter.uploadReference) throw new Error("ComfyUI 适配器不支持参考图上传");
    const uploaded = await adapter.uploadReference(taskDirectory, reference);
    for (const node of Object.values(workflow)) if (node.class_type === "LoadImage" && node.inputs.image === referenceImageFilename(reference)) node.inputs.image = uploaded;
  }
  return workflow;
}

async function runCell({ execution, cell, projectRoot, modelsRoot, adapter, apiUrl, onCell, onSubmitted, onComfyTerminal }) {
  await assertLorasExist(cell, modelsRoot);
  const workflow = await resolveComparisonReferenceWorkflow(
    adapter.resolveWorkflow ? await adapter.resolveWorkflow(cell.workflow.api) : clone(cell.workflow.api),
    cell.reference_images, adapter, path.join(projectRoot, "Saved", "comparison-results", execution.experiment_id));
  const clientId = randomUUID();
  const submission = { availability: "recorded", api_url: apiUrl, submitted_at: new Date().toISOString(), request: { client_id: clientId, prompt: workflow, extra_data: clone(cell.extra_data) }, prompt_id: null };
  const recorder = createTaskStageRecorder(submission, value => recordComparisonSubmission(projectRoot, execution.experiment_id, cell.id, value));
  const promptId = await recorder.measure("submit", async () => {
    const id = await adapter.submit({ workflow, extraData: clone(cell.extra_data), clientId, cell });
    onSubmitted?.(id);
    submission.prompt_id = id;
    return id;
  });
  submission.prompt_id = promptId;
  let history;
  try {
    history = await recorder.measure("remote_wait", () => adapter.wait(promptId, cell.timeout_ms));
  } catch (error) {
    if (error?.comfyTerminal) onComfyTerminal?.();
    throw error;
  }
  onComfyTerminal?.();
  const descriptor = cell.outputs[0];
  const image = outputImage(history, descriptor);
  if (!image) throw new Error(`cell ${cell.id} 没有冻结输出`);
  const bytes = await recorder.measure("download", async () => {
    const value = await adapter.download(image);
    if (!Buffer.isBuffer(value) || !isCompletePng(value)) throw new Error(`cell ${cell.id} 的 ComfyUI 输出不是 PNG`);
    return value;
  }, cell.id);
  const completedAt = new Date().toISOString();
  const result = {
    image: { relative_path: descriptor.relative_path, sha256: sha256(bytes), byte_length: bytes.length },
    completed_at: completedAt,
    generation: { prompt_id: promptId, output: clone(descriptor) },
  };
  const published = await recorder.measure("save", () => publishComparisonCell(projectRoot, execution.experiment_id, cell.id, bytes, result, submission), cell.id);
  await completeComparisonCell(projectRoot, execution.experiment_id, cell.id, published, new Date().toISOString());
  onCell?.({ cell, result: published });
  return published;
}

/** 顺序执行冻结 execution.json。失败后保留已完成 cell，并终结剩余 cell。 */
async function executeComparison({ projectRoot, experimentId, apiUrl, modelsRoot, adapter = null, now = () => new Date().toISOString(), onCell = null, generationQueue = null } = {}) {
  const stored = await readComparisonExperimentStorage(projectRoot, experimentId);
  if (!stored.execution) throw new Error("比较实验尚未冻结 execution plan");
  if (stored.status.status !== "queued") throw new Error("比较实验已经启动或已结束");
  const execution = clone(stored.execution);
  if (!Array.isArray(execution.cells) || !execution.cells.length) throw new Error("比较实验 execution plan 没有可执行 cell");
  // Recovery must not claim cells whose published result is already present.
  // Keep the execution order, but derive the queue units from the domain's
  // actual unfinished cells so the lease always names the cell being claimed.
  const storedCells = new Map(stored.status.cells.map((cell) => [cell.id, cell]));
  const pendingCells = execution.cells.filter((cell) => storedCells.get(cell.id)?.status !== "completed");
  const comfy = adapter ?? createComparisonComfyAdapter({ apiUrl });
  const resolvedModelsRoot = modelsRoot ?? path.resolve(projectRoot, "models");
  const files = new Map();
  for (const input of stored.preflight.inputs) for (const model of Object.values(input.render.profile.models ?? {})) {
    files.set(`${model.relative_path}:${model.sha256}`, { relativePath: model.relative_path, sha256: model.sha256 });
  }
  for (const cell of pendingCells) for (const lora of cell.loras) {
    const relativePath = lora.relative_path ?? `loras/${lora.filename}`;
    files.set(`${relativePath}:${lora.sha256}`, { relativePath, sha256: lora.sha256 });
  }
  for (const file of files.values()) {
    const diagnosis = await diagnoseModelFile({ projectRoot, config: { models_root: resolvedModelsRoot }, ...file });
    if (diagnosis.status !== "available") throw new Error(`冻结模型不可用或身份已变化：${file.relativePath} (${diagnosis.status})`);
  }
  try {
    if (!pendingCells.length) {
      const completed = await readComparisonExperimentStorage(projectRoot, experimentId);
      return completed;
    }
    if (!generationQueue) await markComparisonExperimentRunning(projectRoot, experimentId, now());
    for (const expected of pendingCells) {
      const beforeClaim = await readComparisonExperimentStorage(projectRoot, experimentId);
      if (beforeClaim.status.status === "completed" || beforeClaim.status.cells.find((cell) => cell.id === expected.id)?.status === "completed") continue;
      if (beforeClaim.status.status === "cancelled") return beforeClaim;
      let lease = null;
      let releaseOptions = {};
      let submittedToComfy = false;
      let comfyTerminalConfirmed = false;
      try {
        lease = generationQueue
          ? await waitForGenerationUnitTurn(generationQueue.repositoryRoot, generationQueue.reference, expected.id, { drainApiUrl: apiUrl })
          : null;
      } catch (error) {
        if (generationQueue && error?.code === "generation_task_removed") return readComparisonExperimentStorage(projectRoot, experimentId);
        throw error;
      }
      try {
        const claimed = await claimNextComparisonCell(projectRoot, experimentId, now());
        if (!claimed) {
          const current = await readComparisonExperimentStorage(projectRoot, experimentId);
          const domainCompleted = current.status.status === "completed";
          const activeLease = lease;
          releaseOptions = { completed: domainCompleted, domainCompleted };
          await activeLease?.release(releaseOptions);
          lease = null;
          return current;
        }
        const cell = execution.cells[claimed.ordinal];
        if (!cell || cell.id !== claimed.id || cell.id !== expected.id) throw new Error(`比较实验 cell 顺序不一致：${claimed.id}`);
        if (generationQueue) await waitForGenerationQueueDrain(generationQueue.repositoryRoot);
        await runCell({
          execution,
          cell,
          projectRoot,
          modelsRoot: resolvedModelsRoot,
          adapter: comfy,
          apiUrl,
          onCell,
          onSubmitted: () => { submittedToComfy = true; },
          onComfyTerminal: () => { comfyTerminalConfirmed = true; },
        });
        const afterCell = await readComparisonExperimentStorage(projectRoot, experimentId);
        const domainCompleted = afterCell.status.status === "completed";
        const activeLease = lease;
        releaseOptions = { completed: domainCompleted, domainCompleted };
        const control = await activeLease?.release(releaseOptions) ?? { action: null };
        lease = null;
        if (!domainCompleted && control.action === "cancel") {
          await cancelComparisonExperiment(projectRoot, experimentId, now());
          return readComparisonExperimentStorage(projectRoot, experimentId);
        }
      } finally {
        if (lease) await lease.release({
          ...releaseOptions,
          draining: submittedToComfy && !comfyTerminalConfirmed,
          drainApiUrl: submittedToComfy && !comfyTerminalConfirmed ? apiUrl : null,
        });
      }
    }
    const completed = await readComparisonExperimentStorage(projectRoot, experimentId);
    return completed;
  } catch (error) {
    const current = await readComparisonExperimentStorage(projectRoot, experimentId).catch(() => null);
    if (current?.status?.status === "cancelled") return current;
    throw error;
  }
}

export function runComparisonExperiment(options = {}) {
  return executeGenerationTask({ projectRoot: options.projectRoot, taskId: options.experimentId,
    purpose: "comparison", generationQueue: options.generationQueue }, () => executeComparison(options));
}

export async function readComparisonExperimentResult(projectRoot, experimentId, cellId) {
  const target = await resolvePublishedComparisonCellImagePath(projectRoot, experimentId, cellId);
  const bytes = await readFile(target);
  if (!isCompletePng(bytes)) throw new Error(`比较结果 ${cellId} 不是完整 PNG`);
  return bytes;
}
