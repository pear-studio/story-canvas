import {useEffect, useRef, useState, type ReactNode} from 'react';
import './TopbarTools.css';

/** 手机按需展开工具，保留状态组件挂载，继续更新任务与文档标题。 */
export function TopbarTools({children, resetKey, online, activeCount}: {
  children: ReactNode; resetKey: string; online: boolean; activeCount: number;
}) {
  const [open,setOpen]=useState(false);
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>setOpen(false),[resetKey]);
  useEffect(()=>{
    if (!open) panel.current?.querySelectorAll('details[open]').forEach(element=>{ (element as HTMLDetailsElement).open=false; });
  },[open]);
  return <>
    <button type="button" className="topbar-tools-toggle" aria-label="更多工具" aria-expanded={open} aria-controls="topbar-tools" onClick={()=>setOpen(value=>!value)}>
      <span aria-hidden="true">⋯</span>
      {!online ? <span className="topbar-tools-badge is-offline" aria-label="服务离线">!</span> : activeCount>0 ? <span className="topbar-tools-badge" aria-label={`${activeCount} 个进行中任务`}>{activeCount}</span> : null}
    </button>
    <div id="topbar-tools" className="topbar-tools" data-open={open} ref={panel}>{children}</div>
  </>;
}
