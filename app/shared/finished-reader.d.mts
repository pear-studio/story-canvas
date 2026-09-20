export type ReaderPage = { src: string; number: number; width: number; height: number };
export function finishedReaderDocument(pages: ReaderPage[], title?: string): string;
export function finishedReaderHead(title?: string): string;
export function finishedReaderFigure(src: string, number: number, width: number, height: number): string;
export const finishedReaderTail: string;
