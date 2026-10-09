type HistoryTask = { id: string; purpose: string; project_id: string | null; status: string; created_at: string | null; completed_at?: string | null; failed_at?: string | null };
export function taskHistoryMoment(task: HistoryTask): string | null | undefined;
export function taskHistoryKey(task: HistoryTask): string;
export function compareTaskHistory(left: HistoryTask, right: HistoryTask): number;
