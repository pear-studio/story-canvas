import { useEffect, useState } from "react";

type GitStatus = {
  status: "ready" | "not_repository" | "unavailable"; message?: string;
  branch?: string; commit?: string | null; upstream?: string | null;
  ahead?: number | null; behind?: number | null; dirty?: boolean;
  changes?: { status: string; path: string; original_path?: string }[];
  remotes?: { name: string; url: string; web_url: string | null }[];
};

export function ProjectGitStatus({ id, path }: { id: string; path: string }) {
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
  }, [id, path, revision]);
  return <div className="project-git-status">
    <details>
      <summary>Git · {loading ? "读取中…" : value?.status !== "ready" ? value?.message : `${value.dirty ? `${value.changes?.length} 个文件有改动` : "无改动"} · ${value.remotes?.length ? "已关联远程" : "未关联远程"}`}</summary>
      {value?.status === "ready" && <>
        <p>分支：{value.branch === "(detached)" ? "分离 HEAD" : value.branch}{!value.commit ? " · 尚无提交" : ""}</p>
        {value.remotes?.map(remote => <p key={remote.name}>{remote.name}：{remote.web_url ? <a href={remote.web_url} target="_blank" rel="noreferrer">{remote.url}</a> : remote.url}</p>)}
        {value.upstream && <p>上游：{value.upstream} · 领先 {value.ahead ?? "未知"} / 落后 {value.behind ?? "未知"}（本地记录，未联网刷新）</p>}
        <ul className="project-git-changes">{value.changes?.map(change => <li key={change.path}><code>{change.status}</code> {change.original_path ? `${change.original_path} → ` : ""}{change.path}</li>)}</ul>
        {!!value.changes?.length && <small>状态两列分别为暂存区和工作区；?? 为未跟踪，M 修改，A 新增，D 删除，R 重命名，U 冲突。</small>}
      </>}
      <p><button type="button" className="button" disabled={loading} onClick={() => setRevision(current => current + 1)}>刷新 Git 状态</button></p>
    </details>
  </div>;
}
