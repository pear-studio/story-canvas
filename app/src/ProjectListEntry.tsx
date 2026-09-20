import type { RegisteredProject } from "./ProjectDirectoryDialog";
import { useProjectGit } from "./ProjectGitStatus";

export function ProjectListEntry({ entry, active, onOpen }: { entry: RegisteredProject; active: boolean; onOpen: () => void }) {
  const { value, loading } = useProjectGit(entry.id, entry.path, entry);
  const local = value?.status === "not_repository" || (value?.status === "ready" && !value.remotes?.length);
  const changed = value?.status === "ready" && (value.dirty || Boolean(value.ahead) || Boolean(value.behind));
  const hint = loading || !value ? "读取中" : value.status === "not_repository" ? "未初始化 Git" : value.status !== "ready" ? "Git 不可用" : [local ? "未关联远程" : "已关联远程", value.dirty ? `${value.changes?.length} 项改动` : "无改动", value.ahead ? `↑${value.ahead}` : "", value.behind ? `↓${value.behind}` : ""].filter(Boolean).join(" · ");
  return <button type="button" className={`project-list-entry ${entry.temporary ? "is-temporary" : ""}`} aria-label={entry.title ?? entry.id} data-tooltip={entry.temporary ? "临时项目" : undefined} disabled={!entry.available} aria-current={active ? "page" : undefined} onClick={onOpen}>
    <span className="project-list-name"><b>{entry.title ?? entry.id}</b>{!entry.available && <small>路径不可用</small>}</span>
    <span className={`project-list-git ${local ? "is-local" : changed ? "is-changed" : value?.status === "ready" ? "is-clean" : "is-unknown"}`} role="img" aria-label={hint} data-tooltip={hint}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v3c0 4-12 0-12 7"/></svg>{local ? <small>本地</small> : changed ? <span className="project-list-git-dot" /> : null}
    </span>
  </button>;
}
