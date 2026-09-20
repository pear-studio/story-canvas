import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import path from "node:path";

import {
  clearStaleComfyCliBackground,
  ComfyCliError,
  COMFY_CLI_INSTALL_TIMEOUT_MS,
  COMFY_CLI_MAINTENANCE_TIMEOUT_MS,
  runComfyCli,
} from "./comfy-cli.mjs";
import { primaryComfyUiUrl } from "./comfy-endpoint-selector.mjs";

function configuredPath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function comfyProcessError(code) {
  return Object.assign(new Error(code), { code });
}

export function classifyComfyProcessProbeFailure(stderr) {
  return ["listener_not_found", "listener_ambiguous", "process_not_found"]
    .find((code) => String(stderr ?? "").includes(code)) ?? "process_metrics_unavailable";
}

export function comfyProcessBelongsToRoot(value, comfyuiRoot) {
  if (!value || typeof comfyuiRoot !== "string" || !comfyuiRoot.trim()) return false;
  const expectedRoot = path.resolve(comfyuiRoot);
  const processes = [value, ...(Array.isArray(value.process_chain) ? value.process_chain : [])];
  return processes.some((processInfo) => {
    const executable = typeof processInfo?.executable === "string" && processInfo.executable
      ? path.resolve(processInfo.executable)
      : null;
    return Boolean(executable && isWithin(expectedRoot, executable));
  });
}

