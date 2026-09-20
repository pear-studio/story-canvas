import assert from "node:assert/strict";
import test from "node:test";

import { createHardwareStatusReader, parseNvidiaSmiOutput } from "../server/hardware-status.mjs";
import { createComfyEndpointSelector } from "../server/comfy-endpoint-selector.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const cpuReader = () => [{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }];
const fixedEndpoint = (url) => ({
  currentUrl: () => url,
  status: () => ({ status: "available", reason: null, url, endpoint_index: 0, endpoint_count: url ? 1 : 0, version: null, checked_at: null }),
});

test("NVIDIA CSV is converted into stable byte and utilization fields", () => {
  assert.deepEqual(parseNvidiaSmiOutput("0, RTX 4090, 12.34, 1024, 24576\n"), [{
    index: 0,
    name: "RTX 4090",
    utilization: 12.3,
    memory_used_bytes: 1024 * 1024 * 1024,
    memory_total_bytes: 24576 * 1024 * 1024,
    memory_utilization: 4.2,
  }]);
  assert.throws(() => parseNvidiaSmiOutput("0, incomplete"), /invalid_nvidia_smi_output/);
});

test("hardware reads share one non-blocking Comfy probe and reuse its cached result", async () => {
  const probe = deferred();
  let processReads = 0;
  const reader = createHardwareStatusReader({
    gpuReader: async () => [],
    comfyEndpointSelector: fixedEndpoint("http://127.0.0.1:8188"),
    comfyuiRoot: "D:/ComfyUI",
    managedComfyUiUrl: "http://127.0.0.1:8188",
    comfyProcessReader: () => { processReads += 1; return probe.promise; },
    comfyRefreshMs: 10_000,
    clock: () => 1_000,
    cpuReader,
    totalMemoryReader: () => 1000,
    freeMemoryReader: () => 250,
  });

  const [first, second] = await Promise.all([reader(), reader()]);
  assert.equal(first.comfyui.status, "checking");
  assert.equal(second.comfyui.status, "checking");
  assert.equal(processReads, 1, "concurrent hardware reads must share the same process probe");

  probe.resolve({ pid: 42, version: "0.3.0", gpu_memory_bytes: 50, memory_working_set_bytes: 60, memory_private_bytes: 70 });
  await flushPromises();
  const cached = await reader();
  assert.deepEqual(cached.comfyui, {
    status: "available",
    reason: null,
    pid: 42,
    version: "0.3.0",
    gpu_memory_bytes: 50,
    memory_working_set_bytes: 60,
    memory_private_bytes: 70,
    sampled_at: "1970-01-01T00:00:01.000Z",
    url: "http://127.0.0.1:8188",
    endpoint_index: 0,
    endpoint_count: 1,
    endpoints: [{ url: "http://127.0.0.1:8188", endpoint_index: 0, status: "available", version: null, checked_at: null, kind: "local", managed: true }],
  });
  assert.equal(processReads, 1);
});

test("hardware status remains available when nvidia-smi fails", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const reader = createHardwareStatusReader({
    gpuReader: async () => { throw missing; },
    comfyEndpointSelector: fixedEndpoint(""),
    clock: () => 1_000,
    cpuReader,
    totalMemoryReader: () => 1000,
    freeMemoryReader: () => 250,
  });

  const status = await reader();
  assert.deepEqual(status.gpu, { available: false, source: "nvidia-smi", error: "nvidia_smi_not_found", devices: [] });
  assert.equal(status.memory.utilization, 75);
  assert.equal(status.comfyui.reason, "not_configured");
});

test("remote ComfyUI status is probed without exposing remote process metrics", async () => {
  const probe = deferred();
  const selector = createComfyEndpointSelector({ urls: ["http://windows-gpu:8188"], probe: () => probe.promise, clock: () => 1_000 });
  const reader = createHardwareStatusReader({
    gpuReader: async () => [],
    comfyEndpointSelector: selector,
    clock: () => 1_000,
    cpuReader,
    totalMemoryReader: () => 1000,
    freeMemoryReader: () => 250,
  });

  const refresh = selector.refresh();
  const checking = await reader();
  assert.deepEqual(checking.comfyui, {
    status: "checking",
    reason: "remote_instance",
    pid: null,
    version: null,
    gpu_memory_bytes: null,
    memory_working_set_bytes: null,
    memory_private_bytes: null,
    sampled_at: null,
    url: "http://windows-gpu:8188",
    endpoint_index: 0,
    endpoint_count: 1,
    endpoints: [{ url: "http://windows-gpu:8188", endpoint_index: 0, status: "checking", version: null, checked_at: null, kind: "remote", managed: false }],
  });

  probe.resolve({ version: "0.4.0" });
  await refresh;
  const online = await reader();
  assert.deepEqual(online.comfyui, {
    status: "available",
    reason: "remote_instance",
    pid: null,
    version: "0.4.0",
    gpu_memory_bytes: null,
    memory_working_set_bytes: null,
    memory_private_bytes: null,
    sampled_at: "1970-01-01T00:00:01.000Z",
    url: "http://windows-gpu:8188",
    endpoint_index: 0,
    endpoint_count: 1,
    endpoints: [{ url: "http://windows-gpu:8188", endpoint_index: 0, status: "available", version: "0.4.0", checked_at: "1970-01-01T00:00:01.000Z", kind: "remote", managed: false }],
  });
});

test("remote ComfyUI probe failures become a simple offline state", async () => {
  const selector = createComfyEndpointSelector({
    urls: ["http://windows-gpu:8188"],
    probe: async () => { throw new Error("offline"); },
  });
  await selector.refresh();
  const reader = createHardwareStatusReader({
    gpuReader: async () => [],
    comfyEndpointSelector: selector,
    clock: () => 1_000,
    cpuReader,
    totalMemoryReader: () => 1000,
    freeMemoryReader: () => 250,
  });

  assert.equal((await reader()).comfyui.reason, "remote_endpoint_unavailable");
});
