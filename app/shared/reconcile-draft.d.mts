export function reconcileDraft<T>(baseline: T, draft: T, latest: T, fields?: string[]): { value: T; discarded: boolean };
