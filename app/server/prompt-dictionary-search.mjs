import { fuzzy } from "fast-fuzzy";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const fuzzyOptions = { ignoreCase: false, ignoreSymbols: false, normalizeWhitespace: false, useSeparatedUnicode: true };
const latin = /^[\p{Script=Latin}\p{N}]+$/u;

export function normalizeDictionarySearchText(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

export function dictionaryQueryGroups(query, { partial = false } = {}) {
  const pieces = query.match(/[\p{Script=Latin}\p{N}]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}]+/gu) ?? [];
  const tokens = partial ? pieces.flatMap(text => latin.test(text) ? [text]
    : [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment)) : pieces;
  const groups = new Map();
  for (const text of new Set(tokens)) {
    const isLatin = latin.test(text);
    const key = isLatin ? "latin" : "other";
    const block = {
      text, latin: isLatin, weight: [...text].length,
      prefix: isLatin ? new RegExp("(?:^|[^\\p{Script=Latin}\\p{N}])" + text + (text.length < 2 ? "(?=$|[^\\p{Script=Latin}\\p{N}])" : ""), "u") : null,
    };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(block);
  }
  return [...groups.values()];
}

function blockScore(term, block, approximate) {
  if (block.latin ? block.prefix.test(term) : term.includes(block.text)) return 1;
  if (!approximate || !block.latin || block.weight < 3) return 0;
  const score = fuzzy(block.text, term, fuzzyOptions);
  return score + Number.EPSILON >= 1 - 1 / block.weight ? score : 0;
}

// 同语种的块由一个词名/别名/关键词覆盖；跨语种可以使用该词条的不同译名。
// 正文只额外提供一个段落，不能跨整篇文章拼接。
export function dictionaryBlockScore(terms, groups, { paragraph = "", approximate = false } = {}) {
  let matched = 0;
  let total = 0;
  for (const group of groups) {
    const weight = group.reduce((sum, block) => sum + block.weight, 0);
    total += weight;
    let best = 0;
    for (const term of paragraph ? ["", ...terms] : terms) {
      let score = 0;
      for (const block of group) {
        const nameScore = blockScore(term, block, approximate);
        const bodyScore = paragraph ? blockScore(paragraph, block, false) : 0;
        score += Math.max(nameScore, bodyScore) * block.weight;
      }
      best = Math.max(best, score);
      if (best === weight) break;
    }
    matched += best;
  }
  return total ? matched / total : 0;
}

export function dictionaryContainedNameScore(terms, query) {
  let best = 0;
  const queryLength = [...query].length;
  for (const term of terms) {
    const length = [...term].length;
    if (length < 2 || !/[\p{L}\p{N}]/u.test(term)) continue;
    const contains = /^[\p{Script=Latin}\p{N}\s]+$/u.test(term)
      ? query === term || query.startsWith(term + " ") || query.endsWith(" " + term) || query.includes(" " + term + " ")
      : query.includes(term);
    if (contains) best = Math.max(best, length / queryLength);
  }
  return best;
}

export function dictionaryDescriptionParagraphs(entry) {
  const sources = [entry.description_language === "zh" ? entry.description : "", entry.original_description ?? entry.description];
  const seen = new Set();
  const paragraphs = [];
  for (const source of sources) {
    for (const part of String(source ?? "").split(/\r?\n\s*\r?\n/u)) {
      const text = part
        .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu, (_, target, label) => label?.trim() || target.replaceAll("_", " "))
        .replace(/"(.*?)":\[?https?:\/\/[^\s\]]+\]?/gu, "$1")
        .replace(/https?:\/\/[^\s\]]+/gu, "")
        .replace(/!(?:post|asset|pool)\s*#\d+/giu, "")
        .replace(/\[\/?(?:b|i|u|s|spoiler|code|quote)\]/giu, "")
        .replace(/^h[1-6]\.\s*/gmu, "")
        .replace(/^\*+\s*/gmu, "")
        .replace(/\s+/gu, " ").trim();
      const normalized = normalizeDictionarySearchText(text);
      if (!/[\p{L}\p{N}]/u.test(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      paragraphs.push({ text, normalized });
    }
  }
  // 相同查询优先短而集中的段落；仍保留另见、示例等所有章节。
  return paragraphs.sort((left, right) => left.normalized.length - right.normalized.length);
}

export function dictionaryMatchSnippet(paragraph, groups) {
  const positions = groups.flat().map(block => paragraph.normalized.indexOf(block.text)).filter(index => index >= 0);
  const index = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, index - 30);
  return (start ? "…" : "") + paragraph.text.slice(start, start + 140) + (paragraph.text.length > start + 140 ? "…" : "");
}
