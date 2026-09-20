export type LossPoint = { step: number; loss: number };
export function parseLoraTrainingLine(line: string): { step: number | null; loss: number | null };
export function mergeLossHistory(previous: LossPoint[], log: string): LossPoint[];
