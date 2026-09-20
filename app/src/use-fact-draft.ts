import { useEffect, useState, type SetStateAction } from 'react';

/** 外部事实变化时保留未保存草稿及其原指纹，保存由服务端拒绝过期写入。 */
export function useFactDraft<T>(source: T, fingerprint: string) {
  const [state, setState] = useState(() => ({ draft: structuredClone(source), baseline: structuredClone(source), fingerprint }));
  const dirty = JSON.stringify(state.draft) !== JSON.stringify(state.baseline);
  useEffect(() => {
    setState(current => JSON.stringify(current.draft) === JSON.stringify(current.baseline)
      ? { draft: structuredClone(source), baseline: structuredClone(source), fingerprint } : current);
  }, [fingerprint]);
  return {
    draft: state.draft, dirty, fingerprint: state.fingerprint, conflict: fingerprint !== state.fingerprint,
    setDraft(update: SetStateAction<T>) {
      setState(current => ({ ...current, draft: typeof update === 'function' ? (update as (value: T) => T)(current.draft) : update }));
    },
    accept(value: T, nextFingerprint: string) {
      setState({ draft: structuredClone(value), baseline: structuredClone(value), fingerprint: nextFingerprint });
    },
    reset() { setState({ draft: structuredClone(source), baseline: structuredClone(source), fingerprint }); },
  };
}
