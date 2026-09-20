// 固定的首版训练图规格：与 1024 / 256–1024 / step 64 的训练桶一致。
export const preparationPolicy = Object.freeze({ version: 1, resolution: 1024, skip_score: 60, min_gain: 2 });

export function trainingImageTarget(width, height) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error("图片尺寸无效");
  const buckets = [];
  for (let side = 256; side <= 1024; side += 64) {
    buckets.push([side, 1024]);
    if (side !== 1024) buckets.push([1024, side]);
  }
  buckets.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const target = buckets.reduce((best, value) => Math.abs(value[0] / value[1] - width / height) < Math.abs(best[0] / best[1] - width / height) ? value : best);
  return { width: target[0], height: target[1] };
}

export function preparationDecision(before, after) {
  if (!Number.isFinite(before) || (after !== null && !Number.isFinite(after))) throw new Error("MUSIQ 未返回有效分数");
  if (before >= preparationPolicy.skip_score) return "already_good";
  if (after === null) throw new Error("低分图片缺少超分后评分");
  return after - before >= preparationPolicy.min_gain ? "enhanced" : "no_gain";
}

export function validPreparation(value) {
  return value?.version === 1 && value.resolution === 1024
    && /^[a-f0-9]{64}$/.test(value.fingerprint ?? "")
    && ["already_good", "enhanced", "no_gain"].includes(value.decision)
    && Number.isFinite(value.before_score)
    && (value.decision === "already_good" ? value.after_score === null : Number.isFinite(value.after_score))
    && value.target?.width >= 256 && value.target?.height >= 256
    && Math.max(value.target.width, value.target.height) === 1024
    && value.target.width % 64 === 0 && value.target.height % 64 === 0
    && value.skip_score === preparationPolicy.skip_score && value.min_gain === preparationPolicy.min_gain;
}
