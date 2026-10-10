export type ReaderPage = { src: string; number: number; width: number; height: number; media_kind?: "image" | "video"; original_src?: string;message?:string;stale?:boolean };
export function finishedReaderDocument(pages: ReaderPage[], title?: string,locale?:string): string;
export function finishedReaderHead(title?: string,locale?:string): string;
export function finishedReaderFigure(src: string, number: number, width: number, height: number, mediaKind?: "image" | "video", originalSrc?: string,message?:string,stale?:boolean): string;
export const finishedReaderTail: string;
