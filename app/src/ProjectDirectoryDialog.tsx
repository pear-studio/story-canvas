import { useState } from "react";
import { Modal } from "./Modal";

export type RegisteredProject = { id: string; title?: string; type: "story" | "training"; path: string; temporary: boolean; available: boolean };

export function ProjectDirectoryDialog({ promote, onClose, onSave }: { promote?: RegisteredProject; onClose: () => void; onSave: (path: string) => Promise<void> }) {
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Modal title={promote ? "保留为正式项目" : "添加项目"} onClose={onClose} busy={busy}>
    <form className="project-directory-form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(""); void onSave(directory.trim()).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }}>
      <p>{promote ? `为“${promote.title ?? promote.id}”指定新的外部目录，保留素材和成果。` : "添加已有的剧情或训练项目文件夹，文件保留在原位置。"}</p>
      <label>{promote ? "新文件夹路径" : "项目文件夹"}<input autoFocus required disabled={busy} value={directory} onChange={event => setDirectory(event.target.value)} placeholder="完整文件夹路径" /></label>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button className="button button--primary" disabled={busy || !directory.trim()}>{busy ? "处理中…" : promote ? "保留" : "添加"}</button></footer>
    </form>
  </Modal>;
}
