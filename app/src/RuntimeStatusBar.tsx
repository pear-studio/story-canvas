import { useEffect, useMemo, useRef, useState } from "react";

import { finishedJobLabel } from "./finished-client";
import { Popover } from "./Popover";
import { responseJson } from "./api-response";
import { comfyRuntimePresentation, type ComfyRuntimeFailure } from "./comfy-runtime-status";
import { useFeedback } from "./feedback";
import { type GlobalTask, type HardwareStatus, type RuntimePageKey, type TaskCollection } from "./runtime-status";
import { formatTaskDuration, remainingImageCount, taskPageLabel, workbenchDocumentTitle } from "./task-summary";
import { TaskCard, TaskHistory, type OpenTaskPreview } from "./TaskViews";

export type TaskControlResult = { task: Pick<GlobalTask, "id" | "project_id" | "purpose" | "status" | "pending_control">; queue_revision: number };

export type { RuntimePageKey } from "./runtime-status";

function percent(value: number | null | undefined) {
  return Number.isFinite(value) ? `${Math.round(Number(value))}%` : "—";
}

function capacity(value: number | null | undefined) {
  if (!Number.isFinite(value) || Number(value) < 0) return "—";
  const bytes = Number(value);
  return bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

function endpointLabel(value: string) {
  try {
    const url = new URL(value);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return value;
  }
}

function EnvironmentMenu({ status, online, action, elapsed, failure, onControl, refreshing, selectingUrl, onRefresh, onSelect }: {
  status: HardwareStatus | null;
  online: boolean;
  action: "start" | "stop" | null;
  elapsed: number;
  failure: ComfyRuntimeFailure | null;
  onControl: (action: "start" | "stop") => void;
  refreshing: boolean;
  selectingUrl: string;
  onRefresh: () => void;
  onSelect: (url: string) => void;
}) {
  const runtime = comfyRuntimePresentation({ status: status?.comfyui, action, elapsedSeconds: elapsed, failure });
  const endpoints = status?.comfyui.endpoints ?? [];
  const hasManagedLocal = endpoints.some((endpoint) => endpoint.managed);
  const gpu = status?.gpu.available ? Math.max(...status.gpu.devices.map((device) => device.utilization), 0) : null;
  const resourceSummary = status
    ? hasManagedLocal ? `GPU ${status.gpu.available ? percent(gpu) : "不可用"} · CPU ${percent(status.cpu.utilization)}` : `工作台 CPU ${percent(status.cpu.utilization)}`
    : "资源读取中";
  return <Popover className="status-menu hardware-status-menu">
    <summary className="status-summary"><span className={`status-dot status-dot--${online ? runtime.tone : "critical"} ${runtime.busy ? "status-dot--busy" : ""}`} /><b>环境</b><span className="environment-summary-copy"><strong>{online ? runtime.remote ? runtime.summary.replace("远程 ComfyUI ", "远程 ") : runtime.summary.replace("ComfyUI ", "") : "服务离线"}</strong><small>{resourceSummary}</small></span></summary>
    <div className="status-popover hardware-popover"><header><b>运行环境</b><small>{online ? "ComfyUI 实例与本机资源" : "Node 服务不可用"}</small></header>
      <section className="comfy-endpoint-panel"><header><span><b>ComfyUI 实例</b><small>{endpoints.length} 个地址</small></span><button className="button" type="button" disabled={!online || refreshing} onClick={onRefresh}>{refreshing ? "检测中" : "刷新"}</button></header>
        <div className="comfy-endpoint-list">{endpoints.map((endpoint) => { const active = endpoint.url === status?.comfyui.url; const available = endpoint.status === "available"; return <article className={`comfy-endpoint-row ${active ? "is-active" : ""}`} key={endpoint.url}><span className={`status-dot status-dot--${endpoint.status === "available" ? "normal" : endpoint.status === "checking" ? "unknown" : "critical"}`} /><span className="comfy-endpoint-row__copy"><b>{endpointLabel(endpoint.url)}</b><small>{endpoint.kind === "local" ? "本机" : "远程"} · {endpoint.status === "checking" ? "检测中" : available ? `在线${endpoint.version ? ` · ${endpoint.version}` : ""}` : "离线"}</small></span><span className="comfy-endpoint-row__actions">{active ? <small>当前使用</small> : <button className="button" type="button" disabled={!available || Boolean(selectingUrl)} onClick={() => onSelect(endpoint.url)}>{selectingUrl === endpoint.url ? "切换中" : available ? "使用" : "不可用"}</button>}{endpoint.managed && <button className={`button ${available ? "button--danger" : "button--primary"}`} type="button" disabled={!online || refreshing || Boolean(action) || endpoint.status === "checking"} onClick={() => onControl(available ? "stop" : "start")}>{action === "start" ? "启动中" : action === "stop" ? "关闭中" : available ? "关闭" : "启动"}</button>}</span></article>; })}</div>
      </section>
      {hasManagedLocal && (status?.gpu.available ? status.gpu.devices.map((device) => <section className="resource-row" key={device.index}><div className="resource-row__heading"><b>GPU {device.index}</b><small>{device.name}</small><strong>{percent(device.utilization)}</strong></div><p>显存 {capacity(device.memory_used_bytes)} / {capacity(device.memory_total_bytes)} · {percent(device.memory_utilization)}</p></section>) : <section className="resource-row resource-row--unavailable"><div className="resource-row__heading"><b>GPU</b><small>nvidia-smi 不可用</small><strong>—</strong></div></section>)}
      <section className="resource-row"><div className="resource-row__heading"><b>CPU</b><small>{status ? `${status.cpu.logical_processors} Cores` : "正在读取"}</small><strong>{percent(status?.cpu.utilization)}</strong></div></section>
      <section className="resource-row"><div className="resource-row__heading"><b>内存</b><small>{status ? `${capacity(status.memory.used_bytes)} / ${capacity(status.memory.total_bytes)}` : "正在读取"}</small><strong>{percent(status?.memory.utilization)}</strong></div></section>
    </div>
  </Popover>;
}

function TaskMenu({ collection, onOpen, onPreview, onControlled, onQueueRevision }: { collection: TaskCollection; onOpen: (task: GlobalTask) => void; onPreview: OpenTaskPreview; onControlled: (result: TaskControlResult) => void; onQueueRevision?: (revision: number) => void }) {
  const { notify } = useFeedback();
  // The server queue is the ordering authority. Keep this list in response
  // order; sorting here would make a drag operation appear to be ignored.
  const active = collection.tasks.filter((task) => ["launching", "queued", "running"].includes(task.status));
  const remaining = remainingImageCount(active);
  const featured = active[0];
  const [now, setNow] = useState(Date.now());
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeIds = active.map((task) => `${task.project_id}:${task.purpose}:${task.id}`).join("|");
  const [draggedTask, setDraggedTask] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const [requests, setRequests] = useState<Record<string, string>>({});
  async function control(task: GlobalTask, action: "cancel") {
    const key = `${task.project_id}:${task.purpose}:${task.id}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setRequests(current => ({ ...current, [key]: action }));
    try {
      const result = await responseJson<TaskControlResult>(await fetch(`/api/tasks/${encodeURIComponent(task.project_id ?? "global")}/${encodeURIComponent(task.id)}/control`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ action, purpose: task.purpose }) }));
      onControlled(result);
    } catch (error) {
      notify({ kind: "error", message: `任务操作失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      inFlight.current.delete(key);
      setRequests(current => { const next = { ...current }; delete next[key]; return next; });
    }
  }
  async function reorder(sourceId: string, targetId: string) {
    if (!sourceId || sourceId === targetId) return;
    const from = active.findIndex((task) => `${task.project_id}:${task.purpose}:${task.id}` === sourceId);
    const to = active.findIndex((task) => `${task.project_id}:${task.purpose}:${task.id}` === targetId);
    if (from < 0 || to < 0) return;
    const next = [...active];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    try {
      const result = await responseJson<{ revision?: number }>(await fetch("/api/tasks/reorder", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ expected_revision: collection.queue_revision, items: next.filter(task => task.purpose !== "finished").map((task) => ({ project_id: task.project_id, task_id: task.id, purpose: task.purpose })) }),
      }));
      if (Number.isSafeInteger(result.revision)) onQueueRevision?.(Number(result.revision));
    } catch (error) {
      notify({ kind: "error", message: `调整任务顺序失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  useEffect(() => {
    if (!active.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active.length]);
  const duration = featured ? formatTaskDuration(featured.status === "running" ? featured.started_at : featured.created_at, now) : "";
  return <Popover className="status-menu task-status-menu" onOpenChange={setHistoryOpen}>{(close) => <><summary className="status-summary"><span className={`status-dot status-dot--${active.length ? "active" : "normal"}`} /><b>任务</b>{featured ? <span className="task-summary-copy"><span className="task-summary-copy__target">{featured.project_title} · {featured.pages[0] ? taskPageLabel(featured.pages[0]) : "准备生成"}</span><span className="task-summary-copy__progress">剩余 {remaining} 张{featured.purpose === "finished" ? ` · ${finishedJobLabel(featured.stage)}` : ""}{duration ? ` · ${featured.status === "running" ? "生成中" : "已等待"} ${duration}` : ""}</span></span> : <span className="task-summary-copy task-summary-copy--idle">空闲</span>}</summary>
    <div className="status-popover task-popover"><header><b>生成任务</b>{active.length > 0 && <small>剩余 {remaining} 张</small>}</header>
      {!active.length && <p className="task-empty">当前没有执行或等待执行的生成任务。</p>}
      {active.map(task => {
        const key = `${task.project_id}:${task.purpose}:${task.id}`;
        return <div key={key} draggable={task.purpose !== "finished" && !requests[key]} onDragStart={() => setDraggedTask(key)} onDragEnd={() => setDraggedTask(null)} onDragOver={event => event.preventDefault()} onDrop={() => { if (task.purpose !== "finished") void reorder(draggedTask ?? "", key); setDraggedTask(null); }}>
          <TaskCard task={task} now={now} previewsEnabled={historyOpen} onPreview={preview => { onPreview(preview); close(); }} onOpen={target => { close(); onOpen(target); }}>
            {task.purpose !== "finished" && <>
            <button type="button" className="button button--danger" disabled={Boolean(requests[key]) || task.pending_control === "cancel"} aria-busy={requests[key] === "cancel"} onClick={() => void control(task, "cancel")}>{requests[key] === "cancel" && <span className="task-spinner" aria-hidden="true" />}取消</button></>}
          </TaskCard>
        </div>;
      })}
      <TaskHistory enabled={historyOpen} refreshKey={activeIds} onPreview={preview => { onPreview(preview); close(); }} onOpen={task => { close(); onOpen(task); }} />
    </div>
  </>}</Popover>;
}

export default function RuntimeStatusBar({ projectTitle, online, hardware, tasks, onHardwareChange, onOpenTask, onPreview, onControlled, onQueueRevision }: { projectTitle?: string | null; online: boolean; hardware: HardwareStatus | null; tasks: TaskCollection; onHardwareChange: (status: HardwareStatus) => void; onOpenTask: (task: GlobalTask) => void; onPreview: OpenTaskPreview; onControlled: (result: TaskControlResult) => void; onQueueRevision?: (revision: number) => void }) {
  const { notify } = useFeedback();
  const [action, setAction] = useState<"start" | "stop" | null>(null);
  const [actionStartedAt, setActionStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<ComfyRuntimeFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectingUrl, setSelectingUrl] = useState("");

  useEffect(() => {
    const activeTasks = tasks.tasks.filter((task) => ["launching", "queued", "running"].includes(task.status));
    const title = workbenchDocumentTitle(projectTitle, activeTasks);
    document.title = title;
    return () => {
      if (document.title === title) document.title = "工作台";
    };
  }, [projectTitle, tasks]);

  useEffect(() => {
    if (!action) return;
    setElapsed(Math.floor((Date.now() - actionStartedAt) / 1000));
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - actionStartedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [action, actionStartedAt]);

  const status = useMemo(() => hardware, [hardware]);
  async function control(nextAction: "start" | "stop") {
    setAction(nextAction); setActionStartedAt(Date.now()); setFailure(null);
    try {
      await responseJson(await fetch(`/api/comfyui/${nextAction}`, { method: "POST", headers: { accept: "application/json" } }));
      notify({ kind: "success", message: nextAction === "start" ? "ComfyUI 已启动" : "ComfyUI 已关闭" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFailure({ action: nextAction, message });
      notify({ kind: "error", message: `ComfyUI ${nextAction === "start" ? "启动" : "关闭"}失败：${message}` });
    } finally { setAction(null); }
  }

  async function refreshComfyUi() {
    setRefreshing(true);
    try {
      const result = await responseJson<{ hardware: HardwareStatus }>(await fetch("/api/comfyui/refresh", { method: "POST", headers: { accept: "application/json" } }));
      onHardwareChange(result.hardware);
      const available = result.hardware.comfyui.endpoints.some((endpoint) => endpoint.status === "available");
      notify({ kind: "success", message: available ? "ComfyUI 地址已更新" : "没有检测到可用的 ComfyUI" });
    } catch (error) {
      notify({ kind: "error", message: `ComfyUI 检测失败：${error instanceof Error ? error.message : String(error)}` });
    } finally { setRefreshing(false); }
  }

  async function selectComfyUi(url: string) {
    setSelectingUrl(url);
    try {
      const result = await responseJson<{ hardware: HardwareStatus }>(await fetch("/api/comfyui/select", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ url }) }));
      onHardwareChange(result.hardware);
      notify({ kind: "success", message: `已切换到 ${endpointLabel(url)}` });
    } catch (error) {
      notify({ kind: "error", message: `切换 ComfyUI 失败：${error instanceof Error ? error.message : String(error)}` });
    } finally { setSelectingUrl(""); }
  }

  return <div className="topbar-statuses"><EnvironmentMenu status={status} online={online} action={action} elapsed={elapsed} failure={failure} onControl={(next) => void control(next)} refreshing={refreshing} selectingUrl={selectingUrl} onRefresh={() => void refreshComfyUi()} onSelect={(url) => void selectComfyUi(url)} /><TaskMenu collection={tasks} onOpen={onOpenTask} onPreview={onPreview} onControlled={onControlled} onQueueRevision={onQueueRevision} /></div>;
}
