import { useEffect, useRef, useState, type SetStateAction } from 'react';

type ScopeState<T> = { draft: T; baseline: T; fingerprint: string };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const initial = <T,>(draft: T, fingerprint: string): ScopeState<T> => ({ draft: structuredClone(draft), baseline: structuredClone(draft), fingerprint });

/** 一个设定可保留多个未保存范围；外部刷新与保存只接纳自己的范围。 */
export function useScopedFactDrafts<T>(sources: Record<string, T>, fingerprints: Record<string, string>) {
  const [states, setStates] = useState<Record<string, ScopeState<T>>>(() => Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, initial(source, fingerprints[key] ?? '')])));
  const observedFingerprints = useRef(fingerprints);
  const signature = JSON.stringify(fingerprints);
  useEffect(() => {
    const previousFingerprints = observedFingerprints.current;
    observedFingerprints.current = fingerprints;
    setStates(current => {
      const next = { ...current };
      for (const [key, source] of Object.entries(sources)) {
        const previous = current[key];
        // 保存回执可能先于快照刷新；无关范围更新不能把刚接纳的范围退回旧 source。
        if (!previous || (previousFingerprints[key] !== fingerprints[key] && same(previous.draft, previous.baseline))) next[key] = initial(source, fingerprints[key] ?? '');
      }
      for (const key of Object.keys(current)) {
        if (!(key in sources) && same(current[key].draft, current[key].baseline)) delete next[key];
      }
      return next;
    });
  }, [signature]);

  const scopes = Object.fromEntries(Object.entries(states).map(([key, state]) => [key, {
    draft: state.draft,
    fingerprint: state.fingerprint,
    dirty: !same(state.draft, state.baseline),
    conflict: (fingerprints[key] ?? '') !== state.fingerprint,
  }]));
  return {
    scopes,
    dirty: Object.values(scopes).some(scope => scope.dirty),
    conflict: Object.values(scopes).some(scope => scope.dirty && scope.conflict),
    setDraft(key: string, update: SetStateAction<T>) {
      setStates(current => {
        const scope = current[key] ?? initial(sources[key], fingerprints[key] ?? '');
        const draft = typeof update === 'function' ? (update as (value: T) => T)(scope.draft) : update;
        return { ...current, [key]: { ...scope, draft } };
      });
    },
    accept(key: string, value: T, fingerprint: string) {
      setStates(current => ({ ...current, [key]: initial(value, fingerprint) }));
    },
    reset(key?: string) {
      setStates(current => key
        ? { ...current, [key]: initial(sources[key], fingerprints[key] ?? '') }
        : Object.fromEntries(Object.entries(sources).map(([scope, source]) => [scope, initial(source, fingerprints[scope] ?? '')])));
    },
  };
}
