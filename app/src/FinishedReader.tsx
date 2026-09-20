import { useEffect, useRef, useState } from "react";
import { finishedReaderDocument, type ReaderPage } from "../shared/finished-reader.mjs";
import { Modal } from "./Modal";

export function FinishedReader({ pages, onClose }: { pages: ReaderPage[]; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // 阅读期间冻结本次图片清单，后台状态轮询不会重载文档或重置阅读位置。
  const [document] = useState(() => finishedReaderDocument(pages));
  useEffect(() => {
    const close = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow && event.data?.type === "finished-reader-close") onClose(); };
    window.addEventListener("message", close);
    return () => window.removeEventListener("message", close);
  }, [onClose]);
  return <Modal size="workspace" ariaLabel="阅读预览" className="finished-reader-modal" onClose={onClose}>
    <iframe ref={frame} title="成品连续阅读" sandbox="allow-scripts" srcDoc={document} />
    <button type="button" className="finished-reader-close" aria-label="关闭阅读" onClick={onClose} autoFocus>×</button>
  </Modal>;
}
