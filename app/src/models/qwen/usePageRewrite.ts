import {useEffect, useRef, useState} from 'react';
import {loadPageRewrite, loadPageRewriteProgress, runPageRewrite, type PageRewriteValue, type PromptSourceChoice, type WorkbenchPage, type WorkbenchCharacter} from '../../project-workbench-client';

type Options = {
  projectId: string; workspaceIdentity: string; page: WorkbenchPage;
  characters: WorkbenchCharacter[]; scenes: WorkbenchCharacter[];
  defaultRenderProfile: string | null; canvas: string | null; pageDirty: boolean; busy: boolean;
  onSaved: () => void;
};

// 驻留页面工作区，切换编辑标签不停止进度跟踪；页面或 render 变化后隔离旧请求。
export function usePageRewrite({projectId, workspaceIdentity, page, characters, scenes, defaultRenderProfile, canvas, pageDirty, busy, onSaved}: Options) {
  const enabled = page.model_id === 'qwen' && page.page_kind !== 'text';
  const identityRef = useRef(workspaceIdentity);
  identityRef.current = workspaceIdentity;
  const isCurrentWorkspace = () => identityRef.current === workspaceIdentity;
  useEffect(() => {
    identityRef.current = workspaceIdentity;
    return () => { identityRef.current = ''; };
  }, [workspaceIdentity]);
  const [promptSourceState, setPromptSourceState] = useState<{identity: string; value: PromptSourceChoice}>(() => ({identity: workspaceIdentity, value: 'original'}));
  const [rewriteState, setRewriteState] = useState<{identity: string; value: PageRewriteValue | null; loading: boolean; running: boolean; error: string; progress?: PageRewriteValue['progress']}>(() => ({identity: workspaceIdentity, value: null, loading: true, running: false, error: ''}));
  const pendingRewrites = useRef(new Set<string>());
  const promptSource: PromptSourceChoice = enabled && promptSourceState.identity === workspaceIdentity ? promptSourceState.value : 'original';
  const currentRewriteState = rewriteState.identity === workspaceIdentity ? rewriteState : {identity: workspaceIdentity, value: null, loading: true, running: false, error: ''};
  const characterFactsSignature = characters.map(character => `${character.id}:${character.prompt_sha256}`).join('|');
  const sceneFactsSignature = JSON.stringify(scenes);
  const rewriteDepsKey = JSON.stringify([workspaceIdentity, enabled, page.content_sha256, page.prompt_sha256, page.prompt_context_sha256, characterFactsSignature, sceneFactsSignature, page.project_loras, defaultRenderProfile, canvas]);
  useEffect(() => { setPromptSourceState({identity: workspaceIdentity, value: 'original'}); }, [workspaceIdentity]);

  useEffect(() => {
    const controller = new AbortController();
    setRewriteState((current) => ({ identity: workspaceIdentity, value: current.identity === workspaceIdentity ? current.value : null, loading: true, running: current.identity === workspaceIdentity && current.running, error: "" }));
    if (!enabled) { setRewriteState({identity:workspaceIdentity,value:null,loading:false,running:false,error:""}); return () => controller.abort(); }
    void loadPageRewrite(projectId, page.page_key, controller.signal).then((value) => {
      if (!controller.signal.aborted) setRewriteState((current) => current.identity === workspaceIdentity ? { ...current, value, loading: false, progress:value.progress, running:current.running||Boolean(value.progress&&!value.progress.finished_at), error:value.progress?.phase==='failed'?value.progress.error??'优化失败':current.error } : current);
    }).catch((error) => {
      if (!controller.signal.aborted) setRewriteState((current) => current.identity === workspaceIdentity ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) } : current);
    });
    return () => controller.abort();
  }, [rewriteDepsKey]);

  useEffect(() => {
    if (!currentRewriteState.running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { progress } = await loadPageRewriteProgress(projectId, page.page_key, controller.signal);
        if (controller.signal.aborted) return;
        if (progress && !progress.finished_at) {
          setRewriteState(current => current.identity === workspaceIdentity ? { ...current, progress } : current);
        } else if (progress?.finished_at && !pendingRewrites.current.has(workspaceIdentity)) {
          const value = await loadPageRewrite(projectId, page.page_key, controller.signal);
          if (!controller.signal.aborted) setRewriteState(current => current.identity === workspaceIdentity ? {
            ...current, value, progress, running: false, loading: false,
            error: progress.phase === 'failed' ? progress.error ?? '优化失败' : '',
          } : current);
          return;
        }
      } catch { /* 进度读取暂时失败不终止正在执行的优化。 */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [workspaceIdentity, currentRewriteState.running]);

  async function rewriteCurrentPage() {
    if (!enabled || pageDirty || busy || currentRewriteState.running || pendingRewrites.current.has(workspaceIdentity)) return;
    pendingRewrites.current.add(workspaceIdentity);
    setRewriteState((current) => current.identity === workspaceIdentity ? { ...current, running: true, error: "",progress:null } : current);
    try {
      const value = await runPageRewrite(projectId, page.page_key);
      if (!isCurrentWorkspace()) return;
      setRewriteState({ identity: workspaceIdentity, value, loading: false, running: false, error: "" });
      onSaved();
    } catch (error) {
      if (isCurrentWorkspace()) setRewriteState((current) => current.identity === workspaceIdentity ? { ...current, running: false, error: error instanceof Error ? error.message : String(error) } : current);
    } finally {pendingRewrites.current.delete(workspaceIdentity);}
  }


  return { ...currentRewriteState, enabled, promptSource,
    setPromptSource: (value: PromptSourceChoice) => setPromptSourceState({identity: workspaceIdentity, value}),
    run: rewriteCurrentPage,
  };
}
export type PageRewriteController = ReturnType<typeof usePageRewrite>;
