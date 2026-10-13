import { useEffect, useRef } from 'react';
import { isWorkbenchModalOpen } from './workbench-shortcuts';

// 延迟到输入框本轮按键/失焦提交之后，读取最新 React 草稿；切换视图后不保存旧目标。
export function useSaveShortcut(save: () => void, identity: string) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function handle(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's' || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.isComposing || event.repeat || isWorkbenchModalOpen()) return;
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(), 0);
    }
    window.addEventListener('keydown',handle,true);
    return () => { clearTimeout(timer); window.removeEventListener('keydown',handle,true); };
  }, [identity]);
}
