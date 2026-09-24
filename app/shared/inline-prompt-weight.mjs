// 普通括号按字面编码；显式 (内容:正数) 可嵌套，保留作者指定的各层权重。
export function inlinePromptWeights(text) {
  const source = String(text);
  const weights = [];
  let valid = !/<lora:/i.test(source);
  const stack = [{ parts: [] }];
  const literal = value => value.replace(/[()[\]]/g, "\\$&");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const current = stack.at(-1);
    if (char === "\\" && i + 1 < source.length && /[()[\]\\:]/.test(source[i + 1])) {
      const escaped = source[++i];
      current.parts.push({ plain: escaped, encoded: `\\${escaped}` });
    } else if (char === "(") {
      stack.push({ parts: [] });
    } else if (char === ")") {
      if (stack.length === 1) { valid = false; current.parts.push({ plain: char, encoded: literal(char) }); continue; }
      const group = stack.pop();
      const colon = group.parts.findLastIndex(part => part.colon);
      let parts = group.parts;
      let rawWeight = null;
      if (colon >= 0) {
        rawWeight = parts.slice(colon + 1).map(part => part.plain).join("").trim();
        const weight = Number(rawWeight);
        if (!/^\d+(?:\.\d+)?$/.test(rawWeight) || !Number.isFinite(weight) || weight <= 0 || parts.slice(0, colon).some(part => part.colon)) valid = false;
        parts = parts.slice(0, colon);
        if (!parts.map(part => part.plain).join("").trim()) valid = false;
        weights.push(weight);
      }
      const plain = parts.map(part => part.plain).join("");
      const encoded = parts.map(part => part.encoded).join("");
      stack.at(-1).parts.push({ plain: rawWeight === null ? `(${plain})` : plain,
        encoded: rawWeight === null ? `\\(${encoded}\\)` : `(${encoded}:${rawWeight})` });
    } else {
      current.parts.push({ plain: char, encoded: literal(char), colon: char === ":" });
    }
  }
  if (stack.length !== 1) valid = false;
  const parts = stack.flatMap(group => group.parts);
  return { valid, plain: parts.map(part => part.plain).join(""), weights, encoded: parts.map(part => part.encoded).join("") };
}
