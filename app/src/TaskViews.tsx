import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { finishedJobLabel } from "./finished-client";
import { responseJson } from "./api-response";
import { Modal } from "./Modal";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { mergeTaskHistory, type GlobalTask, type RuntimePageKey } from "./runtime-status";
import { formatTaskDuration, formatTaskMoment, taskPageLabel } from "./task-summary";
import ZoomableImageLightbox from "./ImageLightbox";
import { mediaVariantUrl } from "./media-variant";
import "./tasks.css";

export type TaskImage = { id: string; url: string };
export type TaskPreview = { images: TaskImage[]; index: number; title: string };
export type OpenTaskPreview = (preview: TaskPreview) => void;

export function TaskResultViewer({ preview, onClose }: { preview: TaskPreview; onClose: () => void }) {
  const [index, setIndex] = useState(preview.index);
  const image = preview.images[index];
  return <ZoomableImageLightbox src={image.url} alt={`${preview.title} · 第 ${index + 1} 张`} footer={`${preview.title} · ${index + 1} / ${preview.images.length}`} onPrevious={index > 0 ? () => setIndex(index - 1) : undefined} onNext={index + 1 < preview.images.length ? () => setIndex(index + 1) : undefined} onClose={onClose} />;
}

function TaskResultStrip({ task, enabled, onPreview }: { task: GlobalTask; enabled: boolean; onPreview: OpenTaskPreview }) {
  const [images, setImages] = useState<TaskImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const identity = `${task.project_id}/${task.purpose}/${task.id}`;
  useEffect(() => { setImages([]); }, [identity]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      try {
        const result = await responseJson<{ images: TaskImage[] }>(await fetch(`/api/tasks/${encodeURIComponent(task.project_id ?? "global")}/${encodeURIComponent(task.id)}/results?purpose=${task.purpose}`, { signal: controller.signal, cache: "no-store" }));
        if (!controller.signal.aborted) setImages(result.images);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [enabled, task.project_id, task.id, task.purpose, task.status, task.item_counts.available, task.item_counts.discarded, retry]);
  return <div className="task-results">
    {images.length > 0 && <div className="task-results__strip">{images.map((image, index) => <button type="button" key={image.id} className="task-results__image" aria-label={`全屏查看第 ${index + 1} 张生成结果`} onClick={() => onPreview({ images, index, title: task.pages[0] ? taskPageLabel(task.pages[0]) : task.project_title })}>
      <img src={mediaVariantUrl(image.url, 320)} alt={`第 ${index + 1} 张生成结果`} loading="lazy" draggable={false} onError={() => setImages(current => current.filter(item => item.id !== image.id))} />
    </button>)}</div>}
    <div className="task-results__status" aria-live="polite">{loading ? <span className="task-spinner" role="status" aria-label="加载结果" /> : error ? <button type="button" className="button" title={error} onClick={() => setRetry(value => value + 1)}>图片读取失败 · 重试</button> : !images.length ? (task.item_counts.available > 0 || task.item_counts.discarded > 0 ? "图片已删除或不可用" : "尚未生成图片") : null}</div>
  </div>;
}

export function taskStatusLabel(status: string) {
  return ({ completed: "已完成", available: "已完成", discarded: "已完成", failed: "失败", incomplete: "失败", cancelled: "已取消", running: "生成中", queued: "等待中", launching: "等待中", skipped: "已跳过" } as Record<string, string>)[status] ?? status;
}

function taskElapsed(task: GlobalTask, now: number) {
  const waiting = ["queued", "launching"].includes(task.status);
  const end = task.completed_at ?? task.failed_at ?? (["running", "queued", "launching"].includes(task.status) ? now : null);
  return formatTaskDuration(waiting ? task.created_at : task.started_at, end) || "—";
}

export function TaskCard({ task, now = Date.now(), onOpen, onPreview, previewsEnabled = true, children }: { task: GlobalTask; now?: number; onOpen: (task: GlobalTask) => void; onPreview: OpenTaskPreview; previewsEnabled?: boolean; children?: ReactNode }) {
  const active = ["running", "queued", "launching"].includes(task.status);
  const done = task.item_counts.available + task.item_counts.discarded + task.item_counts.skipped;
  const title = task.pages[0] ? taskPageLabel(task.pages[0]) : "未关联页面";
  return <article className={`task-card task-card--${task.status}`}>
    <button type="button" className="task-card__open" onClick={() => onOpen(task)}>
      <span className="task-card__meta"><span title={task.project_title}>{task.project_title}</span><time>{formatTaskMoment(task.created_at)}</time></span>
      <span className="task-card__main"><span className="task-card__title" title={title}>{task.purpose === "comparison" && <small>对比</small>}{task.purpose === "finished" && <small>成品</small>}<b>{title}</b><span>×{task.item_counts.total}</span>{task.pages.length > 1 && <small>{task.pages.length} 页</small>}</span><span className="task-card__result">{task.purpose === "finished" ? finishedJobLabel(task.stage) : taskStatusLabel(task.status)}{active && task.status === "running" ? ` ${done}/${task.item_counts.total}` : ""}<span> · {taskElapsed(task, now)}</span></span></span>
    </button>
    <TaskResultStrip task={task} enabled={previewsEnabled} onPreview={onPreview} />
    {task.pending_control && <p className="task-control-note" role="status">当前生成结束后取消</p>}
    {children && <div className="task-card__controls">{children}</div>}
  </article>;
}

// 两个入口共用分页和取消请求逻辑，不维护全局历史缓存，也不新增任务轮询。
function useTaskHistory(enabled: boolean, refreshKey: string) {
  const [history, setHistory] = useState<GlobalTask[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (before?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError("");
    try {
      const result = await responseJson<{ history: GlobalTask[]; next_cursor: string | null }>(await fetch(`/api/tasks/history${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal: controller.signal, cache: "no-store" }));
      if (controller.signal.aborted) return;
      setHistory(current => before ? mergeTaskHistory(current, result.history) : result.history);
      setNext(result.next_cursor);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request.current === controller) setLoading(false); }
  }, []);
  useEffect(() => {
    if (enabled) void load();
    return () => request.current?.abort();
  }, [enabled, refreshKey, load]);
  return { history, next, loading, error, load };
}

export function TaskHistory({ enabled = true, refreshKey = "", onOpen, onPreview, page = false }: { enabled?: boolean; refreshKey?: string; onOpen: (task: GlobalTask) => void; onPreview: OpenTaskPreview; page?: boolean }) {
  const { history, next, loading, error, load } = useTaskHistory(enabled, refreshKey);
  const refresh = <button type="button" className="button" disabled={loading} onClick={() => void load()}>刷新</button>;
  return <>
    {page ? <WorkspaceHeader title="任务记录" actions={refresh} /> : <div className="task-history-heading"><b>任务记录</b></div>}
    <div className="task-history-content">
    <div className="task-history-list">{history.map(task => <TaskCard key={`${task.project_id}:${task.purpose}:${task.id}`} task={task} onOpen={onOpen} onPreview={onPreview} previewsEnabled={enabled} />)}</div>
    {error && <p className="task-error">{error}<button type="button" className="button" onClick={() => void load(next ?? undefined)}>重试</button></p>}
    <div className="task-history-footer">{loading ? "正在读取" : next ? <button type="button" className="button" onClick={() => void load(next)}>加载更多</button> : !error ? history.length ? "已显示全部历史" : "暂无任务记录" : null}</div>
    </div>
  </>;
}

type Stage = { phase: string; item_id: string | null; started_at: string; ended_at: string | null; duration_ms: number | null; status: string; error?: string };
type TaskItem = { url?: string | null; id: string; status: string; seed?: number; prompt_id?: string; candidate_id?: string; page_key: RuntimePageKey };
type TaskDetail = GlobalTask & {
  items: TaskItem[];
  execution_units: Array<{ two_step?: { positive: string; negative: string; seed: number; strength: number; recipe: { steps: number; shift: number }; loras: Array<{ filename: string; weight: number }> }; intermediates?: Array<{ kind: string; url: string | null }>; id: string; item_ids: string[]; submission: { api_url?: string; prompt_id?: string; stages?: Stage[] } | null }>;
};
const phases: Record<string, string> = { submit: "提交请求", remote_wait: "等待远端结果", download: "下载图片", save: "本地保存" };
function moment(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, fractionalSecondDigits: 3 }) : "—";
}
function stageDuration(ms: number | null) { return ms == null ? "—" : `${(ms / 1000).toFixed(3)} 秒`; }

export function TaskDetailDialog({ selected, onClose, onOpenPage }: { selected: GlobalTask; onClose: () => void; onOpenPage: (projectId: string, page: RuntimePageKey) => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      try {
        const result = await responseJson<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(selected.project_id ?? "global")}/${encodeURIComponent(selected.id)}?purpose=${selected.purpose}`, { signal: controller.signal, cache: "no-store" }));
        if (!controller.signal.aborted) setDetail(result.task);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [selected.project_id, selected.id, selected.purpose, refresh]);
  const task = detail ?? selected;
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  return <Modal title="任务详情" subtitle={task.project_title} size="workspace" className="task-detail" onClose={onClose} footer={<button type="button" className="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button>}>
    {error && <p className="task-error">{error}</p>}
    {loading && <p className="task-muted">正在读取详情</p>}
    {detail && <>
      <dl className="task-detail__facts">
        <div><dt>任务</dt><dd>{task.id}</dd></div><div><dt>状态</dt><dd>{task.purpose === "finished" ? finishedJobLabel(task.stage) : taskStatusLabel(task.status)} · ×{task.item_counts.total}</dd></div>
        {task.render_profile && <div><dt>生成配置</dt><dd>{task.render_profile}</dd></div>}
        <div><dt>提交</dt><dd>{moment(task.created_at)}</dd></div><div><dt>开始</dt><dd>{moment(task.started_at)}</dd></div><div><dt>结束</dt><dd>{moment(task.completed_at ?? task.failed_at)}</dd></div>
        <div><dt>等待</dt><dd>{formatTaskDuration(task.created_at, task.started_at) || "—"}</dd></div><div><dt>运行</dt><dd>{taskElapsed(task, Date.now())}</dd></div>
      </dl>
      <div className="task-detail__pages">{task.pages.map(page => <button type="button" className="button button--quiet" key={JSON.stringify(page.page_key)} onClick={() => { onClose(); onOpenPage(task.project_id ?? "", page.page_key); }}>打开页面 · {taskPageLabel(page)}</button>)}</div>
      {task.error && <p className="task-error">{task.error}</p>}
      <p className="task-muted">等待远端结果包含远端排队、执行与结果检测；本地保存包含锁等待。不代表纯 GPU 耗时或浏览器显示时间。</p>
      {detail.items.map((item, index) => {
        const unit = detail.execution_units.find(entry => entry.item_ids.includes(item.id));
        const stages = unit?.submission?.stages?.filter(stage => !stage.item_id || stage.item_id === item.id) ?? [];
        return <section className="task-detail__item" key={item.id}>
          <header><h3>第 {index + 1} 张</h3><span>{taskStatusLabel(item.status)}</span></header>
          <dl className="task-detail__facts"><div><dt>Seed</dt><dd>{item.seed ?? "—"}</dd></div><div><dt>Prompt ID</dt><dd>{unit?.submission?.prompt_id ?? item.prompt_id ?? "—"}</dd></div>{item.candidate_id && <div><dt>候选 ID</dt><dd>{item.candidate_id}</dd></div>}{unit?.submission?.api_url && <div><dt>ComfyUI</dt><dd>{unit.submission.api_url}</dd></div>}</dl>
          {unit && unit.item_ids.length > 1 && <p className="task-muted">同批 {unit.item_ids.length} 张共享提交与远端等待阶段。</p>}
          {unit?.two_step && <><div className="task-two-step-images">{[...(unit.intermediates ?? []).map(image => ({ ...image, label: image.kind === "draft" ? "草稿" : "深度图" })), { kind: "final", label: "成片", url: item.url }].map(image => <figure key={image.kind}>{image.url ? <a href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={image.label} /></a> : <div className="task-muted">尚无结果</div>}<figcaption>{image.label}</figcaption></figure>)}</div><details className="task-two-step-prompt"><summary>草稿设置 · 深度 {unit.two_step.strength} · {unit.two_step.recipe.steps} 步 · shift {unit.two_step.recipe.shift}</summary><p>草稿 Seed：{unit.two_step.seed} · 草稿 LoRA：{unit.two_step.loras.map(lora => `${lora.filename} ×${lora.weight}`).join("、") || "无"}</p><pre>{unit.two_step.positive}</pre><b>负向 Prompt</b><pre>{unit.two_step.negative || "（空）"}</pre></details></>}
          {stages.length ? <div className="task-stage-list">{stages.map((stage, stageIndex) => <div className="task-stage" key={stageIndex}><div><b>{phases[stage.phase] ?? stage.phase}</b><span>{stage.status === "completed" ? stageDuration(stage.duration_ms) : stage.status === "failed" ? `失败 · ${stageDuration(stage.duration_ms)}` : terminal ? "未记录结束" : "进行中"}</span></div><small>{moment(stage.started_at)} → {moment(stage.ended_at)}</small>{stage.error && <p className="task-error">{stage.error}</p>}</div>)}</div> : <p className="task-muted">未记录阶段耗时</p>}
        </section>;
      })}
    </>}
  </Modal>;
}
