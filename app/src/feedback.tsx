import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { PROJECT_REVISION_CONFLICT_MESSAGE } from "./api-response";
import { Modal } from "./Modal";

export type FeedbackKind = "info" | "warning" | "error" | "success";

export type FeedbackNotice = {
  kind?: FeedbackKind;
  title?: string;
  message: string;
  duration?: number;
};

export type FeedbackConfirmation = {
  kind?: Exclude<FeedbackKind, "success">;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  acknowledgeOnly?: boolean;
};

type FeedbackContextValue = {
  notify: (notice: FeedbackNotice | string) => void;
  confirm: (confirmation: FeedbackConfirmation | string) => Promise<boolean>;
};

type ConfirmationState = FeedbackConfirmation & { resolve: (accepted: boolean) => void };

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

const defaultTitles: Record<FeedbackKind, string> = {
  info: "提示",
  warning: "请注意",
  error: "操作失败",
  success: "已完成",
};

function normalizeNotice(notice: FeedbackNotice | string): FeedbackNotice {
  const normalized = typeof notice === "string" ? { message: notice } : notice;
  return normalized.message.includes(PROJECT_REVISION_CONFLICT_MESSAGE)
    ? { ...normalized, kind: "error", message: PROJECT_REVISION_CONFLICT_MESSAGE }
    : normalized;
}

function normalizeConfirmation(confirmation: FeedbackConfirmation | string): FeedbackConfirmation {
  return typeof confirmation === "string" ? { message: confirmation } : confirmation;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<FeedbackNotice | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const activeConfirmation = useRef<ConfirmationState | null>(null);
  const confirmationQueue = useRef<ConfirmationState[]>([]);


  const confirm = useCallback((value: FeedbackConfirmation | string) => new Promise<boolean>((resolve) => {
    const next = { ...normalizeConfirmation(value), resolve };
    if (activeConfirmation.current) {
      confirmationQueue.current.push(next);
      return;
    }
    activeConfirmation.current = next;
    setConfirmation(next);
  }), []);

  const notify = useCallback((value: FeedbackNotice | string) => {
    const next = normalizeNotice(value);
    if (!next.message.trim()) return;
    if (next.kind === 'error' || next.message.length > 60 || /[\r\n]/.test(next.message)) {
      setNotice(null);
      void confirm({ kind: next.kind === 'success' ? 'info' : next.kind, title: next.title ?? defaultTitles[next.kind ?? 'info'], message: next.message, acknowledgeOnly: true });
    } else setNotice(next);
  }, [confirm]);

  const finishConfirmation = useCallback((accepted: boolean) => {
    const current = activeConfirmation.current;
    if (!current) return;
    const next = confirmationQueue.current.shift() ?? null;
    activeConfirmation.current = next;
    setConfirmation(next);
    current.resolve(accepted);
  }, []);

  useEffect(() => () => {
    const pending = [activeConfirmation.current, ...confirmationQueue.current].filter((item): item is ConfirmationState => Boolean(item));
    activeConfirmation.current = null;
    confirmationQueue.current = [];
    for (const item of pending) item.resolve(false);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), notice.duration ?? 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return <FeedbackContext.Provider value={{ notify, confirm }}>
    {children}
    {notice && <div className={`feedback-toast feedback-toast--${notice.kind ?? "info"}`} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">
      <div><strong>{notice.title ?? defaultTitles[notice.kind ?? "info"]}</strong><p>{notice.message}</p></div>
      <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
    </div>}
    {confirmation && <Modal size="content" title={confirmation.title ?? "请确认此操作"} subtitle={confirmation.kind ? defaultTitles[confirmation.kind] : "请确认"} onClose={() => finishConfirmation(false)} className={`feedback-confirmation-modal ${confirmation.danger ? "feedback-confirmation-modal--danger" : ""}`.trim()} ariaLabel={confirmation.title ?? "请确认此操作"} footer={<>{!confirmation.acknowledgeOnly && <button type="button" onClick={() => finishConfirmation(false)}>{confirmation.cancelLabel ?? "取消"}</button>}<button type="button" className={confirmation.danger ? "button--danger" : "button--primary"} onClick={() => finishConfirmation(true)}>{confirmation.confirmLabel ?? (confirmation.acknowledgeOnly ? "知道了" : "确认")}</button></>}><p className="feedback-confirmation-message">{confirmation.message.split("\n").map((line, index) => <span key={`${line}-${index}`}>{index > 0 && <br />}{line}</span>)}</p></Modal>}
  </FeedbackContext.Provider>;
}

export function useFeedback(): FeedbackContextValue {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error("useFeedback 必须在 FeedbackProvider 内使用");
  return context;
}
