export type PromptTagSpan = { start: number; end: number; tag: string; marked: boolean };
export function promptTagSpans(text: string): PromptTagSpan[];
export function resolvePromptTagMarkers(text: string): string;
export function promptCompletionSpan(text: string, caret: number): { start: number; end: number; query: string; closeBrace: boolean };
export function promptTagMarkerErrors(text: string, isKnown?: (tag: string) => boolean): string[];
