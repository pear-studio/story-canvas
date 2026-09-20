export type ComfyRuntimeProbe = {
  status: "checking" | "available" | "unavailable";
  reason: string | null;
  pid: number | null;
  version: string | null;
  url?: string | null;
  endpoint_index?: number | null;
  endpoint_count?: number;
  endpoints?: Array<{
    url: string;
    status: "checking" | "available" | "unavailable";
    version: string | null;
  }>;
};

export type ComfyRuntimeFailure = { action: "start" | "stop"; message: string };

export type ComfyRuntimePresentation = {
  tone: "unknown" | "normal" | "warning" | "critical";
  summary: string;
  detail: string;
  canStart: boolean;
  canStop: boolean;
  busy: boolean;
  remote: boolean;
};

const stoppedReasons = new Set(["endpoint_unavailable", "listener_not_found", "process_not_found"]);
const unavailableLabels: Record<string, string> = {
  not_configured: "ComfyUI 地址未配置",
  invalid_url: "ComfyUI 地址无效",
  remote_instance: "远程 ComfyUI 不归属本机",
  endpoint_unavailable: "没有检测到运行实例",
  invalid_endpoint_response: "目标不是可识别的 ComfyUI",
  listener_not_found: "没有检测到监听进程",
  listener_ambiguous: "ComfyUI 监听进程不唯一",
  process_not_found: "ComfyUI 进程已结束",
  process_identity_mismatch: "ComfyUI 进程身份不符",
  process_metrics_unavailable: "ComfyUI 指标读取失败",
  unsupported_platform: "当前系统暂不支持进程归属",
  remote_endpoint_unavailable: "无法连接配置的远程地址",
};

function endpointLabel(value: string | null | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return value;
  }
}

export function stabilizeComfyRuntimeProbe<T extends ComfyRuntimeProbe>(previous: T | null | undefined, next: T): T {
  if (previous?.status === "available" && (next.status === "checking" || next.reason === "process_metrics_unavailable")) return previous;
  return next;
}

export function comfyRuntimePresentation({
  status,
  action = null,
  elapsedSeconds = 0,
  failure = null,
}: {
  status?: ComfyRuntimeProbe | null;
  action?: "start" | "stop" | null;
  elapsedSeconds?: number;
  failure?: ComfyRuntimeFailure | null;
} = {}): ComfyRuntimePresentation {
  const remote = status?.reason === "remote_instance" || status?.reason === "remote_endpoint_unavailable";
  if (action) {
    const seconds = Math.max(0, Math.floor(Number(elapsedSeconds) || 0));
    return {
      tone: "warning",
      summary: action === "start" ? "ComfyUI 正在启动" : "ComfyUI 正在关闭",
      detail: `已等待 ${seconds} 秒，${action === "start" ? "启动后会自动确认" : "关闭后会自动确认"}`,
      canStart: false,
      canStop: false,
      busy: true,
      remote,
    };
  }

  const available = status?.status === "available";
  const stopped = status?.status === "unavailable" && stoppedReasons.has(status.reason ?? "");
  const selectedEndpoint = status?.endpoints?.find((endpoint) => endpoint.url === status.url);
  const failureTargetReached = failure?.action === "start" ? available : failure?.action === "stop" ? stopped : false;
  if (failure && !failureTargetReached) {
    return {
      tone: "critical",
      summary: failure.action === "start" ? "ComfyUI 启动失败" : "ComfyUI 关闭失败",
      detail: failure.message,
      canStart: stopped,
      canStop: available,
      busy: false,
      remote,
    };
  }
  if (!remote && !available && selectedEndpoint?.status === "available") {
    return {
      tone: "warning",
      summary: "ComfyUI 在线",
      detail: [selectedEndpoint.version, "生成可用，但无法管理本机进程"].filter(Boolean).join(" · "),
      canStart: false,
      canStop: false,
      busy: false,
      remote: false,
    };
  }
  if (available && remote) {
    const endpoint = endpointLabel(status?.url);
    return {
      tone: "normal",
      summary: "远程 ComfyUI 在线",
      detail: [endpoint, status.version].filter(Boolean).join(" · ") || "生成请求将发送到远程设备",
      canStart: false,
      canStop: false,
      busy: false,
      remote: true,
    };
  }
  if (available) {
    const identity = [status.version, Number.isInteger(status.pid) && Number(status.pid) > 0 ? `PID ${status.pid}` : null].filter(Boolean).join(" · ");
    return {
      tone: "normal",
      summary: "ComfyUI 运行中",
      detail: identity || "运行实例已确认",
      canStart: false,
      canStop: true,
      busy: false,
      remote: false,
    };
  }
  if (!status || status.status === "checking") {
    return {
      tone: "unknown",
      summary: remote ? "远程 ComfyUI 状态读取中" : "ComfyUI 状态读取中",
      detail: remote ? "正在检查远程连接" : "正在确认运行实例",
      canStart: false,
      canStop: false,
      busy: false,
      remote,
    };
  }
  if (status.reason === "remote_endpoint_unavailable") {
    const count = Number(status.endpoint_count) || 0;
    return {
      tone: "critical",
      summary: "远程 ComfyUI 离线",
      detail: count > 1 ? `${count} 个远程地址均不可用` : unavailableLabels.remote_endpoint_unavailable,
      canStart: false,
      canStop: false,
      busy: false,
      remote: true,
    };
  }
  if (stopped) {
    return {
      tone: "unknown",
      summary: "ComfyUI 未启动",
      detail: unavailableLabels[status.reason ?? ""] ?? "没有检测到运行实例",
      canStart: true,
      canStop: false,
      busy: false,
      remote: false,
    };
  }
  if (status.reason === "process_metrics_unavailable") {
    return {
      tone: "warning",
      summary: "ComfyUI 状态待确认",
      detail: unavailableLabels.process_metrics_unavailable,
      canStart: false,
      canStop: false,
      busy: false,
      remote: false,
    };
  }
  return {
    tone: "critical",
    summary: "ComfyUI 状态异常",
    detail: unavailableLabels[status.reason ?? ""] ?? "无法确认 ComfyUI 运行状态",
    canStart: false,
    canStop: false,
    busy: false,
    remote: false,
  };
}
