import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";

import { comfyProcessError, discoverLocalComfyProcess, resolveLocalComfyTarget } from "./comfy-runtime.mjs";

function cpuTimesSnapshot(cpuReader) {
  return cpuReader().reduce((result, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: result.idle + cpu.times.idle, total: result.total + total };
  }, { idle: 0, total: 0 });
}

function percent(value) {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

export function parseNvidiaSmiOutput(output) {
  return String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length !== 5) throw new Error("invalid_nvidia_smi_output");
    const [index, name, utilization, memoryUsedMiB, memoryTotalMiB] = fields;
    const values = [index, utilization, memoryUsedMiB, memoryTotalMiB].map(Number);
    if (!name || values.some((value) => !Number.isFinite(value)) || values[3] <= 0) throw new Error("invalid_nvidia_smi_output");
    const memoryUsedBytes = values[2] * 1024 * 1024;
    const memoryTotalBytes = values[3] * 1024 * 1024;
    return {
      index: values[0],
      name,
      utilization: percent(values[1]),
      memory_used_bytes: memoryUsedBytes,
      memory_total_bytes: memoryTotalBytes,
      memory_utilization: percent(memoryUsedBytes / memoryTotalBytes * 100),
    };
  });
}

export function queryNvidiaGpus() {
  return new Promise((resolve, reject) => {
    execFile("nvidia-smi", [
      "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ], { windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else {
        try { resolve(parseNvidiaSmiOutput(stdout)); }
        catch (parseError) { reject(parseError); }
      }
    });
  });
}

function unavailableComfyStatus(reason, { pid = null, version = null } = {}) {
  return {
    status: "unavailable",
    reason,
    pid,
    version,
    gpu_memory_bytes: null,
    memory_working_set_bytes: null,
    memory_private_bytes: null,
    sampled_at: null,
  };
}

const knownComfyProbeFailures = new Set([
  "endpoint_unavailable",
  "invalid_endpoint_response",
  "listener_not_found",
  "listener_ambiguous",
  "process_not_found",
  "process_identity_mismatch",
  "process_metrics_unavailable",
  "unsupported_platform",
]);

