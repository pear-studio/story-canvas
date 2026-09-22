import { useId, useMemo, useRef, useState } from "react";
import { mergeLossHistory, type LossPoint } from "../shared/lora-loss.mjs";

export function LoraLossChart({ history, log, active }: { history?: LossPoint[]; log: string; active: boolean }) {
  // 旧服务仍在训练时，从轮询日志积累数据；新服务直接提供完整历史。
  const collected = useRef<LossPoint[]>([]);
  const points = useMemo(() => {
    collected.current = history ?? mergeLossHistory(collected.current, log);
    return collected.current;
  }, [history, log]);
  const [hover, setHover] = useState<number | null>(null);
  // 默认自动范围：Qwen 的 loss 量级与旧路线不同，固定 0–0.2 会裁掉曲线。
  const [autoRange, setAutoRange] = useState(true);
  const clipId = useId();
  const width = 900, height = 240, left = 65, right = 20, top = 20, bottom = 35;
  const maxStep = Math.max(1, points.at(-1)?.step ?? 1);
  const values = points.map(point => point.loss);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const margin = Math.max((hi - lo) * 0.1, 0.001);
  const min = autoRange ? Math.max(0, lo - margin) : 0;
  const max = autoRange ? hi + margin : 0.2;
  const outsideRange = points.filter(point => point.loss < min || point.loss > max).length;
  const x = (step: number) => left + step / maxStep * (width - left - right);
  const y = (loss: number) => top + (max - loss) / (max - min) * (height - top - bottom);
  const selected = hover === null ? points.at(-1) : points.reduce<LossPoint | undefined>((best, point) => !best || Math.abs(point.step - hover) < Math.abs(best.step - hover) ? point : best, undefined);
  return <section className="lora-loss-chart" aria-label="训练 loss 曲线">
    <div className="lora-loss-heading"><b>Loss 曲线</b><span>{active ? "实时更新 · " : ""}avr_loss{selected ? ` · Step ${selected.step}：${selected.loss.toFixed(4)}` : ""}</span></div>
    <div className="lora-loss-range"><label>纵轴范围 <select value={autoRange ? "auto" : "fixed"} onChange={event => setAutoRange(event.target.value === "auto")}><option value="auto">自动范围</option><option value="fixed">固定 0–0.2</option></select></label>{!autoRange && outsideRange > 0 && <span>{outsideRange} 个数据点超出范围，可切换自动范围查看。</span>}</div>
    {points.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Loss 随 step 变化，${points.length} 个数据点`} onPointerLeave={() => setHover(null)} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHover(((event.clientX - rect.left) / rect.width * width - left) / (width - left - right) * maxStep);
    }}>
      {[0, 1, 2, 3, 4].map(tick => { const value = min + (max - min) * tick / 4; return <g key={tick}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="loss-grid" /><text x={left - 8} y={y(value) + 4} textAnchor="end">{value.toFixed(4)}</text></g>; })}
      {[0, 1, 2, 3, 4].map(tick => { const step = Math.round(maxStep * tick / 4); return <text key={tick} x={x(step)} y={height - 12} textAnchor="middle">{step}</text>; })}
      <defs><clipPath id={clipId}><rect x={left} y={top} width={width - left - right} height={height - top - bottom} /></clipPath></defs>
      <g clipPath={`url(#${clipId})`}><polyline points={points.map(point => `${x(point.step)},${y(point.loss)}`).join(" ")} fill="none" className="loss-line" />
      {selected && <circle cx={x(selected.step)} cy={y(selected.loss)} r="4" className="loss-point" />}</g>
      <text x={width - right} y={height - 1} textAnchor="end">step</text>
    </svg> : <p>等待训练器报告 loss…</p>}
    <small>{history ? "完整日志历史" : "从当前日志窗口开始积累，刷新页面可能丢失较早数据"} · 同一步保留最后一次报告值；loss 不代表出图质量。</small>
  </section>;
}
