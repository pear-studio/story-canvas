import { useEffect, useRef, useState, type ComponentPropsWithRef } from "react";

// 加载失败按退避自动重试，覆盖服务重启、网络抖动等短暂故障；重试通过更换 key 重挂载 img 触发。
const RETRY_DELAYS_MS = [800, 2000, 5000, 10000];

export function RetryableImage({ src, onError, ...rest }: ComponentPropsWithRef<"img">) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAttempt(0);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [src]);

  function handleError(event: Parameters<NonNullable<ComponentPropsWithRef<"img">["onError"]>>[0]) {
    if (attempt < RETRY_DELAYS_MS.length) {
      timer.current = setTimeout(() => setAttempt((value) => value + 1), RETRY_DELAYS_MS[attempt]);
    }
    onError?.(event);
  }

  return <img key={attempt} src={src} onError={handleError} {...rest} />;
}
