import type {PageRewriteController} from './usePageRewrite';

export function RewritePanel({controller, dirty: anyDirty, disabled, pageIdentity}: {controller: PageRewriteController; dirty: boolean; disabled: boolean; pageIdentity: string}) {
  const {value: rewriteValue, loading: rewriteLoading, running: rewriteRunning, progress: rewriteProgress, error: rewriteError, promptSource, setPromptSource: onPromptSourceChange, run: onRewrite} = controller;
  const rewritePhases={preparing:'准备中',queued:'排队中',running:'执行中',loading:'加载模型／准备优化',generating:'优化中',saving:'保存结果',completed:'已完成',failed:'失败'};
  const rewriteSeconds=Math.floor((rewriteProgress?.elapsed_ms??0)/1000);
  const runningStatus=rewriteProgress?`${rewritePhases[rewriteProgress.phase]}${rewriteProgress.tokens?` · ${rewriteProgress.tokens} token`:''} · ${Math.floor(rewriteSeconds/60)}分${rewriteSeconds%60}秒`:'正在提交…';
  const rewriteStatus = rewriteRunning ? runningStatus : rewriteError ? "失败" : rewriteLoading ? "读取中" : anyDirty ? "待保存" : rewriteValue?.status === "current" ? "当前" : rewriteValue?.status === "stale" ? "已过期" : "未生成";
  const canChooseRewrite = !anyDirty && !rewriteLoading && Boolean(rewriteValue?.rewrite);

  return <div className="page-rewrite" aria-label="最终 Prompt 优化">
        <div className="page-rewrite__toolbar">
          <label className="page-rewrite__choice"><input type="checkbox" checked={promptSource === "rewrite"} disabled={promptSource !== "rewrite" && !canChooseRewrite} onChange={(event) => onPromptSourceChange?.(event.target.checked ? "rewrite" : "original")} />使用优化结果</label>
          <span className="page-rewrite__status" role="status">状态：{rewriteStatus}</span>
          <button type="button" className="button button--quiet" disabled={disabled || anyDirty || rewriteRunning} onClick={onRewrite}>{rewriteRunning ? "优化中…" : "优化"}</button>
        </div>
        {anyDirty && <p className="page-rewrite__hint">请先保存本页修改，再运行优化或使用已有结果。</p>}
        {rewriteError && <p className="prompt-save-error" role="alert">优化失败：{rewriteError}</p>}
        <details key={`${pageIdentity}:rewrite`} className="page-rewrite__details"><summary>优化文本</summary><div className="page-rewrite__body">{rewriteValue?.rewrite ? <><pre>{rewriteValue.rewrite.rewritten_prompt}</pre><small>建议画幅：{rewriteValue.rewrite.wh_ratio}（不改变本页画幅）</small></> : <p>尚无优化结果。</p>}</div></details>
        <details key={`${pageIdentity}:original`} className="page-rewrite__details"><summary>原文</summary><div className="page-rewrite__body"><pre>{rewriteValue?.original_prompt || "当前最终合成 Prompt 尚未载入。"}</pre></div></details>
      </div>;
}
