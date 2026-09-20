import { useEffect, useState } from "react";
import { finishedBusy, finishedJobLabel, loadFinishedPages, type FinishedJob, type FinishedPage } from "./finished-client";
import ZoomableImageLightbox from "./ImageLightbox";
import { useFeedback } from "./feedback";
import { useRef } from "react";
import { readFacts } from "./project-write-client";
import { workbenchResponseJson } from "./api-response";
import "./FinishedPagesView.css";

export function FinishedOutputButton({ projectId, pageId, candidateId, dirty, disabled, onOutput }: {
  projectId: string; pageId: string; candidateId?: string; dirty: boolean; disabled: boolean;
  onOutput: (candidateId?: string) => Promise<FinishedJob | null>;
}) {
  const [job, setJob] = useState<FinishedJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<FinishedPage | null>(null);
  const [viewing, setViewing] = useState(false);
  const { notify } = useFeedback();
  const identity = `${projectId}/${pageId}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  async function viewFinished() {
    setViewing(true);
    try {
      const { pages } = await loadFinishedPages(projectId, undefined, pageId);
      if (currentIdentity.current !== identity) return;
      const page = pages[0];
      if (page?.record?.lettered_url) setPreview(page);
      else notify(page?.record ? "成品文件缺失，请重新制作。" : "本页尚未制作成品。");
    } catch (reason) { if (currentIdentity.current === identity) notify({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { if (currentIdentity.current === identity) setViewing(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { jobs } = await workbenchResponseJson<{ jobs: FinishedJob[] }>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/finished/jobs`, { signal: controller.signal }));
        if (!controller.signal.aborted) setJob(jobs.find(value => value.page_id === pageId) ?? null);
      } catch { /* 提交错误直接显示，轮询在服务恢复后继续。 */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 2500); }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, pageId]);
  async function output() {
    setSubmitting(true); setError("");
    try { const next = await onOutput(candidateId); if (next) setJob(next); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSubmitting(false); }
  }
  return <div className="finished-output-action"><button type="button" className="button" disabled={disabled || submitting || finishedBusy(job?.status)} onClick={() => void output()}>{submitting ? "正在提交…" : dirty ? "保存并输出成品" : "输出成品"}</button>
    <button type="button" className="button button--quiet" disabled={viewing} onClick={() => void viewFinished()}>查看成品</button>
    <small>{error || job?.error || finishedJobLabel(job?.status)}</small>
    {preview?.record?.lettered_url && <ZoomableImageLightbox src={preview.record.lettered_url} alt="当前成品" footer={null} onClose={() => setPreview(null)} />}
  </div>;
}
