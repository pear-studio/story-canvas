import type { PageKey } from "./page-key";
export type RuntimePageKey = PageKey;

export type HardwareDevice = {
  index: number;
  name: string;
  utilization: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  memory_utilization: number;
};

export type HardwareStatus = {
  sampled_at: string;
  cpu: { utilization: number | null; logical_processors: number };
  memory: { used_bytes: number; total_bytes: number; utilization: number | null };
  gpu: { available: boolean; source: "nvidia-smi"; error: string | null; devices: HardwareDevice[] };
  comfyui: {
    status: "checking" | "available" | "unavailable";
    reason: string | null;
    pid: number | null;
    version: string | null;
    gpu_memory_bytes: number | null;
    memory_working_set_bytes: number | null;
    memory_private_bytes: number | null;
    sampled_at: string | null;
    url: string | null;
    endpoint_index: number | null;
    endpoint_count: number;
    endpoints: Array<{
      url: string;
      endpoint_index: number;
      status: "checking" | "available" | "unavailable";
      version: string | null;
      checked_at: string | null;
      kind: "local" | "remote";
      managed: boolean;
    }>;
  };
};

export type TaskCounts = { total: number; available: number; skipped: number; discarded: number; cancelled?: number; running: number; queued: number; failed: number };

export type GlobalTask = {
  id: string;
  created_at: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  project_id: string | null;
  project_title: string;
  purpose: "candidate" | "comparison" | "finished";
  stage?: string;
  status: string;
  pending_control?: "cancel" | null;
  error?: string | null;
  render_profile?: string;
  item_counts: TaskCounts;
  progress: { value: number; max: number } | null;
  pages: Array<{ page_key: RuntimePageKey; page_id: string; order: number | null; title: string | null; owner_label: string | null; item_counts: TaskCounts }>;
};

export type TrackedTaskState = { id: string; status: string };
export type TaskCollection = {
  tasks: GlobalTask[];
  history: GlobalTask[];
  tracked?: TrackedTaskState[];
  missing_tracked_task_ids?: string[];
  queue_revision?: number;
};

export function mergeTaskHistory(current: GlobalTask[], incoming: GlobalTask[]) {
  const tasks = new Map(current.map((task) => [`${task.id}/${task.project_id}/${task.purpose}`, task]));
  for (const task of incoming) tasks.set(`${task.id}/${task.project_id}/${task.purpose}`, task);
  return [...tasks.entries()].sort(([left], [right]) => left < right ? 1 : left > right ? -1 : 0).map(([, task]) => task);
}
export type BackendHealth = { ok: true; instance_id: string };

type TimerHandle = ReturnType<typeof setTimeout>;

export function createSerialPoller({
  intervalMs,
  poll,
  onError = () => undefined,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (timer) => clearTimeout(timer),
}: {
  intervalMs: number;
  poll: (signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancelSchedule?: (timer: TimerHandle) => void;
}) {
  let running = false;
  let generation = 0;
  let timer: TimerHandle | null = null;
  let request: AbortController | null = null;

  function clearTimer() {
    if (timer === null) return;
    cancelSchedule(timer);
    timer = null;
  }

  async function run() {
    if (!running || request) return;
    const currentGeneration = generation;
    clearTimer();
    const controller = new AbortController();
    request = controller;
    try {
      await poll(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      if (request === controller) request = null;
      if (running && generation === currentGeneration) timer = schedule(() => void run(), intervalMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      generation += 1;
      void run();
    },
    stop() {
      running = false;
      generation += 1;
      clearTimer();
      request?.abort();
      request = null;
    },
  };
}

const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);

export function areTrackedTasksTerminal(collection: TaskCollection, taskIds: readonly string[]) {
  if (!taskIds.length) return false;
  const statuses = new Map([...collection.tasks, ...collection.history, ...(collection.tracked ?? [])].map((task) => [task.id, task.status]));
  const missing = new Set(collection.missing_tracked_task_ids ?? []);
  return taskIds.every((taskId) => missing.has(taskId) || terminalTaskStatuses.has(statuses.get(taskId) ?? ""));
}
