/**
 * 将两个整体 Prompt 文本框拆回已有的稀疏片段身份。
 * @param {string} value
 * @param {string} separator
 * @returns {string[]}
 */
export function splitPromptOverrideText(value, separator) {
  const normalizedSeparator = separator.trim();
  const pieces = normalizedSeparator === ","
    ? value.split(/\s*,\s*/)
    : value.split(separator);
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/**
 * 尽量保留未改动片段的稳定 ID；删除中间片段时，不把后面的文本挪到前一个 ID。
 * @param {Array<{ text: string }>} entries
 * @param {string[]} pieces
 * @returns {Array<string | null>}
 */
export function alignPromptOverridePieces(entries, pieces) {
  const values = Array.from({ length: entries.length }, () => null);
  let cursor = 0;
  for (const piece of pieces) {
    if (cursor >= entries.length) break;
    const exactIndex = entries.findIndex((entry, index) => index >= cursor && entry.text.trim() === piece);
    if (exactIndex >= cursor) {
      values[exactIndex] = piece;
      cursor = exactIndex + 1;
      continue;
    }
    values[cursor] = piece;
    cursor += 1;
  }
  return values;
}
