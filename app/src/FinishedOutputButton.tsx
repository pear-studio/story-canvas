import {localeLabels,type LetteringLocale} from "./page-translations";
import { useEffect, useRef, useState } from "react";
import { finishedBusy, finishedJobLabel, type FinishedJob } from "./finished-client";
import { readFacts } from "./project-write-client";
import { workbenchResponseJson } from "./api-response";
import "./FinishedPagesView.css";

export function FinishedOutputButton({locale="zh", projectId, pageId, candidateId, dirty, disabled, onOutput, dirtyLabel="保存嵌字并输出成品" }: {
  dirtyLabel?:string;
  locale?:LetteringLocale;projectId: string; pageId: string; candidateId?: string; dirty: boolean; disabled: boolean;
  onOutput: (candidateId?: string) => Promise<FinishedJob | null>;
}) {
  const [job, setJob] = useState<FinishedJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const identity = `${projectId}/${pageId}/${locale}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { jobs } = await workbenchResponseJson<{ jobs: FinishedJob[] }>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/finished/jobs`, { signal: controller.signal }));
        if (!controller.signal.aborted) setJob(jobs.find(value => value.page_id === pageId&&(value.locale??'zh')===locale) ?? null);
      } catch { /* 提交错误直接显示，轮询在服务恢复后继续。 */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 2500); }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, pageId,locale]);
  useEffect(()=>{setJob(null);setError('');},[identity]);
  async function output() {
    setSubmitting(true); setError("");
    try { const next = await onOutput(candidateId); if (next&&currentIdentity.current===identity) setJob(next); }
    catch (reason) { if(currentIdentity.current===identity)setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if(currentIdentity.current===identity)setSubmitting(false); }
  }
  const status = error || job?.error || finishedJobLabel(job?.status);
  return <div className="finished-output-action"><button type="button" className="button" disabled={disabled || submitting || finishedBusy(job?.status)} onClick={() => void output()}>{submitting ? "正在提交…" : dirty ? dirtyLabel : "输出成品"}{locale!=='zh'&&` · ${localeLabels[locale]}`}</button>
    {status && <small>{status}</small>}
  </div>;
}
