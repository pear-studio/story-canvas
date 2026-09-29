import type { createProjectRequestGuard } from "./project-request-guard";
import { loadProjectWorkbench, type ProjectWorkbenchView } from "./project-workbench-client";
import type { WorkbenchScope } from './project-workbench-client';
import { prepareProjectSnapshotReaders } from "./project-snapshot-sync";
import { acceptProjectSnapshot, getProjectWriteGeneration, isProjectWritePending, waitForProjectWrites } from "./project-write-client";

type LoadOptions = {
  background?: boolean;
  signal?: AbortSignal;
  onApplied?: (view: ProjectWorkbenchView) => void;
  onSettled?: () => void;
};

// 所有工作台载入共用接纳边界；导航和草稿行为留在各自的视图中。
export function createWorkbenchSnapshotSync(
  guard: ReturnType<typeof createProjectRequestGuard>,
  applyView: (view: ProjectWorkbenchView) => void,
  currentScope: () => WorkbenchScope = () => ({kind: 'directory'}),
) {
  let loads = 0;
  return {
    get loading() { return loads > 0; },
    async load(projectId: string, { background = false, signal, onApplied, onSettled }: LoadOptions = {}) {
      if (!projectId || signal?.aborted || !guard.isProjectCurrent(guard.scope(projectId))) return false;
      if (background && (isProjectWritePending(projectId) || loads > 0)) {
        onSettled?.();
        return false;
      }
      const request = guard.beginLoad(projectId);
      const scope = currentScope();
      const started = performance.now();
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let outcome = 'discarded';
      let writeGeneration = getProjectWriteGeneration(projectId);
      const current = () => !signal?.aborted && guard.isLoadCurrent(request) && JSON.stringify(currentScope()) === JSON.stringify(scope);
      const acceptable = () => current() && !isProjectWritePending(projectId)
        && getProjectWriteGeneration(projectId) === writeGeneration;
      loads += 1;
      try {
        if (isProjectWritePending(projectId)) await waitForProjectWrites(projectId);
        if (!current()) return false;
        writeGeneration = getProjectWriteGeneration(projectId);
        const snapshot = await loadProjectWorkbench(projectId, signal, scope, requestId);
        if (!acceptable()) return false;
        const applyReaders = await prepareProjectSnapshotReaders(projectId, snapshot.revision, signal);
        if (!acceptable()) return false;
        applyReaders();
        acceptProjectSnapshot(projectId, snapshot.revision);
        applyView(snapshot.view);
        onApplied?.(snapshot.view);
        outcome = 'applied';
        return true;
      } catch (error) {
        if (!acceptable()) return false;
        outcome = 'failed';
        throw error;
      } finally {
        loads -= 1;
        // 记录到数据接纳为止，不把 React 提交前的时间称为已绘制。
        if (!background && typeof navigator !== 'undefined' && navigator.sendBeacon) {
          try {
            navigator.sendBeacon('/api/performance', new Blob([JSON.stringify({event:'workbench-load', request_id:requestId,
              scope:scope.kind, outcome, duration_ms:performance.now()-started})], {type:'application/json'}));
          } catch { /* 性能记录不影响载入。 */ }
        }
        if (current()) onSettled?.();
      }
    },
  };
}
