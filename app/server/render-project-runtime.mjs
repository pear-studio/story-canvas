import { referenceImageFilename, uploadFrozenReferenceImage } from "./reference-image.mjs";
import { resolveExactPageIdentity } from "./page-render-resolver.mjs";
import { publishCandidateResult, readCandidateResult } from "./candidate-storage.mjs";
import { withCandidateMutationLock } from "./candidate-mutation-lock.mjs";
import { factStorage as storage } from "./story-facts.mjs";
import { randomUUID } from "node:crypto";
import { createTaskStageRecorder } from "./task-stage-recorder.mjs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { diagnoseRenderProfile, diagnoseResolvedLoras } from "./render-profile-diagnostics.mjs";
import { configuredComfyUiUrls, createComfyEndpointSelector, primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";
import { queryComfySystemStats } from "./comfy-runtime.mjs";
import { loadLocalConfig } from "./http-support.mjs";
import { encodePageKey } from "./page-key.mjs";
import { loadPromptDictionaryForRender } from "./prompt-dictionary-loader.mjs";
import { renderTaskIdPattern } from "./render-task-id.mjs";
import { waitForGenerationQueueDrain, waitForGenerationUnitTurn } from "./generation-queue.mjs";
import { validateFrozenRenderTask } from "./render-task-contract.mjs";
import { applyRecoveredRenderItemStatuses } from "./render-task-state.mjs";
import { readRenderTask, renderTaskProgressFile, updateRenderTask } from "./render-task-storage.mjs";
import { executeGenerationTask } from "./generation-lifecycle.mjs";
import {
  isCompletePng,
  resolveRenderOutputTarget,
} from "./render-media.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "..");


async function readJson(target) { return JSON.parse(await readFile(target, "utf8")); }
function clone(value) { return structuredClone(value); }

async function assertFrozenExecutionModels(task, { profile, localConfig }) {
  const units = task.snapshot.execution_units;
  const itemById = new Map(task.items.map((item) => [item.id, item]));
  for (const unit of units) {
    for (const itemId of unit.item_ids) {
      const item = itemById.get(itemId);
      if (item.status !== "discarded") await assertFrozenItemModels(profile, item, localConfig);
    }
  }
}

const comfyLoraLoaderClasses = new Set(["LoraLoader", "LoraLoaderModelOnly"]);

function normalizedComfyModelName(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

export function resolveComfyLoraNames(workflow, optionsByClass) {
  const resolved = clone(workflow);
  for (const [nodeId, node] of Object.entries(resolved)) {
    if (!comfyLoraLoaderClasses.has(node?.class_type) || typeof node.inputs?.lora_name !== "string") continue;
    const options = optionsByClass?.[node.class_type];
    if (!Array.isArray(options) || options.some((value) => typeof value !== "string")) {
      throw new Error(`ComfyUI 未提供 ${node.class_type}.lora_name 的有效枚举`);
    }
    const requested = node.inputs.lora_name;
    if (options.includes(requested)) continue;
    const normalizedRequested = normalizedComfyModelName(requested);
    const matches = options.filter((value) => normalizedComfyModelName(value) === normalizedRequested);
    if (matches.length === 1) {
      node.inputs.lora_name = matches[0];
      continue;
    }
    if (!matches.length) throw new Error(`ComfyUI 未登记 LoRA：${requested}（节点 ${nodeId}）`);
    throw new Error(`ComfyUI 的 LoRA 名称存在路径歧义：${requested}（节点 ${nodeId}）`);
  }
  return resolved;
}

export function mapFrozenExecutionOutputs(unit, history) {
  return unit.outputs.map((output) => {
    const image = history?.outputs?.[output.node_id]?.images?.[output.image_index];
    if (!image) throw new Error(`${unit.id} 缺少冻结输出 ${output.node_id}/${output.image_index}`);
    return { output, image };
  });
}

async function assertFrozenItemModels(profile, item, localConfig) {
  if (Array.isArray(item.loras)) {
    const diagnosis = await diagnoseResolvedLoras(item.loras, repositoryRoot, localConfig);
    const unavailable = diagnosis.filter((lora) => lora.status !== "available");
    if (unavailable.length) {
      throw new Error(`${encodePageKey(item.page_key)} 的任务快照缺少可用 LoRA：${unavailable.map((lora) => `${lora.kind}:${lora.owner} ${lora.relative_path ?? lora.filename}: ${lora.reason}`).join("；")}`);
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(60_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body}`);
  return JSON.parse(body);
}

async function comfyLoraOptionsForWorkflow(apiUrl, workflow, cache) {
  const classTypes = [...new Set(Object.values(workflow)
    .map((node) => node?.class_type)
    .filter((classType) => comfyLoraLoaderClasses.has(classType)))];
  const result = {};
  for (const classType of classTypes) {
    if (!cache.has(classType)) {
      cache.set(classType, fetchJson(`${apiUrl}/object_info/${encodeURIComponent(classType)}`).then((info) => {
        const options = info?.[classType]?.input?.required?.lora_name?.[0];
        if (!Array.isArray(options) || options.some((value) => typeof value !== "string")) {
          throw new Error(`ComfyUI 未提供 ${classType}.lora_name 的有效枚举`);
        }
        return options;
      }));
    }
    result[classType] = await cache.get(classType);
  }
  return result;
}

export function comfyWebSocketUrl(apiUrl, clientId) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = new URLSearchParams({ clientId }).toString();
  return url.toString();
}

export function samplingProgressFromMessage(message, promptId) {
  let value = message;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || value.type !== "progress" || !value.data) return null;
  if (value.data.prompt_id && value.data.prompt_id !== promptId) return null;
  const current = Number(value.data.value);
  const maximum = Number(value.data.max);
  if (!Number.isFinite(current) || !Number.isFinite(maximum) || current < 0 || maximum < 0) return null;
  return { value: current, max: maximum };
}

export function taskProgressSnapshot({ task, item, promptId, sampling, status, updatedAt }) {
  return {
    version: 2,
    task: task.id,
    item: item.id,
    page_key: clone(item.page_key),
    purpose: task.purpose,
    prompt_id: promptId,
    sampling: { value: sampling.value, max: sampling.max },
    status,
    updated_at: updatedAt,
  };
}

export function createProgressWriter(target) {
  let pending = Promise.resolve();
  return {
    write(value) {
      pending = pending.then(async () => {
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
          await rename(temporary, target);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      }).catch(() => undefined);
      return pending;
    },
    flush() { return pending; },
  };
}

function connectComfyProgress({ apiUrl, clientId, getPromptId, onProgress }) {
  if (typeof WebSocket !== "function") return { close() {} };
  let socket;
  try {
    socket = new WebSocket(comfyWebSocketUrl(apiUrl, clientId));
    socket.addEventListener("message", (event) => {
      const progress = samplingProgressFromMessage(event.data, getPromptId());
      if (progress) onProgress(progress);
    });
    socket.addEventListener("error", () => undefined);
  } catch {
    return { close() {} };
  }
  return {
    close() {
      try { socket.close(); } catch { /* WebSocket 进度不可用时继续使用历史轮询。 */ }
    },
  };
}

async function waitForHistory(apiUrl, promptId, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const history = await fetchJson(`${apiUrl}/history/${encodeURIComponent(promptId)}`);
    const item = history[promptId];
    if (item?.outputs && Object.keys(item.outputs).length) return item;
    if (item?.status?.status_str === "error") {
      const error = new Error(`ComfyUI 任务失败：${JSON.stringify(item.status.messages ?? [])}`);
      error.comfyTerminal = true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待 ComfyUI 任务超时：${promptId}`);
}

/**
 * 返回第一个包含图片的输出节点的全部图片。单图任务的输出只有一张,
 * 与原有行为一致;批量任务的图片按 batch 顺序排列,由调用方按索引
 * 对应到各候选条目。
 */
export function findOutputImages(history) {
  for (const output of Object.values(history.outputs ?? {})) {
    if (Array.isArray(output.images) && output.images.length) return output.images;
  }
  throw new Error("ComfyUI 历史记录中没有图片输出");
}

async function downloadImage(apiUrl, image) {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
  const response = await fetch(`${apiUrl}/view?${query}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`下载候选失败：${response.status} ${response.statusText}`);
  const value = Buffer.from(await response.arrayBuffer());
  if (!isCompletePng(value)) throw new Error("下载候选不是完整 PNG");
  return value;
}

export async function loadPersistedRenderTask(projectRoot, taskId, {
  repository = repositoryRoot,
  localConfig = null,
} = {}) {
  const persisted = await readRenderTask(projectRoot, taskId);
  if (!persisted) throw Object.assign(new Error(`渲染任务不存在：${taskId}`), { code: "ENOENT" });
  const task = persisted.task;
  if (task.purpose !== "candidate") throw new Error("当前只支持候选生成任务，请重新创建任务");
  if (task.id !== taskId) throw new Error("任务文件名与冻结任务 ID 不一致");
  const config = localConfig ?? await loadLocalConfig(path.join(repository, "app"));
  const promptDictionary = await loadPromptDictionaryForRender(config, repository);
  const validated = validateFrozenRenderTask(task, { dictionaryEntries: promptDictionary.entries, dictionaryIdentity: promptDictionary.identity });
  return { task: validated.task, execution: validated.execution, localConfig: config, taskDirectory: persisted.task_directory };
}

async function runRender(options, assignedTaskId) {
  const { task, execution, localConfig, taskDirectory } = await loadPersistedRenderTask(options.projectRoot, assignedTaskId);
  let apiUrl = String(options.apiUrl ?? "").trim().replace(/\/$/, "");
  if (!apiUrl) {
    const configuredUrls = configuredComfyUiUrls(localConfig);
    if (configuredUrls.length) {
      const selector = createComfyEndpointSelector({ urls: configuredUrls, probe: queryComfySystemStats });
      await selector.refresh();
      apiUrl = selector.currentUrl() ?? "";
    }
    apiUrl = apiUrl || primaryComfyUiUrl(localConfig) || "http://127.0.0.1:8188";
  }
  const uploadedReferences = new Map();
  const runtimeConfig = { ...localConfig, comfyui_urls: [apiUrl] };
  const purpose = task.purpose;
  const profile = task.snapshot.profile;
  const profileDiagnosis = await diagnoseRenderProfile(task.items.every(item => item.prompt_parts?.mode === "free") ? { ...profile, style_loras: {} } : profile, repositoryRoot, runtimeConfig, null, { modelShaPolicy: "advisory" });
  if (!profileDiagnosis.available) {
    const details = [
      ...Object.values(profileDiagnosis.models).filter((model) => model.status !== "available").map((model) => `${model.relative_path}: ${model.reason}`),
      ...Object.values(profileDiagnosis.style_loras).filter((lora) => lora.status !== "available").map((lora) => `${lora.relative_path ?? lora.filename}: ${lora.reason}`),
      ...profileDiagnosis.errors,
    ];
    throw new Error(`当前生成配置缺少可用模型：${details.join("；")}`);
  }
  console.log(`项目：${path.basename(options.projectRoot)}`);
  console.log(`本地任务：${task.id}`);
  console.log(`ComfyUI：${apiUrl}`);
  if (typeof task.id !== "string" || !renderTaskIdPattern.test(task.id)) {
    throw new Error("本地任务内容中的 ID 无效");
  }
  const progressWriter = createProgressWriter(renderTaskProgressFile(options.projectRoot, task.id));
  const waitingUnits = new Set();
  const generationQueue = options.generationQueue;
  const queueReference = generationQueue?.reference ?? null;
  const queueRepositoryRoot = generationQueue?.repositoryRoot ?? options.repositoryRoot ?? path.resolve(options.projectRoot, "../..");
  const commit = async (mutate) => {
    const updated = await updateRenderTask(options.projectRoot, task.id, mutate);
    for (const field of ["status", "started_at", "completed_at", "failed_at", "error"]) {
      if (updated.task[field] === undefined) delete task[field];
      else task[field] = updated.task[field];
    }
    const updatedItems = new Map(updated.task.items.map((item) => [item.id, item]));
    for (const item of task.items) {
      const source = updatedItems.get(item.id);
      for (const field of ["status", "prompt_id", "generated_at", "discarded_at"]) {
        if (source?.[field] === undefined) delete item[field];
        else item[field] = source[field];
      }
    }
    return updated;
  };
  try {
    // 在查询 ComfyUI、改变任务状态或检查输出之前，复验全部冻结条目的模型。
    const units = execution.units;
    await assertFrozenExecutionModels(task, {
      profile,
      localConfig: runtimeConfig,
    });
    await fetchJson(`${apiUrl}/system_stats`);
    const startedAt = new Date().toISOString();
    if (!queueReference) await commit((current) => {
      current.status = "running";
      current.started_at = startedAt;
      delete current.error;
      delete current.failed_at;
      delete current.completed_at;
    });

    // frozen batch 是原子执行单元：只要任一有效输出缺失，就按完整 unit 重跑，不缩减 batch_size。
    const pendingUnits = [];
    const comfyLoraOptions = new Map();
    let unitsChanged = false;
    for (const unit of units) {
      if (unit.skipped) continue;
      const activeItems = unit.items.filter((item) => item.status !== "discarded");
      const outputByItemId = new Map(unit.plan.outputs.map((output) => [output.item_id, output]));
      const complete = [];
      for (const item of activeItems) {
        const output = outputByItemId.get(item.id);
        const target = await resolveRenderOutputTarget(options.projectRoot, output, {
          purpose,
          item,
          createParent: false,
        });
        complete.push(target.exists && Boolean(await readCandidateResult(options.projectRoot, item.page_key, item.candidate_id)));
      }
      if (complete.every(Boolean)) {
        for (const item of activeItems) {
          item.status = "available";
        }
        unitsChanged = true;
      } else {
        for (const item of activeItems) item.status = "queued";
        pendingUnits.push(unit);
      }
    }
    if (unitsChanged) {
      const statuses = new Map(task.items.map((item) => [item.id, item.status]));
      await commit((current) => {
        applyRecoveredRenderItemStatuses(current.items, statuses);
      });
    }

    // 提交编译器已冻结的 workflow 和 extra_data。
    const submitUnit = async (unit) => {
      if (queueReference) await waitForGenerationQueueDrain(queueRepositoryRoot);
      const items = unit.items;
      const progressItem = items.find((item) => item.status !== "discarded") ?? items[0];
      const clientId = randomUUID();
      let promptId = null;
      unit.sampling = { value: 0, max: 0 };
      unit.progress = (status) => taskProgressSnapshot({
        task,
        item: progressItem,
        promptId,
        sampling: unit.sampling,
        status,
        updatedAt: new Date().toISOString(),
      });
      unit.progressSocket = connectComfyProgress({
        apiUrl,
        clientId,
        getPromptId: () => promptId,
        onProgress: (next) => {
          unit.sampling = next;
          void progressWriter.write(unit.progress("running"));
        },
      });
      const itemIds = new Set(items.map((item) => item.id));
      await commit((current) => {
        for (const item of current.items) if (itemIds.has(item.id) && item.status !== "discarded") item.status = "running";
      });
      try {
        const resolvedPrompt = resolveComfyLoraNames(
          unit.plan.workflow.api,
          await comfyLoraOptionsForWorkflow(apiUrl, unit.plan.workflow.api, comfyLoraOptions),
        );
        const reference = items[0].reference_image;
        if (reference) {
          if (!uploadedReferences.has(reference.sha256)) uploadedReferences.set(reference.sha256, uploadFrozenReferenceImage(apiUrl, taskDirectory, reference));
          const uploaded = await uploadedReferences.get(reference.sha256);
          for (const node of Object.values(resolvedPrompt)) if (node.class_type === "LoadImage" && node.inputs.image === referenceImageFilename(reference)) node.inputs.image = uploaded;
        }
        unit.submission = { availability: "recorded", api_url: apiUrl, submitted_at: new Date().toISOString(), request: { client_id: clientId, prompt: resolvedPrompt, extra_data: unit.plan.extra_data }, prompt_id: null };
        const submissionFile = path.join(options.projectRoot, "Saved", "render", "submissions", task.id, unit.plan.id + ".json");
        await mkdir(path.dirname(submissionFile), { recursive: true });
        unit.recorder = createTaskStageRecorder(unit.submission, value => storage.writeJsonAtomic(submissionFile, value));
        await unit.recorder.measure("submit", async () => {
          const submitted = await fetchJson(`${apiUrl}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_id: clientId,
              prompt: resolvedPrompt,
              extra_data: unit.plan.extra_data,
            }),
          });
          if (!submitted.prompt_id) throw new Error(`ComfyUI 未接受任务：${JSON.stringify(submitted.node_errors ?? submitted)}`);
          promptId = submitted.prompt_id;
          unit.submittedToComfy = true;
          unit.comfyTerminalConfirmed = false;
          unit.promptId = promptId;
          unit.submission.prompt_id = promptId;
        });
        unit.finishWait = await unit.recorder.start("remote_wait");
        waitingUnits.add(unit);
        await progressWriter.write(unit.progress("running"));
        return promptId;
      } catch (error) {
        unit.progressSocket.close();
        unit.progressSocket = null;
        await progressWriter.flush();
        throw error;
      }
    };

    // 按冻结 node/image_index 映射收集输出；discarded 只影响落盘，不改变冻结 unit。
    const collectUnit = async (unit, knownHistory = null) => {
      try {
        let history;
        try {
          history = knownHistory ?? await waitForHistory(apiUrl, unit.promptId);
        } catch (error) {
          if (error?.comfyTerminal) unit.comfyTerminalConfirmed = true;
          await unit.finishWait(error);
          waitingUnits.delete(unit);
          unit.finishWait = null;
          throw error;
        }
        await unit.finishWait();
        waitingUnits.delete(unit);
        unit.finishWait = null;
        // A history entry with output or an explicit error is ComfyUI's
        // terminal acknowledgement.  Network/timeout failures leave this
        // false and therefore keep the persisted drain gate closed.
        unit.comfyTerminalConfirmed = Boolean(
          (history?.outputs && Object.keys(history.outputs).length)
          || history?.status?.status_str === "error",
        );
        const mappedOutputs = unit.plan.outputs.map(output => ({ output, image: history?.outputs?.[output.node_id]?.images?.[output.image_index] }));
        const missing = [];
        const itemById = new Map(unit.items.map((item) => [item.id, item]));
        for (const { output, image } of mappedOutputs) {
          const item = itemById.get(output.item_id);
          if (item.status === "discarded") continue;
          if (!image) { missing.push(item.id); continue; }
          const existing = await readCandidateResult(options.projectRoot, item.page_key, item.candidate_id);
          const generatedAt = existing?.generated_at ?? new Date().toISOString();
          if (!existing) {
            const bytes = await unit.recorder.measure("download", () => downloadImage(apiUrl, image), item.id);
            const repo = options.repositoryRoot ?? path.resolve(options.projectRoot, "../..");
            const projectId = path.basename(options.projectRoot);
            await unit.recorder.measure("save", () => withCandidateMutationLock(repo, projectId, () => storage.withPageLocks(repo, projectId, [item.page_key.page_id], async () => {
              await resolveExactPageIdentity(options.projectRoot, item.page_key);
              return publishCandidateResult(options.projectRoot, task, { ...item, generated_at: generatedAt }, bytes, { submission: unit.submission });
            })), item.id);
          }
          await commit((current) => {
            const currentItem = current.items.find((entry) => entry.id === item.id);
            if (!currentItem || currentItem.status === "discarded") return;
            currentItem.status = "available";
            currentItem.prompt_id = unit.promptId;
            currentItem.generated_at = generatedAt;
          });
          await progressWriter.write(unit.progress("available"));
          console.log(`已生成：${item.file}`);
        }
        if (missing.length || history?.status?.status_str === "error") throw new Error(`ComfyUI 批次未完整完成，已保留成功成果；缺失：${missing.join(", ")}`);
      } finally {
        if (unit.progressSocket) {
          unit.progressSocket.close();
          unit.progressSocket = null;
        }
        await progressWriter.flush();
      }
    };

    // 预提交队列模式:统一轮询所有已提交单元,完成一张下载一张,
    // 轮询间隔 500ms,每个单元独立 15 分钟超时
    async function pollUnits(pending) {
      const remaining = new Map(pending.map((unit) => [unit, Date.now() + 15 * 60_000]));
      while (remaining.size) {
        const settled = [];
        for (const [unit, deadline] of remaining) {
          if (Date.now() > deadline) throw new Error(`等待 ComfyUI 任务超时：${unit.promptId}`);
          const history = await fetchJson(`${apiUrl}/history/${encodeURIComponent(unit.promptId)}`);
          const item = history[unit.promptId];
          if (item?.outputs && Object.keys(item.outputs).length) settled.push([unit, item]);
          else if (item?.status?.status_str === "error") {
            unit.comfyTerminalConfirmed = true;
            throw new Error(`ComfyUI 任务失败：${JSON.stringify(item.status.messages ?? [])}`);
          }
        }
        for (const [unit, history] of settled) {
          remaining.delete(unit);
          await collectUnit(unit, history);
        }
        if (remaining.size) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    let domainCompleted = false;
    if (execution.queueAll && !queueReference) {
      // 预提交全部单元,再统一等待与下载
      for (const unit of pendingUnits) await submitUnit(unit);
      await pollUnits(pendingUnits);
    } else {
      // 默认模式:逐单元提交、等待、下载,与原有串行行为一致
      for (const [unitIndex, unit] of pendingUnits.entries()) {
        let lease = null;
        try {
          try {
            lease = queueReference
              ? await waitForGenerationUnitTurn(queueRepositoryRoot, queueReference, unit.plan.id, { drainApiUrl: apiUrl })
              : null;
          } catch (error) {
            if (queueReference && error?.code === "generation_task_removed") return await readRenderTask(options.projectRoot, task.id);
            throw error;
          }
          if (queueReference) await commit((current) => {
            if (current.status === "queued") {
              current.status = "running";
              current.started_at ??= new Date().toISOString();
            }
          });
          await submitUnit(unit);
          await collectUnit(unit);
          const isLastUnit = unitIndex === pendingUnits.length - 1;
          if (isLastUnit) {
            // Terminalize the domain before the final queue cleanup.  A
            // concurrently linearized cancel therefore cannot turn a
            // fully published task back into a non-terminal result.
            const completedAt = new Date().toISOString();
            await commit((current) => {
              current.status = "completed";
              current.completed_at = completedAt;
            });
            domainCompleted = true;
          }
          const activeLease = lease;
          const control = await activeLease?.release({ completed: isLastUnit, domainCompleted: isLastUnit }) ?? { action: null };
          lease = null;
          if (!isLastUnit && control.action === "cancel") {
            await commit((current) => {
              current.status = "cancelled";
              for (const item of current.items) if (["queued", "running"].includes(item.status)) item.status = "cancelled";
              current.completed_at = null;
            });
            return;
          }
        } finally {
          // 正常释放持久化失败时，仍持有原凭证，在 finally 中再尝试一次。
          const uncertain = Boolean(unit.submittedToComfy && !unit.comfyTerminalConfirmed);
          if (lease) await lease.release({ completed: domainCompleted, domainCompleted, draining: uncertain, drainApiUrl: uncertain ? apiUrl : null });
        }
      }
    }
    if (!domainCompleted) {
      const completedAt = new Date().toISOString();
      await commit((current) => {
        current.status = "completed";
        current.completed_at = completedAt;
      });
    }
  } catch (error) {
    for (const unit of waitingUnits) await unit.finishWait(error);
    throw error;
  }
}

export async function runPersistedRenderTask({ projectRoot, repositoryRoot = null, taskId, apiUrl = null, generationQueue = null }) {
  if (typeof taskId !== "string" || !renderTaskIdPattern.test(taskId)) {
    throw new Error("执行器只接受有效的已持久化渲染任务 ID");
  }
  return executeGenerationTask({ projectRoot, taskId, purpose: "candidate", generationQueue },
    () => runRender({ projectRoot, repositoryRoot, apiUrl, generationQueue }, taskId));
}
