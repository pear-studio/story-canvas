import { StoryCandidateDifference } from './StoryCandidateDifference';
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { useFeedback } from "./feedback";
import { inspectStoryCandidates, refreshStoryCandidates, type StoryCandidateRefreshPage, type WorkbenchPage } from "./project-workbench-client";

type Row = StoryCandidateRefreshPage & { title: string; number: number };
type Action = "clean" | "generate";
type Session = { action: Action; phase: "scan" | "confirm" | "execute"; rows: Row[]; done: number; total: number };

export function StoryCandidateRefresh({ projectId, pages, busy, scopeLabel = "全部剧情页", pageOrder }: { projectId: string; pages: WorkbenchPage[]; busy: boolean; scopeLabel?: string; pageOrder?: Map<string, number> }) {
  const { notify } = useFeedback();
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [scope, setScope] = useState<"mismatch" | "missing" | "all">("mismatch");
  const [perPage, setPerPage] = useState(1);
  const controller = useRef<AbortController | null>(null);
  const stop = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); stop.current = true; };
  }, []);

  function close() { controller.current?.abort(); controller.current = null; setSession(null); setDetailRow(null); }

  async function scan(action: Action) {
    if (controller.current) return;
    const request = new AbortController();
    setScope(action === "clean" ? "mismatch" : "missing");
    setPerPage(1);
    controller.current = request;
    const source = [...pages];
    const rows: Row[] = [];
    setSession({ action, phase: "scan", rows: [], done: 0, total: source.length });
    try {
      // 小批请求有可取消的进度；服务器每批最多同时编译三个页面。
      for (let offset = 0; offset < source.length; offset += 8) {
        const batch = source.slice(offset, offset + 8);
        const result = await inspectStoryCandidates(projectId, batch.map((page) => page.page_key), request.signal);
        if (request.signal.aborted) return;
        rows.push(...result.pages.map((page, index) => ({ ...page, title: batch[index].title, number: pageOrder?.get(batch[index].page_id) ?? offset + index + 1 })));
        setSession({ action, phase: "scan", rows: [], done: rows.length, total: source.length });
      }
      setSession({ action, phase: "confirm", rows, done: rows.length, total: source.length });
    } catch (error) {
      if (!request.signal.aborted) { close(); notify({ kind: "error", message: error instanceof Error ? error.message : String(error) }); }
    }
  }

  const cleanAll = session?.action === "clean" && scope === "all";
  const deleteIds = (row: Row) => cleanAll ? row.all_candidate_ids : row.candidate_ids;
  const targets = session?.rows.filter((row) => (row.status === "ready" || (cleanAll && row.status !== "active"))
    && (session.action === "clean" ? deleteIds(row).length > 0 : scope === "all" || row.matched === 0)) ?? [];
  const count = session?.action === "clean" ? targets.reduce((sum, row) => sum + deleteIds(row).length, 0) : targets.length * perPage;

  async function execute() {
    if (!session || session.phase !== "confirm") return;
    stop.current = false;
    setSession({ ...session, phase: "execute", done: 0, total: targets.length });
    let completed = 0;
    let failed = false;
    for (let index = 0; index < targets.length && !stop.current; index++) {
      const row = targets[index];
      try {
        const result = await refreshStoryCandidates(projectId, session.action === "clean"
          ? { action: "clean", scope: scope === "all" ? "all" : "mismatch" }
          : { action: "generate", scope: scope === "all" ? "all" : "missing", count: perPage }, row);
        if (result.status !== "skipped") completed += session.action === "clean" ? result.count ?? 0 : 1;
      } catch (error) {
        failed = true;
        if (mounted.current) notify({ kind: "error", message: `第 ${row.number} 页 · ${row.title}：${error instanceof Error ? error.message : String(error)}` });
      }
      if (!mounted.current) return;
      setSession((current) => current ? { ...current, done: index + 1 } : null);
    }
    if (!mounted.current) return;
    close();
    if (!failed) notify({ kind: "success", message: session.action === "clean"
      ? `已清理 ${completed} 张候选`
      : `已提交 ${completed} 个页面任务，可在任务列表查看进度` });
  }

  const title = session?.action === "clean" ? "清理候选" : "生成候选";
  return <>
    <button type="button" className="button button--quiet" disabled={busy || !pages.length || Boolean(session)} onClick={() => void scan("clean")}>清理候选</button>
    <button type="button" className="button button--quiet" disabled={busy || !pages.length || Boolean(session)} onClick={() => void scan("generate")}>生成候选</button>
    {session && <Modal title={title} subtitle={scopeLabel} className="story-candidate-refresh-modal"
      onClose={close} busy={session.phase === "execute"} footer={session.phase === "execute"
        ? <button type="button" className="button button--quiet" onClick={() => { stop.current = true; }}>停止后续提交</button>
        : <><button type="button" className="button button--quiet" onClick={close}>{session.phase === "scan" ? "取消扫描" : "取消"}</button>
          {session.phase === "confirm" && <button type="button" className={`button ${session.action === "clean" ? "button--danger" : "button--primary"}`}
            disabled={!targets.length} onClick={() => void execute()}>{session.action === "clean" ? `删除 ${count} 张` : `生成 ${count} 张`}</button>}</>}>
      {session.phase !== "confirm" ? <div className="story-candidate-refresh-progress" role="status">
        <p>{session.phase === "scan" ? "正在检查页面" : session.action === "clean" ? "正在清理页面候选" : "正在提交生成任务"}：{session.done} / {session.total}</p>
        <progress value={session.done} max={session.total || 1} aria-label="处理进度" />
        {session.phase === "execute" && <p>停止后续提交会保留已处理的页面；已提交的生成任务继续在队列中运行。</p>}
      </div> : <>
        <div className="story-candidate-refresh-options">
          <label>{session.action === "clean" ? "清理范围" : "生成范围"}
            <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
              {session.action === "clean" ? <><option value="mismatch">清理不符候选</option><option value="all">清理全部候选</option></>
                : <><option value="missing">缺失候选的页面</option><option value="all">所有页面</option></>}
            </select>
          </label>
          {session.action === "generate" && <label>每页张数<select value={perPage} onChange={(event) => setPerPage(Number(event.target.value))}>
            {[1, 2, 3].map((value) => <option key={value} value={value}>{value} 张</option>)}
          </select></label>}
        </div>
        <p className="story-candidate-refresh-help">{session.action === "clean"
          ? cleanAll ? "删除以下页面的全部候选，无法撤销。" : "仅删除与当前已保存的生成条件不符的候选，无法撤销。"
          : scope === "missing" ? "缺失包括：尚无候选图，以及已有候选但都与当前生成条件不符。" : "为所有可生成的页面新增候选。"}</p>
        <div className="story-candidate-refresh-summary" role="status">
          <span>{targets.length ? `${targets.length} 页${session.action === "generate" ? ` · 每页 ${perPage} 张` : ""}` : "没有需要处理的页面"}</span>
          {targets.length > 0 && <strong>{session.action === "clean" ? "删除" : "生成"} {count} 张</strong>}
        </div>
        {session.action === "generate" && <p>尚无候选 {session.rows.filter(row => row.status === 'ready' && !row.all_candidate_ids.length).length} 页 · 已有候选但无相符结果 {session.rows.filter(row => row.status === 'ready' && row.all_candidate_ids.length > 0 && !row.matched).length} 页 · 已有相符候选 {session.rows.filter(row => row.status === 'ready' && row.matched > 0).length} 页</p>}
        {targets.length > 0 && <ul className="story-candidate-refresh-pages">{targets.map((row) => <li key={row.page_key.page_id}>
          <span>第 {String(row.number).padStart(2, "0")} 页 · {row.title}</span>
          {session.action === "clean" ? <span>删除 {deleteIds(row).length} 张，保留 {cleanAll ? 0 : row.matched} 张</span> : <span>{!row.all_candidate_ids.length ? "尚无候选" : row.matched ? "已有相符候选" : "已有候选不符"} · 生成 {perPage} 张</span>}
          <button type="button" className="button button--quiet" onClick={() => setDetailRow(row)}>查看详情</button>
        </li>)}</ul>}
        {([ ["unavailable", "无法编译，已跳过"], ["active", "已有生成任务，已跳过"] ] as const).map(([status, label]) => {
          const skipped = session.rows.filter((row) => row.status === status && !(status === "unavailable" && cleanAll));
          return skipped.length > 0 && <section className="story-candidate-refresh-skipped" key={status}><p>{label}（{skipped.length} 页）</p><ul>{skipped.map((row) => <li key={row.page_key.page_id}>{row.title} <button type="button" className="button button--quiet" onClick={() => setDetailRow(row)}>查看详情</button></li>)}</ul></section>;
        })}
      </>}
    </Modal>}
    {detailRow && <StoryCandidateDifference key={detailRow.page_key.page_id} projectId={projectId} row={detailRow} onClose={() => setDetailRow(null)} />}
  </>;
}
