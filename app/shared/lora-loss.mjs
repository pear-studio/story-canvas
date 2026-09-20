export function parseLoraTrainingLine(line) {
  const step = /(?:global_step|current step)[\s=:]+(\d+)/i.exec(line) ?? /steps:.*?\|\s*(\d+)\/(\d+)\s*\[/.exec(line);
  const loss = /(?:avr_loss|loss)[\s=:]+([0-9.e+-]+)/i.exec(line);
  return { step: step ? Number(step[1]) : null, loss: loss ? Number(loss[1]) : null };
}

// tqdm 同一步可能刷新多次；保留最后一个有效值，不混入预览采样进度。
export function mergeLossHistory(previous, log) {
  const points = new Map(previous.map(point => [point.step, point.loss]));
  for (const line of log.split(/[\r\n]/)) {
    const { step, loss } = parseLoraTrainingLine(line);
    if (step !== null && step > 0 && loss !== null && Number.isFinite(loss)) points.set(step, loss);
  }
  return [...points].sort(([a], [b]) => a - b).map(([step, loss]) => ({ step, loss }));
}
