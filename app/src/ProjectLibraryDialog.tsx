import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useFeedback } from "./feedback";

type Entry = { id: string; title?: string; type: "story" | "training"; path: string; temporary: boolean; available: boolean };

export function ProjectLibraryDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (entry: Entry) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [directory, setDirectory] = useState("");
  const [target, setTarget] = useState<{ entry: Entry; action: "promote" | "relocate" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { confirm } = useFeedback();
  const refresh = async () => {
    const response = await fetch("/api/project-library");
    if (!response.ok) throw new Error("无法读取项目列表");
    setEntries((await response.json()).projects);
  };
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); }, []);
  const execute = async (endpoint: string, body: object) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? result.code ?? "操作失败");
      await refresh();
      return result;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const action = async (entry: Entry, operation: "copy" | "forget" | "delete") => {
    if (operation !== "copy" && !await confirm({ kind: "warning", title: operation === "delete" ? "删除临时项目" : "从列表移除", message: operation === "delete" ? "将删除此临时项目及其中全部素材和成果。" : "只取消登记，磁盘文件和 Git 历史保留。", confirmLabel: "确认", danger: operation === "delete" })) return;
    const result = await execute(`/api/project-library/${entry.id}/${operation}`, {});
    if (result && operation === "copy") onOpen({ ...entry, ...result, temporary: true, available: true });
  };
  return <Modal title="项目管理" size="workspace" onClose={onClose} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); void execute(target ? `/api/project-library/${target.entry.id}/${target.action}` : "/api/project-library/open", { path: directory }).then(result => { if (result) { setDirectory(""); setTarget(null); } }); }}>
      <label>{target ? `${target.action === "promote" ? "保留为正式项目" : "重新定位"} · ${target.entry.id}` : "打开已有项目文件夹"}<input autoFocus required value={directory} onChange={event => setDirectory(event.target.value)} placeholder="完整文件夹路径" /></label>
      <button className="button" disabled={busy}>{target ? "确定位置" : "添加项目"}</button>
      {target && <button className="button" type="button" onClick={() => { setTarget(null); setDirectory(""); }}>取消</button>}
    </form>
    {error && <p role="alert">{error}</p>}
    {entries.map(entry => <section key={entry.id} className="lora-panel">
      <header><b>{entry.title ?? entry.id}</b><span>{entry.type === "training" ? "训练" : "剧情"} · {entry.temporary ? "临时项目" : "正式项目"}{!entry.available ? " · 路径不可用" : ""}</span></header>
      <p>{entry.path}</p><div className="lora-actions">
        <button className="button" disabled={busy || !entry.available} onClick={() => onOpen(entry)}>打开</button>
        <button className="button" disabled={busy || !entry.available} onClick={() => void action(entry, "copy")}>创建临时副本</button>
        {entry.temporary && <button className="button" disabled={busy || !entry.available} onClick={() => { setTarget({ entry, action: "promote" }); setDirectory(""); }}>保留为正式项目</button>}
        {!entry.available && <button className="button" disabled={busy} onClick={() => { setTarget({ entry, action: "relocate" }); setDirectory(entry.path); }}>重新定位</button>}
        <button className="button" disabled={busy} onClick={() => void action(entry, "forget")}>从列表移除</button>
        {entry.temporary && <button className="button" disabled={busy || !entry.available} onClick={() => void action(entry, "delete")}>删除临时项目</button>}
      </div>
    </section>)}
  </Modal>;
}
