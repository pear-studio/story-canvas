import { useEffect, useState } from 'react';
import { loadWorkbenchSetting, type WorkbenchCharacter, type SettingKind } from './project-workbench-client';

// 名称列表始终可用；只有新加入当前草稿的引用才补读编辑内容。
export function useReferencedSettings(projectId: string, pageId: string, characters: WorkbenchCharacter[], scenes: WorkbenchCharacter[], characterIds: string[], sceneId?: string) {
  const identity = `${projectId}:${pageId}`;
  const [loaded, setLoaded] = useState<{identity:string; values:Record<string, Awaited<ReturnType<typeof loadWorkbenchSetting>>>}>({identity, values:{}});
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const values = loaded.identity === identity ? loaded.values : {};
  const targets: Array<{kind:SettingKind; id:string}> = [
    ...characters.filter(c => characterIds.includes(c.id) && !c.prompt && !values[`character:${c.id}`]).map(c => ({kind:'character' as const,id:c.id})),
    ...scenes.filter(c => c.id === sceneId && !c.prompt && !values[`scene:${c.id}`]).map(c => ({kind:'scene' as const,id:c.id})),
  ];
  const targetKey = JSON.stringify(targets);
  useEffect(() => {
    setError('');
    if (!targets.length) return;
    const controller = new AbortController();
    void Promise.all(targets.map(async target => [ `${target.kind}:${target.id}`, await loadWorkbenchSetting(projectId, target.kind, target.id, controller.signal) ] as const))
      .then(entries => { if (!controller.signal.aborted) setLoaded(current => ({identity, values:{...(current.identity === identity ? current.values : {}), ...Object.fromEntries(entries)}})); })
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => controller.abort();
  }, [identity, targetKey, retry]);
  const merge = (entries:WorkbenchCharacter[], kind:SettingKind) => entries.map(entry => entry.prompt || !values[`${kind}:${entry.id}`] ? entry : {...entry,...values[`${kind}:${entry.id}`]});
  return {characters:merge(characters,'character'), scenes:merge(scenes,'scene'), pending:targets.length > 0, error, retry:()=>setRetry(value=>value+1), reset:()=>{setLoaded({identity,values:{}});setError('');setRetry(value=>value+1);}};
}
