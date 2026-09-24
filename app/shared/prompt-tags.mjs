// 编辑器和编译器共用：逗号分隔的完整标签，以及句内显式 {标签}。
export function promptTagSpans(text) {
  const spans = [];
  let braceStart = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { if (depth++ === 0) braceStart = i; }
    if (text[i] === "}" && depth > 0 && --depth === 0) {
      const tag = text.slice(braceStart + 1, i).trim();
      if (tag && !/[{}(),，:\n]/.test(tag)) spans.push({ start: braceStart, end: i + 1, tag, marked: true });
    }
  }
  function segment(start, end) {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const value = text.slice(start, end);
    const weighted = /^\((.*):\s*(\d+(?:\.\d+)?)\s*\)$/s.exec(value);
    if (weighted && Number(weighted[2]) > 0) { segment(start + 1, start + 1 + weighted[1].length); return; }
    if (value && !/[{},，]/.test(value)) spans.push({ start, end, tag: value, marked: false });
  }
  let start = 0;
  let parentheses = 0;
  let braces = 0;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (i === text.length || ((char === "," || char === "，") && !parentheses && !braces)) { segment(start, i); start = i + 1; }
    if (char === "(") parentheses++;
    if (char === ")") parentheses = Math.max(0, parentheses - 1);
    if (char === "{") braces++;
    if (char === "}") braces = Math.max(0, braces - 1);
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function promptTagMarkerErrors(text, isKnown) {
  const errors = [];
  const spans = promptTagSpans(text).filter(span => span.marked);
  const remainder = spans.reduceRight((value, span) => value.slice(0, span.start) + value.slice(span.end), text);
  if (/[{}]/.test(remainder)) errors.push("花括号必须配对且不可嵌套，内部只能填写一个非空标签；权重请写在花括号外");
  if (isKnown) for (const span of spans) {
    if (!isKnown(span.tag)) errors.push(`圈选标签不在词库中：${span.tag}`);
  }
  return errors;
}

export function resolvePromptTagMarkers(text) {
  let result = text;
  for (const span of promptTagSpans(text).reverse()) {
    if (span.marked) result = result.slice(0, span.start) + span.tag + result.slice(span.end);
  }
  return result;
}

export function promptCompletionSpan(text, caret) {
  caret = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, caret);
  const brace = before.lastIndexOf("{");
  if (brace > before.lastIndexOf("}")) {
    const closing = text.indexOf("}", caret);
    const end = closing < 0 ? caret : closing;
    return { start: brace + 1, end, query: text.slice(brace + 1, caret).trim(), closeBrace: closing < 0 };
  }
  let start = Math.max(before.lastIndexOf(","), before.lastIndexOf("，")) + 1;
  let end = text.slice(caret).search(/[,，]/);
  end = end < 0 ? text.length : caret + end;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const weighted = /^\((.*):\s*\d+(?:\.\d+)?\s*\)$/s.exec(text.slice(start, end));
  if (weighted) { start++; end = start + weighted[1].length; }
  return { start, end, query: text.slice(start, Math.min(caret, end)).trim(), closeBrace: false };
}
