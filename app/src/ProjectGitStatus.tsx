import { useEffect, useState } from "react";

type GitStatus = {
  status: "ready" | "not_repository" | "unavailable"; message?: string;
  branch?: string; commit?: string | null; upstream?: string | null;
  ahead?: number | null; behind?: number | null; dirty?: boolean;
  changes?: { status: string; path: string; original_path?: string }[];
  remotes?: { name: string; url: string; web_url: string | null }[];
};

export function useProjectGit(id: string, path: string, refreshKey?: object) {
  const [value, setValue] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setValue(null);
    void fetch(`/api/project-library/${encodeURIComponent(id)}/git`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<GitStatus>; })
      .then(result => { if (!controller.signal.aborted) setValue(result); })
      .catch(() => { if (!controller.signal.aborted) setValue({ status: "unavailable", message: "Git 状态读取失败" }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, path, revision, refreshKey]);
  return { value, loading, refresh: () => setRevision(current => current + 1) };
}

export function ProjectGitStatus({ id, path }: { id: string; path: string }) {
  const { value, loading, refresh } = useProjectGit(id, path);
  const ready = value?.status === "ready";
  const local = ready && !value.remotes?.length;
  const status = loading ? "读取中…" : !ready ? value?.message ?? "状态未知" : value.dirty ? (value.changes?.length ?? 0) + " 项改动" : "无改动";
  return <div className="project-git-status">
    <header className="project-git-header"><h3>Git 仓库</h3><span className={ready && !value.dirty ? "git-status-tag is-clean" : "git-status-tag"}>{status}</span><button type="button" className="git-refresh" disabled={loading} aria-label="刷新 Git 状态" data-tooltip="刷新" onClick={refresh}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.5 7a7.5 7.5 0 0 1 12-1L20 9M4 15l2.5 3a7.5 7.5 0 0 0 12-1"/></svg></button></header>
    {ready && <dl className="project-git-facts">
      <div><dt>分支</dt><dd><code>{value.branch === "(detached)" ? "分离 HEAD" : value.branch}</code>{!value.commit && <span className="git-status-tag">尚无提交</span>}</dd></div>
      {local ? <div><dt>远程</dt><dd><span className="git-status-tag">本地</span><span className="git-muted">未关联远程仓库</span></dd></div> : value.remotes?.map(remote => <div key={remote.name}><dt>{value.remotes?.length === 1 ? "远程" : remote.name}</dt><dd>{remote.web_url ? <a href={remote.web_url} target="_blank" rel="noreferrer">{remote.web_url.replace(/^https?:\/\//, "")}</a> : remote.url}</dd></div>)}
      {value.upstream && Boolean(value.ahead || value.behind) && <div><dt>提交差异</dt><dd data-tooltip="相对本机上游记录，未联网刷新">{value.ahead ? <span>↑ {value.ahead} 领先</span> : null}{value.behind ? <span>↓ {value.behind} 落后</span> : null}</dd></div>}
    </dl>}
    {!!value?.changes?.length && <details className="project-git-files"><summary>查看改动文件</summary><ul className="project-git-changes">{value.changes.map(change => <li key={change.path}><code data-tooltip="Git 暂存区 / 工作区状态">{change.status}</code><span>{change.original_path ? change.original_path + " → " : ""}{change.path}</span></li>)}</ul></details>}
  </div>;
}
