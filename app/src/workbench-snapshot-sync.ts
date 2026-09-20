import type { createProjectRequestGuard } from "./project-request-guard";
import { loadProjectWorkbench, type ProjectWorkbenchView } from "./project-workbench-client";
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
      let writeGeneration = getProjectWriteGeneration(projectId);
      const current = () => !signal?.aborted && guard.isLoadCurrent(request);
      const acceptable = () => current() && !isProjectWritePending(projectId)
        && getProjectWriteGeneration(projectId) === writeGeneration;
      loads += 1;
      try {
        if (isProjectWritePending(projectId)) await waitForProjectWrites(projectId);
        if (!current()) return false;
        writeGeneration = getProjectWriteGeneration(projectId);
        const snapshot = await loadProjectWorkbench(projectId, signal);
        if (!acceptable()) return false;
        const applyReaders = await prepareProjectSnapshotReaders(projectId, snapshot.revision, signal);
        if (!acceptable()) return false;
        applyReaders();
        acceptProjectSnapshot(projectId, snapshot.revision);
        applyView(snapshot.view);
        onApplied?.(snapshot.view);
        return true;
      } catch (error) {
        if (!acceptable()) return false;
        throw error;
      } finally {
        loads -= 1;
        if (current()) onSettled?.();
      }
    },
  };
}
