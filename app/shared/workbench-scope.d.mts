export type WorkbenchScope = { kind: 'directory' | 'lettering' } | { kind: 'page'; page_id: string } | { kind: 'setting'; setting_kind: 'character' | 'scene'; setting_id: string } | { kind: 'story'; chapter_id?: string; sequence_id?: string };
export function parseWorkbenchScope(value: unknown): WorkbenchScope;