export function comfyLaunchRecordMatchesProcessChain(value, plannedPid, comfyuiRoot) {
  const listenerPid = Number(value?.pid);
  const targetPid = Number(plannedPid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  if (targetPid === listenerPid) return true;
  return comfyRecordedLauncherMatchesProcess(value, targetPid, comfyuiRoot);
}

export function comfyRecordedLauncherMatchesProcess(value, plannedPid, comfyuiRoot) {
  const targetPid = Number(plannedPid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  if (typeof comfyuiRoot !== "string" || !comfyuiRoot.trim()) return false;
  const normalizedRoot = path.resolve(comfyuiRoot).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  const processInfo = [...(Array.isArray(value?.process_chain) ? value.process_chain : []), value]
    .find((item) => Number(item?.pid) === targetPid);
  if (!processInfo) return false;
  const commandLine = String(processInfo.command_line ?? "").replaceAll("/", "\\").toLowerCase();
  const invokesComfy = /(?:^|[\s"'])comfy(?:\.exe)?(?:[\s"']|$)/i.test(commandLine);
  const launches = /(?:^|\s)launch(?:\s|$)/i.test(commandLine);
  const selectsWorkspace = commandLine.includes(`--workspace=${normalizedRoot}`)
    || commandLine.includes(`--workspace="${normalizedRoot}"`)
    || commandLine.includes(`"--workspace=${normalizedRoot}"`);
  return invokesComfy && launches && selectsWorkspace;
}

export function resolveLocalComfyTarget(apiUrl, comfyuiRoot) {
  if (typeof apiUrl !== "string" || !apiUrl.trim()) return { reason: "not_configured", target: null };
  let url;
  try { url = new URL(apiUrl); }
  catch { return { reason: "invalid_url", target: null }; }
  if (!new Set(["http:", "https:"]).has(url.protocol)) return { reason: "invalid_url", target: null };
  const configuredHost = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", hostname().toLowerCase()]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) localHosts.add(String(address.address).toLowerCase());
  }
  if (!localHosts.has(configuredHost) && !/^127(?:\.\d{1,3}){3}$/.test(configuredHost)) {
    return { reason: "remote_instance", target: null };
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { reason: "invalid_url", target: null };
  return {
    reason: null,
    target: {
      api_url: apiUrl.trim().replace(/\/+$/, ""),
      port,
      comfyui_root: typeof comfyuiRoot === "string" && comfyuiRoot.trim() ? comfyuiRoot : null,
    },
  };
}

export async function queryComfySystemStats(apiUrl) {
  let response;
  try {
    response = await fetch(`${apiUrl}/system_stats`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  } catch {
    throw comfyProcessError("endpoint_unavailable");
  }
  if (!response.ok) throw comfyProcessError("endpoint_unavailable");
  let value;
  try { value = await response.json(); }
  catch { throw comfyProcessError("invalid_endpoint_response"); }
  if (!value?.system || !Array.isArray(value.system.argv) || !value.system.argv.some((argument) => /main\.py$/i.test(String(argument)))) {
    throw comfyProcessError("invalid_endpoint_response");
  }
  return { version: typeof value.system.comfyui_version === "string" ? value.system.comfyui_version : null };
}

export function queryLocalComfyProcess(target) {
  if (process.platform !== "win32") return Promise.reject(comfyProcessError("unsupported_platform"));
  const port = Number(target?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(comfyProcessError("invalid_url"));
  // 只统计配置地址对应的监听，避免 Tailscale Serve 等绑定在其他本机地址上的同端口代理干扰身份确认。
  let addressFilter = "";
  try {
    const host = new URL(target?.api_url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopbacks = host === "localhost" ? ["127.0.0.1", "::1"] : /^127(?:\.\d{1,3}){3}$|^::1$/.test(host) ? [host] : [];
    // 全地址监听仍可能占用回环入口，不能当作空闲；IPv6 通配监听也可能是双栈。
    if (loopbacks.length) loopbacks.push(...(host === "::1" ? ["::"] : ["0.0.0.0", "::"]));
    if (loopbacks.length) addressFilter = ` | Where-Object { @(${loopbacks.map((address) => `'${address}'`).join(", ")}) -contains $_.LocalAddress }`;
  } catch { /* api_url 已由 resolveLocalComfyTarget 校验，异常时退化为不过滤。 */ }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$connections = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue${addressFilter})
if ($connections.Count -eq 0) { throw 'listener_not_found' }
$ownerPids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ownerPids.Count -ne 1) { throw 'listener_ambiguous' }
$targetPid = [int]$ownerPids[0]
$processById = @{}
foreach ($candidateProcess in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
  $processById[[string]$candidateProcess.ProcessId] = $candidateProcess
}
$winProcess = $processById[[string]$targetPid]
if (-not $winProcess) { throw 'process_not_found' }
$processInfo = Get-Process -Id $targetPid -ErrorAction Stop
$processChain = @()
$seenProcessIds = @{}
$currentProcess = $winProcess
for ($depth = 0; $depth -lt 12 -and $currentProcess; $depth += 1) {
  $currentPid = [int]$currentProcess.ProcessId
  if ($seenProcessIds.ContainsKey($currentPid)) { break }
  $seenProcessIds[$currentPid] = $true
  $processChain += [pscustomobject]@{
    pid = $currentPid
    parent_pid = [int]$currentProcess.ParentProcessId
    executable = $currentProcess.ExecutablePath
    command_line = $currentProcess.CommandLine
  }
  $parentPid = [int]$currentProcess.ParentProcessId
  if ($parentPid -le 0) { break }
  $currentProcess = $processById[[string]$parentPid]
}
$dedicatedGpuBytes = $null
try {
  $samples = (Get-Counter -Counter "\GPU Process Memory(pid_$($targetPid)_*)\Dedicated Usage" -ErrorAction Stop).CounterSamples
  $dedicatedGpuBytes = [long](($samples | Measure-Object -Property CookedValue -Sum).Sum)
} catch {}
[pscustomobject]@{
  pid = $targetPid
  executable = $winProcess.ExecutablePath
  command_line = $winProcess.CommandLine
  process_chain = @($processChain)
  gpu_memory_bytes = $dedicatedGpuBytes
  memory_working_set_bytes = [long]$processInfo.WorkingSet64
  memory_private_bytes = [long]$processInfo.PrivateMemorySize64
} | ConvertTo-Json -Compress -Depth 4
`;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(comfyProcessError(classifyComfyProcessProbeFailure(stderr)));
        return;
      }
      try {
        const value = JSON.parse(stdout);
        const commandLine = String(value.command_line ?? "");
        if (!/main\.py/i.test(commandLine)) throw comfyProcessError("process_identity_mismatch");
        if (target.comfyui_root && !comfyProcessBelongsToRoot(value, target.comfyui_root)) throw comfyProcessError("process_identity_mismatch");
        resolve(value);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

export function queryWindowsProcessByPid(pid) {
  if (process.platform !== "win32") return Promise.reject(comfyProcessError("unsupported_platform"));
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return Promise.reject(comfyProcessError("process_not_found"));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = ${targetPid}
$processById = @{}
foreach ($candidateProcess in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
  $processById[[string]$candidateProcess.ProcessId] = $candidateProcess
}
$winProcess = $processById[[string]$targetPid]
if (-not $winProcess) { throw 'process_not_found' }
$processChain = @()
$seenProcessIds = @{}
$currentProcess = $winProcess
for ($depth = 0; $depth -lt 12 -and $currentProcess; $depth += 1) {
  $currentPid = [int]$currentProcess.ProcessId
  if ($seenProcessIds.ContainsKey($currentPid)) { break }
  $seenProcessIds[$currentPid] = $true
  $processChain += [pscustomobject]@{
    pid = $currentPid
    parent_pid = [int]$currentProcess.ParentProcessId
    executable = $currentProcess.ExecutablePath
    command_line = $currentProcess.CommandLine
  }
  $parentPid = [int]$currentProcess.ParentProcessId
  if ($parentPid -le 0) { break }
  $currentProcess = $processById[[string]$parentPid]
}
[pscustomobject]@{
  pid = $targetPid
  executable = $winProcess.ExecutablePath
  command_line = $winProcess.CommandLine
  process_chain = @($processChain)
} | ConvertTo-Json -Compress -Depth 4
`;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(comfyProcessError(classifyComfyProcessProbeFailure(stderr)));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (parseError) { reject(parseError); }
    });
  });
}

export async function discoverLocalComfyProcess(target) {
  const processMetrics = await queryLocalComfyProcess(target);
  let system;
  try {
    system = await queryComfySystemStats(target.api_url);
  } catch (error) {
    error.process_detected = true;
    throw error;
  }
  return { ...processMetrics, version: system.version };
}

export class ComfyRuntimeError extends Error {
  constructor(code, details, status = 409) {
    super(code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

const stoppedComfyReasons = new Set(["endpoint_unavailable", "listener_not_found", "process_not_found"]);

export function isConfirmedComfyStopped(error) {
  return stoppedComfyReasons.has(error?.code) && error?.process_detected !== true;
}

const comfyInstallDeviceArgs = new Map([
  ["nvidia", ["--nvidia"]],
  ["amd", ["--amd"]],
  ["m-series", ["--m-series"]],
  ["cpu", ["--cpu"]],
]);
const comfyWorkspaceMarkers = ["main.py", "comfy", "nodes.py", "comfy_extras", "comfy_api"];

async function inspectComfyWorkspace(comfyuiRoot) {
  if (!comfyuiRoot) return { status: "missing", markers: [] };
  let root;
  try {
    root = await lstat(comfyuiRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", markers: [] };
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return { status: "partial", markers: [], reason: "workspace_root_not_directory" };
  }
  const markers = [];
  for (const marker of comfyWorkspaceMarkers) {
    try {
      await lstat(path.join(comfyuiRoot, marker));
      markers.push(marker);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return markers.length >= 4
    ? { status: "installed", markers }
    : { status: "partial", markers, reason: "workspace_markers_incomplete" };
}

function normalizeComfyInstallSource(projectRoot, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = value.trim();
  if (/^https:\/\//i.test(source)) return source;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
    throw new ComfyRuntimeError("comfyui_install_source_invalid", ["comfy_install_source 只接受 HTTPS Git 地址或本机路径"], 422);
  }
  return configuredPath(projectRoot, source);
}

function classifyComfyInstallFailure(error, workspaceState) {
  const evidence = JSON.stringify([error?.message, error?.details]).toLowerCase();
  if (/pytorch|torch|download\.pytorch\.org|cuda/.test(evidence)) return "torch";
  if (/requirements\.txt|requirement|dependency|dependencies|pip install/.test(evidence)) return "requirements";
  if (/virtual environment|virtualenv|venv|ensurepip|no module named pip|python/.test(evidence)) return "python";
  return workspaceState?.status === "missing" ? "clone" : "requirements";
}

function requireComfyInstallDevice(device) {
  if (typeof device !== "string" || !comfyInstallDeviceArgs.has(device)) {
    throw new ComfyRuntimeError("comfyui_install_device_required", ["首次安装必须显式指定 device：nvidia、amd、m-series 或 cpu"], 422);
  }
  return device;
}

function normalizedComfyHost(value) {
  const host = String(value ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" ? "127.0.0.1" : host;
}

async function queryComfyQueue(apiUrl) {
  let response;
  try {
    response = await fetch(`${apiUrl}/queue`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  } catch {
    throw new ComfyRuntimeError("comfyui_queue_unavailable", ["无法确认 ComfyUI 队列是否为空，未执行关闭"]);
  }
  if (!response.ok) throw new ComfyRuntimeError("comfyui_queue_unavailable", ["无法确认 ComfyUI 队列是否为空，未执行关闭"]);
  const value = await response.json().catch(() => null);
  if (!value || !Array.isArray(value.queue_running) || !Array.isArray(value.queue_pending)) {
    throw new ComfyRuntimeError("comfyui_queue_unavailable", ["ComfyUI 队列响应无效，未执行关闭"]);
  }
  return { running: value.queue_running.length, pending: value.queue_pending.length };
}

async function launchComfyUiViaCli({ target, comfyuiRoot, comfyCli, cliRunner = runComfyCli }) {
  if (!comfyuiRoot) throw new ComfyRuntimeError("comfyui_root_not_configured", ["请先在本机配置 comfyui_root（comfy-cli workspace）"], 422);
  if (!comfyCli) throw new ComfyRuntimeError("comfy_cli_not_configured", ["请先在本机配置 comfy_cli"], 422);
  const configuredHost = new URL(target.api_url).hostname.replace(/^\[|\]$/g, "");
  const listenHost = configuredHost.toLowerCase() === "localhost" ? "127.0.0.1" : configuredHost;
  try {
    await cliRunner({ executable: comfyCli, workspace: comfyuiRoot, args: ["launch", "--background", "--", "--disable-auto-launch", "--listen", listenHost, "--port", String(target.port)] });
  } catch (error) {
    if (error instanceof ComfyCliError) throw new ComfyRuntimeError(error.code, [error.message, error.details].filter(Boolean), error.status);
    throw new ComfyRuntimeError("comfyui_cli_failed", [error?.message ?? "comfy-cli 启动失败"]);
  }
}

export function createComfyRuntimeController({
  projectRoot,
  config,
  processReader = discoverLocalComfyProcess,
  queueReader = (target) => queryComfyQueue(target.api_url),
  launcher = launchComfyUiViaCli,
  recordedProcessReader = queryWindowsProcessByPid,
  backgroundRecordCleaner = clearStaleComfyCliBackground,
  stopper = async (pid, { target, comfyCli, comfyuiRoot, cliRunner = runComfyCli } = {}) => {
    if (!comfyCli || !comfyuiRoot) throw new ComfyRuntimeError("comfy_cli_not_configured", ["请先在本机配置 comfy_cli 和 comfyui_root"], 422);
    if (!Number.isInteger(Number(target?.port))) throw new ComfyRuntimeError("comfyui_invalid_url", ["未取得可信的 ComfyUI 端口，未执行关闭"], 422);
    try {
      return await cliRunner({ executable: comfyCli, workspace: comfyuiRoot, args: ["stop", "--port", String(target.port)] });
    } catch (error) {
      if (error instanceof ComfyCliError) throw new ComfyRuntimeError(error.code, [error.message, error.details].filter(Boolean), error.status);
      throw new ComfyRuntimeError("comfyui_cli_failed", [error?.message ?? "comfy-cli 停止失败"]);
    }
  },
  cliRunner = runComfyCli,
  workspaceInspector = inspectComfyWorkspace,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  startAttempts = 240,
  stopAttempts = 30,
} = {}) {
  const comfyuiRoot = configuredPath(projectRoot, config?.comfyui_root);
  const comfyCli = configuredPath(projectRoot, config?.comfy_cli);
  const { reason, target } = resolveLocalComfyTarget(primaryComfyUiUrl(config), comfyuiRoot);
  let operation = null;

  function requireTarget(action) {
    if (target) return target;
    const details = reason === "remote_instance"
      ? ["远程 ComfyUI 不能由当前工作台启停"]
      : [action === "start" ? "本机 ComfyUI 地址配置无效，无法启动" : "本机 ComfyUI 地址配置无效，无法关闭"];
    throw new ComfyRuntimeError(`comfyui_${reason ?? "not_configured"}`, details, 422);
  }

  async function verifyCliWorkspace() {
    if (!comfyCli) throw new ComfyRuntimeError("comfy_cli_not_configured", ["请先在本机配置 comfy_cli"], 422);
    if (!comfyuiRoot) throw new ComfyRuntimeError("comfyui_root_not_configured", ["请先在本机配置 comfyui_root（comfy-cli workspace）"], 422);
    try {
      const result = await cliRunner({ executable: comfyCli, workspace: comfyuiRoot, args: ["which"] });
      const workspacePath = result?.data?.workspace_path;
      if (typeof workspacePath !== "string" || path.resolve(workspacePath) !== path.resolve(comfyuiRoot)) {
        throw new ComfyRuntimeError("comfy_cli_workspace_mismatch", ["comfy-cli 返回的 workspace 与 comfyui_root 不一致"], 422);
      }
      return result;
    } catch (error) {
      if (error instanceof ComfyRuntimeError) throw error;
      if (error instanceof ComfyCliError) throw new ComfyRuntimeError(error.code, [error.message, error.details].filter(Boolean), error.status);
      throw new ComfyRuntimeError("comfy_cli_failed", [error?.message ?? "comfy-cli workspace 验证失败"]);
    }
  }

  async function invokeCli(args, { cwd = comfyuiRoot, timeoutMs, allowMissingEnvelope = false } = {}) {
    try {
      return await cliRunner({ executable: comfyCli, workspace: comfyuiRoot, args, cwd, timeoutMs, allowMissingEnvelope });
    } catch (error) {
      if (error instanceof ComfyCliError) throw new ComfyRuntimeError(error.code, [error.message, error.details].filter(Boolean), error.status);
      throw new ComfyRuntimeError("comfyui_cli_failed", [error?.message ?? "comfy-cli 命令失败"]);
    }
  }

  async function launchWithStaleRecordRecovery(localTarget) {
    try {
      await launcher({ projectRoot, target: localTarget, comfyuiRoot, comfyCli, cliRunner });
      return;
    } catch (error) {
      if (error?.code !== "comfy_cli_server_already_running") throw error;
    }

    const dryRun = await invokeCli(["stop", "--dry-run"]);
    const planned = dryRun?.data;
    const expectedHost = normalizedComfyHost(new URL(localTarget.api_url).hostname);
    if (
      !planned || planned.dry_run !== true || planned.untracked === true
      || normalizedComfyHost(planned.host) !== expectedHost
      || Number(planned.port) !== Number(localTarget.port)
      || !Number.isInteger(Number(planned.pid)) || Number(planned.pid) <= 0
    ) {
      throw new ComfyRuntimeError("comfyui_cli_background_conflict", [
        "comfy-cli 记录了另一个或无法确认的后台服务，未自动清理",
      ]);
    }

    let recordedProcess = null;
    try { recordedProcess = await recordedProcessReader(Number(planned.pid)); }
    catch (error) {
      if (error?.code !== "process_not_found") {
        throw new ComfyRuntimeError("comfyui_identity_unverified", ["无法确认 comfy-cli 后台记录对应的进程，未自动清理"]);
      }
    }
    if (recordedProcess && comfyRecordedLauncherMatchesProcess(recordedProcess, planned.pid, comfyuiRoot)) {
      throw new ComfyRuntimeError("comfyui_start_in_progress", [
        "comfy-cli 后台记录仍属于当前 workspace 的启动进程，请稍候或查看 ComfyUI 日志",
      ]);
    }

    try {
      await backgroundRecordCleaner({
        executable: comfyCli,
        workspace: comfyuiRoot,
        expected: { host: planned.host, port: Number(planned.port), pid: Number(planned.pid) },
        cliRunner,
      });
    } catch (error) {
      if (error instanceof ComfyCliError) {
        throw new ComfyRuntimeError(error.code, [error.message, error.details].filter(Boolean), error.status);
      }
      throw new ComfyRuntimeError("comfyui_cli_background_cleanup_failed", [error?.message ?? "comfy-cli 陈旧后台记录清理失败"]);
    }
    await launcher({ projectRoot, target: localTarget, comfyuiRoot, comfyCli, cliRunner });
  }

  async function assertComfyStoppedForMaintenance() {
    const localTarget = requireTarget("maintenance");
    let current;
    try {
      current = await processReader(localTarget);
    } catch (error) {
      if (isConfirmedComfyStopped(error)) return;
      throw new ComfyRuntimeError("comfyui_identity_unverified", ["无法确认 ComfyUI 是否属于当前 workspace，未执行环境维护"]);
    }
    let queue;
    try {
      queue = await queueReader(localTarget);
    } catch (error) {
      if (error instanceof ComfyRuntimeError) throw error;
      throw new ComfyRuntimeError("comfyui_queue_unavailable", ["无法确认 ComfyUI 队列是否为空，未执行环境维护"]);
    }
    if (Number(queue.running) + Number(queue.pending) > 0) {
      throw new ComfyRuntimeError("comfyui_queue_busy", [`ComfyUI 自身队列还有 ${Number(queue.running) + Number(queue.pending)} 个任务，不能维护环境`]);
    }
    throw new ComfyRuntimeError("comfyui_running", [`ComfyUI 当前仍在运行（PID ${Number(current.pid) || "未知"}），请先关闭后再维护环境`]);
  }

  async function runMaintenanceCommand(args) {
    await verifyCliWorkspace();
    const result = await invokeCli(args, {
      cwd: comfyuiRoot,
      timeoutMs: COMFY_CLI_MAINTENANCE_TIMEOUT_MS,
      allowMissingEnvelope: true,
    });
    const postCheck = await verifyCliWorkspace();
    return {
      ...result,
      data: { ...(result.data && typeof result.data === "object" ? result.data : {}), post_check: { workspace_path: postCheck?.data?.workspace_path ?? comfyuiRoot } },
    };
  }

  async function runInstallCommand(installDevice) {
    const before = await workspaceInspector(comfyuiRoot);
    if (before?.status === "partial") {
      throw new ComfyRuntimeError("comfyui_install_partial_workspace", [{
        workspace_path: comfyuiRoot,
        markers: Array.isArray(before.markers) ? before.markers : [],
        reason: before.reason ?? "workspace_markers_incomplete",
      }, "workspace 既不是空路径也不是可恢复的 ComfyUI 仓库；请先检查或移走该目录"], 409);
    }
    const restored = before?.status === "installed";
    const installSource = normalizeComfyInstallSource(projectRoot, config?.comfy_install_source);
    const args = ["install"];
    if (restored) args.push("--restore");
    args.push("--skip-manager");
    if (installSource) args.push("--url", installSource);
    args.push(...comfyInstallDeviceArgs.get(installDevice));

    let result;
    try {
      result = await invokeCli(args, {
        cwd: tmpdir(),
        timeoutMs: COMFY_CLI_INSTALL_TIMEOUT_MS,
        allowMissingEnvelope: true,
      });
    } catch (error) {
      let after = before;
      try { after = await workspaceInspector(comfyuiRoot); }
      catch { /* workspace 状态只用于细化安装失败阶段。 */ }
      const stage = classifyComfyInstallFailure(error, after);
      throw new ComfyRuntimeError(`comfyui_install_${stage}_failed`, [
        stage === "clone" ? "ComfyUI 源码取得失败" : stage === "torch" ? "PyTorch 依赖安装失败" : stage === "python" ? "Python 虚拟环境创建失败" : "ComfyUI Python 依赖安装失败",
        { stage, cause: error?.code ?? "comfy_cli_failed", details: error?.details ?? null, workspace_status: after?.status ?? "unknown" },
      ], error?.status ?? 409);
    }

    const postCheck = await workspaceInspector(comfyuiRoot);
    if (postCheck?.status !== "installed") {
      throw new ComfyRuntimeError("comfyui_install_post_check_failed", [
        "comfy-cli 已退出，但 workspace 未通过 ComfyUI 仓库完整性检查",
        { stage: "post_check", workspace_path: comfyuiRoot, workspace_status: postCheck?.status ?? "unknown", markers: postCheck?.markers ?? [] },
      ]);
    }
    const cliWorkspace = await verifyCliWorkspace();
    return {
      result: {
        ...result,
        data: { ...(result.data && typeof result.data === "object" ? result.data : {}), post_check: { workspace_path: cliWorkspace?.data?.workspace_path ?? comfyuiRoot } },
      },
      restored,
    };
  }

  async function serialized(run) {
    if (operation) throw new ComfyRuntimeError("comfyui_operation_in_progress", ["ComfyUI 正在执行另一项运行环境操作，请稍候"]);
    operation = Promise.resolve().then(run);
    try { return await operation; }
    finally { operation = null; }
  }

  return {
    start: () => serialized(async () => {
      const localTarget = requireTarget("start");
      await verifyCliWorkspace();
      try {
        const current = await processReader(localTarget);
        return { status: "running", already_running: true, pid: Number(current.pid), version: current.version ?? null };
      } catch (error) {
        if (!isConfirmedComfyStopped(error)) {
          throw new ComfyRuntimeError("comfyui_identity_unverified", ["当前端口上的进程无法确认为配置中的 ComfyUI，未执行启动"]);
        }
      }
      await launchWithStaleRecordRecovery(localTarget);
      for (let attempt = 0; attempt < startAttempts; attempt += 1) {
        try {
          const current = await processReader(localTarget);
          return { status: "running", already_running: false, pid: Number(current.pid), version: current.version ?? null };
        } catch (error) {
          if (!isConfirmedComfyStopped(error)) {
            throw new ComfyRuntimeError("comfyui_identity_unverified", ["启动后的进程无法确认为配置中的 ComfyUI"]);
          }
        }
        await delay(500);
      }
      throw new ComfyRuntimeError("comfyui_start_timeout", [`ComfyUI 启动超时，请查看 workspace 的 user/comfyui_${localTarget.port}.log`]);
    }),
    stop: () => serialized(async () => {
      const localTarget = requireTarget("stop");
      await verifyCliWorkspace();
      try {
        await processReader(localTarget);
      } catch (error) {
        if (isConfirmedComfyStopped(error)) return { status: "stopped", already_stopped: true };
        throw new ComfyRuntimeError("comfyui_identity_unverified", ["当前进程无法确认为配置中的 ComfyUI，未执行关闭"]);
      }
      let queue;
      try {
        queue = await queueReader(localTarget);
      } catch (error) {
        if (error instanceof ComfyRuntimeError) throw error;
        throw new ComfyRuntimeError("comfyui_queue_unavailable", ["无法确认 ComfyUI 队列是否为空，未执行关闭"]);
      }
      if (Number(queue.running) + Number(queue.pending) > 0) {
        throw new ComfyRuntimeError("comfyui_queue_busy", [`ComfyUI 自身队列还有 ${Number(queue.running) + Number(queue.pending)} 个任务，不能关闭`]);
      }
      const dryRun = await invokeCli(["stop", "--dry-run"]);
      const verified = await processReader(localTarget);
      const pid = Number(verified.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new ComfyRuntimeError("comfyui_identity_unverified", ["未取得可信的 ComfyUI 进程 ID，未执行关闭"]);
      const planned = dryRun?.data;
      const portDryRun = await invokeCli(["stop", "--port", String(localTarget.port), "--dry-run"]);
      const portTarget = portDryRun?.data;
      const expectedHost = normalizedComfyHost(new URL(localTarget.api_url).hostname);
      const portWorkspaceMatches = typeof portTarget?.cwd === "string"
        && path.resolve(portTarget.cwd).toLowerCase() === path.resolve(comfyuiRoot).toLowerCase();
      if (
        !planned || planned.dry_run !== true || planned.untracked === true
        || normalizedComfyHost(planned.host) !== expectedHost
        || Number(planned.port) !== Number(localTarget.port)
        || !comfyLaunchRecordMatchesProcessChain(verified, planned.pid, comfyuiRoot)
        || !portTarget || portTarget.dry_run !== true || portTarget.verified !== true || portTarget.untracked !== true
        || Number(portTarget.port) !== Number(localTarget.port)
        || Number(portTarget.pid) !== pid
        || !portWorkspaceMatches
      ) {
        throw new ComfyRuntimeError("comfyui_stop_target_mismatch", ["comfy-cli 的全局记录或端口 dry-run 与当前 ComfyUI workspace、主机、端口或进程链不一致，未执行关闭"], 409);
      }
      await stopper(pid, { target: localTarget, comfyuiRoot, comfyCli, cliRunner });
      for (let attempt = 0; attempt < stopAttempts; attempt += 1) {
        try { await processReader(localTarget); }
        catch (error) {
          if (isConfirmedComfyStopped(error)) return { status: "stopped", already_stopped: false };
          throw new ComfyRuntimeError("comfyui_identity_unverified", ["关闭后检测到身份异常，请手工检查 ComfyUI"]);
        }
        await delay(500);
      }
      throw new ComfyRuntimeError("comfyui_stop_timeout", ["ComfyUI 未在预期时间内关闭，未尝试强制清理"]);
    }),
    install: ({ device } = {}) => serialized(async () => {
      const installDevice = requireComfyInstallDevice(device);
      await assertComfyStoppedForMaintenance();
      const { result: cli, restored } = await runInstallCommand(installDevice);
      return { status: "installed", device: installDevice, restored, cli };
    }),
    update: () => serialized(async () => {
      await assertComfyStoppedForMaintenance();
      const cli = await runMaintenanceCommand(["update"]);
      return { status: "updated", cli };
    }),
  };
}
