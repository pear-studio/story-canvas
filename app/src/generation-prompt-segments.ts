export type PromptTextPart = { text: string };
export type PromptTextSegment<T> = { text: string; part?: T };

export function generationPromptSegments<T extends PromptTextPart>(text: string, parts: T[]): PromptTextSegment<T>[] {
  if (!parts.length) return [{ text }];
  const segments: PromptTextSegment<T>[] = [];
  let cursor = 0;
  for (const part of parts) {
    if (!part.text) continue;
    const start = text.indexOf(part.text, cursor);
    if (start < 0) return [{ text }];
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: part.text, part });
    cursor = start + part.text.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