export function createHardwareStatusReader({
  gpuReader = queryNvidiaGpus,
  comfyEndpointSelector,
  comfyuiRoot,
  managedComfyUiUrl = null,
  comfyProcessReader = discoverLocalComfyProcess,
  comfyRefreshMs = 10_000,
  clock = Date.now,
  cpuReader = cpus,
  totalMemoryReader = totalmem,
  freeMemoryReader = freemem,
} = {}) {
  let previousCpuTimes = cpuTimesSnapshot(cpuReader);
  let comfyCache = null;
  let comfyQuery = null;
  let comfyQueryStartedAt = Number.NEGATIVE_INFINITY;
  let cachedUrl = null;

  async function comfyProcessStatus() {
    const endpoint = comfyEndpointSelector?.status?.() ?? {
      status: "unavailable", reason: "not_configured", url: null,
      endpoint_index: null, endpoint_count: 0, version: null, checked_at: null,
    };
    const comfyuiUrl = endpoint.url ?? comfyEndpointSelector?.currentUrl?.() ?? "";
    const { reason: targetReason, target: comfyTarget } = resolveLocalComfyTarget(comfyuiUrl, comfyuiRoot);
    const remote = targetReason === "remote_instance";
    const endpointFields = {
      url: comfyuiUrl || null,
      endpoint_index: endpoint.endpoint_index,
      endpoint_count: endpoint.endpoint_count,
      endpoints: (comfyEndpointSelector?.endpoints?.() ?? (endpoint.url ? [endpoint] : [])).map((item) => ({
        url: item.url,
        endpoint_index: item.endpoint_index,
        status: item.status,
        version: item.version,
        checked_at: item.checked_at,
        kind: resolveLocalComfyTarget(item.url, comfyuiRoot).reason === "remote_instance" ? "remote" : "local",
        managed: item.url === managedComfyUiUrl,
      })),
    };
    if (remote) {
      return {
        ...(endpoint.status === "available"
          ? {
            status: "available", reason: "remote_instance", pid: null,
            version: endpoint.version, gpu_memory_bytes: null,
            memory_working_set_bytes: null, memory_private_bytes: null,
            sampled_at: endpoint.checked_at,
          }
          : endpoint.status === "checking"
            ? {
              status: "checking", reason: "remote_instance", pid: null,
              version: null, gpu_memory_bytes: null,
              memory_working_set_bytes: null, memory_private_bytes: null,
              sampled_at: null,
            }
            : unavailableComfyStatus("remote_endpoint_unavailable")),
        ...endpointFields,
      };
    }
    if (!comfyTarget) return { ...unavailableComfyStatus(targetReason), ...endpointFields };
    if (cachedUrl !== comfyuiUrl) {
      cachedUrl = comfyuiUrl;
      comfyCache = null;
      comfyQueryStartedAt = Number.NEGATIVE_INFINITY;
    }
    const now = clock();
    if (!comfyQuery && now - comfyQueryStartedAt >= comfyRefreshMs) {
      comfyQueryStartedAt = now;
      const probe = comfyProcessReader(comfyTarget);
      comfyQuery = Promise.resolve(probe).then((value) => {
        if (!value) throw comfyProcessError("process_metrics_unavailable");
        const pid = Number(value.pid);
        if (!Number.isInteger(pid) || pid <= 0) throw comfyProcessError("process_not_found");
        comfyCache = {
          status: "available",
          reason: null,
          pid,
          version: typeof value.version === "string" ? value.version : null,
          gpu_memory_bytes: Number.isFinite(Number(value.gpu_memory_bytes)) ? Number(value.gpu_memory_bytes) : null,
          memory_working_set_bytes: Number.isFinite(Number(value.memory_working_set_bytes)) ? Number(value.memory_working_set_bytes) : null,
          memory_private_bytes: Number.isFinite(Number(value.memory_private_bytes)) ? Number(value.memory_private_bytes) : null,
          sampled_at: new Date(clock()).toISOString(),
        };
      }).catch((error) => {
        comfyCache = unavailableComfyStatus(knownComfyProbeFailures.has(error?.code) ? error.code : "process_metrics_unavailable");
      }).finally(() => { comfyQuery = null; });
    }
    return { ...(comfyCache ?? {
      status: "checking",
      reason: null,
      pid: null,
      version: null,
      gpu_memory_bytes: null,
      memory_working_set_bytes: null,
      memory_private_bytes: null,
      sampled_at: null,
    }), ...endpointFields };
  }

  async function readHardwareStatus() {
    const nextCpuTimes = cpuTimesSnapshot(cpuReader);
    const totalDelta = nextCpuTimes.total - previousCpuTimes.total;
    const idleDelta = nextCpuTimes.idle - previousCpuTimes.idle;
    previousCpuTimes = nextCpuTimes;
    const totalMemory = totalMemoryReader();
    const freeMemory = freeMemoryReader();
    let gpu;
    try {
      const devices = await gpuReader();
      gpu = { available: true, source: "nvidia-smi", error: null, devices };
    } catch (error) {
      gpu = {
        available: false,
        source: "nvidia-smi",
        error: error?.code === "ENOENT" ? "nvidia_smi_not_found" : "nvidia_smi_failed",
        devices: [],
      };
    }
    return {
      sampled_at: new Date(clock()).toISOString(),
      cpu: {
        utilization: totalDelta > 0 ? percent((1 - idleDelta / totalDelta) * 100) : null,
        logical_processors: cpuReader().length,
      },
      memory: {
        used_bytes: totalMemory - freeMemory,
        total_bytes: totalMemory,
        utilization: totalMemory > 0 ? percent((totalMemory - freeMemory) / totalMemory * 100) : null,
      },
      gpu,
      comfyui: await comfyProcessStatus(),
    };
  }

  readHardwareStatus.invalidateComfyUi = () => {
    comfyCache = null;
    comfyQueryStartedAt = Number.NEGATIVE_INFINITY;
  };
  return readHardwareStatus;
}
